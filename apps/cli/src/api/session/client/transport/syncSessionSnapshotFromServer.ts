import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

import type { AgentState, Metadata } from '../../../types';
import type { Credentials } from '@/persistence';
import type { SessionMetadataEnvelopeTupleSnapshot } from '@/session/metadata/updateSessionMetadataWithRetry';
import type { KnownPendingQueueState } from '../../pendingQueueState';
import { fetchSessionSnapshotUpdateFromServer } from '../../snapshotSync';
import type { SessionSnapshotRefreshReason } from '../../sessionSnapshotRefreshReason';
import type { LatestTurnStatusSnapshot } from '../../sessionTurnStatusSnapshot';

export async function syncSessionSnapshotFromServer(
    params: Readonly<{
        token: string;
        sessionId: string;
        credentials?: Credentials | null;
        encryptionKey: Uint8Array;
        encryptionVariant: 'legacy' | 'dataKey';
        currentMetadataLayoutVersion: number;
        currentMetadataVersion: number;
        currentAgentStateVersion: number;
        currentMetadata: Metadata | null;
        currentAgentState: AgentState | null;
        sessionConnectionSupervisor: ManagedConnectionSupervisor | null;
        isClosed: () => boolean;
        setMetadataSnapshot: (metadata: Metadata | null, version: number, layoutVersion: number) => void;
        setAgentStateSnapshot: (agentState: AgentState | null, version: number) => void;
        setMetadataEnvelopeTupleSnapshot: (
            snapshot: SessionMetadataEnvelopeTupleSnapshot,
        ) => void;
        applyPendingQueueState: (state: KnownPendingQueueState) => void;
        applyLatestTurnStatus: (status: LatestTurnStatusSnapshot, observedAt?: number) => void;
        reason: SessionSnapshotRefreshReason;
    }>,
): Promise<boolean> {
    const request = () => fetchSessionSnapshotUpdateFromServer({
        token: params.token,
        sessionId: params.sessionId,
        credentials: params.credentials,
        encryptionKey: params.encryptionKey,
        encryptionVariant: params.encryptionVariant,
        currentMetadataLayoutVersion: params.currentMetadataLayoutVersion,
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

    if (update.metadataTuple) {
        params.setMetadataEnvelopeTupleSnapshot(update.metadataTuple);
    } else if (update.metadata) {
        params.setMetadataSnapshot(
            update.metadata.metadata,
            update.metadata.metadataVersion,
            update.metadataLayoutVersion ?? params.currentMetadataLayoutVersion,
        );
    }

    if (!update.metadataTuple && update.agentState) {
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
