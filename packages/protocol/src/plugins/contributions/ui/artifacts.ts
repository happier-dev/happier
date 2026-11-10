import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { isPortableRelativePath } from '../../../filesystem/portablePathSegment.js';
import { PluginUiArtifactDigestV1Schema } from '../../ui/artifactIntegrity.js';

export const PluginUiArtifactRelativePathV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.refine(isPortableRelativePath, { message: 'artifact file paths must use portable relative path segments' })));

export const PluginUiArtifactFileV1Schema = lazyZodSchema(() => z.strictObject({
  relativePath: PluginUiArtifactRelativePathV1Schema,
  digest: PluginUiArtifactDigestV1Schema,
  byteSize: z.number().check(z.int(), z.positive()),
}));
export type PluginUiArtifactFileV1 = z.infer<typeof PluginUiArtifactFileV1Schema>;
