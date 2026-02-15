import { z } from 'zod';

export const ActionInputPathSchema = z.string().min(1);
export type ActionInputPath = z.infer<typeof ActionInputPathSchema>;

export const ActionInputPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type ActionInputPrimitive = z.infer<typeof ActionInputPrimitiveSchema>;

export const ActionInputPredicateSchema: z.ZodType<any> = z.lazy(() =>
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
export type ActionInputPredicate = z.infer<typeof ActionInputPredicateSchema>;

function getValueAtPath(input: unknown, path: string): unknown {
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
    const v = getValueAtPath(input, String((predicate as any).path ?? ''));
    return Boolean(v);
  }

  if (op === 'eq') {
    const v = getValueAtPath(input, String((predicate as any).path ?? ''));
    return v === (predicate as any).value;
  }

  if (op === 'includes') {
    const v = getValueAtPath(input, String((predicate as any).path ?? ''));
    if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).includes(String((predicate as any).value ?? '').trim());
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

