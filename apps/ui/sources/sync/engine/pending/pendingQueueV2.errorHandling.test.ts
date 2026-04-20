import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import type { DiscardedPendingMessage } from '@/sync/domains/state/storageTypes';

import {
    deleteDiscardedPendingMessageV2,
    deletePendingMessageV2,
    discardPendingMessageV2,
    enqueuePendingMessageV2,
    fetchAndApplyPendingMessagesV2,
    reorderPendingMessagesV2,
    restoreDiscardedPendingMessageV2,
    updatePendingMessageV2,
} from './pendingQueueV2';
import { buildSession, createPendingQueueEncryption, resetPendingQueueState } from './pendingQueueV2.testHelpers';

function buildDiscardedPendingMessage(): DiscardedPendingMessage {
    return {
        id: 'd1',
        localId: 'd1',
        createdAt: 1,
        updatedAt: 1,
        text: 'x',
        rawRecord: { role: 'user', content: { type: 'text', text: 'x' } },
        discardedAt: 2,
        discardedReason: 'manual',
    };
}

async function expectNotAuthenticated(promise: Promise<unknown>, status: 401 | 403): Promise<void> {
    await expect(promise).rejects.toMatchObject({
        name: 'HappyError',
        canTryAgain: false,
        kind: 'auth',
        code: 'not_authenticated',
        status,
    });
}

function insertEditablePendingMessage(sessionId: string): void {
    storage.getState().applySessions([buildSession({ sessionId })]);
    storage.getState().upsertPendingMessage(sessionId, {
        id: 'p1',
        localId: 'p1',
        createdAt: 1,
        updatedAt: 1,
        text: 'original',
        rawRecord: {
            role: 'user',
            content: { type: 'text', text: 'original' },
            meta: {},
        },
    });
}

describe('pendingQueueV2 error handling', () => {
    beforeEach(() => {
        resetPendingQueueState();
    });

    it('clears discarded messages when the pending fetch fails', async () => {
        const sessionId = 's_test';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.getState().applyDiscardedPendingMessages(sessionId, [buildDiscardedPendingMessage()]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response('nope', { status: 500 }),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.discarded ?? []).toEqual([]);
        expect(pendingState?.isLoaded).toBe(true);
    });

    it('clears discarded messages when the pending response JSON shape is invalid', async () => {
        const sessionId = 's_test_bad_shape';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.getState().applyDiscardedPendingMessages(sessionId, [buildDiscardedPendingMessage()]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response(JSON.stringify({ pending: 'bad' }), { status: 200 }),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.discarded ?? []).toEqual([]);
        expect(pendingState?.isLoaded).toBe(true);
    });

    it('clears discarded messages when response JSON parsing fails', async () => {
        const sessionId = 's_test_parse_fail';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 6 });

        storage.getState().applyDiscardedPendingMessages(sessionId, [buildDiscardedPendingMessage()]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response('{', { status: 200 }),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.discarded ?? []).toEqual([]);
        expect(pendingState?.isLoaded).toBe(true);
    });

    it.each([401, 403])('maps pending enqueue HTTP %s to a non-retryable auth HappyError', async (status) => {
        const sessionId = `s_test_enqueue_auth_${status}`;
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 9 });

        await expect(
            enqueuePendingMessageV2({
                sessionId,
                text: 'hello',
                encryption,
                request: async () => new Response('auth failed', { status }),
            }),
        ).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            code: 'not_authenticated',
            canTryAgain: false,
            status,
        });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it.each([401, 403] as const)('surfaces pending fetch auth status %s as not_authenticated', async (status) => {
        const sessionId = `s_test_fetch_auth_${status}`;
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });
        const discarded = buildDiscardedPendingMessage();

        storage.getState().applyDiscardedPendingMessages(sessionId, [discarded]);

        await expectNotAuthenticated(
            fetchAndApplyPendingMessagesV2({
                sessionId,
                encryption,
                request: async () => new Response(null, { status }),
            }),
            status,
        );

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.discarded ?? []).toEqual([discarded]);
        expect(pendingState?.isLoaded ?? false).toBe(false);
    });

    it.each([401, 403] as const)('surfaces pending mutation auth status %s as not_authenticated', async (status) => {
        const sessionId = `s_test_mutation_auth_${status}`;
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });
        insertEditablePendingMessage(sessionId);
        const request = async () => new Response(null, { status });

        const mutations: Array<() => Promise<void>> = [
            () => updatePendingMessageV2({ sessionId, pendingId: 'p1', text: 'new text', encryption, request }),
            () => deletePendingMessageV2({ sessionId, pendingId: 'p1', request }),
            () => discardPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
            () => restoreDiscardedPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
            () => deleteDiscardedPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
            () => reorderPendingMessagesV2({ sessionId, orderedLocalIds: ['p1'], encryption, request }),
        ];

        for (const runMutation of mutations) {
            await expectNotAuthenticated(runMutation(), status);
        }
    });

    it('preserves pending enqueue request timeout errors without mapping them to auth failures', async () => {
        const sessionId = 's_test_enqueue_timeout';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 10 });
        const timeoutError = Object.assign(new Error('operation has timed out'), {
            name: 'ServerFetchConnectivityTimeoutError',
        });

        await expect(
            enqueuePendingMessageV2({
                sessionId,
                text: 'hello',
                encryption,
                request: async () => {
                    throw timeoutError;
                },
            }),
        ).rejects.toBe(timeoutError);

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });
});
