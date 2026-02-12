import axios from 'axios';

import { configuration } from '@/configuration';
import type { Update } from '../types';
import { resolveLoopbackHttpUrl } from '../client/loopbackUrl';

export async function catchUpSessionMessagesAfterSeq(params: {
    token: string;
    sessionId: string;
    afterSeq: number;
    onUpdate: (update: Update) => void;
}): Promise<void> {
    let cursor = Number.isFinite(params.afterSeq) && params.afterSeq >= 0 ? Math.floor(params.afterSeq) : 0;
    const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
    for (let page = 0; page < 10; page++) {
        const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
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
            if (!content || content.t !== 'encrypted' || typeof content.c !== 'string') continue;

            const localId = typeof (msg as any).localId === 'string' ? (msg as any).localId : undefined;
            const createdAt = typeof (msg as any).createdAt === 'number' ? (msg as any).createdAt : Date.now();

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
                        ...(localId ? { localId } : {}),
                        content,
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
