import { z } from 'zod';
import { lazySchema } from '@happier-dev/protocol';

const identifier = lazySchema(() => z.string().min(1).max(512).refine((candidate) => candidate.trim().length > 0, {
  message: 'Identifier must not be blank',
}));
const label = lazySchema(() => z.string().trim().min(1).max(16_384));
const value = identifier;

const selectChoice = lazySchema(() => z.object({
  value,
  name: label,
  description: z.string().max(16_384).optional(),
}).strip());

export const cursorAvailableModelConfigOptionSchema = lazySchema(() => z.object({
  id: identifier,
  name: label,
  description: z.string().max(16_384).optional(),
  category: identifier.optional(),
  type: z.literal('select'),
  currentValue: value,
  options: z.array(selectChoice).max(256),
}).strip());

export const cursorAvailableModelSchema = lazySchema(() => z.object({
  value: identifier,
  name: label,
  configOptions: z.array(cursorAvailableModelConfigOptionSchema).max(128).optional(),
}).strip());

export const cursorListAvailableModelsResponseSchema = lazySchema(() => z.object({
  models: z.array(cursorAvailableModelSchema).max(512),
}).strip());

export type CursorAvailableModel = z.infer<typeof cursorAvailableModelSchema>;
