import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Every session runner imports most of the CLI, but only touches a few of its
// schemas. Building them all at startup cost each runner thousands of zod
// instances (each with its own method closures), so top-level schemas go
// through lazySchema from @happier-dev/protocol, like the protocol package.
const SRC_DIR = __dirname;

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'fixtures' ? [] : listSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|testkit|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function isSchemaFactoryCall(expression: ts.Expression): boolean {
  let node = expression;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    node = node.expression;
  }
  if (!ts.isCallExpression(node)) return false;
  let callee: ts.Expression = node;
  while (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) {
    callee = callee.expression;
  }
  if (!ts.isIdentifier(callee)) return false;
  // `z.object(...)`, `OtherSchema.extend(...)`, ... — but `OtherSchema.parse(...)` builds a value, not a schema.
  const isSchemaRoot = callee.text === 'z' || (callee.text !== 'lazySchema' && /Schema$/.test(callee.text));
  const firstMember = node.expression;
  const isParse = ts.isPropertyAccessExpression(firstMember) && /^(safe)?[pP]arse/.test(firstMember.name.text);
  return isSchemaRoot && !isParse;
}

describe('CLI module-level schemas', () => {
  it('declares top-level schemas through lazySchema', () => {
    const eager = listSources(SRC_DIR).flatMap((file) => {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      return source.statements.flatMap((statement) => {
        if (!ts.isVariableStatement(statement)) return [];
        return statement.declarationList.declarations
          .filter((declaration) => declaration.initializer && isSchemaFactoryCall(declaration.initializer))
          .map((declaration) => `${relative(SRC_DIR, file)}: ${declaration.name.getText(source)}`);
      });
    });

    expect(eager).toEqual([]);
  });
});
