/**
 * Protocol-internal bridge for legacy Zod parents.
 *
 * The public composable remains a neutral five-member value. This bridge is
 * deliberately not exported from a package entry point: it delegates parsing
 * and normalization straight back to that public value while an incumbent
 * internal Zod parent is migrated.
 */
import { z } from 'zod';

import type {
  ProtocolSchemaSafeParseResult,
} from './jsonSchemaValidation.js';

/**
 * This private bridge receives the neutral parser surface structurally. The
 * typed parser signature is deliberately separate from the broad public
 * admission overload so Zod parents retain concrete input/output projections
 * without publishing a validator identity or leaking private aliases into
 * generated SDK declarations.
 */
type ProtocolComposableSchemaForZod<TInput, TOutput> = Readonly<{
  readonly jsonSchema: object;
  parse(value: TInput): TOutput;
  safeParse(value: unknown): ProtocolSchemaSafeParseResult<TOutput>;
  optional(): unknown;
  nullable(): unknown;
}>;

function addProtocolZodFailure<TOutput>(
  parsed: Exclude<ProtocolSchemaSafeParseResult<TOutput>, Readonly<{ success: true }>>,
  context: z.RefinementCtx,
): void {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: parsed.error.issues[0]?.message ?? 'Value does not match the canonical Protocol schema',
  });
}

export function asProtocolZod<TInput, TOutput>(
  schema: ProtocolComposableSchemaForZod<TInput, TOutput>,
): z.ZodType<TOutput, TInput> {
  const adapter = z.unknown().superRefine((value, context) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) addProtocolZodFailure(parsed, context);
  }).transform((value): TOutput => {
    // `superRefine` has admitted this value through the canonical owner. Read
    // the same normalized output once more rather than exposing a local Zod
    // projection to the parent schema.
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });

  // Zod cannot infer the portable schema hidden behind this neutral adapter.
  // Project the canonical Protocol-owned JSON Schema into exporters so public
  // authoring schemas retain the exact same admission constraints as runtime.
  adapter._zod.processJSONSchema = (_context, jsonSchema) => {
    Object.assign(jsonSchema, structuredClone(schema.jsonSchema));
  };

  return adapter as unknown as z.ZodType<TOutput, TInput>;
}
