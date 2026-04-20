import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

import type { AgentState, Metadata } from '../../../types';
import { fetchSessionSnapshotUpdateFromServer } from '../../snapshotSync';

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
    }>,
): Promise<void> {
    const request = () => fetchSessionSnapshotUpdateFromServer({
        token: params.token,
        sessionId: params.sessionId,
        encryptionKey: params.encryptionKey,
        encryptionVariant: params.encryptionVariant,
        currentMetadataVersion: params.currentMetadataVersion,
        currentAgentStateVersion: params.currentAgentStateVersion,
        currentMetadata: params.currentMetadata,
        currentAgentState: params.currentAgentState,
    });
    const update = params.sessionConnectionSupervisor
        ? await runSupervisedRequest({
            supervisor: params.sessionConnectionSupervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        })
        : await request();

    if (params.isClosed()) return;

    if (update.metadata) {
        params.setMetadataSnapshot(update.metadata.metadata, update.metadata.metadataVersion);
    }

    if (update.agentState) {
        params.setAgentStateSnapshot(update.agentState.agentState, update.agentState.agentStateVersion);
    }
}
