import { z } from 'zod/mini';

const opaqueIdSchema = z.lazy(() => z.string().check(z.minLength(1), z.maxLength(512), z.refine((value) => value.trim().length > 0, 'Identifier must not be blank')));
const labelSchema = z.lazy(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(16 * 1024)));

const cursorModelChoiceSchema = z.lazy(() => z.object({
  value: opaqueIdSchema,
  name: labelSchema,
  description: z.optional(z.string().check(z.maxLength(16 * 1024))),
}));

export const cursorAvailableModelConfigOptionSchema = z.lazy(() => z.object({
  id: opaqueIdSchema,
  name: labelSchema,
  description: z.optional(z.string().check(z.maxLength(16 * 1024))),
  category: z.optional(opaqueIdSchema),
  type: z.literal('select'),
  currentValue: opaqueIdSchema,
  options: z.array(cursorModelChoiceSchema).check(z.maxLength(256)),
}));

export const cursorAvailableModelSchema = z.lazy(() => z.object({
  value: opaqueIdSchema,
  name: labelSchema,
  configOptions: z.optional(z.array(cursorAvailableModelConfigOptionSchema).check(z.maxLength(128))),
}));

export const cursorListAvailableModelsResponseSchema = z.lazy(() => z.object({
  models: z.array(cursorAvailableModelSchema).check(z.maxLength(512)),
}));

export type CursorAvailableModel = z.infer<typeof cursorAvailableModelSchema>;
export type CursorAvailableModelConfigOption = z.infer<typeof cursorAvailableModelConfigOptionSchema>;
