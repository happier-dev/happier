import { z } from 'zod';

import type { RuntimeActionIdV1 } from '../actionIds.js';

export type RuntimeActionSpecTextMap = Readonly<Partial<Record<RuntimeActionIdV1, string>>>;

export type RuntimeActionSpecFamily = Readonly<{
  titles: RuntimeActionSpecTextMap;
  descriptions?: RuntimeActionSpecTextMap;
  inputSchemaForAction: (actionId: RuntimeActionIdV1) => z.ZodTypeAny | null;
  outputSchemaForAction: (actionId: RuntimeActionIdV1) => z.ZodTypeAny | null;
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
