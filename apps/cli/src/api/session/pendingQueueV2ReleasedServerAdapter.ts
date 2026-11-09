import type { Socket } from 'socket.io-client';

import type { SessionSyncPendingInputServerContractResult } from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import type { ClientToServerEvents, ServerToClientEvents, UserMessage } from '../types';
import { UserMessageSchema } from '../types';
import type {
    MaterializeNextPendingResult,
    PendingMaterializationDiagnosticPhase,
} from './sessionClientPort';
import { materializeNextPendingQueueV2MessageViaReleasedServerSocket } from './pendingQueueV2Transport';
import { findTranscriptEncryptedMessageByLocalIdV2 } from './transcriptMessageLookup';
import { delayUnrefAbortable } from '@/utils/time';
import { configuration } from '@/configuration';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { openSessionMessageContent, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';

type SessionSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// Compatibility seam provenance: immutable server-v0.2.1 commit 4913c1e.
// Pending owns this request-scoped exact ACK + transcript-lookup adapter; it grants no passive replay.
// Remove it when server-v0.2.1 leaves the supported hosted/self-hosted compatibility window.

function readCanonicalUserTextMessage(params: Readonly<{
    body: unknown;
    localId: string;
    createdAt: number;
}>): UserMessage | null {
    if (!params.body || typeof params.body !== 'object' || Array.isArray(params.body)) return null;
    const body = params.body as Record<string, unknown>;
    if (body.role !== 'user' || !body.content || typeof body.content !== 'object' || Array.isArray(body.content)) {
        return null;
    }
    const content = body.content as Record<string, unknown>;
    if (content.type !== 'text' || typeof content.text !== 'string') return null;
    const parsed = UserMessageSchema.safeParse({
        ...body,
        // This released carrier has no authenticated requester receipt.
        actionRequestAttributionV1: undefined,
        localId: params.localId,
        createdAt: params.createdAt,
    });
    return parsed.success ? parsed.data : null;
}

export async function runPendingQueueV2ReleasedServerAdapter(params: Readonly<{
    token: string;
    serverUrl: string;
    signal?: AbortSignal;
    sessionId: string;
    contractResult: SessionSyncPendingInputServerContractResult;
    getContractResult: () => SessionSyncPendingInputServerContractResult | null;
    getSessionConnectionEpoch: () => number;
    getSocket: () => SessionSyncPendingInputServerContractResult['socket'];
    isRuntimeAuthorityCurrent: () => boolean;
    deliverMaterializedUserMessageToAgentQueue: (message: UserMessage, providerAction: 'send') => boolean | void;
    reportDiagnosticPhase?: (phase: PendingMaterializationDiagnosticPhase) => void;
}> & SessionStoredContentCryptoContext): Promise<MaterializeNextPendingResult> {
    const contractSocket = params.contractResult.socket as SessionSocket;
    const signal = params.signal ?? AbortSignal.any([]);
    const hasCurrentAuthority = (): boolean => (
        params.contractResult.pendingInput === 'released_server_v0_2_1'
        && params.getContractResult() === params.contractResult
        && params.getSessionConnectionEpoch() === params.contractResult.sessionConnectionEpoch
        && params.getSocket() === contractSocket
        && contractSocket.connected === true
        && !signal.aborted
        && params.isRuntimeAuthorityCurrent()
    );

    if (!hasCurrentAuthority()) return { type: 'retryable_transport' };

    params.reportDiagnosticPhase?.('materialize.server_claim');
    const materialized = await materializeNextPendingQueueV2MessageViaReleasedServerSocket({
        signal,
        socket: contractSocket,
        sessionId: params.sessionId,
    });
    if (!hasCurrentAuthority()) return { type: 'retryable_transport' };
    if (materialized.type === 'no_pending') return { type: 'no_pending' };
    if (materialized.type === 'error') {
        if (materialized.error === 'forbidden') {
            throw createHttpStatusError(403, materialized.error, materialized.error);
        }
        throw new Error(materialized.error);
    }
    if (!materialized.didWrite) return { type: 'no_pending' };

    const acknowledged = materialized.message;
    let lookup: Awaited<ReturnType<typeof findTranscriptEncryptedMessageByLocalIdV2>>;
    for (;;) {
        params.reportDiagnosticPhase?.('materialize.compatibility_transcript_lookup');
        lookup = await findTranscriptEncryptedMessageByLocalIdV2({
            token: params.token,
            serverUrl: params.serverUrl,
            sessionId: params.sessionId,
            localId: acknowledged.localId,
            signal,
        });
        if (!hasCurrentAuthority()) return { type: 'retryable_transport' };
        if (lookup.type !== 'unhealthy') break;
        // Keep the popped ACK in this operation until exact observation settles. The
        // transcript transport owns pacing; the containing caller owns cancellation.
        await delayUnrefAbortable(configuration.transcriptLookupErrorBackoffBaseMs, signal);
        if (!hasCurrentAuthority()) return { type: 'retryable_transport' };
    }
    if (!hasCurrentAuthority()) return { type: 'retryable_transport' };
    if (lookup.type === 'auth_failed') return { type: 'auth_failure' };
    if (lookup.type === 'protocol_error') throw lookup.error;
    if (lookup.type !== 'found') return { type: 'retryable_transport' };

    const message = lookup.message;
    if (
        message.id !== acknowledged.id
        || message.seq !== acknowledged.seq
        || message.localId !== acknowledged.localId
        || message.sidechainId !== null
        || !Number.isSafeInteger(message.seq)
        || message.seq < 0
        || !Number.isSafeInteger(message.createdAt)
        || message.createdAt < 0
        || !Number.isSafeInteger(message.updatedAt)
        || message.updatedAt < 0
    ) {
        throw new Error('Released Pending transcript identity mismatch');
    }

    const body = openSessionMessageContent({ ...params, content: message.content });
    const userMessage = readCanonicalUserTextMessage({
        body,
        localId: acknowledged.localId,
        createdAt: message.createdAt,
    });
    if (!userMessage) throw new Error('Invalid released Pending user message');
    if (!hasCurrentAuthority()) return { type: 'retryable_transport' };

    const delivered = params.deliverMaterializedUserMessageToAgentQueue(userMessage, 'send');
    if (delivered === false) return { type: 'retryable_transport' };
    return {
        type: 'materialized',
        localId: acknowledged.localId,
        seq: acknowledged.seq,
        content: message.content,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
    };
}
