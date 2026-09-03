import type { Socket } from 'socket.io-client';

import type {
    SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import type { ClientToServerEvents, ServerToClientEvents, SessionMessageContent } from '../types';
import { UserMessageSchema } from '../types';
import {
    materializeNextPendingQueueV2MessageOnReleasedServer,
    type PendingQueueMaterializedMessage,
} from './pendingQueueV2Transport';
import { findTranscriptEncryptedMessageByLocalIdV2 } from './transcriptMessageLookup';
import { delayUnref } from '@/utils/time';
import type { PendingMaterializationDiagnosticPhase } from './sessionClientPort';

const RELEASED_SERVER_EXACT_READ_MAX_ATTEMPTS = 2;
const RELEASED_SERVER_EXACT_READ_RETRY_DELAY_MS = 100;

export type ReleasedServerPendingContinuationResult =
    | Readonly<{ type: 'materialized'; message: PendingQueueMaterializedMessage }>
    | Readonly<{ type: 'no_pending' }>
    | Readonly<{ type: 'zero_effect' }>
    | Readonly<{ type: 'auth_failed'; statusCode: 401 | 403 }>;

type ReleasedServerSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

function isExactContractCurrent(params: Readonly<{
    contract: SessionSyncPendingInputServerContractResult;
    getServerContract: () => SessionSyncPendingInputServerContractResult | null;
    getSessionConnectionEpoch: () => number;
    getSocket: () => unknown;
    hasCurrentLocalRuntimeAuthority: () => boolean;
}>): boolean {
    return params.contract.pendingInput === 'released_server_v0_2_1'
        && params.getServerContract() === params.contract
        && params.contract.sessionConnectionEpoch === params.getSessionConnectionEpoch()
        && params.contract.socket === params.getSocket()
        && params.contract.socket.connected === true
        && params.hasCurrentLocalRuntimeAuthority();
}

function isValidTimestamp(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function waitForExactReadRetry(): Promise<void> {
    return delayUnref(RELEASED_SERVER_EXACT_READ_RETRY_DELAY_MS);
}

/**
 * Compatibility seam for the server-v0.2.1 contract at 4913c1e533c872a0712ba1c25b3104fd470aacc2:
 * the released server owns atomic materialization and this candidate CLI only translates its strict
 * socket acknowledgement plus exact transcript lookup into the current Pending consumer. Retain it
 * for CLI/server upgrade and coexistence; remove it when server-v0.2.1 leaves the supported window.
 */
export async function continuePendingQueueV2OnReleasedServer(params: Readonly<{
    contract: SessionSyncPendingInputServerContractResult;
    getServerContract: () => SessionSyncPendingInputServerContractResult | null;
    token: string;
    serverUrl: string;
    sessionId: string;
    getSessionConnectionEpoch: () => number;
    getSocket: () => unknown;
    hasCurrentLocalRuntimeAuthority: () => boolean;
    decodeStoredContent: (content: SessionMessageContent) => unknown;
    reportDiagnosticPhase?: (phase: PendingMaterializationDiagnosticPhase) => void;
}>): Promise<ReleasedServerPendingContinuationResult> {
    if (!isExactContractCurrent(params)) return { type: 'zero_effect' };

    let ack: Awaited<ReturnType<typeof materializeNextPendingQueueV2MessageOnReleasedServer>>;
    try {
        params.reportDiagnosticPhase?.('materialize.server_claim');
        ack = await materializeNextPendingQueueV2MessageOnReleasedServer({
            sessionId: params.sessionId,
            socket: params.contract.socket as ReleasedServerSocket,
        });
    } catch {
        return { type: 'zero_effect' };
    }

    if (!isExactContractCurrent(params)) return { type: 'zero_effect' };
    if (!ack.ok) return { type: 'zero_effect' };
    if (!ack.didMaterialize) return { type: 'no_pending' };
    if (!ack.didWrite) return { type: 'zero_effect' };

    let lookup: Awaited<ReturnType<typeof findTranscriptEncryptedMessageByLocalIdV2>>;
    for (let attempt = 0; ; attempt += 1) {
        params.reportDiagnosticPhase?.('materialize.compatibility_transcript_lookup');
        lookup = await findTranscriptEncryptedMessageByLocalIdV2({
            token: params.token,
            serverUrl: params.serverUrl,
            sessionId: params.sessionId,
            localId: ack.message.localId,
        });
        if (!isExactContractCurrent(params)) return { type: 'zero_effect' };
        if (lookup.type !== 'unhealthy' || attempt + 1 >= RELEASED_SERVER_EXACT_READ_MAX_ATTEMPTS) break;
        await waitForExactReadRetry();
        if (!isExactContractCurrent(params)) return { type: 'zero_effect' };
    }
    if (!isExactContractCurrent(params)) return { type: 'zero_effect' };
    if (lookup.type === 'auth_failed') {
        return { type: 'auth_failed', statusCode: lookup.statusCode };
    }
    if (lookup.type !== 'found') return { type: 'zero_effect' };

    const message = lookup.message;
    if (
        message.id !== ack.message.id
        || message.seq !== ack.message.seq
        || message.localId !== ack.message.localId
        || message.sidechainId !== null
        || !isValidTimestamp(message.createdAt)
        || !isValidTimestamp(message.updatedAt)
    ) {
        return { type: 'zero_effect' };
    }

    let decoded: unknown;
    try {
        decoded = params.decodeStoredContent(message.content);
    } catch {
        return { type: 'zero_effect' };
    }
    const parsedUserMessage = UserMessageSchema.safeParse({
        ...(decoded && typeof decoded === 'object' ? decoded : {}),
        localId: message.localId,
        createdAt: message.createdAt,
    });
    if (!parsedUserMessage.success) return { type: 'zero_effect' };
    if (!isExactContractCurrent(params)) return { type: 'zero_effect' };

    return {
        type: 'materialized',
        message: {
            id: message.id,
            seq: message.seq,
            localId: message.localId,
            messageRole: 'user',
            content: message.content,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
        },
    };
}
