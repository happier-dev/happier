import { describe, it, expect } from 'vitest';

import { readStoredSessionMessage, readStoredSessionRawRecord } from './readStoredSessionContent';

describe('readStoredSessionRawRecord', () => {
    it('exposes witnessed accepted delivery only from matching plain Session content', async () => {
        const facts = { v: 1, acceptedAtMs: 1234, delivery: { kind: 'newTurn', turnId: 'turn-1' } } as const;
        const message = { id: 'accepted-plain', seq: 1, localId: 'input-1', createdAt: 1, updatedAt: 1,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: facts } },
        } as const;
        expect((await readStoredSessionMessage({ message, sessionEncryptionMode: 'plain' }))?.acceptedDelivery).toEqual(facts);
        expect((await readStoredSessionMessage({ message: { ...message, deliveryResolution: {
            v: 1, kind: 'provider_accepted', content: { t: 'encrypted', c: 'opaque-facts' },
        } }, sessionEncryptionMode: 'plain' }))?.acceptedDelivery).toBeUndefined();
    });
    const structuredPresentation = {
        v: 1,
        profile: 'pluginTranscriptV1',
        owner: {
            pluginId: 'acme.transcript',
            contributionLocalId: 'review-card',
        },
        snapshot: {
            kind: 'text',
            text: 'Review ready',
        },
    } as const;

    it('does not disclose a plain stored message from an E2EE Session', async () => {
        const params = {
            sessionEncryptionMode: 'e2ee' as const,
            message: {
                id: 'mode-mismatch',
                seq: 1,
                localId: null,
                content: {
                    t: 'plain' as const,
                    v: { role: 'user', content: { type: 'text', text: 'Must not disclose' } },
                },
                createdAt: 1,
            },
        };

        await expect(readStoredSessionMessage(params)).resolves.toBeNull();
    });

    it('parses a plain content envelope', async () => {
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'Plain string message',
                    },
                    uuid: 'string-uuid',
                },
            },
        } as const;

        const parsed = await readStoredSessionRawRecord({ content: { t: 'plain', v: rawRecord } });
        expect(parsed?.role).toBe('agent');
        expect(parsed?.content.type).toBe('output');
    });

    it('parses a raw record directly (legacy payload)', async () => {
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'Plain string message',
                    },
                    uuid: 'string-uuid',
                },
            },
        } as const;

        const parsed = await readStoredSessionRawRecord({ content: rawRecord });
        expect(parsed?.role).toBe('agent');
        expect(parsed?.content.type).toBe('output');
    });

    it('parses a stringified plain content envelope (legacy payload)', async () => {
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'Plain string message',
                    },
                    uuid: 'string-uuid',
                },
            },
        } as const;

        const parsed = await readStoredSessionRawRecord({ content: JSON.stringify({ t: 'plain', v: rawRecord }) });
        expect(parsed?.role).toBe('agent');
        expect(parsed?.content.type).toBe('output');
    });

    it('parses a stringified raw record (legacy payload)', async () => {
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'Plain string message',
                    },
                    uuid: 'string-uuid',
                },
            },
        } as const;

        const parsed = await readStoredSessionRawRecord({ content: JSON.stringify(rawRecord) });
        expect(parsed?.role).toBe('agent');
        expect(parsed?.content.type).toBe('output');
    });

    it('preserves stored message role metadata when reading plain messages', async () => {
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'No response requested.' }],
                        model: '<synthetic>',
                        stop_reason: 'stop_sequence',
                        stop_sequence: '',
                    },
                    uuid: 'synthetic-uuid',
                },
            },
        } as const;

        const parsed = await readStoredSessionMessage({
            sessionEncryptionMode: 'plain',
            message: {
                id: 'msg-synthetic',
                seq: 12,
                localId: 'claude-jsonl:main:assistant:synthetic-uuid',
                messageRole: 'event',
                content: { t: 'plain', v: rawRecord },
                createdAt: 1_700,
            },
        });

        expect(parsed?.messageRole).toBe('event');
    });

    it('rejects current and future structured profiles after plain or E2EE decoding', async () => {
        const futureStructuredPresentation = {
            ...structuredPresentation,
            profile: 'pluginTranscriptV2',
            // A future structured root may superficially resemble a valid
            // legacy record. Its profile discriminator still reserves the
            // whole record from raw replay.
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'Must not reach the legacy reader',
                    },
                    uuid: 'future-structured-uuid',
                },
            },
        } as const;

        const readPlain = (content: unknown) => readStoredSessionMessage({
            sessionEncryptionMode: 'plain',
            message: {
                id: 'msg-structured-plain',
                seq: 13,
                localId: 'plugin:structured:plain',
                messageRole: 'agent',
                content: { t: 'plain', v: content },
                createdAt: 1_701,
            },
        });
        const readE2ee = (content: unknown) => readStoredSessionMessage({
            sessionEncryptionMode: 'e2ee',
            message: {
                id: 'msg-structured-e2ee',
                seq: 14,
                localId: 'plugin:structured:e2ee',
                messageRole: 'agent',
                content: { t: 'encrypted', c: 'ciphertext' },
                createdAt: 1_702,
            },
            decryptMessage: async (message) => ({
                id: message.id,
                seq: message.seq,
                localId: message.localId ?? null,
                messageRole: message.messageRole ?? null,
                content,
                createdAt: message.createdAt,
            }),
        });

        await expect(readPlain(structuredPresentation)).resolves.toMatchObject({ content: null });
        await expect(readPlain(futureStructuredPresentation)).resolves.toMatchObject({ content: null });
        await expect(readE2ee(structuredPresentation)).resolves.toMatchObject({ content: null });
        await expect(readE2ee(futureStructuredPresentation)).resolves.toMatchObject({ content: null });
    });

    it('preserves ordinary RawRecord content and incumbent happier metadata after plain or E2EE decoding', async () => {
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'Ordinary transcript record',
                    },
                    uuid: 'ordinary-e2ee-uuid',
                },
            },
            meta: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: { sessionId: 's1', comments: [] },
                },
            },
        } as const;

        const parsedPlain = await readStoredSessionMessage({
            sessionEncryptionMode: 'plain',
            message: {
                id: 'msg-ordinary-plain',
                seq: 15,
                localId: null,
                messageRole: 'agent',
                content: { t: 'plain', v: rawRecord },
                createdAt: 1_703,
            },
        });
        const parsedE2ee = await readStoredSessionMessage({
            sessionEncryptionMode: 'e2ee',
            message: {
                id: 'msg-ordinary-e2ee',
                seq: 16,
                localId: null,
                messageRole: 'agent',
                content: { t: 'encrypted', c: 'ciphertext' },
                createdAt: 1_703,
            },
            decryptMessage: async (message) => ({
                id: message.id,
                seq: message.seq,
                localId: message.localId ?? null,
                messageRole: message.messageRole ?? null,
                content: rawRecord,
                createdAt: message.createdAt,
            }),
        });

        expect(parsedPlain?.content).toEqual(rawRecord);
        expect(parsedE2ee?.content).toEqual(rawRecord);
    });
});
