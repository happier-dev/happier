import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { systemPrompt } from '@/agents/prompt/systemPrompt';

import { updatePendingMessageV2 } from './pendingQueueV2';
import {
    buildSession,
    createPendingQueueEncryption,
    getSessionEncryptionOrThrow,
    resetPendingQueueState,
} from './pendingQueueV2.testHelpers';

describe('pendingQueueV2 updatePendingMessageV2', () => {
    beforeEach(() => {
        resetPendingQueueState();
    });

    it('preserves outgoing meta fields when existing.rawRecord is missing', async () => {
        const sessionId = 's_test';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.setState(
            {
                ...storage.getState(),
                sessions: {
                    ...storage.getState().sessions,
                    [sessionId]: {
                        ...buildSession({ sessionId }),
                        metadata: { path: '/tmp', host: 'h', flavor: 'claude' },
                        permissionMode: 'default',
                        modelMode: 'default',
                    } as Session,
                },
            },
            true,
        );

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1',
            localId: 'p1',
            createdAt: 1,
            updatedAt: 1,
            text: 'old',
            displayText: 'Old display',
            rawRecord: null,
        });

        let capturedCiphertext: string | null = null;
        const request = async (_path: string, init?: RequestInit) => {
            const parsed = JSON.parse(String(init?.body ?? 'null'));
            capturedCiphertext = typeof parsed?.ciphertext === 'string' ? parsed.ciphertext : null;
            return new Response('{}', { status: 200 });
        };

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'new text',
            encryption,
            request,
        });

        expect(capturedCiphertext).toEqual(expect.any(String));
        const sessionEncryption = getSessionEncryptionOrThrow({ encryption, sessionId });
        const decrypted = await sessionEncryption.decryptRaw(capturedCiphertext!);
        expect(decrypted).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'new text' },
        });

        expect(decrypted?.meta?.appendSystemPrompt).toBe(systemPrompt);
        expect(typeof decrypted?.meta?.source).toBe('string');
        expect(typeof decrypted?.meta?.sentFrom).toBe('string');
        expect(typeof decrypted?.meta?.permissionMode).toBe('string');
        expect(decrypted?.meta?.displayText).toBe('Old display');
    });

    it('throws when pending message does not exist', async () => {
        const sessionId = 's_test_not_found';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        await expect(
            updatePendingMessageV2({
                sessionId,
                pendingId: 'missing',
                text: 'new text',
                encryption,
                request: async () => new Response('{}', { status: 200 }),
            }),
        ).rejects.toThrow('Pending message not found');
    });

    it('does not mutate pending text when API update request fails', async () => {
        const sessionId = 's_test_api_fail';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 4 });

        storage.setState(
            {
                ...storage.getState(),
                sessions: {
                    ...storage.getState().sessions,
                    [sessionId]: {
                        ...buildSession({ sessionId }),
                        metadata: { path: '/tmp', host: 'h', flavor: 'claude' },
                        permissionMode: 'default',
                        modelMode: 'default',
                    } as Session,
                },
            },
            true,
        );

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1',
            localId: 'p1',
            createdAt: 1,
            updatedAt: 1,
            text: 'original',
            displayText: 'Original display',
            rawRecord: null,
        });

        await expect(
            updatePendingMessageV2({
                sessionId,
                pendingId: 'p1',
                text: 'new text',
                encryption,
                request: async () => new Response('{}', { status: 500 }),
            }),
        ).rejects.toThrow('Failed to update pending message (500)');

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending).toHaveLength(1);
        expect(pending[0]?.text).toBe('original');
        expect(pending[0]?.displayText).toBe('Original display');
    });
});
