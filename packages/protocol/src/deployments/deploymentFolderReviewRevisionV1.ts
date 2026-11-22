import { z } from '../zodRuntimePolicy.js';
import { WorkspaceManifestFingerprintSchema, WorkspaceManifestRelativePathSchema } from '../workspaces/manifestSchema.js';

/** The folder bytes identified in Deploy review and bound to Confirm. */
export const DeploymentFolderReviewRevisionV1Schema = z.strictObject({
    kind: z.literal('folder'),
    manifestFingerprint: WorkspaceManifestFingerprintSchema,
    fileCount: z.number().check(z.int(), z.nonnegative()),
    totalBytes: z.number().check(z.int(), z.nonnegative()),
    excludedPaths: z.array(WorkspaceManifestRelativePathSchema),
});
