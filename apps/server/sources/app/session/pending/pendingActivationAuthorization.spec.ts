import { describe, expect, it, vi } from 'vitest';

import {
    armPendingActivationAuthorizationInTx,
    clearPendingActivationAuthorizationForPublisherActivityData,
    mapPendingActivationAuthorization,
    markPendingActivationAuthorizationFailedInTx,
    reconcilePendingActivationAuthorizationForRemovedRequestInTx,
} from './pendingActivationAuthorization';

function createTx(session: Record<string, unknown>, row?: Record<string, unknown>) {
    const updateMany = vi.fn(async ({ where, data }: any) => {
        if (where.pendingActivationRequestId && where.pendingActivationRequestId !== session.pendingActivationRequestId) return { count: 0 };
        if (where.pendingActivationRequestedAt && where.pendingActivationRequestedAt.getTime() !== (session.pendingActivationRequestedAt as Date)?.getTime()) return { count: 0 };
        if (where.pendingActivationStatus && where.pendingActivationStatus !== session.pendingActivationStatus) return { count: 0 };
        if (where.lastActiveAt?.lt && (session.lastActiveAt as Date).getTime() >= where.lastActiveAt.lt.getTime()) return { count: 0 };
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
            findUnique: vi.fn(async () => row ?? {
                localId: 'p1',
                messageRole: 'user',
                status: 'queued',
                deliveryState: null,
                providerAction: null,
                requestedAction: { v: 1, kind: 'send_now' },
                authorAccountId: 'owner',
                inputAdmissionReceipt: {
                    v: 1,
                    issuer: 'authenticatedAccount',
                    actorAccountId: 'owner',
                    sessionRelationship: 'owner',
                },
            }),
        },
    } as any;
}

describe('pending activation authorization owner', () => {
    it('arms an eligible Account-authored send_now beyond the publisher fence', async () => {
        const session = {
            accountId: 'owner',
            lastActiveAt: new Date(100),
            pendingActivationRequestId: null,
            pendingActivationRequestedAt: null,
            pendingActivationStatus: null,
            pendingActivationFailureCode: null,
        };
        const result = await armPendingActivationAuthorizationInTx({
            tx: createTx(session),
            currentAccess: { accountId: 'owner', sessionId: 's1', level: 'owner' },
            sessionId: 's1',
            requestId: 'p1',
            now: new Date(50),
        });
        expect(result).toEqual({ accountId: 'owner', requestId: 'p1' });
        expect(session).toMatchObject({
            pendingActivationRequestId: 'p1',
            pendingActivationRequestedAt: new Date(101),
            pendingActivationStatus: 'waiting',
            pendingActivationFailureCode: null,
        });
    });

    it('rearms a same-action retry with a fresh timestamp', async () => {
        const session = {
            accountId: 'owner',
            lastActiveAt: new Date(100),
            pendingActivationRequestId: 'p1',
            pendingActivationRequestedAt: new Date(101),
            pendingActivationStatus: 'failed',
            pendingActivationFailureCode: 'runtime_start_failed',
        };
        await armPendingActivationAuthorizationInTx({
            tx: createTx(session),
            currentAccess: { accountId: 'owner', sessionId: 's1', level: 'owner' },
            sessionId: 's1',
            requestId: 'p1',
            now: new Date(90),
        });
        expect(session).toMatchObject({
            pendingActivationRequestedAt: new Date(102),
            pendingActivationStatus: 'waiting',
            pendingActivationFailureCode: null,
        });
    });

    it('arms an Account-authored enqueue row only for an explicit resume-on-availability request', async () => {
        const session = {
            accountId: 'owner',
            lastActiveAt: new Date(100),
            pendingActivationRequestId: null,
            pendingActivationRequestedAt: null,
            pendingActivationStatus: null,
            pendingActivationFailureCode: null,
        };
        const row = {
            localId: 'p1',
            messageRole: 'user',
            status: 'queued',
            deliveryState: null,
            providerAction: null,
            requestedAction: { v: 1, kind: 'enqueue' },
            authorAccountId: null,
            inputAdmissionReceipt: {
                v: 1,
                issuer: 'authenticatedAccount',
                actorAccountId: 'owner',
                sessionRelationship: 'owner',
            },
        };
        const tx = createTx(session, row);

        await expect(armPendingActivationAuthorizationInTx({
            tx,
            sessionId: 's1',
            requestId: 'p1',
            currentAccess: { accountId: 'owner', sessionId: 's1', level: 'owner' },
        })).resolves.toBeUndefined();
        await expect(armPendingActivationAuthorizationInTx({
            tx,
            sessionId: 's1',
            requestId: 'p1',
            resumeWhenAvailable: true,
            currentAccess: { accountId: 'owner', sessionId: 's1', level: 'owner' },
        })).resolves.toEqual({ accountId: 'owner', requestId: 'p1' });
    });

    it('fails closed when the mutable author projection conflicts with the immutable Account receipt', async () => {
        const session = {
            accountId: 'owner',
            lastActiveAt: new Date(100),
            pendingActivationRequestId: null,
            pendingActivationRequestedAt: null,
            pendingActivationStatus: null,
            pendingActivationFailureCode: null,
        };
        const tx = createTx(session, {
            messageRole: 'user',
            status: 'queued',
            deliveryState: null,
            providerAction: null,
            requestedAction: { v: 1, kind: 'send_now' },
            authorAccountId: 'attacker',
            inputAdmissionReceipt: {
                v: 1,
                issuer: 'authenticatedAccount',
                actorAccountId: 'owner',
                sessionRelationship: 'owner',
            },
        });

        await expect(armPendingActivationAuthorizationInTx({
            tx,
            sessionId: 's1',
            requestId: 'p1',
            currentAccess: { accountId: 'owner', sessionId: 's1', level: 'owner' },
        })).resolves.toBeUndefined();
        expect(tx.session.update).not.toHaveBeenCalled();
    });

    it.each([
        ['machine admission', { row: { inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } } }],
        ['malformed receipt', { row: { inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: '' } } }],
        ['different receipt actor', { row: { inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'shared', sessionRelationship: 'sharedAdmin' } } }],
        ['non-user row', { row: { messageRole: 'agent' } }],
        ['blocked row', { row: { deliveryState: 'blocked' } }],
        ['claimed row', { row: { providerAction: 'send' } }],
        ['discarded row', { row: { status: 'discarded' } }],
        ['enqueue row', { row: { requestedAction: { v: 1, kind: 'enqueue' } } }],
    ])('does not arm %s', async (_label, override) => {
        const session = {
            accountId: 'owner',
            lastActiveAt: new Date(100),
            pendingActivationRequestedAt: null,
        };
        const baseRow = {
            localId: 'p1',
            messageRole: 'user',
            status: 'queued',
            deliveryState: null,
            providerAction: null,
            requestedAction: { v: 1, kind: 'send_now' },
            authorAccountId: 'owner',
            inputAdmissionReceipt: {
                v: 1,
                issuer: 'authenticatedAccount',
                actorAccountId: 'owner',
                sessionRelationship: 'owner',
            },
        };
        const tx = createTx(session, { ...baseRow, ...('row' in override ? override.row : {}) });
        await expect(armPendingActivationAuthorizationInTx({
            tx,
            sessionId: 's1',
            requestId: 'p1',
            currentAccess: { accountId: 'owner', sessionId: 's1', level: 'owner' },
        })).resolves.toBeUndefined();
        expect(tx.session.update).not.toHaveBeenCalled();
    });

    it('clears only the exact removed request and never retargets another row', async () => {
        const session = {
            accountId: 'owner',
            lastActiveAt: new Date(100),
            pendingActivationRequestId: 'p1',
            pendingActivationRequestedAt: new Date(101),
            pendingActivationStatus: 'waiting',
            pendingActivationFailureCode: null,
        };
        await reconcilePendingActivationAuthorizationForRemovedRequestInTx({
            tx: createTx(session),
            sessionId: 's1',
            requestId: 'p1',
        });
        expect(session).toMatchObject({
            pendingActivationRequestId: null,
            pendingActivationRequestedAt: null,
            pendingActivationStatus: null,
            pendingActivationFailureCode: null,
        });
    });

    it('does not clear or retarget when a different request is removed', async () => {
        const session = {
            accountId: 'owner',
            lastActiveAt: new Date(100),
            pendingActivationRequestId: 'newer',
            pendingActivationRequestedAt: new Date(103),
            pendingActivationStatus: 'waiting',
            pendingActivationFailureCode: null,
        };
        const tx = createTx(session);

        await expect(reconcilePendingActivationAuthorizationForRemovedRequestInTx({
            tx,
            sessionId: 's1',
            requestId: 'older',
        })).resolves.toBe(false);
        expect(tx.session.updateMany).not.toHaveBeenCalled();
        expect(session.pendingActivationRequestId).toBe('newer');
    });

    it('uses exact CAS so stale failures cannot overwrite a newer authorization', async () => {
        const session = {
            accountId: 'owner',
            lastActiveAt: new Date(100),
            pendingActivationRequestId: 'new',
            pendingActivationRequestedAt: new Date(103),
            pendingActivationStatus: 'waiting',
            pendingActivationFailureCode: null,
        };
        await expect(markPendingActivationAuthorizationFailedInTx({
            tx: createTx(session),
            sessionId: 's1',
            requestId: 'old',
            requestedAt: new Date(101),
            failureCode: 'runtime_start_failed',
        })).resolves.toBe(false);
        expect(session).toMatchObject({ pendingActivationRequestId: 'new', pendingActivationStatus: 'waiting' });
    });

    it('fences stale authorization at lastActiveAt and supplies an explicit publisher clear', () => {
        expect(mapPendingActivationAuthorization({
            lastActiveAt: new Date(102),
            pendingActivationRequestId: 'p1',
            pendingActivationRequestedAt: new Date(101),
            pendingActivationStatus: 'waiting',
            pendingActivationFailureCode: null,
        })).toBeUndefined();
        expect(clearPendingActivationAuthorizationForPublisherActivityData()).toEqual({
            pendingActivationRequestId: null,
            pendingActivationRequestedAt: null,
            pendingActivationStatus: null,
            pendingActivationFailureCode: null,
        });
    });
});
