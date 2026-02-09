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
            getSessionEncryption: () => ({
                encryptRawRecord: async () => {
                    throw new Error('encrypt-failed');
                },
            }),
        } as Pick<Encryption, 'getSessionEncryption'> as Encryption;

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
});
