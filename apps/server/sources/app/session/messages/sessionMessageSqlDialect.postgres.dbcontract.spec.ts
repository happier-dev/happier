import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { SESSION_ACCESS_SESSION_BATCH_SIZE } from '@/app/session/access/sessionAccess';
import { hasCurrentSessionScopedMachineAccessInTx } from '@/app/api/socket/sessionScopedBinding';
import { deleteSessionTree } from '@/app/session/delete/deleteSessionTree';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { areCurrentSessionInputMachineTargetsInTx } from './sessionInputAdmission';
import { createSessionInputReplyProgressInTx, listSessionMessageRepliesPendingInTx } from './sessionMessageReply';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Session message PostgreSQL-compatible SQL dialects', () => {
    const homeId = 'srv_session_message_sql_dialect';
    const authentication = createPresentUserSessionAccessAuthentication();
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Requires the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', homeId);
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); vi.unstubAllEnvs(); });

    async function fixture() {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'session-sql-dialect' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: account.id, sessionId: session.id, machineId: machine.id, data: 'opaque-test-binding' } });
        return { account, machine, session };
    }

    async function expectRowLocked(table: 'Machine' | 'AccessKey' | 'Session', field: 'id' | 'sessionId', id: string,
        lock: 'UPDATE' | 'KEY SHARE' = 'UPDATE') {
        await expect(db.$transaction(tx => tx.$queryRawUnsafe(
            `SELECT "${field}" FROM "${table}" WHERE "${field}" = $1 FOR ${lock} NOWAIT`, id,
        ))).rejects.toThrow(/could not obtain lock on row/);
    }

    function observeSessionContentRead(before: () => Promise<void>) {
        const original = db.$transaction;
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const operation = args[0];
            if (typeof operation !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => operation(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    const delegate: unknown = Reflect.get(inner, property, innerReceiver);
                    if (property !== 'session' || !delegate || typeof delegate !== 'object') {
                        return typeof delegate === 'function' ? delegate.bind(inner) : delegate;
                    }
                    return new Proxy(delegate, { get(model, method, modelReceiver) {
                        const member: unknown = Reflect.get(model, method, modelReceiver);
                        if (method !== 'findUnique' || typeof member !== 'function') return typeof member === 'function' ? member.bind(model) : member;
                        return async (...values: unknown[]) => {
                            const query = values[0];
                            if (query && typeof query === 'object' && 'select' in query && query.select
                                && typeof query.select === 'object' && 'updatedAt' in query.select) await before();
                            return Reflect.apply(member, model, values);
                        };
                    } });
                },
            })), ...args.slice(1)]);
        } });
        return () => { db.$transaction = original; };
    }

    for (const backend of ['postgres', 'pglite']) {
        it(`reads Session and AccessKey placement sets without ORM chunking for ${backend}`, async () => {
            const f = await fixture();
            const target = { homeId, accountId: f.account.id, machineId: f.machine.id,
                installationId: f.machine.installationId!, sessionId: f.session.id };
            const targets = Array.from({ length: SESSION_ACCESS_SESSION_BATCH_SIZE + 1 }, () => target);
            const previous = process.env.HAPPIER_DB_PROVIDER;
            try {
                // PGlite uses PostgreSQL SQL; keep the actual PostgreSQL database adapter.
                process.env.HAPPIER_DB_PROVIDER = backend;
                await inTx(async tx => {
                    const observed = observePrismaReads(tx, ['session', 'accessKey']);
                    expect(await areCurrentSessionInputMachineTargetsInTx(observed.tx, targets)).toEqual(targets.map(() => true));
                    expect(observed.reads).toEqual([]);
                });
            } finally {
                if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
                else process.env.HAPPIER_DB_PROVIDER = previous;
            }
        });

        it(`reads pending reply UNION and cursor bindings for ${backend}`, async () => {
            const f = await fixture();
            const source = await db.session.create({ data: { accountId: f.account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
            const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: f.account.id,
                authentication, requestSessionId: f.session.id, reply: { mode: 'return', humanOrigin: { sessionId: source.id } } }));
            expect(progress).not.toBeNull();
            const inputAdmissionReceipt = SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: 'authenticatedAccount',
                actorAccountId: f.account.id, sessionRelationship: 'owner' });
            await db.sessionPendingMessage.create({ data: { sessionId: f.session.id, localId: 'a-pending', position: 0,
                content: { t: 'plain', v: {} }, requestedAction: { v: 1, kind: 'enqueue' },
                authorAccountId: f.account.id, inputAdmissionReceipt, replyDisposition: 'return_pending', replyProgress: progress! } });
            await db.sessionMessage.create({ data: { sessionId: f.session.id, localId: 'b-message', seq: 1,
                content: { t: 'plain', v: {} }, authorAccountId: f.account.id, inputAdmissionReceipt,
                replyDisposition: 'return_pending', replyProgress: progress! } });
            const previous = process.env.HAPPIER_DB_PROVIDER;
            try {
                process.env.HAPPIER_DB_PROVIDER = backend;
                const read = (afterLocalId?: string) => inTx(tx => listSessionMessageRepliesPendingInTx(tx, {
                    accountId: f.account.id, sessionId: f.session.id, authentication, afterLocalId }));
                expect((await read()).entries.map(entry => entry.requestLocalId)).toEqual(['a-pending', 'b-message']);
                expect((await read('a-pending')).entries.map(entry => entry.requestLocalId)).toEqual(['b-message']);
                expect((await read('b-message')).entries).toEqual([]);
            } finally {
                if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
                else process.env.HAPPIER_DB_PROVIDER = previous;
            }
        });

        it(`holds the Machine and AccessKey authority rows for ${backend}`, async () => {
            const f = await fixture();
            const previous = process.env.HAPPIER_DB_PROVIDER;
            try {
                process.env.HAPPIER_DB_PROVIDER = backend;
                await inTx(async tx => {
                    expect(await hasCurrentSessionScopedMachineAccessInTx({ tx, accountId: f.account.id,
                        machineId: f.machine.id, sessionId: f.session.id, lockAuthority: true })).toBe(true);
                    await expectRowLocked('Machine', 'id', f.machine.id);
                    await expectRowLocked('AccessKey', 'sessionId', f.session.id);
                });
            } finally {
                if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
                else process.env.HAPPIER_DB_PROVIDER = previous;
            }
        });

        it(`blocks new FK readers at the Session deletion boundary for ${backend}`, async () => {
            const f = await fixture();
            const rollback = new Error('rollback disposable Session deletion probe');
            const previous = process.env.HAPPIER_DB_PROVIDER;
            try {
                process.env.HAPPIER_DB_PROVIDER = backend;
                await expect(inTx(tx => deleteSessionTree(tx, { sessionId: f.session.id, actorAccountId: f.account.id,
                    sessionUpdatedAt: f.session.updatedAt, reason: 'user_request', afterSessionWriteBoundary: async () => {
                        await expectRowLocked('Session', 'id', f.session.id, 'KEY SHARE');
                        throw rollback;
                    } }))).rejects.toBe(rollback);
            } finally {
                if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
                else process.env.HAPPIER_DB_PROVIDER = previous;
            }
        });

        it(`locks the Session before reading heartbeat content clocks for ${backend}`, async () => {
            const f = await fixture();
            const presence = createSessionPublisherPresence();
            const socket = {};
            const registered = await presence.registerPublisher({ socket, binding: { accountId: f.account.id,
                machineId: f.machine.id, sessionId: f.session.id }, completeActivitySnapshot: { state: 'active', activeCount: 1 } });
            expect(registered.status).toBe('registered');
            const previous = process.env.HAPPIER_DB_PROVIDER;
            let checked = false;
            const restore = observeSessionContentRead(async () => {
                checked = true;
                await expectRowLocked('Session', 'id', f.session.id);
            });
            try {
                process.env.HAPPIER_DB_PROVIDER = backend;
                expect(await presence.touchPublisher({ socket })).toMatchObject({ status: 'touched' });
                expect(checked).toBe(true);
            } finally {
                restore();
                if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
                else process.env.HAPPIER_DB_PROVIDER = previous;
            }
        });
    }
});
