import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '../storage';
import type { DiscardedPendingMessage } from '../storageTypes';

import { fetchAndApplyPendingMessagesV2 } from './pendingQueueV2';
import { createPendingQueueEncryption, resetPendingQueueState } from './pendingQueueV2.testHelpers';

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
});
