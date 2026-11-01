import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const PromptPlacementV1Schema = lazySchema(() => z.enum([
  'system_append',
  'composer_insert',
  'skill_instructions',
  'provider_asset',
]));

export type PromptPlacementV1 = z.infer<typeof PromptPlacementV1Schema>;
