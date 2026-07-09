import axios, { type AxiosResponse } from 'axios';

import { SessionMessageContentSchema, type Update } from '../types';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
import {
    createAuthenticationHttpStatusError,
    isAuthenticationStatus,
    readAuthenticationStatus,
} from '../client/httpStatusError';

function readCatchUpTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
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
            throw error;
        }
        const status = response?.status;
        if (isAuthenticationStatus(status)) {
            throw createAuthenticationHttpStatusError(
                status,
                `Authentication failed during session message catch-up (HTTP ${status})`,
            );
        }

        const messages = (response?.data as any)?.messages;
        const nextAfterSeq = (response?.data as any)?.nextAfterSeq;
        if (!Array.isArray(messages) || messages.length === 0) {
            return;
        }

        for (const msg of messages) {
            if (!msg || typeof msg !== 'object') continue;
            const id = (msg as any).id;
            const seq = (msg as any).seq;
            const content = (msg as any).content;
            if (typeof id !== 'string' || typeof seq !== 'number') continue;
            const parsedContent = SessionMessageContentSchema.safeParse(content);
            if (!parsedContent.success) continue;

            const localIdRaw = (msg as any).localId;
            const localId =
                typeof localIdRaw === 'string' ? (localIdRaw.trim() || null) : null;
            const sidechainIdRaw = (msg as any).sidechainId;
            const sidechainId =
                typeof sidechainIdRaw === 'string' ? (sidechainIdRaw.trim() || null) : null;
            const createdAt = readCatchUpTimestamp((msg as any).createdAt);
            const updatedAt = readCatchUpTimestamp((msg as any).updatedAt) ?? createdAt;

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
                    },
                },
            } as Update;

            params.onUpdate(update);
            cursor = Math.max(cursor, seq);
        }

        if (typeof nextAfterSeq === 'number' && Number.isFinite(nextAfterSeq) && nextAfterSeq > cursor) {
            cursor = nextAfterSeq;
            continue;
        }
        return;
    }
}
