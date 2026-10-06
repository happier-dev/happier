import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios, { type AxiosResponse } from 'axios';
import { SessionMessagesPageV1Schema, buildSessionMessagesPath } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { SessionMessageV1 } from '@happier-dev/protocol';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { drainSessionMessagesAfter, openSessionStoredContent, SessionMessageGapError, type SessionStoredContentContext } from '@happier-dev/sync-client';

import { type Update } from '../types';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
import { decryptSessionPayload, encryptSessionPayload, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import {
    createAuthenticationHttpStatusError,
    createHttpStatusError,
    isAuthenticationStatus,
    readAuthenticationStatus,
} from '../client/httpStatusError';
import {
    createSessionTranscriptStoredContentUnavailableError,
    rethrowSessionTranscriptStoredContentUnavailableResponse,
    throwIfSessionTranscriptStoredContentUnavailableResponse,
} from './sessionTranscriptStoredContentUnavailable';

type SessionHistoryReplayProvenance = Readonly<{
    sourceCreatedAt: number | null;
    sourceUpdatedAt: number | null;
}>;

// History classification is local control-plane state. A remote update cannot forge it.
const sessionHistoryReplayProvenance = new WeakMap<object, SessionHistoryReplayProvenance>();

export function readSessionHistoryReplayProvenance(update: Update): SessionHistoryReplayProvenance | null {
    return sessionHistoryReplayProvenance.get(update as object) ?? null;
}

function readCatchUpTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function createCatchUpUpdate(msg: SessionMessageV1, sessionId: string): Update {
    const localId = readPendingLocalId(msg.localId);
    const sidechainId = msg.sidechainId?.trim() || null;
    const createdAt = readCatchUpTimestamp(msg.createdAt);
    const updatedAt = readCatchUpTimestamp(msg.updatedAt) ?? createdAt;
    const sourceCreatedAt = readCatchUpTimestamp(msg.sourceCreatedAt);
    const sourceUpdatedAt = readCatchUpTimestamp(msg.sourceUpdatedAt) ?? sourceCreatedAt;
    const update: Update = {
        id: `catchup-${msg.id}`,
        seq: 0,
        createdAt,
        body: {
            t: 'new-message',
            sid: sessionId,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId,
                sidechainId,
                content: msg.content,
                createdAt,
                updatedAt,
                ...(sourceCreatedAt === null ? {} : { sourceCreatedAt }),
                ...(sourceUpdatedAt === null ? {} : { sourceUpdatedAt }),
                ...(msg.transcriptObservationProvenance ? { transcriptObservationProvenance: msg.transcriptObservationProvenance } : {}),
            },
        },
    } as Update;

    sessionHistoryReplayProvenance.set(update as object, {
        sourceCreatedAt: sourceCreatedAt ?? createdAt,
        sourceUpdatedAt: sourceUpdatedAt ?? updatedAt,
    });
    return update;
}

export async function catchUpSessionMessagesAfterSeq(params: {
    token: string;
    sessionId: string;
    afterSeq: number;
    onUpdate: (update: Update) => void;
} & SessionStoredContentCryptoContext): Promise<void> {
    const afterSeq = Number.isFinite(params.afterSeq) && params.afterSeq >= 0 ? Math.floor(params.afterSeq) : 0;
    const serverUrl = resolveServerHttpBaseUrl();
    const content: SessionStoredContentContext = params.mode === 'plain'
        ? { mode: 'plain' }
        : {
            mode: 'e2ee',
            encryption: {
                encryptRaw: async (payload) => encryptSessionPayload({ ctx: params.ctx, payload }),
                decryptRaw: async (ciphertextBase64) => decryptSessionPayload({ ctx: params.ctx, ciphertextBase64 }),
            },
        };
    try {
        await drainSessionMessagesAfter({
            afterSeq,
            signal: new AbortController().signal,
            fetchPage: async (cursor) => {
                let response: AxiosResponse<unknown>;
                try {
                    const path = buildSessionMessagesPath({ sessionId: params.sessionId, scope: 'all', afterSeq: cursor, limit: 200 });
                    response = await axios.get(`${serverUrl}${path}`, {
                        headers: {
                            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                            Authorization: `Bearer ${params.token}`,
                            'Content-Type': 'application/json',
                        },
                        timeout: 15_000,
                    });
                } catch (error) {
                    const status = readAuthenticationStatus(error);
                    if (status) {
                        throw createAuthenticationHttpStatusError(
                            status,
                            `Authentication failed during session message catch-up (HTTP ${status})`,
                        );
                    }
                    rethrowSessionTranscriptStoredContentUnavailableResponse(error);
                }
                const status = response?.status;
                throwIfSessionTranscriptStoredContentUnavailableResponse(status, response?.data);
                if (isAuthenticationStatus(status)) {
                    throw createAuthenticationHttpStatusError(
                        status,
                        `Authentication failed during session message catch-up (HTTP ${status})`,
                    );
                }

                if (typeof status === 'number' && status !== 200) {
                    throw createHttpStatusError(status, `Unexpected status during session message catch-up (HTTP ${status})`);
                }

                const page = SessionMessagesPageV1Schema.safeParse(response?.data);
                if (!page.success) throw createSessionTranscriptStoredContentUnavailableError();
                return page.data;
            },
            onPage: async (messages) => {
                const opened = await Promise.all(messages.map((message) => openSessionStoredContent(content, message.content)));
                if (opened.some((result) => result.status !== 'ready')) throw createSessionTranscriptStoredContentUnavailableError();
                // Ordering observes every Session row; the existing CLI replay surface remains the main chain.
                for (const message of messages) {
                    if (!message.sidechainId) params.onUpdate(createCatchUpUpdate(message, params.sessionId));
                }
            },
        });
    } catch (error) {
        if (error instanceof SessionMessageGapError) throw createSessionTranscriptStoredContentUnavailableError();
        throw error;
    }
}
