import ts from 'typescript';

// Static imports still evaluate their targets when their bindings are read only
// later. Keep that graph; distinguish the reads that can hit a TDZ at startup.
export function collectImportBindingReads(sourceFile) {
  const imports = new Map();
  const localFunctions = new Map();
  for (const node of sourceFile.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) localFunctions.set(node.name.text, node);
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer
          && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          localFunctions.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression
      && ts.isStringLiteral(node.moduleReference.expression)) {
      imports.set(node.name.text, node.moduleReference.expression.text);
    }
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
    const clause = node.importClause;
    const specifier = node.moduleSpecifier.text;
    if (clause?.name) imports.set(clause.name.text, specifier);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, specifier);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly) imports.set(binding.name.text, specifier);
      }
    }
  }

  const runtimeBindings = new Set();
  const eagerReads = new Map();
  const evaluatingFunctions = new Set();
  function visitFunction(node, eager, shadowed) {
    const local = new Set(shadowed);
    for (const parameter of node.parameters) collectBindingNames(parameter.name, local);
    for (const parameter of node.parameters) {
      if (parameter.initializer) visit(parameter.initializer, eager, local);
    }
    if (node.body) visit(node.body, eager, local);
  }
  function visit(node, eager, shadowed = new Set()) {
    if (ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent)
      && (ts.isClassDeclaration(node.parent.parent) || ts.isClassExpression(node.parent.parent))
      && node.parent.token === ts.SyntaxKind.ExtendsKeyword) {
      visit(node.expression, eager, shadowed);
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isTypeNode(node)) return;
    if (ts.isExportDeclaration(node)) {
      if (!node.moduleSpecifier && !node.isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const binding of node.exportClause.elements) {
          if (!binding.isTypeOnly) runtimeBindings.add((binding.propertyName ?? binding.name).text);
        }
      }
      return;
    }
    if (ts.isFunctionLike(node)) {
      // Computed method names evaluate while defining a class.
      if (node.name && ts.isComputedPropertyName(node.name)) visit(node.name.expression, eager, shadowed);
      let expression = node;
      while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
      const immediate = (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
        && ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
      visitFunction(node, eager && immediate, shadowed);
      return;
    }
    if (ts.isPropertyDeclaration(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name.expression, eager, shadowed);
      const isStatic = node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
      if (node.initializer) visit(node.initializer, eager && Boolean(isStatic), shadowed);
      return;
    }
    if (ts.isBlock(node)) {
      shadowed = new Set(shadowed);
      for (const statement of node.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) collectBindingNames(declaration.name, shadowed);
        } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
          shadowed.add(statement.name.text);
        }
      }
    }
    if (eager && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const fn = localFunctions.get(name);
      if (fn && !shadowed.has(name) && !evaluatingFunctions.has(name)) {
        evaluatingFunctions.add(name);
        visitFunction(fn, true, shadowed);
        evaluatingFunctions.delete(name);
      }
    }
    if (ts.isIdentifier(node) && imports.has(node.text) && !shadowed.has(node.text) && isValueReference(node)) {
      runtimeBindings.add(node.text);
      if (eager) {
        const parent = node.parent;
        const parse = ts.isPropertyAccessExpression(parent) && parent.expression === node
          && ts.isCallExpression(parent.parent) && parent.parent.expression === parent
          && ['parse', 'safeParse', 'parseAsync', 'safeParseAsync'].includes(parent.name.text);
        const previous = eagerReads.get(node.text);
        eagerReads.set(node.text, {
          moduleSpecifier: imports.get(node.text), binding: node.text,
          parse: parse || previous?.parse === true,
        });
      }
    }
    ts.forEachChild(node, child => visit(child, eager, shadowed));
  }
  visit(sourceFile, true);
  return { runtimeBindings, eagerReads: [...eagerReads.values()] };
}

function collectBindingNames(name, names) {
  if (ts.isIdentifier(name)) names.add(name.text);
  else for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, names);
  }
}

function isValueReference(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)
    || ts.isBindingElement(parent) || ts.isParameter(parent) || ts.isClassDeclaration(parent)
    || ts.isClassExpression(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node) return false;
  return true;
}

export function findEvaluationCycles({ graph, components, eagerReads, relativePath }) {
  const cyclicComponent = new Map();
  for (const component of components) {
    if (component.length < 2 && !graph.get(component[0])?.has(component[0])) continue;
    for (const file of component) cyclicComponent.set(file, component);
  }
  const cycles = [];
  for (const read of eagerReads) {
    const component = cyclicComponent.get(read.to);
    if (!component) continue;
    let path;
    if (cyclicComponent.get(read.from) === component) {
      path = shortestPath(graph, read.to, read.from);
      path = [read.from, ...path];
    } else if (read.parse) {
      // Parsing can force a deferred schema graph from outside its own cycle.
      const next = [...graph.get(read.to)].find(file => component.includes(file));
      path = [read.to, ...shortestPath(graph, next, read.to)];
    } else continue;
    cycles.push({
      files: [...new Set(path.map(relativePath))].sort(),
      edges: path.slice(1).map((to, index) => [relativePath(path[index]), relativePath(to)]),
      read: { from: relativePath(read.from), to: relativePath(read.to), binding: read.binding },
    });
  }
  return cycles;
}

function shortestPath(graph, from, to) {
  const parents = new Map([[from, null]]);
  const queue = [from];
  for (const current of queue) {
    if (current === to) {
      const path = [];
      for (let file = to; file !== null; file = parents.get(file)) path.unshift(file);
      return path;
    }
    for (const next of graph.get(current) ?? []) {
      if (parents.has(next)) continue;
      parents.set(next, current);
      queue.push(next);
    }
  }
  throw new Error(`Missing cycle return path: ${from} -> ${to}`);
}
