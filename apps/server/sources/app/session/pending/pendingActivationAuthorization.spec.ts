import { describe, expect, it, vi } from 'vitest';

import {
    armPendingActivationAuthorizationInTx,
    mapPendingActivationAuthorization,
    markPendingActivationAuthorizationFailedInTx,
    reconcilePendingActivationAuthorizationForRemovedRequestInTx,
} from './pendingActivationAuthorization';

function createTx(session: Record<string, unknown>, rows: Array<Record<string, unknown>> = []) {
    const updateMany = vi.fn(async ({ where, data }: any) => {
        if (where.pendingActivationRequestId && where.pendingActivationRequestId !== session.pendingActivationRequestId) return { count: 0 };
        if (where.pendingActivationRequestedAt && where.pendingActivationRequestedAt.getTime() !== (session.pendingActivationRequestedAt as Date)?.getTime()) return { count: 0 };
        if (where.pendingActivationStatus && where.pendingActivationStatus !== session.pendingActivationStatus) return { count: 0 };
        Object.assign(session, data);
        return { count: 1 };
    });
    return {
        session: {
            findUniqueOrThrow: vi.fn(async () => ({ ...session })),
            update: vi.fn(async ({ data }: any) => Object.assign(session, data)),
            updateMany,
        },
        sessionPendingMessage: {
            findUnique: vi.fn(async () => rows.find((row) => row.localId === 'p1') ?? {
                localId: 'p1', messageRole: 'user', status: 'queued', deliveryState: null,
                providerAction: null, requestedAction: { v: 1, kind: 'send_now' },
            }),
            findMany: vi.fn(async () => rows),
        },
    } as any;
}

describe('pending activation authorization owner', () => {
    it('arms send_now while Session.active is stale true and advances beyond lastActiveAt', async () => {
        const session = {
            accountId: 'owner', active: true, lastActiveAt: new Date(100),
            pendingActivationRequestId: null, pendingActivationRequestedAt: null,
            pendingActivationStatus: null, pendingActivationFailureCode: null,
        };
        const tx = createTx(session);
        const result = await armPendingActivationAuthorizationInTx({ tx, sessionId: 's1', requestId: 'p1', now: new Date(50) });
        expect(result).toEqual({ accountId: 'owner', requestId: 'p1' });
        expect(session.pendingActivationRequestedAt).toEqual(new Date(101));
        expect(session).toMatchObject({ pendingActivationRequestId: 'p1', pendingActivationStatus: 'waiting', pendingActivationFailureCode: null });
    });

    it('refreshes the timestamp for a same-action retry', async () => {
        const session = {
            accountId: 'owner', active: false, lastActiveAt: new Date(100),
            pendingActivationRequestId: 'p1', pendingActivationRequestedAt: new Date(101),
            pendingActivationStatus: 'failed', pendingActivationFailureCode: 'runtime_start_failed',
        };
        const tx = createTx(session);
        await armPendingActivationAuthorizationInTx({ tx, sessionId: 's1', requestId: 'p1', now: new Date(90) });
        expect((session.pendingActivationRequestedAt as Date).getTime()).toBe(102);
        expect(session).toMatchObject({ pendingActivationStatus: 'waiting', pendingActivationFailureCode: null });
    });

    it('clears a removed current request even when another send_now row exists', async () => {
        const session = {
            accountId: 'owner', active: false, lastActiveAt: new Date(100),
            pendingActivationRequestId: 'p1', pendingActivationRequestedAt: new Date(101),
            pendingActivationStatus: 'waiting', pendingActivationFailureCode: null,
        };
        const tx = createTx(session, [
            { localId: 'enqueue', requestedAction: { v: 1, kind: 'enqueue' } },
            { localId: 'p2', messageRole: 'user', status: 'queued', deliveryState: null, providerAction: null, requestedAction: { v: 1, kind: 'send_now' } },
            { localId: 'p3', messageRole: 'user', status: 'queued', deliveryState: null, providerAction: null, requestedAction: { v: 1, kind: 'send_now' } },
        ]);
        const result = await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId: 's1', requestId: 'p1', now: new Date(50) });
        expect(result).toBeUndefined();
        expect(session).toMatchObject({
            pendingActivationRequestId: null,
            pendingActivationRequestedAt: null,
            pendingActivationStatus: null,
            pendingActivationFailureCode: null,
        });
    });

    it('uses exact CAS so an old failure cannot overwrite a newer authorization', async () => {
        const session = {
            accountId: 'owner', active: false, lastActiveAt: new Date(100),
            pendingActivationRequestId: 'new', pendingActivationRequestedAt: new Date(103),
            pendingActivationStatus: 'waiting', pendingActivationFailureCode: null,
        };
        const tx = createTx(session);
        const result = await markPendingActivationAuthorizationFailedInTx({
            tx, sessionId: 's1', requestId: 'old', requestedAt: new Date(101), failureCode: 'runtime_start_failed',
        });
        expect(result).toBe(false);
        expect(session).toMatchObject({ pendingActivationRequestId: 'new', pendingActivationStatus: 'waiting' });
    });

    it('omits an authorization once publisher activity reaches its lifecycle fence', () => {
        expect(mapPendingActivationAuthorization({
            lastActiveAt: new Date(102),
            pendingActivationRequestId: 'p1',
            pendingActivationRequestedAt: new Date(101),
            pendingActivationStatus: 'waiting',
            pendingActivationFailureCode: null,
        })).toBeUndefined();
    });

    it('does not arm non-user, blocked, or already-claimed rows', async () => {
        for (const row of [
            { localId: 'p1', messageRole: 'agent', status: 'queued', deliveryState: null, providerAction: null, requestedAction: { v: 1, kind: 'send_now' } },
            { localId: 'p1', messageRole: 'user', status: 'queued', deliveryState: 'blocked', providerAction: null, requestedAction: { v: 1, kind: 'send_now' } },
            { localId: 'p1', messageRole: 'user', status: 'queued', deliveryState: null, providerAction: 'send', requestedAction: { v: 1, kind: 'send_now' } },
        ]) {
            const session = { accountId: 'owner', lastActiveAt: new Date(100), pendingActivationRequestedAt: null };
            const tx = createTx(session, [row]);
            await expect(armPendingActivationAuthorizationInTx({ tx, sessionId: 's1', requestId: 'p1' })).resolves.toBeUndefined();
            expect(tx.session.update).not.toHaveBeenCalled();
        }
    });
});
