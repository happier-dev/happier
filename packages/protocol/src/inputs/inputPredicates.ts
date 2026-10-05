import { z } from 'zod';

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
export const InputPathSchema = z.string().superRefine((value, context) => {
  if (isBoundedInputPath(value)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Action input paths must contain 1–16 non-empty dot-separated segments and be at most 256 UTF-8 bytes.',
  });
});
export type InputPath = z.infer<typeof InputPathSchema>;

export const InputPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type InputPrimitive = z.infer<typeof InputPrimitiveSchema>;

export type InputPredicate =
  | Readonly<{
      op: 'truthy';
      path: InputPath;
    }>
  | Readonly<{
      op: 'eq';
      path: InputPath;
      value: InputPrimitive;
    }>
  | Readonly<{
      op: 'includes';
      path: InputPath;
      value: string;
    }>
  | Readonly<{
      op: 'not';
      predicate: InputPredicate;
    }>
  | Readonly<{
      op: 'and';
      all: readonly InputPredicate[];
    }>
  | Readonly<{
      op: 'or';
      any: readonly InputPredicate[];
    }>;

export const InputPredicateSchema: z.ZodType<InputPredicate> = z.lazy(() =>
  z.union([
    z
      .object({
        op: z.literal('truthy'),
        path: InputPathSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal('eq'),
        path: InputPathSchema,
        value: InputPrimitiveSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal('includes'),
        path: InputPathSchema,
        value: z.string().min(1),
      })
      .strict(),
    z
      .object({
        op: z.literal('not'),
        predicate: InputPredicateSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal('and'),
        all: z.array(InputPredicateSchema).min(1),
      })
      .strict(),
    z
      .object({
        op: z.literal('or'),
        any: z.array(InputPredicateSchema).min(1),
      })
      .strict(),
  ]),
);

/**
 * Reads a bounded Action-input path through the one shared path traversal.
 * Callers receive no coercion or alternate path grammar.
 */
export function readInputPath(input: unknown, path: string): unknown {
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
  let cursor: unknown = input;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
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
