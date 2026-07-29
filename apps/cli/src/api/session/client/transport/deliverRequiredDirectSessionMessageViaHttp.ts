import axios from 'axios';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

type PlainOrEncryptedPayload = string | { t: 'plain'; v: unknown };

export type RequiredDirectSessionMessageHttpAck = Readonly<{
    id: string;
    seq: number;
    localId: string | null;
}>;

/** HTTP compatibility seam for the non-outbox required direct-message commit path. */
export async function deliverRequiredDirectSessionMessageViaHttp(params: Readonly<{
    token: string;
    sessionId: string;
    message: PlainOrEncryptedPayload;
    localId: string;
    sidechainId: string | null;
    messageRole?: 'user' | 'agent' | 'event' | 'unknown';
    sessionEventType?: 'ready';
}>): Promise<RequiredDirectSessionMessageHttpAck | null> {
    try {
        const body = typeof params.message === 'string'
            ? {
                ciphertext: params.message,
                localId: params.localId,
                sidechainId: params.sidechainId,
                ...(params.messageRole ? { messageRole: params.messageRole } : {}),
                ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
            }
            : {
                content: params.message,
                localId: params.localId,
                sidechainId: params.sidechainId,
                ...(params.messageRole ? { messageRole: params.messageRole } : {}),
                ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
            };
        const response = await axios.post(
            `${resolveServerHttpBaseUrl()}/v2/sessions/${encodeURIComponent(params.sessionId)}/messages`,
            body,
            {
                headers: {
                    Authorization: `Bearer ${params.token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': params.localId,
                },
                timeout: 10_000,
            },
        );
        const data = response?.data as Record<string, unknown> | undefined;
        if (!data || data.ok === false || data.result === 'error') return null;
        const message = data.message;
        if (!message || typeof message !== 'object') return null;
        const record = message as Record<string, unknown>;
        if (
            typeof record.id !== 'string'
            || typeof record.seq !== 'number'
            || !Number.isSafeInteger(record.seq)
            || record.seq < 0
        ) {
            return null;
        }
        return {
            id: record.id,
            seq: record.seq,
            localId: typeof record.localId === 'string' ? record.localId : null,
        };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return null;
    }
}
