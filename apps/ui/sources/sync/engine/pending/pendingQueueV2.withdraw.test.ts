import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { deletePendingMessageV2 } from './pendingQueueV2';
import { resetPendingQueueState } from './pendingQueueV2.testHelpers';

beforeAll(loadSyncSingletonForTests);

describe('pending withdrawal custody', () => {
    const outboxScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    const sessionId = 'session-withdraw';
    beforeEach(async () => {
        await resetPendingQueueState(outboxScope);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'pending-row', localId: 'pending-local', source: 'server_pending',
            pendingDeliveryStatus: 'server_queued', createdAt: 1, updatedAt: 1,
            text: 'expanded transport text', displayText: 'Original typed text', rawRecord: null,
        });
    });

    it('preserves older-server custody without falling back to its mutating legacy DELETE', async () => {
        // The 0.2 predecessor ignores an unknown withdraw query on its DELETE.
        // Model that genuine HTTP boundary: only its incumbent DELETE mutates.
        let serverQueuedDocument: string | null = 'Original typed text';
        const mutations: string[] = [];
        const outcome = await deletePendingMessageV2({
            sessionId, pendingId: 'pending-row', outboxScope, withdraw: true,
            request: async (path, init) => {
                if (init?.method === 'DELETE') {
                    mutations.push(path);
                    serverQueuedDocument = null;
                    return Response.json({ ok: true, pendingVersion: 2, pendingCount: 0 });
                }
                return Response.json({ error: 'not_found' }, { status: 404 });
            },
        });
        expect(outcome).toBe('delivery_unknown');
        expect(serverQueuedDocument).toBe('Original typed text');
        expect(mutations).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toHaveLength(1);
    });

    it('removes the local projection only after the qualified owner confirms removal', async () => {
        const paths: string[] = [];
        const result = await deletePendingMessageV2({
            sessionId, pendingId: 'pending-row', outboxScope, withdraw: true,
            request: async (path) => {
                paths.push(path);
                return new Response(JSON.stringify({ ok: true, outcome: 'removed' }));
            },
        });
        expect(result).toBe('removed');
        expect(paths).toEqual(['/v2/sessions/session-withdraw/pending/pending-local/withdraw']);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it.each(['already_delivered', 'delivery_unknown', undefined] as const)(
        'does not turn %s custody into a removed message', async (outcome) => {
            const result = await deletePendingMessageV2({
                sessionId, pendingId: 'pending-row', outboxScope, withdraw: true,
                request: async () => new Response(JSON.stringify({ ok: true, outcome })),
            });
            expect(result).toBe(outcome ?? 'delivery_unknown');
            expect(storage.getState().sessionPending[sessionId]?.messages).toHaveLength(1);
        },
    );

    it('does not remove a replacement Home projection after the original owner retires', async () => {
        let current = true;
        const result = await deletePendingMessageV2({
            sessionId, pendingId: 'pending-row', outboxScope, withdraw: true,
            isOutboxScopeCurrent: () => current,
            request: async () => {
                current = false;
                return new Response(JSON.stringify({ ok: true, outcome: 'removed' }));
            },
        });
        expect(result).toBe('removed');
        expect(storage.getState().sessionPending[sessionId]?.messages).toHaveLength(1);
    });

    it('reports unknown for a malformed removal acknowledgement without removing the local document', async () => {
        const result = await deletePendingMessageV2({
            sessionId, pendingId: 'pending-row', outboxScope, withdraw: true,
            request: async () => new Response('not-json'),
        });
        expect(result).toBe('delivery_unknown');
        expect(storage.getState().sessionPending[sessionId]?.messages).toHaveLength(1);
    });

    it('does not restore a removal claim inside a non-successful acknowledgement', async () => {
        const result = await deletePendingMessageV2({
            sessionId, pendingId: 'pending-row', outboxScope, withdraw: true,
            request: async () => Response.json({ ok: false, outcome: 'removed' }),
        });
        expect(result).toBe('delivery_unknown');
        expect(storage.getState().sessionPending[sessionId]?.messages).toHaveLength(1);
    });

    it('does not redirect an ordinary queued message into an unrelated execution run', async () => {
        let requested = false;
        const result = await deletePendingMessageV2({
            sessionId, pendingId: 'pending-row', outboxScope, withdraw: true, targetExecutionRunId: 'other-run',
            request: async () => { requested = true; return new Response(JSON.stringify({ outcome: 'removed' })); },
        });
        expect(result).toBe('delivery_unknown');
        expect(requested).toBe(false);
        expect(storage.getState().sessionPending[sessionId]?.messages).toHaveLength(1);
    });
});
