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

    it('sends plaintext pending updates when session encryptionMode is plain', async () => {
        const sessionId = 's_test_plain_update';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.setState(
            {
                ...storage.getState(),
                sessions: {
                    ...storage.getState().sessions,
                    [sessionId]: {
                        ...buildSession({ sessionId, overrides: { encryptionMode: 'plain' } }),
                        metadata: { path: '/tmp', host: 'h' },
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
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'old' },
                meta: {},
            },
        });

        let capturedContent: any = null;
        const request = async (_path: string, init?: RequestInit) => {
            const parsed = JSON.parse(String(init?.body ?? 'null'));
            capturedContent = parsed?.content ?? null;
            return new Response('{}', { status: 200 });
        };

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'new text',
            encryption,
            request,
        });

        expect(capturedContent).toEqual(expect.objectContaining({ t: 'plain', v: expect.any(Object) }));
        expect(capturedContent?.v?.content?.text).toBe('new text');
    });

    it('injects execution-run guidance into appendSystemPrompt when enabled in settings', async () => {
        const sessionId = 's_test_guidance';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 6 });

        storage.setState(
            {
                ...storage.getState(),
                settings: {
                    ...storage.getState().settings,
                    experiments: true,
                    featureToggles: {
                        ...(storage.getState().settings as any)?.featureToggles,
                        'execution.runs': true,
                    },
                    executionRunsGuidanceEnabled: true,
                    executionRunsGuidanceMaxChars: 10_000,
                    executionRunsGuidanceEntries: [
                        { id: 'g1', title: 'Rule 1', description: 'Always use execution runs for code reviews.', enabled: true },
                    ],
                },
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
            id: 'p_guidance_1',
            localId: 'p_guidance_1',
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
            pendingId: 'p_guidance_1',
            text: 'new text',
            encryption,
            request,
        });

        const sessionEncryption = getSessionEncryptionOrThrow({ encryption, sessionId });
        const decrypted = await sessionEncryption.decryptRaw(capturedCiphertext!);
        expect(typeof decrypted?.meta?.appendSystemPrompt).toBe('string');
        expect(String(decrypted?.meta?.appendSystemPrompt)).toContain(systemPrompt);
        expect(String(decrypted?.meta?.appendSystemPrompt)).toContain('Always use execution runs for code reviews.');
    });

    it('does not inject execution-run guidance when execution runs feature is disabled', async () => {
        const sessionId = 's_test_guidance_disabled';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 9 });

        storage.setState(
            {
                ...storage.getState(),
                settings: {
                    ...storage.getState().settings,
                    experiments: false,
                    featureToggles: {
                        ...(storage.getState().settings as any)?.featureToggles,
                        'execution.runs': false,
                    },
                    executionRunsGuidanceEnabled: true,
                    executionRunsGuidanceMaxChars: 10_000,
                    executionRunsGuidanceEntries: [
                        { id: 'g1', title: 'Rule 1', description: 'Always use execution runs for code reviews.', enabled: true },
                    ],
                },
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
            id: 'p_guidance_disabled_1',
            localId: 'p_guidance_disabled_1',
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
            pendingId: 'p_guidance_disabled_1',
            text: 'new text',
            encryption,
            request,
        });

        const sessionEncryption = getSessionEncryptionOrThrow({ encryption, sessionId });
        const decrypted = await sessionEncryption.decryptRaw(capturedCiphertext!);
        expect(decrypted?.meta?.appendSystemPrompt).toBe(systemPrompt);
        expect(String(decrypted?.meta?.appendSystemPrompt)).not.toContain('Always use execution runs for code reviews.');
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
