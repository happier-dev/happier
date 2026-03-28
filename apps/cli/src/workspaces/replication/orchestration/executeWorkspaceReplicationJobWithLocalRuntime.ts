import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import type { ScmBackendRegistry } from '@/scm/registry';
import type {
    ScmSourceControllerWorkspaceTransferConflictPolicy,
    ScmSourceControllerWorkspaceTransferStrategy,
} from '@/scm/sourceController/workspaceTransfer';
import { inferWorkspaceManifestSafeFilterPolicyFromEntries } from '@/scm/sourceController/workspaceExportPackaging/workspaceManifestSafeFilterPolicy';
import type { WorkspaceManifest } from '@happier-dev/protocol';

import { createWorkspaceReplicationBaselineStore } from '../baseline/workspaceReplicationBaselineStore';
import type { WorkspaceReplicationJobStore } from '../jobs/workspaceReplicationJobStore';
import type { WorkspaceReplicationRelationshipStore } from '../relationships/workspaceReplicationRelationshipStore';
import type { WorkspaceReplicationDirectionScope } from '../relationships/relationshipScope';
import type { WorkspaceReplicationSourceOffer } from '../transport/createWorkspaceReplicationSourceOffer';
import { buildWorkspaceReplicationBlobPacks } from '../transport/buildWorkspaceReplicationBlobPacks';
import { receiveWorkspaceReplicationBlobPack } from '../transport/receiveWorkspaceReplicationBlobPack';
import { applyWorkspaceReplicationPlan } from '../apply/applyWorkspaceReplicationPlan';
import { buildOneWaySafeReplicationPlan } from '../planning/buildOneWaySafeReplicationPlan';
import { assertWorkspaceReplicationJobNotCancelled } from '../safety/assertWorkspaceReplicationJobNotCancelled';
import { scanWorkspaceManifestIntoCas } from '../scan/scanWorkspaceManifestIntoCas';
import { runWorkspaceReplicationJob } from '../jobs/runWorkspaceReplicationJob';

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

type ReadonlyWorkspaceManifest = Readonly<{
    entries: readonly WorkspaceManifest['entries'][number][];
    fingerprint?: WorkspaceManifest['fingerprint'];
}>;

function toMutableWorkspaceManifest(manifest: ReadonlyWorkspaceManifest): WorkspaceManifest {
    return {
        entries: manifest.entries.map((entry) => ({ ...entry })),
        ...(manifest.fingerprint ? { fingerprint: manifest.fingerprint } : {}),
    };
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

  // One-way-safe requires a *post-transfer* safety check to prevent overwriting mid-transfer edits.
  // Keep separate caches so a pre-transfer scan can't be (incorrectly) reused after blob transfer.
  let cachedScannedTargetManifestBeforeTransfer:
    | Awaited<ReturnType<typeof scanWorkspaceManifestIntoCas>>
    | null = null;
  let cachedScannedTargetManifestAfterTransfer:
    | Awaited<ReturnType<typeof scanWorkspaceManifestIntoCas>>
    | null = null;

  async function scanTargetManifestIntoCas(offer: WorkspaceReplicationSourceOffer) {
    return await scanWorkspaceManifestIntoCas({
      activeServerDir: params.activeServerDir,
      relationshipId: offer.relationshipId,
      workspaceRoot: params.apply.targetPath,
      safeFilterPolicy: inferWorkspaceManifestSafeFilterPolicyFromEntries(
        offer.manifest.entries,
        params.apply.registry,
      ),
      scmRegistry: params.apply.registry,
    });
  }

  function isAfterTransferCheckpoint(checkpoint: string): boolean {
    return checkpoint === 'blob_transfer_completed'
      || checkpoint === 'apply_started'
      || checkpoint === 'apply_completed'
      || checkpoint === 'baseline_committed';
  }

  async function getScannedTargetManifest(paramsForScan: Readonly<{
    jobCheckpoint: string;
    offer: WorkspaceReplicationSourceOffer;
  }>) {
    const isAfterTransfer = isAfterTransferCheckpoint(paramsForScan.jobCheckpoint);
    if (isAfterTransfer) {
      if (cachedScannedTargetManifestAfterTransfer) {
        return cachedScannedTargetManifestAfterTransfer;
      }
      cachedScannedTargetManifestAfterTransfer = await scanTargetManifestIntoCas(paramsForScan.offer);
      return cachedScannedTargetManifestAfterTransfer;
    }

    if (cachedScannedTargetManifestBeforeTransfer) {
      return cachedScannedTargetManifestBeforeTransfer;
    }
    cachedScannedTargetManifestBeforeTransfer = await scanTargetManifestIntoCas(paramsForScan.offer);
    return cachedScannedTargetManifestBeforeTransfer;
  }

  return await executeWorkspaceReplicationJob({
    activeServerDir: params.activeServerDir,
    jobStore: params.jobStore,
    relationships: params.relationships,
    jobId: params.jobId,
    now: params.now,
    resolveSourceOfferById: params.resolveSourceOfferById,
    assertSafeToApply: async ({ job, offer }) => {
      if (params.relationshipScope.mode !== 'one_way_safe') {
        return null;
      }
      if (params.apply.strategy !== 'sync_changes') {
        return null;
      }

      const baseline = await baselineStore.load(params.relationshipScope);
      if (!baseline) {
        // `sync_changes` requires a baseline. The first successful run must be a snapshot transfer
        // (or another baseline-establishing action) so subsequent runs can safely diff.
        const nowMs = params.now?.() ?? Date.now();
        return await runWorkspaceReplicationJob({
          jobStore: params.jobStore,
          jobId: params.jobId,
          now: params.now,
          run: async (record) => ({
            ...record,
            awaitingRecoveryAtMs: record.awaitingRecoveryAtMs ?? nowMs,
            lastErrorMessage: record.lastErrorMessage ?? 'Workspace replication baseline missing; run transfer_snapshot first',
            status: {
              ...record.status,
              status: 'awaiting_recovery',
              phase: 'planning',
              checkpoint: 'relationship_resolved',
              blockingDivergenceCandidates: [],
            },
          }),
        });
      }

      const targetManifest = toMutableWorkspaceManifest(await getScannedTargetManifest({
        jobCheckpoint: job.status.checkpoint,
        offer,
      }));
      const safePlan = buildOneWaySafeReplicationPlan({
        baseline,
        sourceManifest: toMutableWorkspaceManifest(offer.manifest),
        targetManifest,
      });
      if (!safePlan.hasTargetDivergence) {
        return null;
      }
      if (safePlan.canApplySafely) {
        // Divergence exists, but not on any path the source would overwrite.
        return null;
      }

      const candidates = safePlan.blockingTargetDivergencePaths;
      const count = candidates.length;
      return {
        blockingDivergenceCandidates: candidates,
        lastErrorMessage: `Target workspace diverged since last baseline (${count} paths)`,
      };
    },
    transferMissingBlobsToTargetCas: async ({ job, offer, missingDigests }) => {
      const missingDigestsSet = new Set(missingDigests);
      const blobsForPacking = offer.blobIndex.filter((blob) => missingDigestsSet.has(blob.digest));
      const packs = buildWorkspaceReplicationBlobPacks({
        blobs: blobsForPacking,
        blobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
        blobPackMaxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
        blobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
      });
      const packsToRequest = packs;

            let transferredFiles = 0;
            let transferredBytes = 0;

            for (const pack of packsToRequest) {
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
                    // If cancellation is requested while the blob pack is downloading, do not continue
                    // with CAS mutations (receive/commit) after the download completes.
                    await assertWorkspaceReplicationJobNotCancelled({
                        jobStore: params.jobStore,
                        jobId: job.jobId,
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

                    // Persist incremental progress so large transfers remain observable and liveness
                    // detection can rely on real counter movement (not only checkpoint edges).
                    await runWorkspaceReplicationJob({
                        jobStore: params.jobStore,
                        jobId: job.jobId,
                        now: params.now,
                        run: async (record) => ({
                            ...record,
                            status: {
                                ...record.status,
                                progressCounters: {
                                    ...record.status.progressCounters,
                                    transferredFiles,
                                    transferredBytes,
                                },
                            },
                        }),
                    });
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

            let currentTargetManifest: { entries: typeof offer.manifest.entries; fingerprint?: string } | undefined;
            if (params.apply.strategy === 'sync_changes') {
                const scanned = await getScannedTargetManifest({
                    jobCheckpoint: job.status.checkpoint,
                    offer,
                });
                currentTargetManifest = {
                    entries: scanned.entries.map((entry) => ({ ...entry })),
                };
            }
            const applied = await applyWorkspaceReplicationPlan({
                activeServerDir: params.activeServerDir,
                sourceOffer: offer,
                targetPath: params.apply.targetPath,
                strategy: params.apply.strategy,
                conflictPolicy: params.apply.conflictPolicy,
                ...(currentTargetManifest ? { currentTargetManifest } : {}),
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
