import { z } from 'zod';

export const HOOK_CATEGORY_V1_VALUES = ['integration', 'lifecycle', 'augmentation', 'decision'] as const;

export const HookCategoryV1Schema = z.enum(HOOK_CATEGORY_V1_VALUES);
export type HookCategoryV1 = z.infer<typeof HookCategoryV1Schema>;
