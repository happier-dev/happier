import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

import { isPortableRelativePath } from '../../../filesystem/portablePathSegment.js';
import { PluginUiArtifactDigestV1Schema } from '../../ui/artifactIntegrity.js';

export const PluginUiArtifactRelativePathV1Schema = lazyZodSchema(() => z.string().min(1).refine(
  isPortableRelativePath,
  { message: 'artifact file paths must use portable relative path segments' },
));

export const PluginUiArtifactFileV1Schema = lazyZodSchema(() => z.object({
  relativePath: PluginUiArtifactRelativePathV1Schema,
  digest: PluginUiArtifactDigestV1Schema,
  byteSize: z.number().int().positive(),
}).strict());
export type PluginUiArtifactFileV1 = z.infer<typeof PluginUiArtifactFileV1Schema>;
