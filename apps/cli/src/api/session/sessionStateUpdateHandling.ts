import { decodeBase64, decrypt } from '../encryption';
import type { AgentState, Metadata, Update } from '../types';
import { tryParseJsonObject } from '@/utils/tryParseJsonRecord';
import { readKnownPendingQueueState, type KnownPendingQueueState } from './pendingQueueState';
import type { PendingQueueRuntimeActivityProjection } from '@/agent/runtime/session/input/pendingQueueDrainPolicy';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';

function tryDecodeSessionStateValue<T>(params: {
    rawValue: unknown;
} & SessionStoredContentCryptoContext): { ok: true; value: T | null } | { ok: false } {
    if (params.rawValue === null) {
        return { ok: true, value: null };
    }

    if (typeof params.rawValue !== 'string') {
        return { ok: false };
    }

    if (params.mode === 'plain') {
        const parsed = tryParseJsonObject(params.rawValue);
        return parsed ? { ok: true, value: parsed as T } : { ok: false };
    }

    try {
        const decrypted = decrypt(
            params.ctx.encryptionKey,
            params.ctx.encryptionVariant,
            decodeBase64(params.rawValue),
        );
        return decrypted !== null ? { ok: true, value: decrypted as T } : { ok: false };
    } catch {
        return { ok: false };
    }
}

function hasRuntimeActivityProjectionFields(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return 'runtimeActivityState' in record
        || 'runtimeActivityRevision' in record;
}

export function handleSessionStateUpdate(params: {
    update: Update;
    updateSource: 'session-scoped' | 'user-scoped';
    sessionId: string;
    metadataLayoutVersion?: number;
    metadata: Metadata | null;
    metadataVersion: number;
    agentState: AgentState | null;
    agentStateVersion: number;
    pendingWakeSeq: number;
    onMetadataUpdated: () => void;
    onMetadataEnvelopeTupleInvalidated?: () => void;
    onPendingChangedDrainTrigger?: (state: KnownPendingQueueState) => void;
    onWarning: (message: string) => void;
} & SessionStoredContentCryptoContext): {
    handled: boolean;
    metadata: Metadata | null;
    metadataVersion: number;
    agentState: AgentState | null;
    agentStateVersion: number;
    pendingWakeSeq: number;
    pendingQueueState?: KnownPendingQueueState;
    runtimeActivityProjection?: PendingQueueRuntimeActivityProjection;
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
        const pendingQueueState = readKnownPendingQueueState(body);
        if (pendingQueueState) {
            params.onPendingChangedDrainTrigger?.(pendingQueueState);
        }
        return {
            handled: true,
            metadata: params.metadata,
            metadataVersion: params.metadataVersion,
            agentState: params.agentState,
            agentStateVersion: params.agentStateVersion,
            pendingWakeSeq: params.pendingWakeSeq + 1,
            ...(pendingQueueState ? { pendingQueueState } : {}),
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

        if (
            params.metadataLayoutVersion === 1
            && (
                Object.prototype.hasOwnProperty.call(body, 'metadata')
                || Object.prototype.hasOwnProperty.call(body, 'ownerMetadata')
                || Object.prototype.hasOwnProperty.call(body, 'agentState')
            )
        ) {
            // A shared-only socket projection is not an owner compatibility view.
            // Keep the exact local owner tuple intact until the canonical by-id
            // reader can atomically replace all three envelopes.
            params.onMetadataEnvelopeTupleInvalidated?.();
            return {
                handled: true,
                metadata: params.metadata,
                metadataVersion: params.metadataVersion,
                agentState: params.agentState,
                agentStateVersion: params.agentStateVersion,
                pendingWakeSeq: params.pendingWakeSeq,
                ...(hasRuntimeActivityProjectionFields(body)
                    ? {
                        runtimeActivityProjection: {
                            runtimeActivityState: body.runtimeActivityState,
                            runtimeActivityActiveCount: body.runtimeActivityActiveCount,
                            runtimeActivityObservedAt: body.runtimeActivityObservedAt,
                            runtimeActivityRevision: body.runtimeActivityRevision,
                        },
                    }
                    : {}),
            };
        }

        let metadata = params.metadata;
        let metadataVersion = params.metadataVersion;
        let agentState = params.agentState;
        let agentStateVersion = params.agentStateVersion;

        if (body.metadata && body.metadata.version > metadataVersion) {
            const decodedMetadata = tryDecodeSessionStateValue<Metadata>({
                rawValue: body.metadata.value,
                ...params,
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
                ...params,
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
            ...(hasRuntimeActivityProjectionFields(body)
                ? {
                    runtimeActivityProjection: {
                        runtimeActivityState: body.runtimeActivityState,
                        runtimeActivityActiveCount: body.runtimeActivityActiveCount,
                        runtimeActivityObservedAt: body.runtimeActivityObservedAt,
                        runtimeActivityRevision: body.runtimeActivityRevision,
                    },
                }
                : {}),
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
