import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/**
 * Bundler-generated references that must resolve to a module-scope binding of
 * the same chunk: namespace object members (`Object.freeze({ __proto__: null,
 * name: binding })`, including live-binding getters) and local export
 * specifiers. Rollup < 4.63.6 emitted namespace members for external
 * re-exports without importing them (rollup#6540), which crashed the CLI with
 * "<name> is not defined" only when that path ran.
 */
function collectBindingNames(name, out) {
  if (ts.isIdentifier(name)) { out.add(name.text); return; }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, out);
  }
}

function collectModuleBindings(sourceFile) {
  const bound = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) bound.add(clause.name.text);
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) bound.add(named.name.text);
      if (named && ts.isNamedImports(named)) for (const element of named.elements) bound.add(element.name.text);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      bound.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) collectBindingNames(declaration.name, bound);
    } else if (ts.isEnumDeclaration(statement)) {
      bound.add(statement.name.text);
    }
  }
  return bound;
}

function isNamespaceObject(node) {
  return ts.isCallExpression(node)
    && node.expression.getText() === 'Object.freeze'
    && node.arguments.length === 1
    && ts.isObjectLiteralExpression(node.arguments[0])
    && node.arguments[0].properties.some((property) => (
      ts.isPropertyAssignment(property) && property.name.getText() === '__proto__'
      && property.initializer.kind === ts.SyntaxKind.NullKeyword
    ));
}

function collectNamespaceReferences(objectLiteral, out) {
  for (const property of objectLiteral.properties) {
    if (ts.isShorthandPropertyAssignment(property)) out.push(property.name.text);
    else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) out.push(property.initializer.text);
    else if (ts.isGetAccessorDeclaration(property)) {
      const returned = property.body?.statements.find(ts.isReturnStatement)?.expression;
      if (returned && ts.isIdentifier(returned)) out.push(returned.text);
    }
  }
}

/** Unbound bundler references in one ES module chunk's source text. */
export function findUnboundChunkReferences(code, fileName = 'chunk.mjs') {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bound = collectModuleBindings(sourceFile);
  const references = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause
      && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) references.push((element.propertyName ?? element.name).text);
    }
  }
  const visit = (node) => {
    if (isNamespaceObject(node)) collectNamespaceReferences(node.arguments[0], references);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(references.filter((name) => name !== 'undefined' && !bound.has(name)))].sort();
}

/** Every unbound bundler reference in the ES module chunks under `outputDir`. */
export function findUnboundBundleReferences(outputDir) {
  const problems = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
      for (const name of findUnboundChunkReferences(readFileSync(path, 'utf8'), entry.name)) {
        problems.push({ file: relative(outputDir, path).replaceAll('\\', '/'), name });
      }
    }
  };
  walk(outputDir);
  return problems.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputDir = process.argv[2];
  if (!outputDir) { process.stderr.write('usage: bundleBindings.mjs <bundle output dir>\n'); process.exit(2); }
  const problems = findUnboundBundleReferences(outputDir);
  for (const { file, name } of problems) process.stdout.write(`${file}: ${name}\n`);
  process.exit(problems.length > 0 ? 1 : 0);
}
