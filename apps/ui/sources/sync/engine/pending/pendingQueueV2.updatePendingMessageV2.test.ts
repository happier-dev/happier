import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
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

        expect(Object.prototype.hasOwnProperty.call(decrypted?.meta ?? {}, 'appendSystemPrompt')).toBe(false);
        expect(typeof decrypted?.meta?.source).toBe('string');
        expect(typeof decrypted?.meta?.sentFrom).toBe('string');
        expect(typeof decrypted?.meta?.permissionMode).toBe('string');
        expect(decrypted?.meta?.displayText).toBe('Old display');
    });

    it('marks encrypted pending update payloads as user messages', async () => {
        const sessionId = 's_test_update_message_role';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.setState(
            {
                ...storage.getState(),
                sessions: {
                    ...storage.getState().sessions,
                    [sessionId]: buildSession({ sessionId }) as Session,
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

        const bodies: unknown[] = [];
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'new text',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return new Response('{}', { status: 200 });
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(expect.objectContaining({
            ciphertext: expect.any(String),
            messageRole: 'user',
        }));
    });

    it('rebuilds rawRecord when existing.rawRecord is not a RawRecord (decrypt-failed placeholder)', async () => {
        const sessionId = 's_test_decrypt_failed_update';
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
            id: 'p_decrypt_failed_1',
            localId: 'p_decrypt_failed_1',
            createdAt: 1,
            updatedAt: 1,
            text: 'old',
            displayText: "Couldn't decrypt this pending message.",
            pendingDecryptFailure: { kind: 'decrypt_failed' },
            // This is the placeholder shape emitted by fetchAndApplyPendingMessagesV2 for decrypt failures.
            rawRecord: { pendingDecryptFailure: { kind: 'decrypt_failed' } },
        });

        let capturedCiphertext: string | null = null;
        const request = async (_path: string, init?: RequestInit) => {
            const parsed = JSON.parse(String(init?.body ?? 'null'));
            capturedCiphertext = typeof parsed?.ciphertext === 'string' ? parsed.ciphertext : null;
            return new Response('{}', { status: 200 });
        };

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p_decrypt_failed_1',
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

        // Updating a decrypt-failed placeholder should not preserve the placeholder display text.
        expect(decrypted?.meta?.displayText).toBeUndefined();

        const updated = storage.getState().sessionPending[sessionId]?.messages?.find((m) => m.id === 'p_decrypt_failed_1') ?? null;
        expect(updated?.pendingDecryptFailure).toBeUndefined();
        expect(updated?.displayText).toBeUndefined();
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

        let capturedBody: unknown = null;
        const request = async (_path: string, init?: RequestInit) => {
            capturedBody = JSON.parse(String(init?.body ?? 'null'));
            return new Response('{}', { status: 200 });
        };

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'new text',
            encryption,
            request,
        });

        expect(capturedBody).toEqual(expect.objectContaining({
            content: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
            messageRole: 'user',
        }));
        const capturedRecord = capturedBody as { content?: { v?: { content?: { text?: unknown } } } } | null;
        expect(capturedRecord?.content?.v?.content?.text).toBe('new text');
    });

    it('does not inject appendSystemPrompt even when execution-run guidance is enabled in settings', async () => {
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
        expect(Object.prototype.hasOwnProperty.call(decrypted?.meta ?? {}, 'appendSystemPrompt')).toBe(false);
    });

    it('still omits appendSystemPrompt when execution runs feature is disabled', async () => {
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
        expect(Object.prototype.hasOwnProperty.call(decrypted?.meta ?? {}, 'appendSystemPrompt')).toBe(false);
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

    it('clears pendingDecryptFailure when the user edits a decrypt-failure row', async () => {
        const sessionId = 's_update_pending_decrypt_failure';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 12 });

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
            text: '',
            displayText: 'Failed to decrypt',
            pendingDecryptFailure: { kind: 'decrypt_failed' },
            rawRecord: null,
        });

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'new text',
            encryption,
            request: async () => new Response('{}', { status: 200 }),
        });

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending).toHaveLength(1);
        expect(pending[0]?.text).toBe('new text');
        expect(pending[0]?.pendingDecryptFailure).toBeUndefined();
    });
});
