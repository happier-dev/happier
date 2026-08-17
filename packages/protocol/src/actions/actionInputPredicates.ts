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

function isBoundedActionInputPath(value: string): boolean {
  if (value.length === 0 || value.length > 256 || utf8ByteLength(value) > 256) return false;
  if (value !== value.trim()) return false;
  const segments = value.split('.');
  return segments.length >= 1
    && segments.length <= 16
    && segments.every((segment) => segment.length > 0 && !hasUnicodeWhitespaceAtSegmentBoundary(segment));
}

/** Shared field/predicate grammar at Action descriptor admission. */
export const ActionInputPathSchema = z.string().superRefine((value, context) => {
  if (isBoundedActionInputPath(value)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Action input paths must contain 1–16 non-empty dot-separated segments and be at most 256 UTF-8 bytes.',
  });
});
export type ActionInputPath = z.infer<typeof ActionInputPathSchema>;

export const ActionInputPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type ActionInputPrimitive = z.infer<typeof ActionInputPrimitiveSchema>;

export type ActionInputPredicate =
  | Readonly<{
      op: 'truthy';
      path: ActionInputPath;
    }>
  | Readonly<{
      op: 'eq';
      path: ActionInputPath;
      value: ActionInputPrimitive;
    }>
  | Readonly<{
      op: 'includes';
      path: ActionInputPath;
      value: string;
    }>
  | Readonly<{
      op: 'not';
      predicate: ActionInputPredicate;
    }>
  | Readonly<{
      op: 'and';
      all: readonly ActionInputPredicate[];
    }>
  | Readonly<{
      op: 'or';
      any: readonly ActionInputPredicate[];
    }>;

export const ActionInputPredicateSchema: z.ZodType<ActionInputPredicate> = z.lazy(() =>
  z.union([
    z
      .object({
        op: z.literal('truthy'),
        path: ActionInputPathSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal('eq'),
        path: ActionInputPathSchema,
        value: ActionInputPrimitiveSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal('includes'),
        path: ActionInputPathSchema,
        value: z.string().min(1),
      })
      .strict(),
    z
      .object({
        op: z.literal('not'),
        predicate: ActionInputPredicateSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal('and'),
        all: z.array(ActionInputPredicateSchema).min(1),
      })
      .strict(),
    z
      .object({
        op: z.literal('or'),
        any: z.array(ActionInputPredicateSchema).min(1),
      })
      .strict(),
  ]),
);

/**
 * Reads a bounded Action-input path through the one shared path traversal.
 * Callers receive no coercion or alternate path grammar.
 */
export function readActionInputPath(input: unknown, path: string): unknown {
  const obj = input && typeof input === 'object' ? (input as any) : null;
  if (!obj) return undefined;
  const parts = String(path ?? '')
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

export function evaluateActionInputPredicate(predicate: ActionInputPredicate, input: unknown): boolean {
  if (!predicate || typeof predicate !== 'object') return false;
  const op = (predicate as any).op;

  if (op === 'truthy') {
    const v = readActionInputPath(input, String((predicate as any).path ?? ''));
    return Boolean(v);
  }

  if (op === 'eq') {
    const v = readActionInputPath(input, String((predicate as any).path ?? ''));
    return v === (predicate as any).value;
  }

  if (op === 'includes') {
    const v = readActionInputPath(input, String((predicate as any).path ?? ''));
    if (Array.isArray(v)) {
      const expected = String((predicate as any).value ?? '').trim();
      return v.some((entry) => typeof entry === 'string' && entry.trim() === expected);
    }
    if (typeof v === 'string') return v.includes(String((predicate as any).value ?? ''));
    return false;
  }

  if (op === 'not') {
    return !evaluateActionInputPredicate((predicate as any).predicate, input);
  }

  if (op === 'and') {
    const all: unknown[] = Array.isArray((predicate as any).all) ? (predicate as any).all : [];
    return all.every((p) => evaluateActionInputPredicate(p as any, input));
  }

  if (op === 'or') {
    const any: unknown[] = Array.isArray((predicate as any).any) ? (predicate as any).any : [];
    return any.some((p) => evaluateActionInputPredicate(p as any, input));
  }

  return false;
}
