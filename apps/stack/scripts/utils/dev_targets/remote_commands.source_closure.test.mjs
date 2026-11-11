// @happier-test-preparation source
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const ts = require('typescript');
const { createServer } = await import(pathToFileURL(require.resolve('vite')));

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? testFiles(path) : /\.(test|spec)\.[cm]?[jt]sx?$/u.test(path) ? [path] : [];
  });
}

// Qualify the complete test graph with the actual config's Vite resolver.
// Installed third-party dependency internals belong to dependency bootstrap;
// realpath prevents workspace symlinks from masquerading as those dependencies.
for (const component of ['packages/agents', 'packages/plugins/elevenlabs']) {
  test(`${component} default test graph qualifies source preparation only with complete closure`, async () => {
    const cwd = process.cwd();
    process.chdir(join(root, component));
    let server;
    try {
      server = await createServer({ configFile: join(root, component, 'vitest.config.ts'),
        server: { middlewareMode: true, watch: null }, logLevel: 'silent' });
      const pending = testFiles(join(root, component, 'src'));
      const roots = pending.length;
      const seen = new Set();
      const failures = new Set();
      let edges = 0;
      for (let i = 0; i < pending.length; i++) {
        const file = pending[i];
        if (seen.has(file)) continue;
        seen.add(file);
        if (!/\.[cm]?[jt]sx?$/u.test(file)) continue;
        const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        const imports = new Set();
        function visit(node) {
          if ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
            || (ts.isExportDeclaration(node) && !node.isTypeOnly)) {
            if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
          }
          if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
            const arg = node.arguments[0];
            if (arg && ts.isStringLiteralLike(arg)) imports.add(arg.text);
            else failures.add(`${relative(root, file)}: nonliteral module request`);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
        for (const id of imports) {
          if (isBuiltin(id)) continue;
          edges++;
          let resolved;
          try { resolved = await server.pluginContainer.resolveId(id, file, { ssr: true }); }
          catch { failures.add(`${relative(root, file)} -> ${id}: resolution error`); continue; }
          if (!resolved || resolved.id.startsWith('\0')) {
            failures.add(`${relative(root, file)} -> ${id}: unresolved`); continue;
          }
          let target = resolved.id.replace(/[?#].*$/u, '');
          if (target.startsWith('node:')) continue;
          try { target = realpathSync(target); }
          catch { failures.add(`${relative(root, file)} -> ${id}: missing file`); continue; }
          if (target.includes('/node_modules/')) continue;
          if (target.includes('/dist/')) failures.add(`${relative(root, file)} -> ${relative(root, target)}: workspace dist`);
          else if (target.startsWith(root)) pending.push(target);
          else failures.add(`${relative(root, file)} -> ${id}: outside source/dependencies`);
        }
      }
      console.log(JSON.stringify({ component, roots, files: seen.size, edges, failures: [...failures].sort() }));
      if (component === 'packages/agents') assert.deepEqual([...failures], []);
      else assert.ok([...failures].some(failure => failure ===
        'packages/plugin-sdk/src/protocol/deployment.ts -> packages/deployment-protocol/dist/v1/index.js: workspace dist'),
      'ElevenLabs must retain runtime preparation while its SDK closure consumes emitted deployment-protocol');
    } finally {
      await server?.close();
      process.chdir(cwd);
    }
  });
}
