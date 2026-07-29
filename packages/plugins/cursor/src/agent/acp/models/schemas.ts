import { z } from 'zod';

const opaqueIdSchema = z.string().min(1).max(512)
  .refine((value) => value.trim().length > 0, 'Identifier must not be blank');
const labelSchema = z.string().trim().min(1).max(16 * 1024);

const cursorModelChoiceSchema = z.object({
  value: opaqueIdSchema,
  name: labelSchema,
  description: z.string().max(16 * 1024).optional(),
}).strip();

export const cursorAvailableModelConfigOptionSchema = z.object({
  id: opaqueIdSchema,
  name: labelSchema,
  description: z.string().max(16 * 1024).optional(),
  category: opaqueIdSchema.optional(),
  type: z.literal('select'),
  currentValue: opaqueIdSchema,
  options: z.array(cursorModelChoiceSchema).max(256),
}).strip();

export const cursorAvailableModelSchema = z.object({
  value: opaqueIdSchema,
  name: labelSchema,
  configOptions: z.array(cursorAvailableModelConfigOptionSchema).max(128).optional(),
}).strip();

export const cursorListAvailableModelsResponseSchema = z.object({
  models: z.array(cursorAvailableModelSchema).max(512),
}).strip();

export type CursorAvailableModel = z.infer<typeof cursorAvailableModelSchema>;
export type CursorAvailableModelConfigOption = z.infer<typeof cursorAvailableModelConfigOptionSchema>;
