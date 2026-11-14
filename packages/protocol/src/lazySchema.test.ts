import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { core, z } from 'zod';

import { lazySchema } from './lazySchema.js';
import {
  createSessionPermissionModeInputSchema,
  SessionPermissionModeInputSchema,
} from './sessionMetadata/sessionPermissionModes.js';

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

  describe.each(['input', 'output'] as const)('JSON Schema %s projection', (io) => {
    it.each(['eager', 'lazy'] as const)('matches eager preprocess schemas with %s projected first', (first) => {
      const eager = z.object({ permissionMode: z.preprocess((value) => value, z.enum(['read_only', 'full'])) });
      const lazy = z.object({
        permissionMode: lazySchema(() => z.preprocess((value) => value, z.enum(['read_only', 'full']))),
      });

      expect(() => z.toJSONSchema(first === 'eager' ? eager : lazy, { io })).not.toThrow();
      const expected = z.toJSONSchema(eager, { io });
      expect(z.toJSONSchema(lazy, { io })).toEqual(expected);
      expect(z.toJSONSchema(lazy, { io })).toEqual(expected);
      expect(z.toJSONSchema(eager, { io })).toEqual(expected);
    });

    it('projects two schemas sharing one lazy preprocess child', () => {
      const child = z.preprocess((value) => value, z.enum(['read_only', 'full']));
      const lazyChild = lazySchema(() => child);
      const eager = z.object({
        first: z.object({ permissionMode: child }),
        second: z.object({ permissionMode: child }),
      });
      const lazy = z.object({
        first: z.object({ permissionMode: lazyChild }),
        second: z.object({ permissionMode: lazyChild }),
      });

      expect(z.toJSONSchema(lazy, { io })).toEqual(z.toJSONSchema(eager, { io }));
    });

    it('projects the real session permission mode input schema', () => {
      const eager = z.object({ permissionMode: createSessionPermissionModeInputSchema(z) });
      const lazy = z.object({ permissionMode: SessionPermissionModeInputSchema });

      expect(z.toJSONSchema(lazy, { io })).toEqual(z.toJSONSchema(eager, { io }));
    });

    describe.each(['method', 'standard'] as const)('%s entry point', (entryPoint) => {
      const project = (schema: z.ZodType) => {
        if (entryPoint === 'method') return schema.toJSONSchema({ io });
        return schema['~standard'].jsonSchema[io]({ target: 'draft-2020-12' });
      };

      it('projects a lazy plain object', () => {
        const create = () => z.object({ id: z.string() });
        expect(project(lazySchema(create))).toEqual(project(create()));
      });

      it('projects a lazy string inside an eager object', () => {
        const lazy = z.object({ id: lazySchema(() => z.string()) });
        expect(project(lazy)).toEqual(project(z.object({ id: z.string() })));
      });

      it('projects a lazy preprocess', () => {
        const create = () => z.preprocess((value) => value, z.enum(['read_only', 'full']));
        expect(project(lazySchema(create))).toEqual(project(create()));
      });

      it('projects the real permission mode schema inside an eager object', () => {
        const lazy = z.object({ permissionMode: SessionPermissionModeInputSchema });
        const eager = z.object({ permissionMode: createSessionPermissionModeInputSchema(z) });
        expect(project(lazy)).toEqual(project(eager));
      });

      it('preserves cycles through a caller-owned recursive object', () => {
        const child = z.object({ get next() { return child.optional(); } });
        const expected = project(z.object({ child }));
        const actual = project(z.object({ child: lazySchema(() => child) }));
        expect(actual).toEqual(expected);
        expect(() => JSON.stringify(actual)).not.toThrow();
      });
    });
  });

  it('retries a failed build without registering partial metadata', () => {
    let builds = 0;
    const Schema = lazySchema(() => {
      builds += 1;
      if (builds === 1) throw new Error('build failed');
      return z.preprocess((value) => value, z.enum(['read_only', 'full'])).describe('Permission mode');
    });

    expect(() => z.toJSONSchema(Schema)).toThrow('build failed');
    expect(z.globalRegistry.has(Schema)).toBe(false);
    expect(z.toJSONSchema(Schema)).toMatchObject({
      type: 'string', enum: ['read_only', 'full'], description: 'Permission mode',
    });
    expect(Schema.parse('read_only')).toBe('read_only');
    expect(builds).toBe(2);
  });

  it('keeps the caller schema and its JSON Schema hook intact after resolving', () => {
    const child = z.string();
    const hook = child._zod.processJSONSchema;
    const lazy = lazySchema(() => child);

    expect(lazy.parse('x')).toBe('x');
    expect(child._zod.processJSONSchema).toBe(hook);
    expect(child.toJSONSchema()).toMatchObject({ type: 'string' });
    expect(z.toJSONSchema(child)).toEqual(child.toJSONSchema());
    expect(child['~standard'].jsonSchema.input()).toEqual(child.toJSONSchema({ io: 'input' }));
    expect(child['~standard'].jsonSchema.output()).toEqual(child.toJSONSchema({ io: 'output' }));
  });

  it('keeps a stable per-wrapper view with the built schema parsing and introspection fields', () => {
    const child = z.string();
    const first = lazySchema(() => child);
    const second = lazySchema(() => child);

    expect(first._zod).toBe(first._zod);
    expect(first._zod).not.toBe(second._zod);
    expect(first._zod.def).toBe(child._zod.def);
    expect(first._zod.parse).toBe(child._zod.parse);
    expect(first._zod.traits).toBe(child._zod.traits);
    expect(first.safeParse(1).success).toBe(false);
    expect(second.parse('x')).toBe('x');
  });

  it('preserves an existing built-schema traversal entry when projecting the proxy', () => {
    const child = z.preprocess((value) => value, z.enum(['read_only', 'full']));
    const lazy = lazySchema(() => child);
    const ctx = core.initializeContext({ processors: {} });
    core.processSchema(child, ctx);
    const existing = ctx.seen.get(child);

    core.processSchema(lazy, ctx);
    expect(ctx.seen.get(child)).toBe(existing);
    core.extractDefs(ctx, lazy);
    expect(core.finalize(ctx, lazy)).toEqual(child.toJSONSchema());
  });

  it('supports nested projections of two wrappers sharing a built schema and context', () => {
    const child = z.preprocess((value) => value, z.enum(['read_only', 'full']));
    const hook = child._zod.processJSONSchema!;
    const outer = lazySchema(() => child);
    const inner = lazySchema(() => child);
    let context: core.ToJSONSchemaContext | undefined;
    // Exercise re-entry at Zod's real per-instance extension boundary.
    child._zod.processJSONSchema = (ctx, json, params) => {
      context = ctx;
      const current = ctx.seen.get(child);
      core.processSchema(inner, ctx);
      expect(ctx.seen.get(child)).toBe(current);
      hook(ctx, json, params);
    };

    const actual = z.object({ outer, inner }).toJSONSchema();
    const expected = z.object({
      outer: z.preprocess((value) => value, z.enum(['read_only', 'full'])),
      inner: z.preprocess((value) => value, z.enum(['read_only', 'full'])),
    }).toJSONSchema();
    expect(actual).toEqual(expected);
    expect(context?.seen.get(child)).not.toBe(context?.seen.get(outer));
  });

  it('keeps the caller hook intact and retries with a fresh context after it throws', () => {
    const child = z.preprocess((value) => value, z.string());
    const hook = child._zod.processJSONSchema!;
    const lazy = lazySchema(() => child);
    const ctx = core.initializeContext({ processors: {} });
    let fail = true;
    child._zod.processJSONSchema = (context, json, params) => {
      if (fail) {
        throw new Error('projection failed');
      }
      hook(context, json, params);
    };
    const throwingHook = child._zod.processJSONSchema;

    expect(() => core.processSchema(lazy, ctx)).toThrow('projection failed');
    expect(child._zod.processJSONSchema).toBe(throwingHook);
    expect(ctx.seen.get(lazy)?.ref).toBeUndefined();
    fail = false;
    expect(lazy.toJSONSchema()).toEqual(child.toJSONSchema());
  });

  it('keeps override callbacks keyed by the lazy proxy', () => {
    const lazy = lazySchema(() => z.preprocess((value) => value, z.enum(['read_only', 'full'])));
    const seen: unknown[] = [];
    z.toJSONSchema(z.object({ permissionMode: lazy }), {
      io: 'input',
      override: (ctx) => { seen.push(ctx.zodSchema); },
    });
    expect(seen).toContain(lazy);
  });

  it('projects a lazy schema whose built schema has a metadata id', () => {
    const create = () => z.preprocess((value) => value, z.enum(['read_only', 'full'])).meta({ id: 'Mode' });
    expect(z.toJSONSchema(z.object({ permissionMode: lazySchema(create) })))
      .toEqual(z.toJSONSchema(z.object({ permissionMode: create() })));
    expect(z.toJSONSchema(lazySchema(create))).toEqual(z.toJSONSchema(create()));
  });

  it('projects registered lazy schemas', () => {
    const registry = z.registry<{ id: string }>();
    const lazy = lazySchema(() => z.preprocess((value) => value, z.enum(['read_only', 'full'])));
    registry.add(lazy, { id: 'Mode' });
    expect(z.toJSONSchema(registry)).toMatchObject({
      schemas: { Mode: { type: 'string', enum: ['read_only', 'full'] } },
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
