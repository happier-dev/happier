import { describe, expect, it, vi } from 'vitest';

import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import { normalizeRawMessage, type RawRecord } from '@/sync/typesRaw';

import { persistSessionTranscriptMessage } from './persistSessionTranscriptMessage';

const realtimeMeta = {
    happier: {
        kind: 'conversation_turn.v1',
        payload: { v: 1 },
        conversationTurnOriginV1: {
            v: 1 as const,
            channel: 'realtime_conversation' as const,
            modality: 'voice' as const,
        },
    },
};

function userRecord(text: string): RawRecord {
    return {
        role: 'user',
        content: { type: 'text', text },
        meta: realtimeMeta,
    };
}

describe('persistSessionTranscriptMessage', () => {
    it('writes and updates one idempotent durable row that reloads through the canonical reader', async () => {
        const storedBodies: Readonly<Record<string, unknown>>[] = [];
        let revision = 0;
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            storedBodies.push(JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>);
            revision += 1;
            return new Response(JSON.stringify({
                didWrite: revision === 1,
                ...(revision > 1 ? { didUpdate: true } : {}),
                message: {
                    id: 'server-row',
                    seq: 7,
                    localId: 'voice-realtime:attempt:user:turn',
                    createdAt: 100,
                },
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        const input = {
            sessionId: 'carrier',
            localId: 'voice-realtime:attempt:user:turn',
            createdAt: 100,
            rawRecord: userRecord('initial question'),
            messageRole: 'user' as const,
        };

        const initial = await persistSessionTranscriptMessage({
            request,
            sessionEncryptionMode: 'plain',
        }, input);
        const corrected = await persistSessionTranscriptMessage({
            request,
            sessionEncryptionMode: 'plain',
        }, {
            ...input,
            rawRecord: userRecord('corrected question'),
        });

        expect(initial).toMatchObject({ didWrite: true, didUpdate: false });
        expect(corrected).toMatchObject({ didWrite: false, didUpdate: true });
        expect(corrected.message).toMatchObject({ isAuthoritativeUpdate: true });
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenLastCalledWith(
            '/v2/sessions/carrier/messages',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Idempotency-Key': input.localId,
                }),
            }),
        );

        const storedBody = storedBodies.at(-1);
        if (!storedBody) throw new Error('Expected a stored request body');
        const storedContent = storedBody.content;
        const decrypted = await readStoredSessionMessage({
            message: {
                id: 'server-row',
                seq: 7,
                localId: input.localId,
                messageRole: 'user',
                content: storedContent as { t: 'plain'; v: unknown },
                createdAt: 100,
            },
        });
        const reloaded = decrypted?.content
            ? normalizeRawMessage(
                decrypted.id,
                decrypted.localId,
                decrypted.createdAt,
                decrypted.content,
                { seq: decrypted.seq ?? undefined, messageRole: decrypted.messageRole },
            )
            : null;

        expect(reloaded).toMatchObject({
            id: 'server-row',
            seq: 7,
            localId: input.localId,
            role: 'user',
            content: { type: 'text', text: 'corrected question' },
            meta: realtimeMeta,
        });
    });

    it('encrypts E2EE writes at the existing session boundary without creating a retry owner', async () => {
        const encryptRawRecord = vi.fn(async () => 'ciphertext');
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            expect(body).toMatchObject({
                ciphertext: 'ciphertext',
                localId: 'voice-realtime:attempt:agent:turn',
                messageRole: 'agent',
            });
            expect(body).not.toHaveProperty('content');
            return new Response(JSON.stringify({
                didWrite: true,
                message: {
                    id: 'server-agent-row',
                    seq: 8,
                    localId: 'voice-realtime:attempt:agent:turn',
                    createdAt: 101,
                },
            }), { status: 200 });
        });
        const rawRecord: RawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'answer' }],
                        usage: undefined,
                    },
                },
            },
            meta: realtimeMeta,
        };

        await expect(persistSessionTranscriptMessage({
            request,
            sessionEncryptionMode: 'e2ee',
            encryptRawRecord,
        }, {
            sessionId: 'carrier',
            localId: 'voice-realtime:attempt:agent:turn',
            createdAt: 101,
            rawRecord,
            messageRole: 'agent',
        })).resolves.toMatchObject({
            didWrite: true,
            message: {
                id: 'server-agent-row',
                role: 'agent',
            },
        });
        expect(encryptRawRecord).toHaveBeenCalledOnce();
    });
});
