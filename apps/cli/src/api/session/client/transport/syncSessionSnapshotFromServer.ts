import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

import type { AgentState, Metadata } from '../../../types';
import type { KnownPendingQueueState } from '../../pendingQueueState';
import { fetchSessionSnapshotUpdateFromServer } from '../../snapshotSync';
import type { SessionSnapshotRefreshReason } from '../../sessionSnapshotRefreshReason';
import type { LatestTurnStatusSnapshot } from '../../sessionTurnStatusSnapshot';

export async function syncSessionSnapshotFromServer(
    params: Readonly<{
        token: string;
        sessionId: string;
        encryptionKey: Uint8Array;
        encryptionVariant: 'legacy' | 'dataKey';
        currentMetadataVersion: number;
        currentAgentStateVersion: number;
        currentMetadata: Metadata | null;
        currentAgentState: AgentState | null;
        sessionConnectionSupervisor: ManagedConnectionSupervisor | null;
        isClosed: () => boolean;
        setMetadataSnapshot: (metadata: Metadata, version: number) => void;
        setAgentStateSnapshot: (agentState: AgentState | null, version: number) => void;
        applyPendingQueueState: (state: KnownPendingQueueState) => void;
        applyLatestTurnStatus: (status: LatestTurnStatusSnapshot, observedAt?: number) => void;
        reason: SessionSnapshotRefreshReason;
    }>,
): Promise<boolean> {
    const request = () => fetchSessionSnapshotUpdateFromServer({
        token: params.token,
        sessionId: params.sessionId,
        encryptionKey: params.encryptionKey,
        encryptionVariant: params.encryptionVariant,
        currentMetadataVersion: params.currentMetadataVersion,
        currentAgentStateVersion: params.currentAgentStateVersion,
        currentMetadata: params.currentMetadata,
        currentAgentState: params.currentAgentState,
        reason: params.reason,
    });
    const update = params.sessionConnectionSupervisor
        ? await runSupervisedRequest({
            supervisor: params.sessionConnectionSupervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        })
        : await request();

    if (params.isClosed()) return false;

    if (update.metadata) {
        params.setMetadataSnapshot(update.metadata.metadata, update.metadata.metadataVersion);
    }

    if (update.agentState) {
        params.setAgentStateSnapshot(update.agentState.agentState, update.agentState.agentStateVersion);
    }

    if (update.pendingQueueState) {
        params.applyPendingQueueState(update.pendingQueueState);
    }

    const latestTurnStatus = update.latestTurnStatus;
    if (latestTurnStatus !== undefined) {
        params.applyLatestTurnStatus(latestTurnStatus, update.latestTurnStatusObservedAt);
    }

    return true;
}
