import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const PromptPlacementV1Schema = lazyZodSchema(() => z.enum([
  'system_append',
  'composer_insert',
  'skill_instructions',
  'provider_asset',
]));

export type PromptPlacementV1 = z.infer<typeof PromptPlacementV1Schema>;
