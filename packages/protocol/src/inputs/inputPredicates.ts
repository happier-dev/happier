import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasUnicodeWhitespaceAtSegmentBoundary(segment: string): boolean {
  // ECMAScript trim excludes U+0085 NEXT LINE, which is Unicode White_Space.
  return segment !== segment.trim()
    || /^\p{White_Space}/u.test(segment)
    || /\p{White_Space}$/u.test(segment);
}

function isBoundedInputPath(value: string): boolean {
  if (value.length === 0 || value.length > 256 || utf8ByteLength(value) > 256) return false;
  if (value !== value.trim()) return false;
  const segments = value.split('.');
  return segments.length >= 1
    && segments.length <= 16
    && segments.every((segment) => segment.length > 0 && !hasUnicodeWhitespaceAtSegmentBoundary(segment));
}

/** Shared field/predicate grammar at Action descriptor admission. */
export const InputPathSchema = lazyZodSchema(() => z.string().check(z.superRefine((value, context) => {
  if (isBoundedInputPath(value)) return;
  context.addIssue({
    code: "custom",
    message: 'Action input paths must contain 1–16 non-empty dot-separated segments and be at most 256 UTF-8 bytes.',
  });
})));
export type InputPath = z.infer<typeof InputPathSchema>;

export const InputPrimitiveSchema = lazyZodSchema(() => z.union([z.string(), z.number(), z.boolean(), z.null()]));
export type InputPrimitive = z.infer<typeof InputPrimitiveSchema>;

export type InputPredicateWithValue<Value> =
  | Readonly<{
      op: 'truthy';
      path: InputPath;
    }>
  | Readonly<{
      op: 'eq';
      path: InputPath;
      value: Value;
    }>
  | Readonly<{
      op: 'includes';
      path: InputPath;
      value: string;
    }>
  | Readonly<{
      op: 'not';
      predicate: InputPredicateWithValue<Value>;
    }>
  | Readonly<{
      op: 'and';
      all: readonly InputPredicateWithValue<Value>[];
    }>
  | Readonly<{
      op: 'or';
      any: readonly InputPredicateWithValue<Value>[];
    }>;

export type InputPredicate = InputPredicateWithValue<InputPrimitive>;

/** Recipe declarations bind eq values before using the same concrete grammar. */
export function createInputPredicateSchema<Value>(valueSchema: z.core.$ZodType<Value, Value>): z.ZodMiniType<InputPredicateWithValue<Value>> {
  const schema: z.ZodMiniType<InputPredicateWithValue<Value>> = z.lazy(() => z.union([
    z.strictObject({
        op: z.literal('truthy'),
        path: InputPathSchema,
      }),
    z.strictObject({
        op: z.literal('eq'),
        path: InputPathSchema,
        value: valueSchema,
      }),
    z.strictObject({
        op: z.literal('includes'),
        path: InputPathSchema,
        value: z.string().check(z.minLength(1)),
      }),
    z.strictObject({
        op: z.literal('not'),
        predicate: schema,
      }),
    z.strictObject({
        op: z.literal('and'),
        all: z.array(schema).check(z.minLength(1)),
      }),
    z.strictObject({
        op: z.literal('or'),
        any: z.array(schema).check(z.minLength(1)),
      }),
  ]));
  return schema;
}
export const InputPredicateSchema: z.ZodMiniType<InputPredicate> = createInputPredicateSchema(InputPrimitiveSchema);

/** Bind declaration values without adding another predicate evaluator/parser. */
export function mapInputPredicateValues<InputValue, OutputValue>(predicate: InputPredicateWithValue<InputValue>,
  mapValue: (value: InputValue) => OutputValue): InputPredicateWithValue<OutputValue> {
  switch (predicate.op) {
    case 'eq': return { ...predicate, value: mapValue(predicate.value) };
    case 'not': return { ...predicate, predicate: mapInputPredicateValues(predicate.predicate, mapValue) };
    case 'and': return { ...predicate, all: predicate.all.map(entry => mapInputPredicateValues(entry, mapValue)) };
    case 'or': return { ...predicate, any: predicate.any.map(entry => mapInputPredicateValues(entry, mapValue)) };
    default: return predicate;
  }
}

/**
 * Reads a bounded Action-input path through the one shared path traversal.
 * Callers receive no coercion or alternate path grammar.
 */
export function readInputPath(input: unknown, path: string): unknown {
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
  let cursor: unknown = input;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** The shared predicate grammar's referenced input paths. */
export function readInputPredicatePaths(predicate: unknown): readonly string[] {
  if (!predicate || typeof predicate !== 'object') return [];
  const fields = new Map(Object.entries(predicate));
  switch (fields.get('op')) {
    case 'truthy':
    case 'eq':
    case 'includes': {
      const path = fields.get('path');
      return typeof path === 'string' ? [path] : [];
    }
    case 'not': return readInputPredicatePaths(fields.get('predicate'));
    case 'and': {
      const all = fields.get('all');
      return Array.isArray(all) ? all.flatMap(readInputPredicatePaths) : [];
    }
    case 'or': {
      const any = fields.get('any');
      return Array.isArray(any) ? any.flatMap(readInputPredicatePaths) : [];
    }
    default: return [];
  }
}

export function evaluateInputPredicate(predicate: InputPredicate, input: unknown): boolean {
  if (!predicate || typeof predicate !== 'object') return false;
  switch (predicate.op) {
    case 'truthy': return Boolean(readInputPath(input, predicate.path));
    case 'eq': return readInputPath(input, predicate.path) === predicate.value;
    case 'includes': {
      const value = readInputPath(input, predicate.path);
      return Array.isArray(value)
        ? value.some((entry) => typeof entry === 'string' && entry.trim() === predicate.value.trim())
        : typeof value === 'string' && value.includes(predicate.value);
    }
    case 'not': return !evaluateInputPredicate(predicate.predicate, input);
    case 'and': return predicate.all.every((entry) => evaluateInputPredicate(entry, input));
    case 'or': return predicate.any.some((entry) => evaluateInputPredicate(entry, input));
    default: return false;
  }
}
