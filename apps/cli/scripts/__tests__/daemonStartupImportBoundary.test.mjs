import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = resolve(cliRoot, 'src');

// This is a package evaluation boundary, not a spelling rule: follow every
// static CLI dependency, excluding type edges and demand-driven imports.
function startupImports(...entries) {
  const queue = entries.map(entry => resolve(sourceRoot, entry));
  const seen = new Set(queue);
  const imports = [];
  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index];
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      if (node.isTypeOnly || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      if (ts.isImportDeclaration(node) && node.importClause) {
        const clause = node.importClause;
        if (clause.isTypeOnly) continue;
        if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.every(element => element.isTypeOnly)) continue;
      }
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.every(element => element.isTypeOnly)) continue;
      const specifier = node.moduleSpecifier.text;
      imports.push({ file: file.slice(sourceRoot.length + 1), specifier });
      const target = specifier.startsWith('@/') ? resolve(sourceRoot, specifier.slice(2))
        : specifier.startsWith('.') ? resolve(dirname(file), specifier.replace(/\.js$/u, '')) : null;
      if (target === null) continue;
      const resolved = [target, `${target}.ts`, `${target}.tsx`, resolve(target, 'index.ts')]
        .find(candidate => /\.[cm]?tsx?$/u.test(candidate) && existsSync(candidate));
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return imports;
}

const imports = startupImports('index.ts', 'daemon/startDaemon.ts');

test('daemon startup reaches Protocol through domain exports', () => {
  assert.deepEqual(imports.filter(edge => edge.specifier === '@happier-dev/protocol'), []);
});

test('daemon startup does not evaluate the MCP SDK before an MCP operation', () => {
  assert.deepEqual(imports.filter(edge => edge.specifier.startsWith('@modelcontextprotocol/sdk/')), []);
});

test('daemon startup keeps GitHub management code and database drivers behind invocation', () => {
  const entries = [...imports, ...startupImports('api/apiMachine.ts')];
  const deferred = new Set([
    '@happier-dev/plugins-scm-github',
    '@happier-dev/plugins-scm-github/managed-repository-webhook',
    '@happier-dev/databases/connection/mysql',
    '@happier-dev/databases/connection/postgresql',
  ]);
  assert.deepEqual(entries.filter(edge => deferred.has(edge.specifier)), []);
});

test('Session host startup does not evaluate the holder implementation before a Session or handover', () => {
  const imports = startupImports('cli/commands/sessionHost.ts', 'agent/runtime/lifecycle/sessionHost.ts');
  assert.deepEqual(imports.filter(edge => edge.specifier === '@/subprocess/supervision/sessionHolder'), []);
});

test('daemon startup defers Session clients and launch execution until Session use', () => {
  const sessionDependencies = new Set(['./session/sessionClient', './executeSpawnSessionRequest']);
  assert.deepEqual(imports.filter(edge => sessionDependencies.has(edge.specifier)), []);
});

test('daemon startup defers Workflow coordination and recovery until Machine demand', () => {
  assert.deepEqual(imports.filter(edge => edge.specifier === './workflows/daemonRuntime'), []);
});
