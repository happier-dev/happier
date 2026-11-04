import ts from 'typescript';

import { type InventoryFile } from '../migrations/lib/migrationTypes.ts';
import { isTestPolicyFile } from './testPolicySurface.ts';

export interface InternalModuleMockPackage {
  packagePath: string;
  count: number;
  files: { filePath: string; count: number }[];
}

function mockSpecifier(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return mockSpecifier(node.arguments[0]);
  }
  return undefined;
}

function countInternalModuleMocks(file: InventoryFile): number {
  if (!isTestPolicyFile(file.filePath) || !file.content.includes('mock')) return 0;
  const source = ts.createSourceFile(file.filePath, file.content, ts.ScriptTarget.Latest, true);
  const bindings = new Set(['vi']);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== 'vitest') continue;
    const names = statement.importClause?.namedBindings;
    if (names && ts.isNamedImports(names)) {
      for (const element of names.elements) {
        if ((element.propertyName?.text ?? element.name.text) === 'vi') bindings.add(element.name.text);
      }
    }
  }

  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const access = node.expression;
      const member = ts.isPropertyAccessExpression(access) ? access.name.text
        : ts.isElementAccessExpression(access) ? mockSpecifier(access.argumentExpression) : undefined;
      if (member === 'mock' && (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access))
        && ts.isIdentifier(access.expression) && bindings.has(access.expression.text)) {
        const specifier = mockSpecifier(node.arguments[0]);
        const internal = specifier && /^(?:\.{1,2}\/|@\/|~\/|#|@happier-dev\/)/.test(specifier);
        // The reviewer must establish that this is an actual system adapter, not domain logic.
        const boundary = (ts.getLeadingCommentRanges(file.content, node.getFullStart()) ?? [])
          .some((range) => /test-policy-boundary:\s*\S.+/.test(file.content.slice(range.pos, range.end)));
        if (internal && !boundary) count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return count;
}

export function collectInternalModuleMockInventory(files: readonly InventoryFile[]): InternalModuleMockPackage[] {
  const packages = new Map<string, InternalModuleMockPackage>();
  for (const input of files) {
    const file = { ...input, filePath: input.filePath.replaceAll('\\', '/') };
    const count = countInternalModuleMocks(file);
    if (count === 0) continue;
    const packagePath = /^(apps\/[^/]+|packages\/plugins\/[^/]+|packages\/[^/]+)/.exec(file.filePath)?.[0]
      ?? '.';
    let entry = packages.get(packagePath);
    if (!entry) {
      entry = { packagePath, count: 0, files: [] };
      packages.set(packagePath, entry);
    }
    entry.count += count;
    entry.files.push({ filePath: file.filePath, count });
  }
  return [...packages.values()].sort((a, b) => a.packagePath.localeCompare(b.packagePath)).map((entry) => ({
    ...entry, files: entry.files.sort((a, b) => a.filePath.localeCompare(b.filePath)),
  }));
}
