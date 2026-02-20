import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';

import { enqueuePendingMessageV2 } from './pendingQueueV2';
import { buildSession, createPendingQueueEncryption, resetPendingQueueState } from './pendingQueueV2.testHelpers';

describe('pendingQueueV2 optimistic thinking', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        resetPendingQueueState();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('clears optimistic thinking after successful enqueue', async () => {
        const sessionId = 's_test';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();

        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async () => new Response(null, { status: 200 }),
        });

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('clears optimistic thinking when encryption fails', async () => {
        const sessionId = 's_test_encrypt_fail';
        storage.getState().applySessions([buildSession({ sessionId })]);

        const encryption = {
            getSessionEncryption: () =>
                ({
                    encryptRawRecord: async () => {
                        throw new Error('encrypt-failed');
                    },
                }) as unknown as ReturnType<Encryption['getSessionEncryption']>,
        } as unknown as Encryption;

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();

        const promise = enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async () => new Response(null, { status: 200 }),
        }).catch(() => null);

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        await promise;

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('includes provider-specific message meta extras for queued sends', async () => {
        const sessionId = 's_test_provider_meta';
        storage.getState().applySessions([
            {
                ...buildSession({ sessionId }),
                metadata: { path: '/tmp', host: 'h', flavor: 'claude' } as Session['metadata'],
            },
        ]);
        storage.setState(
            {
                ...storage.getState(),
                settings: settingsParse({
                    claudeRemoteAgentSdkEnabled: true,
                    claudeRemoteSettingSources: 'project',
                }),
            },
            true,
        );

        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async () => new Response(null, { status: 200 }),
        });

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.length).toBe(1);
        const metadata = pending[0]?.rawRecord?.meta as Record<string, unknown> | undefined;
        expect(metadata?.claudeRemoteAgentSdkEnabled).toBe(true);
        expect(metadata?.claudeRemoteSettingSources).toBe('project');
    });

    it('includes metaOverrides (e.g. meta.happier) for queued sends', async () => {
        const sessionId = 's_test_meta_overrides';
        storage.getState().applySessions([buildSession({ sessionId })]);

        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            metaOverrides: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: { sessionId, comments: [] },
                },
            },
            request: async () => new Response(null, { status: 200 }),
        });

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.length).toBe(1);
        const metadata = pending[0]?.rawRecord?.meta as Record<string, unknown> | undefined;
        expect((metadata as any)?.happier?.kind).toBe('review_comments.v1');
    });

    it('removes queued pending message and clears optimistic thinking when enqueue request fails', async () => {
        const sessionId = 's_test_request_fail';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        await expect(
            enqueuePendingMessageV2({
                sessionId,
                text: 'hello',
                encryption,
                request: async () => new Response(null, { status: 500 }),
            }),
        ).rejects.toThrow('Failed to enqueue pending message (500)');

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('sends plaintext pending payloads when session encryptionMode is plain', async () => {
        const sessionId = 's_test_plain_send';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        const bodies: unknown[] = [];
        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return new Response(null, { status: 200 });
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(
            expect.objectContaining({
                localId: expect.any(String),
                content: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
            }),
        );
        expect(bodies[0]).not.toEqual(expect.objectContaining({ ciphertext: expect.anything() }));
    });

    it('does not require a session encryption key when session encryptionMode is plain', async () => {
        const sessionId = 's_test_plain_send_no_key';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);

        const bodies: unknown[] = [];
        const encryptionWithoutSessionKey = {
            getSessionEncryption: () => null,
        } as unknown as Encryption;
        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption: encryptionWithoutSessionKey,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return new Response(null, { status: 200 });
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(
            expect.objectContaining({
                localId: expect.any(String),
                content: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
            }),
        );
        expect(bodies[0]).not.toEqual(expect.objectContaining({ ciphertext: expect.anything() }));
    });
});
