import { Session } from 'node:inspector';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import * as z from 'zod/mini';

import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { compileProtocolJsonSchema } from './jsonSchemaCompiler.js';
import { createProtocolComposableSchema, createProtocolStoredReadSchema, defineProtocolObject, defineProtocolString } from './protocolComposableSchema.js';

it('releases resolved factories while keeping cold factories and admitted documents live', async () => {
  const inspector = new Session();
  inspector.connect();
  const factories: WeakRef<object>[] = [];
  function materialize() {
    const nativeFactory = () => z.string();
    const projectionFactory = () => ({ type: 'string' });
    factories.push(new WeakRef(nativeFactory), new WeakRef(projectionFactory));
    const native = lazyZodSchema(nativeFactory);
    const schema = createProtocolComposableSchema(projectionFactory, value => ({ success: true, data: value }));
    expect(native.parse('first')).toBe('first');
    const document = schema.jsonSchema;
    return { native, schema, document, validate: compileProtocolJsonSchema(document, 'draft-07') };
  }
  const live = Array.from({ length: 40 }, materialize);
  let coldCalls = 0;
  const cold = lazyZodSchema(() => { coldCalls++; return z.string(); });
  const collect = () => new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
  try {
    await setImmediate();
    await collect();
    await setImmediate();
    await collect();
    // Count retained construction closures, not elapsed GC time or total heap.
    expect(factories.filter(ref => ref.deref()).length).toBe(0);
    expect(coldCalls).toBe(0);
    expect(cold.parse('cold')).toBe('cold');
    expect(coldCalls).toBe(1);
    for (const { native, schema, document, validate } of live) {
      const { parse, safeParse } = schema;
      expect(parse('next')).toBe('next');
      expect(safeParse('next').success).toBe(true);
      expect(native.safeParse(2).success).toBe(false);
      expect(schema.jsonSchema).toBe(document);
      expect(compileProtocolJsonSchema(document, 'draft-07')).toBe(validate);
      expect(structuredClone(document)).toEqual(document);
    }
  } finally {
    inspector.disconnect();
  }
});

it('shares a stored reader by definition across repeated members while preserving input and stored policies', () => {
  const child = defineProtocolObject({ value: defineProtocolString() }, { policy: 'additive-open/drop' });
  const readers = Array.from({ length: 40 }, () => createProtocolStoredReadSchema(child));
  expect(new Set(readers).size).toBe(1);
  const parent = defineProtocolObject({ first: child, second: child }, { policy: 'closed' });
  const { parse, safeParse } = readers[0]!;
  expect(parse({ value: 'kept', retired: true })).toEqual({ value: 'kept' });
  expect(safeParse({ value: 2 }).success).toBe(false);
  expect(parent.parse({ first: { value: 'a' }, second: { value: 'b' } })).toEqual({ first: { value: 'a' }, second: { value: 'b' } });
  expect(parent.safeParse({ first: { value: 'a' }, second: { value: 2 } }).success).toBe(false);
});

it('keeps shared methods attached to their owner through nested deferred definitions', () => {
  const original = defineProtocolString({ minLength: 2 });
  const schema = lazyDefinition(() => lazyDefinition(() => original));
  expect(schema.jsonSchema).toBe(original.jsonSchema);
  const { parse, safeParse, optional, nullable } = schema;
  expect(parse('kept')).toBe('kept');
  expect(safeParse('x').success).toBe(false);
  expect(optional().parse(undefined)).toBeUndefined();
  expect(nullable().parse(null)).toBeNull();
});

it('keeps unresolved factories available after a failed admission', () => {
  let nativeAttempts = 0;
  const native = lazyZodSchema(() => {
    if (++nativeAttempts === 1) throw new Error('construction failed');
    return z.string();
  });
  expect(() => native.parse('first')).toThrow('construction failed');
  expect(native.parse('retry')).toBe('retry');
  expect(nativeAttempts).toBe(2);
  let projectionAttempts = 0;
  const schema = createProtocolComposableSchema(() => {
    if (++projectionAttempts === 1) throw new Error('projection failed');
    return { type: 'string' };
  }, value => ({ success: true, data: value }));
  expect(schema.parse('still usable')).toBe('still usable');
  expect(() => schema.jsonSchema).toThrow('projection failed');
  expect(schema.jsonSchema.type).toBe('string');
  expect(projectionAttempts).toBe(2);
});

it('projects nested composed documents by sharing admitted children, copying only a child that holds a pointer', async () => {
  const inspector = new Session();
  inspector.connect();
  const post = <T,>(method: string, params?: object) => new Promise<T>((resolve, reject) => inspector.post(method, params ?? {}, (error, result) => error ? reject(error) : resolve(result as T)));
  type Coverage = { result: { functions: { functionName: string; ranges: { count: number }[] }[] }[] };
  const calls = (coverage: Coverage, name: string) => coverage.result.flatMap(script => script.functions)
    .filter(fn => fn.functionName === name).reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
  const nestedSchema = (depth: number) => {
    let schema = defineProtocolObject({ leaf: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
    for (let level = 0; level < depth; level += 1) schema = defineProtocolObject({ child: schema, label: defineProtocolString() }, { policy: 'closed' });
    return schema;
  };
  const nestedValue = (depth: number) => {
    let value: Record<string, unknown> = { leaf: 'x' };
    for (let level = 0; level < depth; level += 1) value = { child: value, label: 'l' };
    return value;
  };
  await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  try {
    // Relocation copies made to construct and project one composed document; each copy is re-admitted by the parent's snapshot.
    const measure = async (build: () => { jsonSchema: unknown }) => {
      await post('Profiler.takePreciseCoverage');
      const document = build().jsonSchema;
      const coverage = await post<Coverage>('Profiler.takePreciseCoverage');
      return { document, copies: calls(coverage, 'embedProtocolJsonSchema') };
    };
    const [shallow, deep] = [await measure(() => nestedSchema(8)), await measure(() => nestedSchema(16))];
    expect({ copies: [shallow.copies, deep.copies] }).toEqual({ copies: [0, 0] });
    const validate = compileProtocolJsonSchema(deep.document as object, 'draft-07');
    expect(validate(nestedValue(16))).toBe(true);
    expect(validate({ ...nestedValue(16), extra: true })).toBe(false);

    const referenced = createProtocolComposableSchema(
      { $defs: { text: { type: 'string' } }, type: 'object', properties: { text: { $ref: '#/$defs/text' } } },
      value => ({ success: true, data: value }),
    );
    const withPointer = await measure(() => defineProtocolObject({ nested: nestedSchema(8), referenced }, { policy: 'closed' }));
    const document = withPointer.document as { properties: { referenced: { properties: { text: { $ref: string } } } } };
    expect(withPointer.copies).toBe(1);
    expect(document.properties.referenced.properties.text.$ref).toBe('#/properties/referenced/$defs/text');
    const validateReferenced = compileProtocolJsonSchema(document, 'draft-07');
    expect(validateReferenced({ nested: nestedValue(8), referenced: { text: 't' } })).toBe(true);
    expect(validateReferenced({ nested: nestedValue(8), referenced: { text: 1 } })).toBe(false);
  } finally {
    await post('Profiler.stopPreciseCoverage').catch(() => undefined);
    inspector.disconnect();
  }
});
