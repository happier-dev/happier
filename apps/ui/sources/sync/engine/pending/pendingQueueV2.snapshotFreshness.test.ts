import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

beforeAll(loadSyncSingletonForTests);

import { createPendingQueueEncryption, getSessionEncryptionOrThrow } from './pendingQueueV2.testHelpers';
import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import { filterCommittedTranscriptMessageIdsForPendingState } from '@/sync/domains/pending/pendingTranscriptProjection';

import { fetchAndApplyPendingMessagesV2 } from './pendingQueueV2';
import { buildSession, resetPendingQueueState } from './pendingQueueV2.testHelpers';

const sessionId = 'snapshot-freshness-session';
const localId = 'first-message';
const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

function deliveringResponse() {
    return Response.json({ pending: [{
        localId,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' }, meta: {} } },
        requestedAction: { v: 1, kind: 'enqueue' },
        status: 'queued', deliveryState: 'delivering', position: 0,
        createdAt: 1_000, updatedAt: 1_100, discardedAt: null, discardedReason: null,
    }] });
}

describe('pending snapshot freshness on a newly opened session', () => {
    beforeEach(async () => { await resetPendingQueueState(scope); });

    it.each([false, true])('does not restore delivering after settlement (successor refresh: %s)', async (successor) => {
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain', pendingVersion: 1 } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1_000, updatedAt: 1_100,
            source: 'server_pending', text: 'hello', pendingDeliveryStatus: 'server_delivering',
            rawRecord: { role: 'user', content: { type: 'text', text: 'hello' } },
        });
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const request = vi.fn(async () => { await gate; return deliveringResponse(); });
        const params = { sessionId, encryption, outboxScope: scope, isOutboxScopeCurrent: () => true, request };
        const oldRefresh = fetchAndApplyPendingMessagesV2(params);
        // The transaction commits the first message and removes its pending row. This client had
        // no transcript sequence at capture, so the existing sequence fence cannot protect it.
        storage.getState().applyMessages(sessionId, [{
            id: 'committed-first', seq: 2, localId, createdAt: 2_000, isSidechain: false,
            role: 'user', content: { type: 'text', text: 'hello' },
        }]);
        storage.getState().applyMessagesLoaded(sessionId);
        storage.getState().applySessions([{ ...storage.getState().sessions[sessionId], pendingVersion: 2, pendingCount: 0 }]);
        storage.getState().pruneServerPendingMessages(sessionId);
        const freshRefresh = successor
            ? fetchAndApplyPendingMessagesV2({ ...params, request: async () => Response.json({ pending: [] }) })
            : Promise.resolve();
        release();
        await Promise.all([oldRefresh, freshRefresh]);
        const state = storage.getState();
        expect(state.sessionPending[sessionId].messages).toEqual([]);
        const transcript = state.sessionMessages[sessionId];
        const visibleIds = filterCommittedTranscriptMessageIdsForPendingState({
            messageIdsOldestFirst: transcript.messageIdsOldestFirst,
            messagesById: transcript.messagesById,
            pendingMessages: state.sessionPending[sessionId].messages,
        });
        expect(visibleIds.some((id) => transcript.messagesById[id]?.localId === localId)).toBe(true);
    });

    it('rejects an older snapshot after a receipt updates a cache-only session', async () => {
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain', pendingVersion: 1 } })]);
        storage.getState().applyServerScopedSessionListRows(scope.serverId, [buildSession({ sessionId, overrides: { encryptionMode: 'plain', pendingVersion: 1 } })], { source: 'ordinary', mode: 'replace' });
        storage.setState({ sessions: {} });
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const oldRefresh = fetchAndApplyPendingMessagesV2({
            sessionId, encryption, outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => { await gate; return deliveringResponse(); },
        });
        storage.getState().applyServerScopedSessionListRowPatches(scope.serverId, [{ sessionId, patch: { pendingVersion: 2, pendingCount: 0 } }]);
        release();
        await oldRefresh;
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('starts a readable refresh when session encryption becomes available during an older read', async () => {
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        const readyEncryption = await createPendingQueueEncryption({ sessionId });
        const ciphertext = await getSessionEncryptionOrThrow({ encryption: readyEncryption, sessionId }).encryptRawRecord({
            role: 'user', content: { type: 'text', text: 'readable after key initialization' },
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const request = async () => {
            await gate;
            return Response.json({ pending: [{
                localId, content: { t: 'encrypted', c: ciphertext }, requestedAction: { v: 1, kind: 'enqueue' },
                status: 'queued', position: 0, createdAt: 1, updatedAt: 1,
            }] });
        };
        const params = { sessionId, encryption, request, outboxScope: scope, isOutboxScopeCurrent: () => true };
        const first = fetchAndApplyPendingMessagesV2(params);
        const second = fetchAndApplyPendingMessagesV2({ ...params, encryption: readyEncryption });
        release();
        await Promise.all([first, second]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'readable after key initialization' }),
        ]);
    });

    it('refreshes with the current transport after an older caller retires', async () => {
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        let current = true;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const first = fetchAndApplyPendingMessagesV2({
            sessionId, encryption, outboxScope: scope, isOutboxScopeCurrent: () => current,
            request: async () => { await gate; return deliveringResponse(); },
        });
        current = false;
        const second = fetchAndApplyPendingMessagesV2({
            sessionId, encryption, outboxScope: scope, isOutboxScopeCurrent: () => true,
            request: async () => deliveringResponse(),
        });
        release();
        await Promise.all([first, second]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'hello' }),
        ]);
    });

    it('shares one complete refresh while its session freshness is unchanged', async () => {
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const request = vi.fn(async () => { await gate; return deliveringResponse(); });
        const params = {
            sessionId, encryption, request, outboxScope: scope,
            isOutboxScopeCurrent: () => true,
        };
        const first = fetchAndApplyPendingMessagesV2(params);
        const second = fetchAndApplyPendingMessagesV2(params);
        release();
        await Promise.all([first, second]);
        expect(storage.getState().sessionPending[sessionId].messages.map((message) => message.localId)).toEqual([localId]);
        // Both callers settle through the same reconciliation, rather than decrypting and
        // publishing the same response independently.
        expect(request).toHaveBeenCalledTimes(1);
    });
});
