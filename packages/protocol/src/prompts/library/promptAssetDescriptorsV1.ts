import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const PromptAssetScopeV1Schema = lazyZodSchema(() => z.enum(['user', 'project']));
export type PromptAssetScopeV1 = z.infer<typeof PromptAssetScopeV1Schema>;

export const PromptAssetInstallModeV1Schema = lazyZodSchema(() => z.enum(['copy', 'symlink']));
export type PromptAssetInstallModeV1 = z.infer<typeof PromptAssetInstallModeV1Schema>;

