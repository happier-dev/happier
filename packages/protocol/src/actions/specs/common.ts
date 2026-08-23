import { z } from 'zod';

import type { RuntimeActionIdV1 } from '../actionIds.js';

export type RuntimeActionSpecTextMap = Readonly<Partial<Record<RuntimeActionIdV1, string>>>;

export type RuntimeActionSchemaMap = Readonly<Partial<Record<RuntimeActionIdV1, z.ZodTypeAny>>>;

export type RuntimeActionSpecFamily = Readonly<{
  titles: RuntimeActionSpecTextMap;
  descriptions?: RuntimeActionSpecTextMap;
  /** Canonical per-id schema rows for public/runtime projections. */
  inputSchemas?: RuntimeActionSchemaMap;
  outputSchemas?: RuntimeActionSchemaMap;
}>;

export const PassthroughEmptyObjectSchema = z.object({}).passthrough();

export function refineKindSchema(
  schema: z.ZodTypeAny,
  field: string,
  expected: string,
  label: string,
): z.ZodTypeAny {
  return schema.refine((value) => (value as Record<string, unknown>)[field] === expected, {
    message: `${label} must be ${expected}.`,
    path: [field],
  });
}
