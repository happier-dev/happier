import { decodeBase64, decrypt } from '../encryption';
import type { AgentState, Metadata, Update } from '../types';
import { tryParseJsonObject } from '@/utils/tryParseJsonRecord';

function tryDecodeSessionStateValue<T>(params: {
    rawValue: unknown;
    sessionEncryptionMode: 'e2ee' | 'plain';
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
}): { ok: true; value: T | null } | { ok: false } {
    if (params.rawValue === null) {
        return { ok: true, value: null };
    }

    if (typeof params.rawValue !== 'string') {
        return { ok: false };
    }

    if (params.sessionEncryptionMode === 'plain') {
        const parsed = tryParseJsonObject(params.rawValue);
        return parsed ? { ok: true, value: parsed as T } : { ok: false };
    }

    try {
        const decrypted = decrypt(params.encryptionKey, params.encryptionVariant, decodeBase64(params.rawValue));
        return decrypted !== null ? { ok: true, value: decrypted as T } : { ok: false };
    } catch {
        return { ok: false };
    }
}

export function handleSessionStateUpdate(params: {
    update: Update;
    updateSource: 'session-scoped' | 'user-scoped';
    sessionId: string;
    sessionEncryptionMode: 'e2ee' | 'plain';
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
            const decodedMetadata = tryDecodeSessionStateValue<Metadata>({
                rawValue: body.metadata.value,
                sessionEncryptionMode: params.sessionEncryptionMode,
                encryptionKey: params.encryptionKey,
                encryptionVariant: params.encryptionVariant,
            });
            if (decodedMetadata.ok) {
                metadata = decodedMetadata.value;
                metadataVersion = body.metadata.version;
                params.onMetadataUpdated();
            }
        }

        if (body.agentState && body.agentState.version > agentStateVersion) {
            const decodedAgentState = tryDecodeSessionStateValue<AgentState>({
                rawValue: body.agentState.value,
                sessionEncryptionMode: params.sessionEncryptionMode,
                encryptionKey: params.encryptionKey,
                encryptionVariant: params.encryptionVariant,
            });
            if (decodedAgentState.ok) {
                agentState = decodedAgentState.value;
                agentStateVersion = body.agentState.version;
            }
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
        // User-scoped sockets receive global machine updates; those are expected and irrelevant to session state.
        // Session-scoped sockets should not receive machine updates; keep a warning in that case.
        if (params.updateSource === 'session-scoped') {
            params.onWarning('[SOCKET] WARNING: Session client received unexpected machine update - ignoring');
        }
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
