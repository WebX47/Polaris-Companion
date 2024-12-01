const esbuild = require("esbuild");

const production = true;

async function build() {
  await esbuild.build({
    entryPoints: ["src/client.ts", "src/server.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    platform: "node",
    outdir: "out",
    external: ["vscode"],
    logLevel: "info",
  });
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
