import type { MetaTheme, MetaTokenGroupShape } from "@shopify/polaris-tokens";
import { createVarName, metaThemeDefault, isTokenName, toPx } from "@shopify/polaris-tokens";
import { createConnection, TextDocuments, ProposedFeatures, CompletionItemKind, TextDocumentSyncKind } from "vscode-languageserver/node";
import type { CompletionItem, TextDocumentPositionParams, InitializeResult, Hover } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const excludedTokenGroupNames = [] as const;

type ExcludedTokenGroupName = (typeof excludedTokenGroupNames)[number];

type TokenGroupName = Exclude<keyof MetaTheme, ExcludedTokenGroupName>;

const tokenGroups = Object.fromEntries(
  Object.entries(metaThemeDefault).filter(([tokenGroupName]) => !excludedTokenGroupNames.includes(tokenGroupName as ExcludedTokenGroupName))
) as unknown as Omit<MetaTheme, ExcludedTokenGroupName>;

type TokenGroupCompletionItems = {
  [T in TokenGroupName]: CompletionItem[];
};

// helper function
const getTokenValue = (value: string) => {
  if (value.startsWith("var(")) {
    // Find the referenced token in tokenGroups
    const varName = value.slice(4, -1); // Remove var( and )
    for (const group of Object.values(tokenGroups)) {
      for (const [name, props] of Object.entries(group)) {
        if (isTokenName(name) && createVarName(name) === varName) {
          return props.value;
        }
      }
    }
    return value;
  }
  return value;
};

const formatDetail = (value: string) => {
  const resolvedValue = getTokenValue(value);
  if (resolvedValue.includes("rem") && resolvedValue !== "0rem") {
    return value.startsWith("var(") ? `${value} → ${resolvedValue} (${toPx(resolvedValue)})` : `${resolvedValue} (${toPx(resolvedValue)})`;
  }
  return value.startsWith("var(") ? `${value} → ${resolvedValue}` : resolvedValue;
};

const getTokenScore = (property: string, tokenName: string): number => {
  property = property.toLowerCase();
  tokenName = tokenName.toLowerCase();
  
  // Extract property name ("font-size" from "font-size: --")
  const propertyName = property.split(':')[0].trim();
  const propertyParts = propertyName.split('-');
  
  let score = 0;
  
  // Exact match bonus
  if (tokenName.includes(propertyName.replace('-', ''))) {
    score += 100;
  }
  
  // Individual word match scoring
  propertyParts.forEach(part => {
    if (tokenName.includes(part)) {
      score += 50;
    }
  });
  
  return score;
};

/**
 * Grouped VS Code `CompletionItem`s for Polaris custom properties
 */
const tokenGroupCompletionItems = Object.fromEntries(
  Object.entries(tokenGroups).map(([tokenGroupName, tokenGroup]: [string, MetaTokenGroupShape]) => {
    const completionItems: CompletionItem[] = Object.entries(tokenGroup).map(([tokenName, tokenProperties]): CompletionItem => {
      if (!isTokenName(tokenName)) {
        throw new Error(`Invalid token name: ${tokenName}`);
      }

      return {
        label: createVarName(tokenName),
        insertText: `var(${createVarName(tokenName)})`,
        detail: formatDetail(tokenProperties.value),
        documentation: tokenProperties.description,
        filterText: createVarName(tokenName),
        kind: tokenGroupName === "color" ? CompletionItemKind.Color : CompletionItemKind.Variable,
      };
    });

    return [tokenGroupName, completionItems];
  })
) as unknown as TokenGroupCompletionItems;

const allTokenGroupCompletionItems: CompletionItem[] = Object.values(tokenGroupCompletionItems).flat();

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

type TokenGroupPatterns = {
  [T in TokenGroupName]: RegExp;
};

const tokenGroupPatterns: TokenGroupPatterns = {
  border: /border/,
  breakpoints: /width/,
  color: /color|background|shadow|border|column-rule|filter|opacity|outline|text-decoration/,
  text: /font|letter-spacing|line-height/,
  font: /font|letter-spacing|line-height/,
  height: /height|min-height|max-height/,
  motion: /animation/,
  shadow: /shadow/,
  space: /margin|padding|gap|top|left|right|bottom/,
  width: /width|min-width|max-width/,
  zIndex: /z-index/,
};

connection.onInitialize(() => {
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        triggerCharacters: ["--"],
      },
      // Add hover support
      hoverProvider: true,
    },
  };

  return result;
});

// Add hover handler
connection.onHover(({ textDocument, position }) => {
  const doc = documents.get(textDocument.uri);
  if (!doc) return null;

  const text = doc.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: 1000 },
  });

  // Find any var(--token-name) at the current position
  const matches = [...text.matchAll(/var\(([^)]+)\)/g)];
  
  // Get the character position within the line
  const charPositionInLine = position.character;

  for (const match of matches) {
    const varName = match[1].trim(); // Get the variable name including --
    const matchStartInLine = match.index || 0;
    const matchEndInLine = matchStartInLine + match[0].length;

    // Check if hover position is within this match
    if (charPositionInLine >= matchStartInLine && charPositionInLine <= matchEndInLine) {
      // Find token details
      for (const group of Object.values(tokenGroups)) {
        for (const [name, props] of Object.entries(group)) {
          if (isTokenName(name) && createVarName(name) === varName) {
            return {
              contents: {
                kind: "markdown",
                value: [`**[Polaris] ${name}**`, props.description || "", `\`${formatDetail(props.value)}\``].filter(Boolean).join("\n\n"),
              },
            };
          }
        }
      }
    }
  }

  return null;
});

// This handler provides the list of token completion items.
connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
  const doc = documents.get(textDocumentPosition.textDocument.uri);
  let matchedCompletionItems: CompletionItem[] = [];

  // if the doc can't be found, return nothing
  if (!doc) {
    return [];
  }

  const currentLine = doc.getText({
    start: { line: textDocumentPosition.position.line, character: 0 },
    end: { line: textDocumentPosition.position.line, character: textDocumentPosition.position.character },
  });

  // Only provide completions if we're typing a custom property (starts with --)
  const trimmedLine = currentLine.trimEnd();
  if (!trimmedLine.includes("--")) {
    return [];
  }

  // Get the partial text after -- to use for filtering
  const partialText = trimmedLine.split("--").pop() || "";
  
  const fullLineText = doc.getText({
    start: { line: textDocumentPosition.position.line, character: 0 },
    end: { line: textDocumentPosition.position.line, character: 1000 },
  });

  for (const [tokenGroupName, pattern] of Object.entries(tokenGroupPatterns)) {
    if (!pattern.test(fullLineText)) continue;

    const currentCompletionItems = tokenGroupCompletionItems[tokenGroupName as keyof typeof tokenGroupPatterns];
    // Filter items based on partial text if it exists
    const filteredItems = partialText 
      ? currentCompletionItems.filter(item => 
          item.label.toLowerCase().includes(partialText.toLowerCase()))
      : currentCompletionItems;
    matchedCompletionItems = matchedCompletionItems.concat(filteredItems);
  }

  // Sort completion items based on relevance to the current property
  const sortedItems = matchedCompletionItems.length > 0 ? matchedCompletionItems : 
    (partialText 
      ? allTokenGroupCompletionItems.filter(item => 
          item.label.toLowerCase().includes(partialText.toLowerCase()))
      : allTokenGroupCompletionItems);
  
  return sortedItems
    .map(item => ({
      ...item,
      sortText: String.fromCharCode(97 + Math.max(999 - getTokenScore(fullLineText, item.label), 0)).padStart(3, 'a')
    }))
    .sort((a, b) => a.sortText.localeCompare(b.sortText));
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
