import { z } from '../zodRuntimePolicy.js';
import { WorkspaceManifestFingerprintSchema, WorkspaceManifestRelativePathSchema } from '../workspaces/manifestSchema.js';

/** The folder bytes identified in Deploy review and bound to Confirm. */
export const DeploymentFolderReviewRevisionV1Schema = z.strictObject({
    kind: z.literal('folder'),
    manifestFingerprint: WorkspaceManifestFingerprintSchema,
    fileCount: z.number().check(z.int(), z.nonnegative()),
    totalBytes: z.number().check(z.int(), z.nonnegative()),
    excludedPaths: z.array(WorkspaceManifestRelativePathSchema),
    unsupportedFilePaths: z.optional(z.array(WorkspaceManifestRelativePathSchema)),
    exclusionReasons: z.optional(z.array(z.strictObject({ path: WorkspaceManifestRelativePathSchema,
        reason: z.enum(['gitIgnore', 'repositoryMetadata', 'env', 'symlink']) }))),
});
export type DeploymentFolderReviewRevisionV1 = z.infer<typeof DeploymentFolderReviewRevisionV1Schema>;

export function projectDeploymentFolderReviewRevisionV1(source: DeploymentFolderReviewRevisionV1): DeploymentFolderReviewRevisionV1 {
    const { kind, manifestFingerprint, fileCount, totalBytes, excludedPaths, unsupportedFilePaths, exclusionReasons } = source;
    return { kind, manifestFingerprint, fileCount, totalBytes, excludedPaths,
        ...(unsupportedFilePaths === undefined ? {} : { unsupportedFilePaths }),
        ...(exclusionReasons === undefined ? {} : { exclusionReasons }) };
}
