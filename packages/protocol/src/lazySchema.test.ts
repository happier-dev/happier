import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { lazySchema } from './lazySchema.js';

describe('lazySchema', () => {
  it('builds the schema once, on first use', () => {
    let builds = 0;
    const Schema = lazySchema(() => {
      builds += 1;
      return z.object({ id: z.string() });
    });

    expect(builds).toBe(0);
    expect(Schema.parse({ id: 'a' })).toEqual({ id: 'a' });
    expect(Schema.safeParse({ id: 1 }).success).toBe(false);
    expect(builds).toBe(1);
  });

  it('behaves as the built schema for composition and introspection', () => {
    const Base = lazySchema(() => z.object({ type: z.literal('base'), id: z.string() }));
    const Other = lazySchema(() => z.object({ type: z.literal('other') }));
    const Union = lazySchema(() => z.discriminatedUnion('type', [Base, Other]));
    const Wrapper = z.object({ base: Base.optional(), item: Union });

    expect(Base).toBeInstanceOf(z.ZodObject);
    expect(Object.keys(Base.shape)).toEqual(['type', 'id']);
    expect(Base.extend({ extra: z.number() }).parse({ type: 'base', id: 'x', extra: 1 })).toEqual({
      type: 'base',
      id: 'x',
      extra: 1,
    });
    expect(Wrapper.parse({ item: { type: 'other' } })).toEqual({ item: { type: 'other' } });
    expect(Wrapper.safeParse({ item: { type: 'base' } }).success).toBe(false);
    expect(z.toJSONSchema(Base)).toMatchObject({ type: 'object', required: ['type', 'id'] });
  });

  it('keeps schema metadata when projected to JSON Schema', () => {
    const Described = lazySchema(() => z.string().describe('Workspace path'));

    expect(z.toJSONSchema(z.object({ path: Described }))).toMatchObject({
      properties: { path: { type: 'string', description: 'Workspace path' } },
    });
  });
});

// Importing the protocol package must not build every schema it declares; each
// process only touches a few of them. Top-level schemas therefore go through
// lazySchema, and this guard keeps new eager declarations from creeping back in.
describe('protocol module-level schemas', () => {
  const srcDir = __dirname;
  const isSchemaFactoryCall = (expression: ts.Expression): boolean => {
    let node: ts.Expression = expression;
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
  };

  const listSources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : listSources(full);
      return /\.ts$/.test(entry.name) && !/\.(test|spec|d)\.ts$|\.generated\.ts$/.test(entry.name) ? [full] : [];
    });

  it('declares top-level schemas through lazySchema', () => {
    const eager = listSources(srcDir).flatMap((file) => {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      return source.statements.flatMap((statement) => {
        if (!ts.isVariableStatement(statement)) return [];
        return statement.declarationList.declarations
          .filter((declaration) => declaration.initializer && isSchemaFactoryCall(declaration.initializer))
          .map((declaration) => `${path.relative(srcDir, file)}: ${declaration.name.getText(source)}`);
      });
    });

    expect(eager).toEqual([]);
  });
});
