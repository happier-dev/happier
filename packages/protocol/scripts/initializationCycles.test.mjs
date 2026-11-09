import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { test } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));

// As with actionCatalogImports.test.mjs, collect the graph before the assertion:
// the contract concerns eager reads, not Vitest's generic five-second deadline.
function findCyclicSchemaReads() {
  const graph = new Map();
  const reads = [];
  const pending = Object.values(manifest.exports).map(entry => {
    assert.equal(typeof entry['happier-source'], 'string', 'Public exports must identify their source entrypoint');
    return resolve(packageRoot, entry['happier-source']);
  });
  for (const file of pending) {
    if (graph.has(file)) continue;
    if (file.endsWith('.json')) { graph.set(file, []); continue; }
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = new Map();
    const edges = [];
    graph.set(file, edges);
    for (const statement of ast.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        || !statement.moduleSpecifier || statement.isTypeOnly || statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings ?? statement.exportClause;
      const named = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings));
      if (named && bindings.elements.length > 0 && bindings.elements.every(binding => binding.isTypeOnly)
        && !statement.importClause?.name) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) continue;
      const base = resolve(dirname(file), specifier);
      const target = [base.replace(/\.js$/u, '.ts'), `${base}.ts`, resolve(base, 'index.ts')]
        .find(candidate => existsSync(candidate));
      assert.ok(target, `Unresolved Protocol source import: ${file} -> ${specifier}`);
      edges.push(target);
      pending.push(target);
      if (ts.isImportDeclaration(statement) && named) {
        for (const binding of bindings.elements) {
          if (!binding.isTypeOnly && /Schema$/u.test((binding.propertyName ?? binding.name).text)) {
            imports.set(binding.name.text, target);
          }
        }
      }
    }
    function visit(node) {
      if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      // Deferred factories do not read bindings during initialization; an
      // immediately invoked function does, just like an ordinary initializer.
      if (ts.isFunctionLike(node)) {
        if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
        let expression = node;
        while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
        if (!ts.isCallExpression(expression.parent) || expression.parent.expression !== expression) return;
      }
      if (ts.isIdentifier(node) && imports.has(node.text)
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
        && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
        const parse = ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
          && ['parse', 'safeParse', 'parseAsync', 'safeParseAsync'].includes(node.parent.name.text);
        reads.push({ file, target: imports.get(node.text), name: node.text, parse,
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 });
      }
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(ast, visit);
  }
  function pathTo(from, to) {
    const queue = [[from]];
    const seen = new Set([from]);
    for (const path of queue) {
      const last = path.at(-1);
      if (last === to) return path;
      for (const next of graph.get(last) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push([...path, next]); }
      }
    }
  }
  const failures = reads.flatMap(read => {
    const back = pathTo(read.target, read.file);
    let cycle = back && [read.file, ...back];
    // Parsing forces a schema's own cyclic graph even when the caller is not
    // itself a member of that cycle (the historical Workflow builtin parse).
    if (!cycle && read.parse) {
      for (const next of graph.get(read.target) ?? []) {
        const back = pathTo(next, read.target);
        if (back) { cycle = [read.target, ...back]; break; }
      }
    }
    return cycle ? [`${relative(packageRoot, read.file)}:${read.line} eagerly reads ${read.name}\n  ${cycle
      .map(file => relative(packageRoot, file)).join(' -> ')}`] : [];
  });
  return failures;
}
const failures = findCyclicSchemaReads();
test('Protocol public module graphs defer cyclic top-level schema reads', () => {
  assert.equal(failures.length, 0, `Defer cyclic schema reads with lazyZodSchema or use an independent leaf module:\n${failures.join('\n')}`);
});
