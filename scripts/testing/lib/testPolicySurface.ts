import ts from 'typescript';

const TEST_POLICY_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_POLICY_DIR_PATTERN = /(?:^|\/)(?:testkit|__tests__)\//;
const CANONICAL_TEST_SPAWN_HELPER_PATH_PATTERN = /(?:^|\/)(?:packages\/tests\/src\/testkit\/process\/testSpawn\.ts|apps\/stack\/scripts\/testkit\/core\/spawn_test_process\.mjs)$/;
const CHILD_PROCESS_MODULES = new Set(['node:child_process', 'child_process']);

export function isTestPolicyFile(filePath: string): boolean {
  return TEST_POLICY_FILE_PATTERN.test(filePath) || TEST_POLICY_DIR_PATTERN.test(filePath);
}

export function isCanonicalTestSpawnHelperPath(filePath: string): boolean {
  return CANONICAL_TEST_SPAWN_HELPER_PATH_PATTERN.test(filePath);
}

export function stripStringsAndComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

function resolveScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.ts') || filePath.endsWith('.mts') || filePath.endsWith('.cts')) return ts.ScriptKind.TS;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function isChildProcessModuleName(text: string): boolean {
  return CHILD_PROCESS_MODULES.has(text);
}

function isChildProcessRequireCall(node: ts.Node | undefined): node is ts.CallExpression {
  return Boolean(
    node
    && ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'require'
    && node.arguments.length === 1
    && ts.isStringLiteral(node.arguments[0])
    && isChildProcessModuleName(node.arguments[0].text),
  );
}

function collectSpawnBindings(sourceFile: ts.SourceFile): { identifiers: Set<string>; namespaces: Set<string> } {
  const identifiers = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && isChildProcessModuleName(statement.moduleSpecifier.text)) {
      const clause = statement.importClause;
      const namedBindings = clause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === 'spawn') {
            identifiers.add(element.name.text);
          }
        }
      }
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        namespaces.add(namedBindings.name.text);
      }
      continue;
    }

    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!isChildProcessRequireCall(declaration.initializer)) {
        continue;
      }

      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          const importedName = ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
          if (importedName === 'spawn') {
            identifiers.add(element.name.text);
          }
        }
        continue;
      }

      if (ts.isIdentifier(declaration.name)) {
        namespaces.add(declaration.name.text);
      }
    }
  }

  return { identifiers, namespaces };
}

function hasDetachedTrueOption(node: ts.CallExpression): boolean {
  const optionsArg = node.arguments[node.arguments.length - 1];
  if (!optionsArg || !ts.isObjectLiteralExpression(optionsArg)) {
    return false;
  }

  return optionsArg.properties.some((property) =>
    ts.isPropertyAssignment(property)
    && ts.isIdentifier(property.name)
    && property.name.text === 'detached'
    && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
}

function isSpawnCallExpression(
  expression: ts.LeftHandSideExpression,
  bindings: { identifiers: Set<string>; namespaces: Set<string> },
): boolean {
  if (ts.isIdentifier(expression)) {
    return bindings.identifiers.has(expression.text);
  }

  return ts.isPropertyAccessExpression(expression)
    && expression.name.text === 'spawn'
    && ts.isIdentifier(expression.expression)
    && bindings.namespaces.has(expression.expression.text);
}

export function countDirectDetachedSpawnCalls(filePath: string, content: string): number {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    resolveScriptKind(filePath),
  );
  const bindings = collectSpawnBindings(sourceFile);
  if (bindings.identifiers.size === 0 && bindings.namespaces.size === 0) {
    return 0;
  }

  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isSpawnCallExpression(node.expression, bindings) && hasDetachedTrueOption(node)) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return count;
}
