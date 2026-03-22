import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import type { ScmBackendRegistry } from '@/scm/registry';
import type {
    ScmSourceControllerWorkspaceTransferConflictPolicy,
    ScmSourceControllerWorkspaceTransferStrategy,
} from '@/scm/sourceController/workspaceTransfer';

import { createWorkspaceReplicationBaselineStore } from '../baseline/workspaceReplicationBaselineStore';
import type { WorkspaceReplicationJobStore } from '../jobs/workspaceReplicationJobStore';
import type { WorkspaceReplicationRelationshipStore } from '../relationships/workspaceReplicationRelationshipStore';
import type { WorkspaceReplicationDirectionScope } from '../relationships/relationshipScope';
import type { WorkspaceReplicationSourceOffer } from '../transport/createWorkspaceReplicationSourceOffer';
import { buildWorkspaceReplicationBlobPacks } from '../transport/buildWorkspaceReplicationBlobPacks';
import { receiveWorkspaceReplicationBlobPack } from '../transport/receiveWorkspaceReplicationBlobPack';
import { applyWorkspaceReplicationPlan } from '../apply/applyWorkspaceReplicationPlan';
import { assertWorkspaceReplicationJobNotCancelled } from '../safety/assertWorkspaceReplicationJobNotCancelled';

import { executeWorkspaceReplicationJob } from './executeWorkspaceReplicationJob';

function sumAppliedBytes(offer: WorkspaceReplicationSourceOffer): number {
    let total = 0;
    for (const entry of offer.manifest.entries) {
        if (entry.kind !== 'file') continue;
        total += entry.sizeBytes;
    }
    return total;
}

function countAppliedFiles(offer: WorkspaceReplicationSourceOffer): number {
    let total = 0;
    for (const entry of offer.manifest.entries) {
        if (entry.kind !== 'file') continue;
        total += 1;
    }
    return total;
}

export async function executeWorkspaceReplicationJobWithLocalRuntime(params: Readonly<{
    activeServerDir: string;
    jobStore: WorkspaceReplicationJobStore;
    relationships: WorkspaceReplicationRelationshipStore;
    jobId: string;
    now?: () => number;
    relationshipScope: WorkspaceReplicationDirectionScope;
    resolveSourceOfferById: (offerId: string) => Promise<WorkspaceReplicationSourceOffer>;
    requestBlobPackToFile: (input: Readonly<{
        packId: string;
        digests: readonly string[];
        destinationPath: string;
    }>) => Promise<void>;
    apply: Readonly<{
        targetPath: string;
        strategy: ScmSourceControllerWorkspaceTransferStrategy;
        conflictPolicy: ScmSourceControllerWorkspaceTransferConflictPolicy;
        registry?: ScmBackendRegistry;
    }>;
}>): Promise<Awaited<ReturnType<typeof executeWorkspaceReplicationJob>>> {
    const baselineStore = createWorkspaceReplicationBaselineStore({
        activeServerDir: params.activeServerDir,
    });

    return await executeWorkspaceReplicationJob({
        activeServerDir: params.activeServerDir,
        jobStore: params.jobStore,
        relationships: params.relationships,
        jobId: params.jobId,
        now: params.now,
        resolveSourceOfferById: params.resolveSourceOfferById,
        transferMissingBlobsToTargetCas: async ({ job, offer, missingDigests }) => {
            const missingDigestsSet = new Set(missingDigests);
            const missingBlobs = offer.blobIndex.filter((blob) => missingDigestsSet.has(blob.digest));
            const packs = buildWorkspaceReplicationBlobPacks({
                blobs: missingBlobs,
                blobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
                blobPackMaxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
                blobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
            });

            let transferredFiles = 0;
            let transferredBytes = 0;

            for (const pack of packs) {
                await assertWorkspaceReplicationJobNotCancelled({
                    jobStore: params.jobStore,
                    jobId: job.jobId,
                });
                const temporaryDirectory = await mkdtemp(join(tmpdir(), 'happier-workspace-replication-pack-'));
                const destinationPath = join(temporaryDirectory, `${pack.packId}.bin`);

                try {
                    await params.requestBlobPackToFile({
                        packId: pack.packId,
                        digests: pack.digests,
                        destinationPath,
                    });
                    const result = await receiveWorkspaceReplicationBlobPack({
                        activeServerDir: params.activeServerDir,
                        jobId: job.jobId,
                        packId: pack.packId,
                        packFilePath: destinationPath,
                        maxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
                    });
                    transferredFiles += result.transferredBlobs;
                    transferredBytes += result.transferredBytes;
                } finally {
                    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
                }
            }

            return {
                transferredFiles,
                transferredBytes,
            };
        },
        applyPlan: async ({ job, offer }) => {
            await assertWorkspaceReplicationJobNotCancelled({
                jobStore: params.jobStore,
                jobId: job.jobId,
            });
            const applied = await applyWorkspaceReplicationPlan({
                activeServerDir: params.activeServerDir,
                sourceOffer: offer,
                targetPath: params.apply.targetPath,
                strategy: params.apply.strategy,
                conflictPolicy: params.apply.conflictPolicy,
                registry: params.apply.registry,
                assertCanContinue: async () => {
                    await assertWorkspaceReplicationJobNotCancelled({
                        jobStore: params.jobStore,
                        jobId: job.jobId,
                    });
                },
            });

            // The underlying SCM layer does not currently report byte/file counters. Treat the offer
            // manifest as the source of truth for counters so progress is stable across backends.
            return {
                appliedFiles: countAppliedFiles(offer),
                appliedBytes: sumAppliedBytes(offer),
                targetPath: applied.targetPath,
            };
        },
        commitBaseline: async ({ job, offer }) => {
            await assertWorkspaceReplicationJobNotCancelled({
                jobStore: params.jobStore,
                jobId: job.jobId,
            });
            const nowMs = params.now?.() ?? Date.now();
            await baselineStore.save({
                scope: params.relationshipScope,
                baseline: {
                    manifestFingerprint: offer.sourceFingerprint,
                    manifest: offer.manifest,
                    savedAtMs: nowMs,
                },
            });
        },
    });
}
