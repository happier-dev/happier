import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export { PromptAssetScopeV1Schema, PromptAssetInstallModeV1Schema,
  type PromptAssetScopeV1, type PromptAssetInstallModeV1 } from './promptAssetDescriptorsV1.js';

/** Native install receipts retain predecessor external references losslessly. */
export const PromptAssetExternalRefV1Schema = lazyZodSchema(() => z.record(z.string(), z.unknown()));
export type PromptAssetExternalRefV1 = z.infer<typeof PromptAssetExternalRefV1Schema>;
