import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function productionTsxFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) return productionTsxFiles(path);
    if (!path.endsWith('.tsx') || /\.(test|spec)\.tsx$/u.test(path)) return [];
    return [path];
  });
}

function switchElementsWithoutAccessibleNames(path: string): string[] {
  const sourceText = readFileSync(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const missing: string[] = [];

  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxElement(node)
        ? node.openingElement
        : null;
    if (opening?.tagName.getText(sourceFile) === 'Switch') {
      const labelAttribute = opening.attributes.properties.find((attribute) => (
        ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === 'accessibilityLabel'
      ));
      const hasAccessibleName = (() => {
        if (!labelAttribute || !ts.isJsxAttribute(labelAttribute) || !labelAttribute.initializer) return false;
        if (ts.isStringLiteral(labelAttribute.initializer)) {
          return labelAttribute.initializer.text.trim().length > 0;
        }
        if (!ts.isJsxExpression(labelAttribute.initializer) || !labelAttribute.initializer.expression) return false;
        const expression = labelAttribute.initializer.expression;
        if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
          return expression.text.trim().length > 0;
        }
        if (expression.kind === ts.SyntaxKind.NullKeyword) return false;
        return !(ts.isIdentifier(expression) && expression.text === 'undefined');
      })();
      if (!hasAccessibleName) {
        const position = sourceFile.getLineAndCharacterOfPosition(opening.getStart(sourceFile));
        missing.push(`${relative(process.cwd(), path)}:${position.line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return missing;
}

describe('Voice settings switch accessibility boundary', () => {
  it('gives every active Voice settings switch a programmatic accessible name', () => {
    const files = productionTsxFiles(join(process.cwd(), 'sources/voice'));
    const switchCount = files.reduce((count, path) => {
      const sourceText = readFileSync(path, 'utf8');
      const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let fileCount = 0;
      const visit = (node: ts.Node): void => {
        if (
          (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sourceFile) === 'Switch')
          || (ts.isJsxElement(node) && node.openingElement.tagName.getText(sourceFile) === 'Switch')
        ) {
          fileCount += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return count + fileCount;
    }, 0);
    const missing = files.flatMap(switchElementsWithoutAccessibleNames);

    expect(switchCount).toBeGreaterThan(0);
    expect(missing, 'Every Voice settings Switch must expose accessibilityLabel').toEqual([]);
  });
});
