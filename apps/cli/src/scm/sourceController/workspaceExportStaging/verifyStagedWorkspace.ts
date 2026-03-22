import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import { compareWorkspaceManifests, type WorkspaceManifestComparison } from '../workspaceExportPackaging/compareWorkspaceManifests';
import { hashWorkspaceFile } from '../workspaceExportPackaging/hashWorkspaceFile';
import { scanWorkspaceManifest } from '../workspaceExportPackaging/scanWorkspaceManifest';
import { inferWorkspaceManifestSafeFilterPolicyFromEntries } from '../workspaceExportPackaging/workspaceManifestSafeFilterPolicy';

const workspaceManifestDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export type StagedWorkspaceBlobFailure =
    | Readonly<{
        digest: string;
        reason: 'missing';
      }>
    | Readonly<{
        digest: string;
        reason: 'digest_mismatch';
        actualDigest: string;
      }>;

export type VerifyStagedWorkspaceResult = Readonly<{
    expectedManifest: WorkspaceManifest;
    actualManifest: WorkspaceManifest;
    manifestComparison: WorkspaceManifestComparison;
    blobFailures: readonly StagedWorkspaceBlobFailure[];
    isVerified: boolean;
}>;

export function resolveStagedWorkspaceBlobFilePath(params: Readonly<{
    blobsDirectory: string;
    digest: string;
}>): string {
    const [algorithm, hash] = workspaceManifestDigestSchema.parse(params.digest).split(':', 2);
    return join(params.blobsDirectory, algorithm, `${hash}.blob`);
}

async function verifyStagedBlobDigest(params: Readonly<{
    blobsDirectory: string;
    digest: string;
}>): Promise<StagedWorkspaceBlobFailure | null> {
    const filePath = resolveStagedWorkspaceBlobFilePath(params);

    try {
        await access(filePath);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return {
                digest: params.digest,
                reason: 'missing',
            };
        }
        throw error;
    }

    const actualDigest = await hashWorkspaceFile({ filePath });
    if (actualDigest === params.digest) {
        return null;
    }

    return {
        digest: params.digest,
        reason: 'digest_mismatch',
        actualDigest,
    };
}

export async function verifyStagedWorkspace(params: Readonly<{
    workspaceDirectory: string;
    blobsDirectory: string;
    expectedManifest: WorkspaceManifest;
    expectedBlobDigests: readonly string[];
}>): Promise<VerifyStagedWorkspaceResult> {
    const scannedManifest = await scanWorkspaceManifest({
        workspaceRoot: params.workspaceDirectory,
        safeFilterPolicy: inferWorkspaceManifestSafeFilterPolicyFromEntries(params.expectedManifest.entries),
    });
    const actualManifest: WorkspaceManifest = {
        entries: [...scannedManifest.entries],
    };
    const manifestComparison = compareWorkspaceManifests({
        previousManifest: params.expectedManifest,
        nextManifest: actualManifest,
    });
    const blobFailureCandidates = await Promise.all(
        [...new Set(params.expectedBlobDigests)].map(async (digest) => await verifyStagedBlobDigest({
            blobsDirectory: params.blobsDirectory,
            digest: workspaceManifestDigestSchema.parse(digest),
        })),
    );
    const blobFailures = blobFailureCandidates.filter((failure): failure is StagedWorkspaceBlobFailure => failure !== null);

    return {
        expectedManifest: params.expectedManifest,
        actualManifest,
        manifestComparison,
        blobFailures,
        isVerified: !manifestComparison.hasChanges && blobFailures.length === 0,
    };
}
