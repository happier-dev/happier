import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/** Current authoring has one placement; legacy placements remain stored data. */
export const PromptPlacementV1Schema = lazyZodSchema(() => z.enum(['system_append']));
export type PromptPlacementV1 = z.infer<typeof PromptPlacementV1Schema>;

// 0.2 promptLibrary/promptPlacementV1.ts at cd2bb4d853; retained full-row
// edits preserve these values until their stored-data support window ends.
export const PromptPlacementV1StoredSchema = lazyZodSchema(() => z.enum([
  'system_append',
  'composer_insert',
  'skill_instructions',
  'provider_asset',
]));

export type PromptPlacementV1Stored = z.infer<typeof PromptPlacementV1StoredSchema>;

/** Generic bundles and documents retain the predecessor's prompt preparation placements. */
export function isPromptStackSystemAppendPlacementV1(placement: PromptPlacementV1Stored): boolean {
  return placement === 'system_append' || placement === 'skill_instructions';
}
