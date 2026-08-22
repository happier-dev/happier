import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios, { type AxiosResponse } from 'axios';
import {
    SessionTranscriptObservationProvenanceV1Schema,
    readPendingLocalId,
} from '@happier-dev/protocol';

import { SessionMessageContentSchema, type Update } from '../types';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
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

function isOptionalTimestampValid(value: unknown): boolean {
    return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function parseCatchUpPage(params: Readonly<{
    rawMessages: unknown;
    sessionId: string;
}>): Readonly<{ updates: Update[]; highestSeq: number }> {
    if (!Array.isArray(params.rawMessages)) {
        throw createSessionTranscriptStoredContentUnavailableError();
    }

    const updates: Update[] = [];
    let highestSeq = 0;
    for (const rawMessage of params.rawMessages) {
        if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) {
            throw createSessionTranscriptStoredContentUnavailableError();
        }
        const msg = rawMessage as Record<string, unknown>;
        const id = msg.id;
        const seq = msg.seq;
        const parsedContent = SessionMessageContentSchema.safeParse(msg.content);
        if (
            typeof id !== 'string'
            || !id
            || typeof seq !== 'number'
            || !Number.isSafeInteger(seq)
            || seq < 0
            || !parsedContent.success
            || !isOptionalTimestampValid(msg.createdAt)
            || !isOptionalTimestampValid(msg.updatedAt)
            || !isOptionalTimestampValid(msg.sourceCreatedAt)
            || !isOptionalTimestampValid(msg.sourceUpdatedAt)
            || (msg.localId !== undefined && msg.localId !== null && typeof msg.localId !== 'string')
            || (msg.sidechainId !== undefined && msg.sidechainId !== null && typeof msg.sidechainId !== 'string')
        ) {
            throw createSessionTranscriptStoredContentUnavailableError();
        }

        const localId = readPendingLocalId(msg.localId);
        const sidechainId = typeof msg.sidechainId === 'string' ? (msg.sidechainId.trim() || null) : null;
        const createdAt = readCatchUpTimestamp(msg.createdAt);
        const updatedAt = readCatchUpTimestamp(msg.updatedAt) ?? createdAt;
        const sourceCreatedAt = readCatchUpTimestamp(msg.sourceCreatedAt);
        const sourceUpdatedAt = readCatchUpTimestamp(msg.sourceUpdatedAt) ?? sourceCreatedAt;
        const provenance = msg.transcriptObservationProvenance === undefined
            ? null
            : SessionTranscriptObservationProvenanceV1Schema.safeParse(msg.transcriptObservationProvenance);
        if (provenance && !provenance.success) {
            throw createSessionTranscriptStoredContentUnavailableError();
        }

        const update: Update = {
            id: `catchup-${id}`,
            seq: 0,
            createdAt,
            body: {
                t: 'new-message',
                sid: params.sessionId,
                message: {
                    id,
                    seq,
                    localId,
                    sidechainId,
                    content: parsedContent.data,
                    createdAt,
                    updatedAt,
                    ...(sourceCreatedAt === null ? {} : { sourceCreatedAt }),
                    ...(sourceUpdatedAt === null ? {} : { sourceUpdatedAt }),
                    ...(provenance ? { transcriptObservationProvenance: provenance.data } : {}),
                },
            },
        } as Update;

        sessionHistoryReplayProvenance.set(update as object, {
            sourceCreatedAt: sourceCreatedAt ?? createdAt,
            sourceUpdatedAt: sourceUpdatedAt ?? updatedAt,
        });
        updates.push(update);
        highestSeq = Math.max(highestSeq, seq);
    }

    return { updates, highestSeq };
}

export async function catchUpSessionMessagesAfterSeq(params: {
    token: string;
    sessionId: string;
    afterSeq: number;
    onUpdate: (update: Update) => void;
}): Promise<void> {
    let cursor = Number.isFinite(params.afterSeq) && params.afterSeq >= 0 ? Math.floor(params.afterSeq) : 0;
    const serverUrl = resolveServerHttpBaseUrl();
    for (let page = 0; page < 10; page++) {
        let response: AxiosResponse<unknown>;
        try {
            response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
                headers: {
                    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                    Authorization: `Bearer ${params.token}`,
                    'Content-Type': 'application/json',
                },
                params: {
                    afterSeq: cursor,
                    limit: 200,
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

        const messages = (response?.data as any)?.messages;
        const nextAfterSeq = (response?.data as any)?.nextAfterSeq;
        if (Array.isArray(messages) && messages.length === 0) {
            return;
        }
        const parsedPage = parseCatchUpPage({ rawMessages: messages, sessionId: params.sessionId });
        if (nextAfterSeq !== null && nextAfterSeq !== undefined && (
            typeof nextAfterSeq !== 'number'
            || !Number.isSafeInteger(nextAfterSeq)
            || nextAfterSeq < 0
        )) {
            throw createSessionTranscriptStoredContentUnavailableError();
        }

        for (const update of parsedPage.updates) {
            params.onUpdate(update);
        }
        cursor = Math.max(cursor, parsedPage.highestSeq);

        if (typeof nextAfterSeq === 'number' && Number.isFinite(nextAfterSeq) && nextAfterSeq > cursor) {
            cursor = nextAfterSeq;
            continue;
        }
        return;
    }
}
