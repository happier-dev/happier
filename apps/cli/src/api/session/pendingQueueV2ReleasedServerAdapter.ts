import type { Socket } from 'socket.io-client';

import type { SessionSyncPendingInputServerContractResult } from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { decodeBase64, decrypt } from '../encryption';
import type { ClientToServerEvents, ServerToClientEvents, UserMessage } from '../types';
import { UserMessageSchema } from '../types';
import type { MaterializeNextPendingResult } from './sessionClientPort';
import { materializeNextPendingQueueV2MessageViaReleasedServerSocket } from './pendingQueueV2Transport';
import { findTranscriptEncryptedMessageByLocalIdV2 } from './transcriptMessageLookup';
import { delayUnref } from '@/utils/time';

type SessionSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const RELEASED_SERVER_EXACT_LOOKUP_MAX_ATTEMPTS = 2;
const RELEASED_SERVER_EXACT_LOOKUP_RETRY_DELAY_MS = 100;

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
        localId: params.localId,
        createdAt: params.createdAt,
    });
    return parsed.success ? parsed.data : null;
}

export async function runPendingQueueV2ReleasedServerAdapter(params: Readonly<{
    token: string;
    serverUrl: string;
    sessionId: string;
    contractResult: SessionSyncPendingInputServerContractResult;
    getContractResult: () => SessionSyncPendingInputServerContractResult | null;
    getSessionConnectionEpoch: () => number;
    getSocket: () => SessionSyncPendingInputServerContractResult['socket'];
    isRuntimeAuthorityCurrent: () => boolean;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    deliverMaterializedUserMessageToAgentQueue: (message: UserMessage, providerAction: 'send') => boolean | void;
}>): Promise<MaterializeNextPendingResult> {
    const contractSocket = params.contractResult.socket as SessionSocket;
    const hasCurrentAuthority = (): boolean => (
        params.contractResult.mode === 'released_server_v0_2_1'
        && params.getContractResult() === params.contractResult
        && params.getSessionConnectionEpoch() === params.contractResult.sessionConnectionEpoch
        && params.getSocket() === contractSocket
        && contractSocket.connected === true
        && params.isRuntimeAuthorityCurrent()
    );

    if (!hasCurrentAuthority()) return { type: 'no_pending' };

    let materialized;
    try {
        materialized = await materializeNextPendingQueueV2MessageViaReleasedServerSocket({
            socket: contractSocket,
            sessionId: params.sessionId,
        });
    } catch {
        return { type: 'no_pending' };
    }
    if (!hasCurrentAuthority()) return { type: 'no_pending' };
    if (materialized.type === 'no_pending') return { type: 'no_pending' };
    if (materialized.type === 'error') return { type: 'no_pending' };
    if (!materialized.didWrite) return { type: 'no_pending' };

    const acknowledged = materialized.message;
    let lookup: Awaited<ReturnType<typeof findTranscriptEncryptedMessageByLocalIdV2>>;
    for (let attempt = 0; ; attempt += 1) {
        lookup = await findTranscriptEncryptedMessageByLocalIdV2({
            token: params.token,
            serverUrl: params.serverUrl,
            sessionId: params.sessionId,
            localId: acknowledged.localId,
        });
        if (!hasCurrentAuthority()) return { type: 'no_pending' };
        if (lookup.type !== 'unhealthy' || attempt + 1 >= RELEASED_SERVER_EXACT_LOOKUP_MAX_ATTEMPTS) break;
        await delayUnref(RELEASED_SERVER_EXACT_LOOKUP_RETRY_DELAY_MS);
        if (!hasCurrentAuthority()) return { type: 'no_pending' };
    }
    if (!hasCurrentAuthority()) return { type: 'no_pending' };
    if (lookup.type === 'auth_failed') return { type: 'auth_failure' };
    if (lookup.type !== 'found') return { type: 'no_pending' };

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
        return { type: 'no_pending' };
    }

    let body: unknown;
    if (message.content.t === 'plain') {
        body = message.content.v;
    } else {
        try {
            body = decrypt(
                params.encryptionKey,
                params.encryptionVariant,
                decodeBase64(message.content.c),
            );
        } catch {
            return { type: 'no_pending' };
        }
    }
    const userMessage = readCanonicalUserTextMessage({
        body,
        localId: acknowledged.localId,
        createdAt: message.createdAt,
    });
    if (!userMessage || !hasCurrentAuthority()) return { type: 'no_pending' };

    const delivered = params.deliverMaterializedUserMessageToAgentQueue(userMessage, 'send');
    if (delivered === false) return { type: 'no_pending' };
    return {
        type: 'materialized',
        localId: acknowledged.localId,
        seq: acknowledged.seq,
        content: message.content,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
    };
}
