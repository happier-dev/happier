import { readSessionSystemRecordChangeV1 } from '@happier-dev/protocol/sessions/board/changeHint';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { db, initDbPostgres } from '@/storage/db';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { inTx, type Tx } from '@/storage/inTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { enqueuePendingMessageByAuthenticatedMachine } from './pendingMessageService';
import { mutateSessionBoard } from '@/app/session/board/service';
import { controlAutonomousExchange } from './autonomousExchangeControl';
import { deleteSessionOrganizationFolder, deleteSessionOrganizationLabel, setSessionAttentionStanding, setSessionFolderAssignment, upsertSessionOrganizationFolder } from '@/app/session/organization/organizationMutations';
import { hashSessionOrganizationKey } from '@/app/session/organization/hashKeys';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import {
    initializeSessionSystemRecordsProtocolV1Activation,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
} from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';

// Keep internal owners real; deterministic interleaving is at the Prisma boundary.
// Use only a disposable database, never the retained development stack.
describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Account cursor contention', () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('Missing ephemeral PostgreSQL DATABASE_URL');
        initDbPostgres();
        await db.$connect();
        expect(await initializeSessionSystemRecordsProtocolV1Activation(db)).toBe(true);
    });
    afterAll(async () => { resetSessionSystemRecordsProtocolV1ActivationForTests(); await db.$disconnect(); });

    it.each(['cursor advance', 'root archived'] as const)('readmits autonomous control after %s during discovery', async interleaving => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const [source, destination] = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted',
        } })));
        const originLocalId = `origin-${randomUUID()}`;
        const state = { v: 1, observedStarts: 1, pauseAtStarts: 1, afterTurns: 1, stopped: false };
        const root = await db.sessionMessage.create({ data: {
            sessionId: source.id, localId: originLocalId, seq: 1, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'original' } } },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: account.id, sessionRelationship: 'owner' },
            autonomousExchangeState: state,
        } });
        const pending = await db.sessionPendingMessage.create({ data: {
            sessionId: destination.id, localId: `dependent-${randomUUID()}`, position: 1,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'dependent' } } },
            requestedAction: { v: 1, kind: 'enqueue' }, status: 'queued',
            deliveryState: 'blocked', deliveryBlockedReason: 'autonomous_check_in',
            autonomousExchangeRootSessionId: source.id, autonomousExchangeRootLocalId: originLocalId,
            autonomousExchangeCause: 'agent_session',
        } });
        await db.session.update({ where: { id: destination.id }, data: { pendingCount: 1, pendingBlockedCount: 1 } });
        const originalTransaction = db.$transaction;
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        let interleaved = false;
        try {
            // Interleave only at the real Prisma transport, preserving the
            // production admission, state transition and publication owners.
            db.$transaction = new Proxy(originalTransaction, {
                apply(target, thisArg, args) {
                    const operation: unknown = args[0];
                    if (typeof operation !== 'function') return Reflect.apply(target, thisArg, args);
                    return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                        const pendingMessages = new Proxy(tx.sessionPendingMessage, {
                            get(owner, property, receiver) {
                                const method: unknown = Reflect.get(owner, property, receiver);
                                if (property !== 'findMany' || typeof method !== 'function') return method;
                                return async (...values: unknown[]) => {
                                    const rows: unknown = await Reflect.apply(method, owner, values);
                                    if (!interleaved) {
                                        interleaved = true;
                                        if (interleaving === 'root archived') {
                                            await db.session.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
                                        } else {
                                            await inTx(client => markAccountChanged(client, {
                                                accountId: account.id, kind: 'account', entityId: account.id,
                                            }));
                                        }
                                    }
                                    return rows;
                                };
                            },
                        });
                        return Reflect.apply(operation, undefined, [new Proxy(tx, {
                            get(owner, property, receiver) {
                                return property === 'sessionPendingMessage' ? pendingMessages : Reflect.get(owner, property, receiver);
                            },
                        })]);
                    }, args[1]]);
                },
            });
            const result = await controlAutonomousExchange({ actorUserId: account.id, sessionId: source.id,
                originInputLocalId: originLocalId,
                request: { control: 'continue', observedRevision: `session-message-row-revision:v1:${root.rowRevision}` },
            });
            expect(interleaved).toBe(true);
            if (interleaving === 'root archived') {
                expect(result).toEqual({ ok: false, error: 'forbidden' });
                expect(await db.sessionMessage.findUniqueOrThrow({ where: { id: root.id } }))
                    .toMatchObject({ autonomousExchangeState: state, rowRevision: root.rowRevision });
                expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { id: pending.id } }))
                    .toMatchObject({ deliveryState: 'blocked', deliveryBlockedReason: 'autonomous_check_in' });
                expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
            } else {
                expect(result).toMatchObject({ ok: true, state: { pauseAtStarts: 2 } });
                expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { id: pending.id } }))
                    .toMatchObject({ deliveryState: null, deliveryBlockedReason: null });
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ seq: 2 });
            }
        } finally {
            db.$transaction = originalTransaction;
            vi.unstubAllEnvs();
            await db.sessionMessage.deleteMany({ where: { sessionId: { in: [source.id, destination.id] } } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('archives only the requested label when the Account cursor advances before publication', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const scopeKey = randomUUID();
        const retainedScopeKey = randomUUID();
        await db.sessionOrganizationLabel.createMany({ data: [scopeKey, retainedScopeKey].map(key => ({
            accountId: account.id, labelKind: 'workspace', scopeKey: key, scopeHash: hashSessionOrganizationKey(key),
        })) });
        const originalTransaction = db.$transaction;
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        let advanced = false;
        try {
            db.$transaction = new Proxy(originalTransaction, {
                apply(target, thisArg, args) {
                    const operation: unknown = args[0];
                    if (typeof operation !== 'function') return Reflect.apply(target, thisArg, args);
                    return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                        return Reflect.apply(operation, undefined, [new Proxy(tx, {
                            get(owner, property, receiver) {
                                if (property !== '$queryRawUnsafe') return Reflect.get(owner, property, receiver);
                                return (query: string, ...values: unknown[]) => {
                                    const native = owner.$queryRawUnsafe(query, ...values);
                                    if (advanced || !query.includes('FROM "Account"') || !query.includes('FOR UPDATE')) return native;
                                    advanced = true;
                                    let scheduled: Promise<unknown> | undefined;
                                    const run = () => scheduled ??= (async () => {
                                        // The aggregate owner now admits exclusively at entry.
                                        // Let an independent cursor publisher win before it.
                                        await inTx(client => markAccountChanged(client, { accountId: account.id, kind: 'account', entityId: account.id }));
                                        return await native;
                                    })();
                                    return new Proxy(native, { get(promise, method, queryReceiver) {
                                        if (method !== 'then' && method !== 'catch' && method !== 'finally') return Reflect.get(promise, method, queryReceiver);
                                        return (...callbacks: unknown[]) => {
                                            const queryPromise = run();
                                            return Reflect.apply(Reflect.get(queryPromise, method, queryPromise), queryPromise, callbacks);
                                        };
                                    } });
                                };
                            },
                        })]);
                    }, args[1]]);
                },
            });
            expect(await deleteSessionOrganizationLabel({ accountId: account.id, request: { labelKind: 'workspace', scopeKey } }))
                .toEqual({ labelKind: 'workspace', scopeKey, archived: true });
            expect(advanced).toBe(true);
            const rows = await db.sessionOrganizationLabel.findMany({ where: { accountId: account.id } });
            expect(rows.find(row => row.scopeKey === scopeKey)?.archivedAt).toBeInstanceOf(Date);
            expect(rows.find(row => row.scopeKey === retainedScopeKey)?.archivedAt).toBeNull();
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ seq: 2 });
        } finally {
            db.$transaction = originalTransaction;
            vi.unstubAllEnvs();
            await db.sessionOrganizationLabel.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('rejects a folder deleted before folder-assignment admission', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted',
        } });
        const created = await upsertSessionOrganizationFolder({ accountId: account.id, request: {
            folderKey: randomUUID(), parentFolderId: null, parentFolderKey: null, sortKey: null, display: null,
        } });
        if ('error' in created) throw new Error(`Unexpected folder setup refusal: ${created.error}`);
        const folderId = created.folder.folderId;
        const originalTransaction = db.$transaction;
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        let deleted = false;
        try {
            db.$transaction = new Proxy(originalTransaction, {
                apply(target, thisArg, args) {
                    const operation: unknown = args[0];
                    if (typeof operation !== 'function') return Reflect.apply(target, thisArg, args);
                    return Reflect.apply(target, thisArg, [async (tx: Tx) => Reflect.apply(operation, undefined, [new Proxy(tx, {
                        get(owner, property, receiver) {
                            const method: unknown = Reflect.get(owner, property, receiver);
                            if (property !== '$queryRawUnsafe' || typeof method !== 'function') return method;
                            return async (...values: unknown[]) => {
                                if (!deleted && typeof values[0] === 'string'
                                    && values[0].includes('FROM "Account"') && /FOR (?:KEY SHARE|UPDATE)/.test(values[0])) {
                                    // The canonical delete owns exclusive Account admission.
                                    // Commit it immediately before this attempt's admission.
                                    deleted = true;
                                    await deleteSessionOrganizationFolder({ accountId: account.id, request: { folderId, assignmentBehavior: 'moveAssignmentsToParent' } });
                                }
                                return Reflect.apply(method, owner, values);
                            };
                        },
                    })]), args[1]]);
                },
            });
            expect(await setSessionFolderAssignment({ accountId: account.id, sessionId: session.id,
                folderId, authentication: createPresentUserSessionAccessAuthentication() })).toEqual({ error: 'invalid-folder' });
            expect(deleted).toBe(true);
            expect(await db.sessionFolderAssignment.findUnique({ where: {
                accountId_sessionId: { accountId: account.id, sessionId: session.id },
            } })).toBeNull();
        } finally {
            db.$transaction = originalTransaction;
            vi.unstubAllEnvs();
            await db.session.delete({ where: { id: session.id } });
            await db.sessionOrganizationFolder.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('waits for every autonomous control Session before mutating its root or dependent Pending child', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const [source, destination] = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted',
        } })));
        const originLocalId = `origin-${randomUUID()}`;
        const root = await db.sessionMessage.create({ data: {
            sessionId: source.id, localId: originLocalId, seq: 1, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'original' } } },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: account.id, sessionRelationship: 'owner' },
            autonomousExchangeState: { v: 1, observedStarts: 1, pauseAtStarts: 1, afterTurns: 1, stopped: false },
        } });
        const pending = await db.sessionPendingMessage.create({ data: {
            sessionId: destination.id, localId: `dependent-${randomUUID()}`, position: 1,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'dependent' } } },
            requestedAction: { v: 1, kind: 'enqueue' }, status: 'queued',
            deliveryState: 'blocked', deliveryBlockedReason: 'autonomous_check_in',
            autonomousExchangeRootSessionId: source.id, autonomousExchangeRootLocalId: originLocalId,
            autonomousExchangeCause: 'agent_session',
        } });
        await db.session.update({ where: { id: destination.id }, data: { pendingCount: 1, pendingBlockedCount: 1 } });
        let writer: ReturnType<typeof controlAutonomousExchange> | undefined;
        try {
            await db.$transaction(async tx => {
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${destination.id} FOR UPDATE`;
                let finished = false;
                writer = controlAutonomousExchange({ actorUserId: account.id, sessionId: source.id,
                    originInputLocalId: originLocalId,
                    request: { control: 'continue', observedRevision: `session-message-row-revision:v1:${root.rowRevision}` },
                }).finally(() => { finished = true; });
                void writer.catch(() => undefined);
                let waiting = false;
                while (!finished && !waiting) {
                    const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                            AND ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
                    `;
                    waiting = row.waiting;
                }
                expect(waiting).toBe(true);
                await tx.$queryRaw`SELECT "id" FROM "SessionPendingMessage" WHERE "id" = ${pending.id} FOR UPDATE NOWAIT`;
                await tx.$queryRaw`SELECT "id" FROM "SessionMessage" WHERE "id" = ${root.id} FOR UPDATE NOWAIT`;
                expect(await tx.sessionPendingMessage.findUniqueOrThrow({ where: { id: pending.id } }))
                    .toMatchObject({ deliveryState: 'blocked', deliveryBlockedReason: 'autonomous_check_in' });
            });
            expect(await writer).toMatchObject({ ok: true, state: { pauseAtStarts: 2 } });
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { id: pending.id } }))
                .toMatchObject({ deliveryState: null, deliveryBlockedReason: null });
        } finally {
            await writer;
            await db.sessionMessage.deleteMany({ where: { sessionId: { in: [source.id, destination.id] } } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('waits for the assigned Session before deleting its existing folder-assignment child', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted',
        } });
        const folder = await upsertSessionOrganizationFolder({ accountId: account.id, request: {
            folderKey: randomUUID(), parentFolderId: null, parentFolderKey: null, sortKey: null, display: null,
        } });
        if ('error' in folder) throw new Error(`Unexpected folder setup refusal: ${folder.error}`);
        const authentication = createPresentUserSessionAccessAuthentication();
        await db.sessionFolderAssignment.create({ data: {
            accountId: account.id, sessionId: session.id, folderId: folder.folder.folderId,
        } });
        let writer: ReturnType<typeof setSessionFolderAssignment> | undefined;
        try {
            await db.$transaction(async tx => {
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${session.id} FOR UPDATE`;
                let finished = false;
                writer = setSessionFolderAssignment({ accountId: account.id, sessionId: session.id,
                    folderId: null, authentication }).finally(() => { finished = true; });
                void writer.catch(() => undefined);
                let waiting = false;
                while (!finished && !waiting) {
                    const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                            AND ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
                    `;
                    waiting = row.waiting;
                }
                expect(waiting).toBe(true);
                await tx.$queryRaw`SELECT "sessionId" FROM "SessionFolderAssignment"
                    WHERE "accountId" = ${account.id} AND "sessionId" = ${session.id} FOR UPDATE NOWAIT`;
            });
            expect(await writer).toEqual({ sessionId: session.id, folderId: null });
            expect(await db.sessionFolderAssignment.count({ where: { accountId: account.id, sessionId: session.id } })).toBe(0);
        } finally {
            await writer;
            await db.session.delete({ where: { id: session.id } });
            await db.sessionOrganizationFolder.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('waits for a reminder Session before moving its existing viewer-read child', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted', seq: 1,
        } });
        await db.accountSessionReadState.create({ data: {
            accountId: account.id, sessionId: session.id, lastViewedSessionSeq: 0, unreadSince: new Date(),
        } });
        let writer: ReturnType<typeof setSessionAttentionStanding> | undefined;
        try {
            await db.$transaction(async tx => {
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${session.id} FOR UPDATE`;
                let finished = false;
                writer = setSessionAttentionStanding({ accountId: account.id, sessionId: session.id,
                    request: { remindAt: Date.now() + 60_000 },
                    authentication: createPresentUserSessionAccessAuthentication(),
                }).finally(() => { finished = true; });
                void writer.catch(() => undefined);
                let waiting = false;
                while (!finished && !waiting) {
                    const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                            AND ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
                    `;
                    waiting = row.waiting;
                }
                expect(waiting).toBe(true);
                await tx.$queryRaw`SELECT "sessionId" FROM "AccountSessionReadState"
                    WHERE "accountId" = ${account.id} AND "sessionId" = ${session.id} FOR UPDATE NOWAIT`;
                expect(await tx.accountSessionReadState.findUniqueOrThrow({
                    where: { accountId_sessionId: { accountId: account.id, sessionId: session.id } },
                })).toMatchObject({ lastViewedSessionSeq: 0 });
            });
            expect(await writer).toMatchObject({ standing: { sessionId: session.id, standing: false } });
            expect(await db.accountSessionReadState.findUniqueOrThrow({
                where: { accountId_sessionId: { accountId: account.id, sessionId: session.id } },
            })).toMatchObject({ lastViewedSessionSeq: 1, unreadSince: null });
        } finally {
            await writer;
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('commits two concurrent Board writes on one Account under ReadCommitted', async () => {
        const account = await db.account.create({ data: { publicKey: `contention-board-${randomUUID()}`, encryptionMode: 'plain' } });
        const originalTransaction = db.$transaction;
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        let recordsWritten = 0;
        let transactionIndex = 0;
        const pids: number[] = [];
        const completed = new Set<number>();
        let releaseTransactions!: () => void;
        const bothTransactionsEntered = new Promise<void>(resolve => { releaseTransactions = resolve; });
        try {
            const sessions = await Promise.all([0, 1].map(() => db.session.create({ data: {
                accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
            } })));
            // Rendezvous at the real transaction boundary. After insertion,
            // allow the peer to insert or wait on a correctly acquired early
            // lock; the test must also admit a valid serialized implementation.
            db.$transaction = new Proxy(originalTransaction, {
                apply(target, thisArg, args) {
                    const operation: unknown = args[0];
                    if (typeof operation !== 'function') return Reflect.apply(target, thisArg, args);
                    // Exercise the candidate isolation at the real database
                    // transport before activating the shared production default.
                    const options: unknown = args[1];
                    const candidateOptions = { ...(typeof options === 'object' && options !== null ? options : {}),
                        isolationLevel: 'ReadCommitted' };
                    return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                        const index = transactionIndex++;
                        const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
                        pids[index] = row.pid;
                        if (pids.length === 2) releaseTransactions();
                        await bothTransactionsEntered;
                        const records = new Proxy(tx.sessionSystemRecord, {
                            get(owner, property, receiver) {
                                const method: unknown = Reflect.get(owner, property, receiver);
                                if (property !== 'create' || typeof method !== 'function') return method;
                                return async (...values: unknown[]) => {
                                    const row: unknown = await Reflect.apply(method, owner, values);
                                    recordsWritten++;
                                    while (recordsWritten < 2 && !completed.has(1 - index)) {
                                        const [peer] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                                            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock') AS waiting",
                                            pids[1 - index],
                                        );
                                        if (peer.waiting) break;
                                    }
                                    return row;
                                };
                            },
                        });
                        try {
                            return await Reflect.apply(operation, undefined, [new Proxy(tx, {
                                get(owner, property, receiver) {
                                    return property === 'sessionSystemRecord' ? records : Reflect.get(owner, property, receiver);
                                },
                            })]);
                        } finally { completed.add(index); }
                    }, candidateOptions]);
                },
            });
            const results = await Promise.allSettled(sessions.map(session => writeBoard(account.id, session.id)));
            for (const result of results) {
                if (result.status === 'rejected') throw result.reason;
                expect(result.value).toMatchObject({ ok: true, result: { outcome: 'created' } });
            }
            expect(recordsWritten).toBe(2);
            expect(await db.sessionSystemRecord.count({ where: { accountId: account.id } })).toBe(2);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 2 });
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(2);
        } finally {
            releaseTransactions();
            db.$transaction = originalTransaction;
            vi.unstubAllEnvs();
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('commits first input after a heartbeat and Board write on the same Account under ReadCommitted', async () => {
        const account = await db.account.create({ data: { publicKey: `contention-three-${randomUUID()}` } });
        const originalTransaction = db.$transaction;
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', `srv_${'a'.repeat(32)}`);
        try {
            const machine = await db.machine.create({ data: {
                id: randomUUID(), accountId: account.id, metadata: '{}', installationId: randomUUID(),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            const sessions = await Promise.all([0, 1, 2].map(() => db.session.create({ data: {
                accountId: account.id, tag: randomUUID(), metadata: '{}',
            } })));
            for (const session of sessions) await db.accessKey.create({ data: {
                accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'encrypted',
            } });
            const [destination, publisherSession, boardSession] = sessions;
            const socket = {};
            const presence = createSessionPublisherPresence();
            expect(await presence.registerPublisher({ socket,
                binding: { accountId: account.id, machineId: machine.id, sessionId: publisherSession.id },
                completeActivitySnapshot: { state: 'unknown', activeCount: 0 },
            })).toMatchObject({ status: 'registered' });
            let interleaved = false;
            db.$transaction = new Proxy(originalTransaction, {
                apply(target, thisArg, args) {
                    const operation: unknown = args[0];
                    if (typeof operation !== 'function') return Reflect.apply(target, thisArg, args);
                    const options: unknown = args[1];
                    const candidateOptions = { ...(typeof options === 'object' && options !== null ? options : {}),
                        isolationLevel: 'ReadCommitted' };
                    if (interleaved) return Reflect.apply(target, thisArg, [operation, candidateOptions]);
                    return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                        const session = new Proxy(tx.session, {
                            get(owner, property, receiver) {
                                const method: unknown = Reflect.get(owner, property, receiver);
                                if (typeof property !== 'string' || !property.startsWith('find') || typeof method !== 'function') return method;
                                return async (...values: unknown[]) => {
                                    const row: unknown = await Reflect.apply(method, owner, values);
                                    if (!interleaved) {
                                        interleaved = true;
                                        expect(await presence.touchPublisher({ socket })).toMatchObject({ status: 'touched' });
                                        expect(await writeBoard(account.id, boardSession.id, 'e2ee')).toMatchObject({ ok: true });
                                    }
                                    return row;
                                };
                            },
                        });
                        return Reflect.apply(operation, undefined, [new Proxy(tx, {
                            get(owner, property, receiver) {
                                return property === 'session' ? session : Reflect.get(owner, property, receiver);
                            },
                        })]);
                    }, candidateOptions]);
                },
            });
            const localId = `three-first-${randomUUID()}`;
            expect(await enqueuePendingMessageByAuthenticatedMachine({
                accountId: account.id, sourceMachineId: machine.id, targetMachineId: machine.id,
                sessionId: destination.id, localId, content: { t: 'encrypted', c: 'first-input' },
                requestedAction: { v: 1, kind: 'enqueue' },
            })).toEqual({ status: 'accepted', localId });
            expect(interleaved).toBe(true);
            expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(1);
            expect(await db.sessionSystemRecord.count({ where: { sessionId: boardSession.id } })).toBe(1);
            expect(await db.accountChange.findMany({ where: { accountId: account.id }, orderBy: { cursor: 'asc' },
                select: { sessionId: true, cursor: true } })).toEqual([
                { sessionId: publisherSession.id, cursor: 2 }, { sessionId: null, cursor: 3 },
                { sessionId: destination.id, cursor: 4 },
            ]);
            const boardChange = await db.accountChange.findFirstOrThrow({ where: { accountId: account.id, cursor: 3 } });
            expect(readSessionSystemRecordChangeV1(boardChange)).toMatchObject({ sessionId: boardSession.id });
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

function writeBoard(accountId: string, sessionId: string, encryptionMode: 'plain' | 'e2ee' = 'plain') {
    return mutateSessionBoard({ actorUserId: accountId, sessionId,
        authentication: createPresentUserSessionAccessAuthentication(),
        mutation: { operation: 'upsert_item', itemId: 'visual', expectedItemRevision: null,
            itemContent: encryptionMode === 'e2ee' ? { t: 'encrypted', c: 'opaque-board-item' }
                : { t: 'plain', v: { v: 1, destination: 'transcript', title: 'Result', frame: 'frameless',
                height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative',
                    document: { version: 1, root: { kind: 'markdown', text: 'Hello' } } } } } },
    });
}
