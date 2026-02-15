import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import ts from 'typescript';

const SOURCE_FILE_PATH = new URL('./LocalConversationSection.tsx', import.meta.url);

function isReactUseStateCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  return ts.isPropertyAccessExpression(expr) && expr.expression.getText() === 'React' && expr.name.text === 'useState';
}

function containsReactUseState(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (isReactUseStateCall(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function isReturnNull(statement: ts.Statement): boolean {
  if (!ts.isReturnStatement(statement)) return false;
  return statement.expression?.kind === ts.SyntaxKind.NullKeyword;
}

function isEnabledGuardReturnNull(statement: ts.Statement): boolean {
  if (!ts.isIfStatement(statement)) return false;

  // Match: if (!enabled) return null;
  const cond = statement.expression;
  if (!ts.isPrefixUnaryExpression(cond) || cond.operator !== ts.SyntaxKind.ExclamationToken) return false;
  if (!ts.isIdentifier(cond.operand) || cond.operand.text !== 'enabled') return false;

  const thenStmt = statement.thenStatement;
  if (ts.isBlock(thenStmt)) {
    return thenStmt.statements.length === 1 && isReturnNull(thenStmt.statements[0]);
  }
  return isReturnNull(thenStmt);
}

describe('LocalConversationSection hook-order invariants', () => {
  it('does not place the enabled guard return before React.useState', () => {
    const content = readFileSync(SOURCE_FILE_PATH, 'utf8');
    const sourceFile = ts.createSourceFile('LocalConversationSection.tsx', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const localConversationFn = sourceFile.statements.find(
      (stmt): stmt is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(stmt) && stmt.name?.text === 'LocalConversationSection' && stmt.body != null,
    );

    expect(localConversationFn).toBeTruthy();

    const statements = localConversationFn!.body!.statements;
    const guardIndex = statements.findIndex(isEnabledGuardReturnNull);
    const useStateIndex = statements.findIndex((stmt) => containsReactUseState(stmt));

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(useStateIndex).toBeGreaterThanOrEqual(0);
    expect(useStateIndex).toBeLessThan(guardIndex);
  });
});

