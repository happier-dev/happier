import { decodeBase64, decrypt } from '../encryption';
import type { AgentState, Metadata, Update } from '../types';

export function handleSessionStateUpdate(params: {
    update: Update;
    sessionId: string;
    metadata: Metadata | null;
    metadataVersion: number;
    agentState: AgentState | null;
    agentStateVersion: number;
    pendingWakeSeq: number;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    onMetadataUpdated: () => void;
    onWarning: (message: string) => void;
}): {
    handled: boolean;
    metadata: Metadata | null;
    metadataVersion: number;
    agentState: AgentState | null;
    agentStateVersion: number;
    pendingWakeSeq: number;
} {
    const body = params.update.body as any;
    if (body?.t === 'pending-changed') {
        const sid = body.sid ?? body.sessionId;
        if (sid !== params.sessionId) {
            return {
                handled: true,
                metadata: params.metadata,
                metadataVersion: params.metadataVersion,
                agentState: params.agentState,
                agentStateVersion: params.agentStateVersion,
                pendingWakeSeq: params.pendingWakeSeq,
            };
        }

        params.onMetadataUpdated();
        return {
            handled: true,
            metadata: params.metadata,
            metadataVersion: params.metadataVersion,
            agentState: params.agentState,
            agentStateVersion: params.agentStateVersion,
            pendingWakeSeq: params.pendingWakeSeq + 1,
        };
    }

    if (body?.t === 'update-session') {
        const sid = body.sid ?? body.id;
        if (sid !== params.sessionId) {
            return {
                handled: true,
                metadata: params.metadata,
                metadataVersion: params.metadataVersion,
                agentState: params.agentState,
                agentStateVersion: params.agentStateVersion,
                pendingWakeSeq: params.pendingWakeSeq,
            };
        }

        let metadata = params.metadata;
        let metadataVersion = params.metadataVersion;
        let agentState = params.agentState;
        let agentStateVersion = params.agentStateVersion;

        if (body.metadata && body.metadata.version > metadataVersion) {
            const nextMetadata = body.metadata.value;
            metadata =
                typeof nextMetadata === 'string'
                    ? decrypt(params.encryptionKey, params.encryptionVariant, decodeBase64(nextMetadata))
                    : null;
            metadataVersion = body.metadata.version;
            params.onMetadataUpdated();
        }

        if (body.agentState && body.agentState.version > agentStateVersion) {
            agentState = body.agentState.value
                ? decrypt(params.encryptionKey, params.encryptionVariant, decodeBase64(body.agentState.value))
                : null;
            agentStateVersion = body.agentState.version;
        }

        return {
            handled: true,
            metadata,
            metadataVersion,
            agentState,
            agentStateVersion,
            pendingWakeSeq: params.pendingWakeSeq,
        };
    }

    if (body?.t === 'update-machine') {
        params.onWarning('[SOCKET] WARNING: Session client received unexpected machine update - ignoring');
        return {
            handled: true,
            metadata: params.metadata,
            metadataVersion: params.metadataVersion,
            agentState: params.agentState,
            agentStateVersion: params.agentStateVersion,
            pendingWakeSeq: params.pendingWakeSeq,
        };
    }

    return {
        handled: false,
        metadata: params.metadata,
        metadataVersion: params.metadataVersion,
        agentState: params.agentState,
        agentStateVersion: params.agentStateVersion,
        pendingWakeSeq: params.pendingWakeSeq,
    };
}
