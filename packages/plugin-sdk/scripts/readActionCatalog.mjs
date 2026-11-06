import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

export function createActionCatalogReader(readSource = path => readFileSync(path, 'utf8'), recordInput = () => {}) {
  const sources = new Map();
  const source = path => {
    if (!sources.has(path)) {
      const text = readSource(path);
      recordInput(path, text);
      sources.set(path, ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true));
    }
    return sources.get(path);
  };
  const definition = (path, name) => {
    for (const node of source(path).statements) {
      if (ts.isVariableStatement(node)) {
        const declaration = node.declarationList.declarations.find(n => ts.isIdentifier(n.name) && n.name.text === name);
        if (declaration) return { path, node: declaration.initializer };
      }
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        const binding = node.importClause.namedBindings.elements.find(n => n.name.text === name);
        if (binding) return definition(resolve(dirname(path), node.moduleSpecifier.text.replace(/\.js$/u, '.ts')), (binding.propertyName ?? binding.name).text);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
        const binding = node.exportClause.elements.find(n => n.name.text === name);
        if (binding) return definition(resolve(dirname(path), node.moduleSpecifier.text.replace(/\.js$/u, '.ts')), (binding.propertyName ?? binding.name).text);
      }
    }
    throw Error(`Unresolved Action catalog declaration: ${name}`);
  };
  const value = (path, name) => {
    const found = definition(path, name);
    return evaluate(found.path, found.node);
  };
  const unwrap = node => {
    while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  };
  const owner = (path, node) => {
    node = unwrap(node);
    if (!ts.isIdentifier(node)) return path;
    const found = definition(path, node.text);
    return owner(found.path, found.node);
  };
  const evaluate = (path, node, bindings = new Map()) => {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return bindings.has(node.text) ? bindings.get(node.text) : value(path, node.text);
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return evaluate(path, node.expression, bindings)[node.name.text];
    if (ts.isElementAccessExpression(node)) return evaluate(path, node.expression, bindings)[evaluate(path, node.argumentExpression, bindings)];
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(n => ts.isSpreadElement(n) ? evaluate(path, n.expression, bindings) : [evaluate(path, n, bindings)]);
    if (ts.isObjectLiteralExpression(node)) return Object.assign({}, ...node.properties.map(n => ts.isSpreadAssignment(n) ? evaluate(path, n.expression, bindings) : { [n.name.text]: evaluate(path, n.initializer, bindings) }));
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Map' && node.arguments?.length === 1) {
      return new Map(evaluate(path, node.arguments[0], bindings));
    }
    if (ts.isCallExpression(node) && node.expression.getText(source(path)) === 'Object.freeze') return evaluate(path, node.arguments[0], bindings);
    if (ts.isCallExpression(node) && node.expression.getText(source(path)) === 'Object.values') return Object.values(evaluate(path, node.arguments[0], bindings));
    // Canonical families partition literal ids with these predicates. Interpret
    // only their syntax; catalog source and callback bodies never execute.
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) {
      const equal = evaluate(path, node.left, bindings) === evaluate(path, node.right, bindings);
      return node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : !equal;
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return !evaluate(path, node.operand, bindings);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length === 1) {
      const method = node.expression.name.text;
      if (method === 'get') {
        const entries = evaluate(path, node.expression.expression, bindings);
        if (entries instanceof Map) return entries.get(evaluate(path, node.arguments[0], bindings));
      }
      if (method === 'includes') {
        const ids = evaluate(path, node.expression.expression, bindings);
        if (Array.isArray(ids)) return ids.includes(evaluate(path, node.arguments[0], bindings));
      }
      if (method === 'filter') {
        const callback = node.arguments[0];
        if (ts.isArrowFunction(callback) && callback.parameters.length === 1 && !ts.isBlock(callback.body)
          && !callback.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
          const parameter = callback.parameters[0];
          const ids = evaluate(path, node.expression.expression, bindings);
          if (ts.isIdentifier(parameter.name) && !parameter.initializer && !parameter.dotDotDotToken && Array.isArray(ids)) {
            return ids.filter(id => {
              const selected = evaluate(path, callback.body, new Map([...bindings, [parameter.name.text, id]]));
              if (typeof selected !== 'boolean') throw Error('Action catalog filter must use a boolean predicate');
              return selected;
            });
          }
        }
      }
    }
    throw Error(`Unsupported Action catalog expression: ${node.getText(source(path))}`);
  };
  return { source, definition, unwrap, owner, value, evaluate };
}

export function readActionCatalog(repoRoot, recordInput = () => {}, readSource = path => readFileSync(path, 'utf8')) {
  const { source, definition, unwrap, owner, value } = createActionCatalogReader(readSource, recordInput);
  const protocol = resolve(repoRoot, 'packages/protocol/src');
  const catalog = definition(resolve(protocol, 'actions/actionIds.ts'), 'ACTION_ID_FAMILIES_V1');
  let catalogNode = unwrap(catalog.node);
  if (ts.isCallExpression(catalogNode) && catalogNode.expression.getText(source(catalog.path)) === 'Object.freeze') catalogNode = unwrap(catalogNode.arguments[0]);
  if (!ts.isObjectLiteralExpression(catalogNode)) throw Error('Action family catalog must declare its family exports');
  const familyOwners = Object.fromEntries(catalogNode.properties.map(member => {
    if (!ts.isPropertyAssignment(member)) throw Error('Action family catalog must name each family export');
    return [member.name.text, owner(catalog.path, member.initializer)];
  }));
  return { families: value(resolve(protocol, 'actions/actionIds.ts'), 'ACTION_ID_FAMILIES_V1'),
    familyOwners, excluded: value(resolve(protocol, 'actions/pluginActionSurface.ts'), 'PLUGIN_SURFACE_EXCLUSION_REASONS') };
}
