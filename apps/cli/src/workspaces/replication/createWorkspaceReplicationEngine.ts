import { createWorkspaceReplicationBaselineStore } from './baseline/workspaceReplicationBaselineStore';
import { createWorkspaceReplicationCasStore } from './cas/workspaceReplicationCasStore';
import { abortWorkspaceReplicationJob } from './jobs/abortWorkspaceReplicationJob';
import { createWorkspaceReplicationJobStore } from './jobs/workspaceReplicationJobStore';
import { createWorkspaceReplicationRelationshipStore } from './relationships/workspaceReplicationRelationshipStore';
import type { WorkspaceReplicationDirectionScope } from './relationships/relationshipScope';
import { buildWorkspaceReplicationDirectionId } from './relationships/workspaceReplicationRelationshipStore';
import { scanWorkspaceManifestIntoCas } from './scan/scanWorkspaceManifestIntoCas';
import { gcWorkspaceReplicationJobs } from './state/workspaceReplicationGc';
import { WorkspaceReplicationError } from './workspaceReplicationError';
import type { WorkspaceReplicationEngine } from './workspaceReplicationEngine';
import type {
    WorkspaceReplicationEngineDependencies,
    WorkspaceReplicationEngineInput,
    WorkspaceReplicationCreateSourceOfferInput,
    WorkspaceReplicationGcInput,
    WorkspaceReplicationListJobsInput,
    WorkspaceReplicationPlanResult,
    WorkspaceReplicationResolvedRelationship,
    WorkspaceReplicationStartJobFromOfferInput,
    WorkspaceReplicationStartJobFromOfferResult,
} from './workspaceReplicationTypes';
import { compareWorkspaceManifests } from './planning/compareWorkspaceManifests';
import { buildOneWaySafeReplicationPlan } from './planning/buildOneWaySafeReplicationPlan';
import { objectKey } from '@/utils/deterministicJson';
import { createWorkspaceReplicationSourceOffer } from './transport/createWorkspaceReplicationSourceOffer';
import type { WorkspaceReplicationSourceOffer } from './transport/createWorkspaceReplicationSourceOffer';
import { listWorkspaceReplicationJobs } from './engine/listWorkspaceReplicationJobs';
import { executeWorkspaceReplicationJobWithLocalRuntime } from './orchestration/executeWorkspaceReplicationJobWithLocalRuntime';
import type { WorkspaceManifest } from '@happier-dev/protocol';
import type { WorkspaceReplicationJobRecord } from './jobs/workspaceReplicationJobStore';

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

export function createWorkspaceReplicationEngine(
    input: WorkspaceReplicationEngineInput,
    dependencies: WorkspaceReplicationEngineDependencies = {},
): WorkspaceReplicationEngine {
    const createCasStore = dependencies.createCasStore ?? createWorkspaceReplicationCasStore;
    const createRelationshipStore = dependencies.createRelationshipStore ?? createWorkspaceReplicationRelationshipStore;
    const createBaselineStore = dependencies.createBaselineStore ?? createWorkspaceReplicationBaselineStore;
    const createJobStore = dependencies.createJobStore ?? createWorkspaceReplicationJobStore;
    const createSourceOfferImpl = dependencies.createSourceOffer ?? createWorkspaceReplicationSourceOffer;
    const scanManifestIntoCasImpl = dependencies.scanManifestIntoCas ?? scanWorkspaceManifestIntoCas;
    const executeJobWithLocalRuntimeImpl =
        dependencies.executeJobWithLocalRuntime ?? executeWorkspaceReplicationJobWithLocalRuntime;
    const executeJobInBackground = dependencies.executeJobInBackground;

    try {
        const stores = {
            cas: createCasStore({ activeServerDir: input.activeServerDir }),
            relationships: createRelationshipStore({ activeServerDir: input.activeServerDir }),
            baselines: createBaselineStore({ activeServerDir: input.activeServerDir }),
            jobs: createJobStore({ activeServerDir: input.activeServerDir }),
        } as const;
        const now = input.now ?? (() => Date.now());

        async function resolveRelationship(scope: WorkspaceReplicationDirectionScope): Promise<WorkspaceReplicationResolvedRelationship> {
            const relationship = await stores.relationships.ensureRelationship(scope);
            const baseline = await stores.baselines.load(scope);
            return {
                relationshipId: relationship.relationshipId,
                directionId: buildWorkspaceReplicationDirectionId(scope),
                baseline,
            };
        }

        async function plan(params: Readonly<{
            scope: WorkspaceReplicationDirectionScope;
            sourceManifest: WorkspaceReplicationPlanResult['sourceManifest'];
            targetWorkspaceRoot: string;
        }>): Promise<WorkspaceReplicationPlanResult> {
            const relationship = await stores.relationships.ensureRelationship(params.scope);
            const baseline = await stores.baselines.load(params.scope);
            const scannedTargetManifest = await scanManifestIntoCasImpl({
                activeServerDir: input.activeServerDir,
                relationshipId: relationship.relationshipId,
                workspaceRoot: params.targetWorkspaceRoot,
                scmRegistry: input.scmRegistry,
            });
            const targetManifest = toMutableWorkspaceManifest(scannedTargetManifest);
            const sourceManifest = toMutableWorkspaceManifest(params.sourceManifest);

            const comparison = compareWorkspaceManifests({
                previousManifest: targetManifest,
                nextManifest: sourceManifest,
            });
            const plannedFileCount = comparison.added.length + comparison.changed.length + comparison.removed.length;
            const plannedByteCount = [
                ...comparison.added,
                ...comparison.changed.map((change) => change.next),
            ].reduce((total, entry) => total + (entry.kind === 'file' ? entry.sizeBytes : 0), 0);
            const removedFileCount = comparison.removed.length;
            const removedByteCount = comparison.removed.reduce(
                (total, entry) => total + (entry.kind === 'file' ? entry.sizeBytes : 0),
                0,
            );

            if (params.scope.mode === 'one_way_safe' && baseline) {
                const oneWaySafe = buildOneWaySafeReplicationPlan({
                    baseline,
                    sourceManifest,
                    targetManifest,
                });
                return {
                    scope: params.scope,
                    baseline,
                    sourceManifest,
                    targetManifest,
                    preflightSummary: {
                        plannedFileCount,
                        plannedByteCount,
                        removedFileCount,
                        removedByteCount,
                    },
                    targetDivergencePaths: oneWaySafe.targetDivergencePaths,
                    blockingTargetDivergencePaths: oneWaySafe.blockingTargetDivergencePaths,
                    canApplySafely: oneWaySafe.canApplySafely,
                };
            }

            return {
                scope: params.scope,
                baseline,
                sourceManifest,
                targetManifest,
                preflightSummary: {
                    plannedFileCount,
                    plannedByteCount,
                    removedFileCount,
                    removedByteCount,
                },
            };
        }

        async function createSourceOffer(
            inputOrScope: WorkspaceReplicationCreateSourceOfferInput | WorkspaceReplicationDirectionScope,
        ): Promise<WorkspaceReplicationSourceOffer> {
            const scope: WorkspaceReplicationDirectionScope = 'scope' in inputOrScope ? inputOrScope.scope : inputOrScope;
            const safeFilterPolicy = 'scope' in inputOrScope ? inputOrScope.safeFilterPolicy : undefined;

            return await createSourceOfferImpl({
                activeServerDir: input.activeServerDir,
                source: { machineId: scope.sourceMachineId, rootPath: scope.sourceWorkspaceRoot },
                target: { machineId: scope.targetMachineId, rootPath: scope.targetWorkspaceRoot },
                mode: scope.mode,
                ignorePatterns: scope.ignorePatterns,
                safeFilterPolicy,
                scmRegistry: input.scmRegistry,
            });
        }

        async function startJobFromOffer(params: WorkspaceReplicationStartJobFromOfferInput): Promise<WorkspaceReplicationStartJobFromOfferResult> {
            const relationship = await stores.relationships.ensureRelationship(params.scope);
            const nowMs = now();
            const jobId = `job_${objectKey({
                correlationId: params.correlationId ?? '',
                offerId: params.sourceOffer.offerId,
                nowMs,
            })}`;

            const initialStatus: WorkspaceReplicationJobRecord = {
                schemaVersion: 1,
                jobId,
                ...(params.correlationId ? { correlationId: params.correlationId } : {}),
                relationshipId: relationship.relationshipId,
                directionId: buildWorkspaceReplicationDirectionId(params.scope),
                offerId: params.sourceOffer.offerId,
                mode: params.scope.mode,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                status: {
                    status: 'pending',
                    phase: 'planning',
                    checkpoint: 'job_created',
                    progressCounters: {
                        plannedFiles: 0,
                        plannedBytes: 0,
                        transferredFiles: 0,
                        transferredBytes: 0,
                        appliedFiles: 0,
                        appliedBytes: 0,
                    },
                    warnings: [],
                    blockingDivergenceCandidates: [],
                },
            };

            await stores.jobs.write(initialStatus);

            const executionInput = {
                jobId,
                scope: params.scope,
                sourceOffer: params.sourceOffer,
                apply: params.apply,
                requestBlobPackToFile: params.requestBlobPackToFile,
            } as const;

            if (executeJobInBackground) {
                executeJobInBackground(executionInput);
            } else {
                queueMicrotask(() => {
                    void executeJobWithLocalRuntimeImpl({
                        activeServerDir: input.activeServerDir,
                        jobStore: stores.jobs,
                        relationships: stores.relationships,
                        jobId,
                        now,
                        relationshipScope: params.scope,
                        resolveSourceOfferById: async (offerId) => {
                            if (offerId !== params.sourceOffer.offerId) {
                                throw new Error(`Workspace replication source offer not found: ${offerId}`);
                            }
                            return params.sourceOffer;
                        },
                        requestBlobPackToFile: params.requestBlobPackToFile,
                        apply: params.apply,
                    }).catch(() => undefined);
                });
            }

            return {
                jobId,
                initialStatus,
            };
        }

        async function getJobStatus(jobId: string) {
            const record = await stores.jobs.read(jobId);
            if (!record) {
                throw new WorkspaceReplicationError({
                    code: 'job_not_found',
                    message: `Workspace replication job not found: ${jobId}`,
                });
            }
            return record;
        }

        async function listJobs(listInput: WorkspaceReplicationListJobsInput = {}) {
            return await listWorkspaceReplicationJobs({
                activeServerDir: input.activeServerDir,
                correlationId: listInput.correlationId,
                limit: listInput.limit,
            });
        }

        async function abortJob(jobId: string) {
            const aborted = await abortWorkspaceReplicationJob({
                jobStore: stores.jobs,
                jobId,
                now,
            });
            if (!aborted) {
                throw new WorkspaceReplicationError({
                    code: 'job_not_found',
                    message: `Workspace replication job not found: ${jobId}`,
                });
            }
            return aborted;
        }

        async function gc(gcInput: WorkspaceReplicationGcInput) {
            return await gcWorkspaceReplicationJobs({
                activeServerDir: input.activeServerDir,
                nowMs: gcInput.nowMs ?? now(),
                terminalTtlMs: gcInput.terminalTtlMs,
            });
        }

        return {
            activeServerDir: input.activeServerDir,
            localMachineId: input.localMachineId,
            resolveRelationship,
            plan,
            createSourceOffer,
            startJobFromOffer,
            getJobStatus,
            listJobs,
            abortJob,
            gc,
        };
    } catch (error) {
        throw new WorkspaceReplicationError({
            code: 'engine_initialization_failed',
            message: `Failed to create workspace replication engine for ${input.activeServerDir}`,
            cause: error,
        });
    }
}
