import { apiSocket } from '@/sync/api/session/apiSocket';
import type { UpdateMetadataAck } from '@/sync/domains/session/metadata/updateSessionMetadataWithRetry';

import { createEphemeralServerSocketClient } from './createEphemeralServerSocketClient';
import { resolvePreferredServerIdForSessionId } from './resolvePreferredServerIdForSessionId';
import { resolveServerScopedSessionContext } from './resolveServerScopedSessionContext';

export async function emitSessionMetadataUpdateWithServerScope(params: Readonly<{
    sessionId: string;
    expectedVersion: number;
    metadata: string;
    timeoutMs?: number;
}>): Promise<UpdateMetadataAck> {
    const context = await resolveServerScopedSessionContext({
        serverId: resolvePreferredServerIdForSessionId(params.sessionId),
        timeoutMs: params.timeoutMs,
    });
    const payload = {
        sid: params.sessionId,
        expectedVersion: params.expectedVersion,
        metadata: params.metadata,
    };

    if (context.scope === 'active') {
        return await apiSocket.emitWithAck<UpdateMetadataAck>('update-metadata', payload);
    }

    const socket = await createEphemeralServerSocketClient({
        serverUrl: context.targetServerUrl,
        token: context.token,
        timeoutMs: context.timeoutMs,
    });
    try {
        return await socket.timeout(context.timeoutMs).emitWithAck('update-metadata', payload) as UpdateMetadataAck;
    } finally {
        socket.disconnect();
    }
}
