import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PendingActivationFailureCodeV1Schema, PendingActivationFailureDetailsV1Schema, PendingActivationRuntimeFailureReasonV1Schema } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { SpawnSessionErrorCodeSchema } from '@happier-dev/protocol/spawnSession';
import {
    createAccountCursorRawQueryTransactionModel,
    createEmptySessionFollowEdgeTransactionModel,
} from '@/app/api/testkit/txHarness';

import { Prisma } from '@prisma/client';
import * as storageBoundary from '@/storage/prisma';
import { inTxPostgresControlStatementMock, installDbModuleMock } from '@/app/api/testkit/dbMocks';

// Transaction delegates are fixtures; supply the real Prisma metadata without
// opening a database connection or mocking activation policy.
const transaction = vi.fn();
installDbModuleMock({ ...storageBoundary, getActivePrismaRuntime: () => Prisma, db: { $transaction: transaction } });

const owner = await import('./pendingActivationAuthorization');
const { inTx } = await import('@/storage/inTx');
type Tx = import('@/storage/inTx').Tx;
const {
    mapPendingActivationAuthorization,
    mapPendingActivationFailureDetails,
} = owner;

async function runWithTx<T>(fixture: Tx, run: (tx: Tx) => Promise<T>): Promise<T> {
    transaction.mockImplementationOnce(async (callback: (tx: Tx) => Promise<unknown>) =>
        callback({ ...inTxPostgresControlStatementMock, ...fixture }));
    const result = await inTx(async tx => ({ value: await run(tx) }));
    return result.value;
}
const armPendingActivationAuthorizationInTx = (params: Parameters<typeof owner.armPendingActivationAuthorizationInTx>[0]) =>
    runWithTx(params.tx, tx => owner.armPendingActivationAuthorizationInTx({ ...params, tx }));
const markPendingActivationAuthorizationFailedInTx = (params: Parameters<typeof owner.markPendingActivationAuthorizationFailedInTx>[0]) =>
    runWithTx(params.tx, tx => owner.markPendingActivationAuthorizationFailedInTx({ ...params, tx }));
const reconcilePendingActivationAuthorizationForRemovedRequestInTx = (params: Parameters<typeof owner.reconcilePendingActivationAuthorizationForRemovedRequestInTx>[0]) =>
    runWithTx(params.tx, tx => owner.reconcilePendingActivationAuthorizationForRemovedRequestInTx({ ...params, tx }));

function createTx(session: Record<string, unknown>, row?: Record<string, unknown>) {
    const publication = () => ({
        id: 's1', accountId: 'owner', seq: 0, currentStorageState: 'hosted',
        account: { status: 'active' }, grants: [], 
        acceptedThroughServerSeq: null, materializationPublicationId: null,
        materializedThroughSourceAt: null, publishedThroughServerSeq: null,
        ...session,
    });
    const account = { update: vi.fn(async () => ({ seq: 1 })) };
    const accountChange = { upsert: vi.fn(async () => ({})) };
    const queryAccount = createAccountCursorRawQueryTransactionModel({ account, accountChange });
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
            findMany: vi.fn(async () => [publication()]),
            findUnique: vi.fn(async () => publication()),
            findUniqueOrThrow: vi.fn(async () => ({ ...session })),
            update: vi.fn(async ({ data }: any) => Object.assign(session, data)),
            updateMany,
        },
        account,
        accountChange,
        $queryRawUnsafe: vi.fn(async (query: string, ...values: unknown[]) => {
            if (query === 'SELECT "id" FROM "Session" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR NO KEY UPDATE') {
                return [{ id: 's1' }];
            }
            return queryAccount(query, ...values);
        }),
        sessionFollowEdge: createEmptySessionFollowEdgeTransactionModel(),
        sessionGrant: { findMany: vi.fn(async () => []) },
        
        
        managedMachine: { findUnique: vi.fn(async () => null) },
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
    it('preserves queueing, conditional steering, reset ownership, and explicit activation cancellation', () => {
        for (const kind of ['enqueue', 'steer_if_active']) {
            expect(owner.shouldArmPendingActivationAuthorization({ requestedAction: { kind } })).toBe(false);
        }
        expect(owner.shouldArmPendingActivationAuthorization({ requestedAction: { kind: 'reset_start' }, resumeWhenAvailable: true })).toBe(false);
        expect(owner.shouldArmPendingActivationAuthorization({ requestedAction: { kind: 'steer_now' }, resumeWhenAvailable: false })).toBe(false);
    });
    it('fits every admitted diagnostic in the existing MySQL VARCHAR(191) field', async () => {
        const migration = readFileSync(new URL('../../../../prisma/mysql/migrations/20260902120000_add_pending_activation_authorization/migration.sql', import.meta.url), 'utf8');
        const columnLimit = Number(migration.match(/`pendingActivationFailureCode` VARCHAR\((\d+)\)/)?.[1]);
        const longest = (values: readonly string[]) => values.reduce((a, b) => a.length >= b.length ? a : b);
        const failureCode = PendingActivationFailureCodeV1Schema.parse(longest(PendingActivationFailureCodeV1Schema.options));
        const session = { lastActiveAt: new Date(100), pendingActivationRequestId: 'p1',
            pendingActivationRequestedAt: new Date(101), pendingActivationStatus: 'waiting', pendingActivationFailureCode: null as string | null };
        const details = PendingActivationFailureDetailsV1Schema.parse({
            reason: longest(PendingActivationFailureDetailsV1Schema.shape.reason.options),
            spawnErrorCode: longest(SpawnSessionErrorCodeSchema.options),
            runtimeReason: longest(PendingActivationRuntimeFailureReasonV1Schema.options),
        });
        await markPendingActivationAuthorizationFailedInTx({ tx: createTx(session), sessionId: 's1', requestId: 'p1',
            requestedAt: new Date(101), failureCode, failureDetails: details });
        expect(session.pendingActivationFailureCode!.length).toBeLessThanOrEqual(columnLimit);
        expect(mapPendingActivationAuthorization(session)).toMatchObject({ status: 'failed', failureCode });
        expect(mapPendingActivationFailureDetails(session)).toEqual(details);
    });
    it('reads retained diagnostic objects and plain failure codes', () => {
        const session = { lastActiveAt: new Date(100), pendingActivationRequestId: 'p1',
            pendingActivationRequestedAt: new Date(101), pendingActivationStatus: 'failed' };
        const details = { reason: 'spawn-rejected', spawnErrorCode: 'SPAWN_VALIDATION_FAILED' };
        const retained = { ...session, pendingActivationFailureCode: JSON.stringify({ failureCode: 'runtime_start_failed', ...details }) };
        expect(mapPendingActivationFailureDetails(retained)).toEqual(details);
        expect(mapPendingActivationAuthorization(retained)).toMatchObject({ status: 'failed', failureCode: 'runtime_start_failed' });
        const plain = { ...session, pendingActivationFailureCode: 'runtime_start_failed' };
        expect(mapPendingActivationAuthorization(plain)).toMatchObject({ status: 'failed', failureCode: 'runtime_start_failed' });
        expect(mapPendingActivationFailureDetails(plain)).toBeUndefined();
    });
    it('retains failure diagnostics in the existing state while preserving the predecessor authorization projection', async () => {
        const session = { lastActiveAt: new Date(100), pendingActivationRequestId: 'p1',
            pendingActivationRequestedAt: new Date(101), pendingActivationStatus: 'waiting', pendingActivationFailureCode: null };
        await markPendingActivationAuthorizationFailedInTx({ tx: createTx(session), sessionId: 's1', requestId: 'p1',
            requestedAt: new Date(101), failureCode: 'runtime_start_failed',
            failureDetails: { reason: 'spawn-rejected', spawnErrorCode: 'SPAWN_VALIDATION_FAILED' } });
        expect(mapPendingActivationAuthorization(session)).toEqual({ requestId: 'p1', requestedAt: 101,
            status: 'failed', failureCode: 'runtime_start_failed' });
        expect(mapPendingActivationFailureDetails(session)).toEqual({ reason: 'spawn-rejected', spawnErrorCode: 'SPAWN_VALIDATION_FAILED' });
        expect(mapPendingActivationFailureDetails({ ...session, lastActiveAt: new Date(102) }))
            .toEqual({ reason: 'spawn-rejected', spawnErrorCode: 'SPAWN_VALIDATION_FAILED' });
        expect(mapPendingActivationAuthorization({ ...session, pendingActivationFailureCode: 'unknown_future_failure' })).toBeUndefined();
    });
    it.each(['send_now', 'steer_now'] as const)('arms an eligible Account-authored %s beyond the publisher fence', async (kind) => {
        const session = {
            accountId: 'owner',
            lastActiveAt: new Date(100),
            pendingActivationRequestId: null,
            pendingActivationRequestedAt: null,
            pendingActivationStatus: null,
            pendingActivationFailureCode: null,
        };
        const result = await armPendingActivationAuthorizationInTx({
            tx: createTx(session, {
                localId: 'p1', messageRole: 'user', status: 'queued', deliveryState: null,
                providerAction: null, requestedAction: { v: 1, kind }, authorAccountId: 'owner',
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount',
                    actorAccountId: 'owner', sessionRelationship: 'owner' },
            }),
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

    it('retains exact authorization after publisher activity until consumption or definite refusal', async () => {
        const session = {
            accountId: 'owner',
            lastActiveAt: new Date(102),
            pendingActivationRequestId: 'p1',
            pendingActivationRequestedAt: new Date(101),
            pendingActivationStatus: 'waiting',
            pendingActivationFailureCode: null,
        };
        expect(mapPendingActivationAuthorization(session)).toEqual({ requestId: 'p1', requestedAt: 101, status: 'waiting' });
        expect(await markPendingActivationAuthorizationFailedInTx({ tx: createTx(session), sessionId: 's1',
            requestId: 'p1', requestedAt: new Date(101), failureCode: 'runtime_start_failed' })).toBe(true);
        expect(mapPendingActivationAuthorization(session)).toMatchObject({ requestId: 'p1', status: 'failed' });
    });
});
