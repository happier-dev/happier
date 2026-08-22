import {
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SessionTranscriptObservationCapabilityAckV1Schema,
} from '@happier-dev/protocol';

import {
    supportsSessionSyncPendingInputV1,
    type SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';

type TranscriptCapabilitySocket = Readonly<{
    connected?: boolean;
    emitWithAck?(event: string, payload: unknown): Promise<unknown>;
    timeout?(ms: number): TranscriptCapabilitySocket;
}>;

export type SessionTranscriptTransportContract =
    | Readonly<{ mode: 'session_transcript_observation_v1' }>
    | Readonly<{ mode: 'released_server_v0_2_1' }>
    | Readonly<{
        mode: 'unavailable';
        reason: 'capability_missing_or_unsupported' | 'capability_probe_failed';
    }>
    | Readonly<{ mode: 'indeterminate'; reason: 'connection_contract_unresolved' }>
    | Readonly<{ mode: 'auth_failed'; reason: 'connection_auth_failed' }>;

export type SessionClientConnectionContractResult =
    SessionSyncPendingInputServerContractResult
    & Readonly<{ transcriptTransport: SessionTranscriptTransportContract }>;

export function composeInvalidatedSessionClientConnectionContract(
    serverContract: SessionSyncPendingInputServerContractResult,
): SessionClientConnectionContractResult {
    return {
        ...serverContract,
        transcriptTransport: serverContract.mode === 'auth_failed'
            ? { mode: 'auth_failed', reason: 'connection_auth_failed' }
            : { mode: 'indeterminate', reason: 'connection_contract_unresolved' },
    };
}

export async function resolveSessionClientConnectionContract(params: Readonly<{
    serverContract: SessionSyncPendingInputServerContractResult;
    sessionId: string;
    socket: TranscriptCapabilitySocket;
}>): Promise<SessionClientConnectionContractResult> {
    if (params.serverContract.pendingInput === 'released_server_v0_2_1') {
        return {
            ...params.serverContract,
            transcriptTransport: { mode: 'released_server_v0_2_1' },
        };
    }
    if (params.serverContract.mode === 'auth_failed') {
        return composeInvalidatedSessionClientConnectionContract(params.serverContract);
    }
    if (!supportsSessionSyncPendingInputV1(params.serverContract)) {
        return composeInvalidatedSessionClientConnectionContract(params.serverContract);
    }
    if (params.socket.connected !== true || typeof params.socket.emitWithAck !== 'function') {
        return {
            ...params.serverContract,
            transcriptTransport: {
                mode: 'unavailable',
                reason: 'capability_missing_or_unsupported',
            },
        };
    }

    try {
        const raw = await emitSocketWithAck({
            socket: params.socket,
            event: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
            payload: { v: 1, sessionId: params.sessionId },
        });
        const parsed = SessionTranscriptObservationCapabilityAckV1Schema.safeParse(raw);
        return {
            ...params.serverContract,
            transcriptTransport: parsed.success && parsed.data.ok === true
                ? { mode: 'session_transcript_observation_v1' }
                : {
                    mode: 'unavailable',
                    reason: 'capability_missing_or_unsupported',
                },
        };
    } catch {
        return {
            ...params.serverContract,
            transcriptTransport: {
                mode: 'unavailable',
                reason: 'capability_probe_failed',
            },
        };
    }
}
