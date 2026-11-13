import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { db, initDbPostgres } from '@/storage/db';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { inTx, type Tx } from '@/storage/inTx';
import { enqueuePendingMessageByAuthenticatedMachine } from './pendingMessageService';
import { reserveNextPendingQueuePosition } from './reserveNextPendingQueuePosition';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { readDatabaseTransactionConfigFromEnv } from '@/config/databaseTransactions';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Pending Machine admission under PostgreSQL Session startup contention', () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL for PostgreSQL contract');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    // R8-B2 handoff to the plugin-platform Account-write owner (2026-10-12).
    // Retained regression/evidence; this lane is stopped from further B2 implementation.
    it('admits mutually shared hosted Sessions without an Account lock cycle', async () => {
        const accounts = await Promise.all([0, 1].map(() => db.account.create({ data: {
            publicKey: `pending-shared-${randomUUID()}`,
        } })));
        const originalTransaction = db.$transaction;
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', `srv_${'a'.repeat(32)}`);
        try {
            const machines = await Promise.all(accounts.map(account => db.machine.create({ data: {
                id: randomUUID(), accountId: account.id, metadata: '{}', installationId: randomUUID(),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            } })));
            const sessions = await Promise.all(accounts.map(account => db.session.create({ data: {
                accountId: account.id, tag: randomUUID(), metadata: '{}', currentStorageState: 'hosted',
            } })));
            for (const [index, session] of sessions.entries()) {
                await db.accessKey.create({ data: {
                    accountId: accounts[index].id, machineId: machines[index].id, sessionId: session.id, data: 'encrypted',
                } });
                await db.sessionGrant.create({ data: { principalKind: 'account',
                    sessionId: session.id, createdByAccountId: accounts[index].id,
                    accountId: accounts[1 - index].id, accessLevel: 'edit',
                } });
            }
            const pids: number[] = [];
            let transactionIndex = 0;
            const inserted = new Set<number>();
            const completed = new Set<number>();
            let releaseTransactions!: () => void;
            const bothTransactionsEntered = new Promise<void>(resolve => { releaseTransactions = resolve; });
            // Interpose only at Prisma, with real transactions and admission logic.
            // Rendezvous before Account or Session acquisition. Account-first
            // writers cannot both hold Session while one waits on the audience.
            // At insertion, allow the peer either to reach fanout or to wait on
            // the same first Account lock; a fixed sorted owner must not be held
            // at an artificial barrier behind the lock it correctly acquired.
            db.$transaction = new Proxy(originalTransaction, {
                apply(target, thisArg, args) {
                    const operation: unknown = args[0];
                    if (typeof operation !== 'function') return Reflect.apply(target, thisArg, args);
                    return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                        const index = transactionIndex++;
                        if (index >= 2) return Reflect.apply(operation, undefined, [tx]);
                        const rows = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
                        pids[index] = rows[0].pid;
                        if (pids.filter(pid => pid !== undefined).length === 2) releaseTransactions();
                        await bothTransactionsEntered;
                        const pending = new Proxy(tx.sessionPendingMessage, {
                            get(owner, property, receiver) {
                                const method: unknown = Reflect.get(owner, property, receiver);
                                if (property !== 'create' || typeof method !== 'function') return method;
                                return async (...createArgs: unknown[]) => {
                                    const row: unknown = await Reflect.apply(method, owner, createArgs);
                                    inserted.add(index);
                                    while (inserted.size < 2 && !completed.has(1 - index)) {
                                        const waiting = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                                            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock') AS waiting",
                                            pids[1 - index],
                                        );
                                        if (waiting[0].waiting) break;
                                    }
                                    return row;
                                };
                            },
                        });
                        try {
                            return await Reflect.apply(operation, undefined, [new Proxy(tx, {
                                get(owner, property, receiver) {
                                    if (property === 'sessionPendingMessage') return pending;
                                    return Reflect.get(owner, property, receiver);
                                },
                            })]);
                        } finally {
                            completed.add(index);
                            releaseTransactions();
                        }
                    }, ...args.slice(1)]);
                },
            });
            let finished = false;
            const admissions = Promise.allSettled(sessions.map((session, index) => {
                const localId = `shared-first-${randomUUID()}`;
                return enqueuePendingMessageByAuthenticatedMachine({
                    accountId: accounts[index].id, sourceMachineId: machines[index].id,
                    targetMachineId: machines[index].id, sessionId: session.id, localId,
                    content: { t: 'encrypted', c: 'first-input' }, requestedAction: { v: 1, kind: 'enqueue' },
                }).then(result => ({ result, localId }));
            })).finally(() => { finished = true; });
            let lockCycle = false;
            while (!finished) {
                if (pids[0] !== undefined && pids[1] !== undefined) {
                    const rows = await db.$queryRawUnsafe<{ cycle: boolean }[]>(
                        'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AND $2::int = ANY(pg_blocking_pids($1::int)) AS cycle',
                        pids[0], pids[1],
                    );
                    lockCycle ||= rows[0].cycle;
                } else {
                    await db.$queryRawUnsafe('SELECT 1');
                }
            }
            for (const admission of await admissions) {
                if (admission.status === 'rejected') throw admission.reason;
                expect(admission.value.result).toEqual({ status: 'accepted', localId: admission.value.localId });
            }
            expect(pids).toHaveLength(2);
            expect(lockCycle).toBe(false);
            for (const session of sessions) {
                expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(1);
                expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                    pendingCount: true, pendingQueueSeq: true,
                } })).toEqual({ pendingCount: 1, pendingQueueSeq: 1 });
                expect(await db.accountChange.findMany({ where: { sessionId: session.id }, select: { accountId: true },
                    orderBy: { accountId: 'asc' } })).toEqual(accounts.map(account => ({ accountId: account.id }))
                    .sort((a, b) => a.accountId.localeCompare(b.accountId)));
            }
        } finally {
            db.$transaction = originalTransaction;
            vi.unstubAllEnvs();
            const accountIds = accounts.map(account => account.id);
            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', createdByAccountId: { in: accountIds } } });
            await db.accessKey.deleteMany({ where: { accountId: { in: accountIds } } });
            await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
            await db.machine.deleteMany({ where: { accountId: { in: accountIds } } });
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
        }
    });

    it('admits a first input while another Session publisher on the same Account persists a heartbeat', async () => {
        const account = await db.account.create({ data: { publicKey: `pending-heartbeat-${randomUUID()}` } });
        const originalTransaction = db.$transaction;
        const publisherRetryLimit = readDatabaseTransactionConfigFromEnv(process.env, 'postgres').maxRetries;
        let heartbeat: ReturnType<ReturnType<typeof createSessionPublisherPresence>['touchPublisher']> | undefined;
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', `srv_${'a'.repeat(32)}`);
        try {
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
                metadata: '{}', installationId: randomUUID(),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1 } });
            const sessions = await Promise.all([0, 1].map(() => db.session.create({ data: {
                accountId: account.id, tag: randomUUID(), metadata: '{}',
            } })));
            for (const session of sessions) await db.accessKey.create({ data: {
                accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'encrypted',
            } });
            const [destination, other] = sessions;
            const socket = {};
            const presence = createSessionPublisherPresence();
            expect(await presence.registerPublisher({ socket,
                binding: { accountId: account.id, machineId: machine.id, sessionId: other.id },
                completeActivitySnapshot: { state: 'unknown', activeCount: 0 },
            })).toMatchObject({ status: 'registered' });
            let interleaved = false;
            let heartbeatFinished = false;
            let heartbeatPid: number | undefined;
            let accountLockAcquiredAt: number | undefined;
            let admissionTransactionFinishedAt: number | undefined;
            let heartbeatLockWaitObservedAt: number | undefined;
            // Prisma is the system boundary; the heartbeat beneath it is the
            // real publisher owner, including currentness checks and fanout.
            db.$transaction = new Proxy(originalTransaction, {
                apply(target, thisArg, args) {
                    const operation: unknown = args[0];
                    if (typeof operation !== 'function') return Reflect.apply(target, thisArg, args);
                    const admissionTransaction = !interleaved;
                    const result = Reflect.apply(target, thisArg, [async (tx: object) => {
                        if (interleaved) {
                            const rows = await (tx as Tx).$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
                            heartbeatPid = rows[0].pid;
                        }
                        const delegate = Reflect.get(tx, 'sessionPendingMessage') as object;
                        const wrappedDelegate = new Proxy(delegate, {
                            get(owner, property, receiver) {
                                const method: unknown = Reflect.get(owner, property, receiver);
                                if (property !== 'create' || typeof method !== 'function') return method;
                                return async (...createArgs: unknown[]) => {
                                    const row: unknown = await Reflect.apply(method, owner, createArgs);
                                    if (!interleaved) {
                                        interleaved = true;
                                        // The admission already captured its zero-retry config.
                                        // The background publisher retains the production retry owner.
                                        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', String(publisherRetryLimit));
                                        heartbeat = presence.touchPublisher({ socket });
                                        void heartbeat.then(() => { heartbeatFinished = true; }, () => { heartbeatFinished = true; });
                                        // Observe actual PostgreSQL lock waiting rather than sleeping
                                        // or replacing the competing writer with a NOWAIT surrogate.
                                        while (!heartbeatFinished) {
                                            const waiting = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                                                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock') AS waiting",
                                                heartbeatPid ?? -1,
                                            );
                                            if (waiting[0].waiting) {
                                                heartbeatLockWaitObservedAt = performance.now();
                                                break;
                                            }
                                        }
                                    }
                                    return row;
                                };
                            },
                        });
                        return Reflect.apply(operation, undefined, [new Proxy(tx, {
                            get(owner, property, receiver) {
                                if (property === '$queryRawUnsafe') {
                                    return async (query: string, ...values: unknown[]) => {
                                        const value: unknown = await Reflect.apply(
                                            Reflect.get(owner, property, receiver), owner, [query, ...values],
                                        );
                                        if (admissionTransaction && query.startsWith('SELECT "id" FROM "Account"')
                                            && query.includes('FOR NO KEY UPDATE')) accountLockAcquiredAt = performance.now();
                                        return value;
                                    };
                                }
                                return property === 'sessionPendingMessage' ? wrappedDelegate : Reflect.get(owner, property, receiver);
                            },
                        })]);
                    }, ...args.slice(1)]);
                    return admissionTransaction
                        ? Promise.resolve(result).finally(() => { admissionTransactionFinishedAt = performance.now(); })
                        : result;
                },
            });
            const localId = `first-heartbeat-${randomUUID()}`;
            expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: account.id,
                sourceMachineId: machine.id, targetMachineId: machine.id, sessionId: destination.id, localId,
                content: { t: 'encrypted', c: 'first-input' }, requestedAction: { v: 1, kind: 'enqueue' },
            })).toEqual({ status: 'accepted', localId });
            expect(interleaved).toBe(true);
            expect(await heartbeat).toMatchObject({ status: 'touched' });
            // Characterize the actual admission transaction and the observed
            // publisher wait, without introducing a product timing threshold.
            console.info('VERIFY_L11_ADMISSION_LOCK_TIMING', {
                accountLockHeldMs: accountLockAcquiredAt !== undefined && admissionTransactionFinishedAt !== undefined
                    ? admissionTransactionFinishedAt - accountLockAcquiredAt : null,
                observedPublisherWaitUntilTouchedMs: heartbeatLockWaitObservedAt !== undefined
                    ? performance.now() - heartbeatLockWaitObservedAt : null,
            });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(1);
            expect(await db.session.findUniqueOrThrow({ where: { id: destination.id }, select: {
                pendingCount: true, pendingQueueSeq: true,
            } })).toEqual({ pendingCount: 1, pendingQueueSeq: 1 });
        } finally {
            db.$transaction = originalTransaction;
            await heartbeat?.catch(() => undefined);
            vi.unstubAllEnvs();
            await db.accessKey.deleteMany({ where: { accountId: account.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('projects the rolled-back P2034 when startup commits after an unlocked Serializable Session read', async () => {
        const account = await db.account.create({ data: { publicKey: `pending-conflict-${randomUUID()}` } });
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        try {
            const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}' } });
            await expect(inTx(async tx => {
                await tx.session.findUniqueOrThrow({ where: { id: session.id }, select: { pendingQueueSeq: true } });
                await db.session.update({ where: { id: session.id }, data: { metadataVersion: { increment: 1 } } });
                return reserveNextPendingQueuePosition(tx, session.id);
            }, { isolationLevel: 'Serializable' })).rejects.toMatchObject({
                code: 'database_transaction_conflict_exhausted', cause: { code: 'P2034' },
            });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { pendingQueueSeq: true } }))
                .toEqual({ pendingQueueSeq: 0 });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(0);
            // A rolled-back first admission leaves a readable empty hosted
            // transcript; it does not itself turn the page into a read failure.
            const app = createAuthenticatedTestApp();
            registerSessionMessageRoutes(app);
            await app.ready();
            try {
                const response = await app.inject({ method: 'GET',
                    url: `/v1/sessions/${session.id}/messages?scope=main`,
                    headers: { 'x-test-user-id': account.id } });
                expect(response.statusCode).toBe(200);
                expect(SessionMessagesPageV1Schema.parse(response.json())).toMatchObject({ messages: [], hasMore: false });
            } finally { await app.close(); }
        } finally {
            vi.unstubAllEnvs();
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('admits one first input while a concurrent metadata writer observes the Session mutation lock', async () => {
        const account = await db.account.create({ data: { publicKey: `pending-start-${randomUUID()}` } });
        const originalTransaction = db.$transaction;
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', `srv_${'a'.repeat(32)}`);
        try {
            const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}' } });
            const machine = await db.machine.create({ data: {
                id: randomUUID(), accountId: account.id, metadata: '{}', installationId: randomUUID(),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
            let interleaved = false;
            let metadataWriteDeferred = false;
            // Interpose only at the real Prisma transaction boundary. After the
            // first Session read, another real connection tries to mutate it.
            // NOWAIT makes the interleaving deterministic without sleeps: an
            // unprotected admission permits the update and then aborts at its
            // queue counter; a protected one defers the writer until commit.
            db.$transaction = new Proxy(originalTransaction, {
                apply(target, thisArg, args) {
                    const operation: unknown = args[0];
                    if (typeof operation !== 'function') return Reflect.apply(target, thisArg, args);
                    return Reflect.apply(target, thisArg, [async (tx: object) => {
                        const delegate = Reflect.get(tx, 'session') as object;
                        const wrappedDelegate = new Proxy(delegate, {
                            get(owner, property, receiver) {
                                const method: unknown = Reflect.get(owner, property, receiver);
                                if (property !== 'findUnique' || typeof method !== 'function') return method;
                                return async (...readArgs: unknown[]) => {
                                    const row: unknown = await Reflect.apply(method, owner, readArgs);
                                    if (!interleaved) {
                                        interleaved = true;
                                        try {
                                            await Reflect.apply(originalTransaction, db, [async (writer: Tx) => {
                                                await writer.$queryRawUnsafe('SELECT "id" FROM "Session" WHERE "id" = $1 FOR UPDATE NOWAIT', session.id);
                                                await writer.session.update({ where: { id: session.id }, data: { metadata: 'concurrent metadata', metadataVersion: { increment: 1 } } });
                                            }]);
                                        } catch (error) {
                                            if (!(error instanceof Error) || !error.message.includes('could not obtain lock')) throw error;
                                            metadataWriteDeferred = true;
                                        }
                                    }
                                    return row;
                                };
                            },
                        });
                        return Reflect.apply(operation, undefined, [new Proxy(tx, {
                            get(owner, property, receiver) {
                                return property === 'session' ? wrappedDelegate : Reflect.get(owner, property, receiver);
                            },
                        })]);
                    }, ...args.slice(1)]);
                },
            });
            const input = { accountId: account.id, sourceMachineId: machine.id, targetMachineId: machine.id,
                sessionId: session.id, localId: `first-${randomUUID()}`, content: { t: 'encrypted' as const, c: 'first-input' },
                requestedAction: { v: 1 as const, kind: 'enqueue' as const } };
            const admitted = await enqueuePendingMessageByAuthenticatedMachine(input);
            db.$transaction = originalTransaction;
            expect(admitted).toEqual({ status: 'accepted', localId: input.localId });
            expect(interleaved).toBe(true);
            expect(metadataWriteDeferred).toBe(true);
            await db.session.update({ where: { id: session.id }, data: { metadata: 'concurrent metadata', metadataVersion: { increment: 1 } } });
            expect(await enqueuePendingMessageByAuthenticatedMachine(input)).toEqual({ status: 'alreadyAccepted', localId: input.localId });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(1);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                pendingQueueSeq: true, pendingCount: true, metadataVersion: true, metadata: true,
            } })).toEqual({ pendingQueueSeq: 1, pendingCount: 1, metadataVersion: 1, metadata: 'concurrent metadata' });
        } finally {
            db.$transaction = originalTransaction;
            vi.unstubAllEnvs();
            await db.accessKey.deleteMany({ where: { accountId: account.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
