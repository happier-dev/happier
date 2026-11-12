import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { readPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { PluginUiArtifactDigestV1Schema } from './artifactIntegrity.js';

/** The byte content returned by readResource and delivered by a Resource watch. */
export const PluginUiResourceContentV1Schema = lazyZodSchema(() => z.strictObject({
  contentType: z.string().check(z.refine(value => value.trim().length > 0)),
  digest: PluginUiArtifactDigestV1Schema,
  bytesBase64: z.string().check(z.refine(value => readPaddedBase64DecodedLength(value) !== null)),
}));
export type PluginUiResourceContentV1 = z.infer<typeof PluginUiResourceContentV1Schema>;
