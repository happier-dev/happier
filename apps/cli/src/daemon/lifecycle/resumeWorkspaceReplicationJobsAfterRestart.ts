import type { MachineTransferChannel } from '@/machines/transfer/serverRoutedTransport';
import { normalizeWorkspacePath } from '@/scm/sourceController/workspaceExportPackaging/normalizeWorkspacePath';
import { buildSessionHandoffWorkspaceBlobPackTransferId } from '@/session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationServerRouted';
import { createWorkspaceReplicationJobStore } from '@/workspaces/replication/jobs/workspaceReplicationJobStore';
import type { WorkspaceReplicationJobRecord } from '@/workspaces/replication/jobs/workspaceReplicationJobStore';
import {
    buildWorkspaceReplicationDirectionId,
    createWorkspaceReplicationRelationshipStore,
} from '@/workspaces/replication/relationships/workspaceReplicationRelationshipStore';
import type { WorkspaceReplicationDirectionScope } from '@/workspaces/replication/relationships/relationshipScope';
import { listWorkspaceReplicationJobs } from '@/workspaces/replication/engine/listWorkspaceReplicationJobs';
import { createWorkspaceReplicationSourceOfferStore } from '@/workspaces/replication/transport/workspaceReplicationSourceOfferStore';
import { createWorkspaceReplicationTransfers } from '@/workspaces/replication/transport/workspaceReplicationTransfers';
import type { WorkspaceReplicationTransfers } from '@/workspaces/replication/transport/workspaceReplicationTransfers';
import { executeWorkspaceReplicationJobWithLocalRuntime } from '@/workspaces/replication/orchestration/executeWorkspaceReplicationJobWithLocalRuntime';
import { recoverWorkspaceReplicationJobsAfterRestart } from '@/workspaces/replication/state/workspaceReplicationGc';

const SESSION_HANDOFF_WORKSPACE_PREPARE_TARGET_CORRELATION_PREFIX = 'session_handoff_workspace_prepare_target:';

function normalizeWorkspaceRootForComparison(value: string): string {
    const normalized = normalizeWorkspacePath(value);
    if (normalized === '/' || normalized === '') {
        return normalized;
    }
    return normalized.replace(/\/+$/u, '');
}

function resolveSessionHandoffIdFromCorrelationId(correlationId: string | undefined): string | null {
    if (typeof correlationId !== 'string') return null;
    if (!correlationId.startsWith(SESSION_HANDOFF_WORKSPACE_PREPARE_TARGET_CORRELATION_PREFIX)) return null;
    const handoffId = correlationId.slice(SESSION_HANDOFF_WORKSPACE_PREPARE_TARGET_CORRELATION_PREFIX.length).trim();
    return handoffId.length > 0 ? handoffId : null;
}

function isRunnableJobStatus(status: WorkspaceReplicationJobRecord['status']['status']): boolean {
    return status === 'pending' || status === 'in_progress';
}

async function resolveDirectionScopeForJob(params: Readonly<{
    record: WorkspaceReplicationJobRecord;
    localMachineId: string;
    normalizedApplyTargetPath: string;
    relationships: ReturnType<typeof createWorkspaceReplicationRelationshipStore>;
}>): Promise<WorkspaceReplicationDirectionScope | null> {
    const record = params.record;
    const relationshipId = record.relationshipId;
    const directionId = record.directionId;
    if (!relationshipId || !directionId) return null;

    const relationship = await params.relationships.readById(relationshipId);
    if (!relationship) return null;

    const mode = record.mode ?? relationship.config.mode;
    const ignorePatterns = relationship.config.ignorePatterns;
    const endpoints = relationship.endpoints;

    const candidates: readonly [typeof endpoints[number], typeof endpoints[number]][] = [
        [endpoints[0], endpoints[1]],
        [endpoints[1], endpoints[0]],
    ];

    for (const [source, target] of candidates) {
        if (target.machineId !== params.localMachineId) {
            continue;
        }
        if (normalizeWorkspaceRootForComparison(target.rootPath) !== params.normalizedApplyTargetPath) {
            continue;
        }
        const scope: WorkspaceReplicationDirectionScope = {
            sourceMachineId: source.machineId,
            sourceWorkspaceRoot: source.rootPath,
            targetMachineId: target.machineId,
            targetWorkspaceRoot: target.rootPath,
            mode,
            ...(ignorePatterns ? { ignorePatterns } : {}),
        };
        if (buildWorkspaceReplicationDirectionId(scope) === directionId) {
            return scope;
        }
    }

    return null;
}

export async function resumeWorkspaceReplicationJobsAfterRestart(_params: Readonly<{
    activeServerDir: string;
    localMachineId: string;
    machineTransferChannel: MachineTransferChannel;
    transfers?: WorkspaceReplicationTransfers;
}>): Promise<void> {
    const nowMs = Date.now();

    await recoverWorkspaceReplicationJobsAfterRestart({
        activeServerDir: _params.activeServerDir,
        nowMs,
    }).catch(() => undefined);

    const jobStore = createWorkspaceReplicationJobStore({
        activeServerDir: _params.activeServerDir,
    });
    const relationships = createWorkspaceReplicationRelationshipStore({
        activeServerDir: _params.activeServerDir,
    });
    const sourceOfferStore = createWorkspaceReplicationSourceOfferStore({
        activeServerDir: _params.activeServerDir,
    });
    const transfers = _params.transfers ?? createWorkspaceReplicationTransfers();

    const jobs = await listWorkspaceReplicationJobs({
        activeServerDir: _params.activeServerDir,
    });

    for (const record of jobs) {
        if (!isRunnableJobStatus(record.status.status)) {
            continue;
        }
        const apply = record.resumeContext?.apply;
        if (!apply) {
            continue;
        }
        const offerId = record.offerId;
        if (!offerId) {
            continue;
        }
        const handoffId = resolveSessionHandoffIdFromCorrelationId(record.correlationId);
        if (!handoffId) {
            continue;
        }

        const normalizedApplyTargetPath = normalizeWorkspaceRootForComparison(apply.targetPath);
        const scope = await resolveDirectionScopeForJob({
            record,
            localMachineId: _params.localMachineId,
            normalizedApplyTargetPath,
            relationships,
        });
        if (!scope) {
            continue;
        }

        await executeWorkspaceReplicationJobWithLocalRuntime({
            activeServerDir: _params.activeServerDir,
            jobStore,
            relationships,
            jobId: record.jobId,
            relationshipScope: scope,
            resolveSourceOfferById: async (offerId) => {
                const offer = await sourceOfferStore.read(offerId);
                if (!offer) {
                    throw new Error(`Workspace replication source offer not found: ${offerId}`);
                }
                return offer;
            },
            requestBlobPackToFile: async ({ packId, digests, destinationPath }) => {
                await transfers.requestServerRoutedBlobPackToFile({
                    transferId: buildSessionHandoffWorkspaceBlobPackTransferId({
                        handoffId,
                        packId,
                    }),
                    sourceMachineId: scope.sourceMachineId,
                    machineTransferChannel: _params.machineTransferChannel,
                    destinationPath,
                    openBody: {
                        t: 'workspace_replication_blob_pack_v1',
                        packId,
                        digests: [...digests],
                    },
                });
            },
            apply: {
                targetPath: apply.targetPath,
                strategy: apply.strategy,
                conflictPolicy: apply.conflictPolicy,
            },
        }).catch(() => undefined);
    }
}
