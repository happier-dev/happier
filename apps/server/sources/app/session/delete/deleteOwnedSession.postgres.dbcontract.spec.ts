import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type ResolvedTransactionResult, type Tx } from "@/storage/inTx";
import { createNativeSessionTeamCredentialFixture, TEST_AUTHENTICATION, TEST_TEAM_AUTHENTICATION } from '@/app/teams/credentials/sessionBinding.testkit';
import { deleteTeamCredentialResourceInTx } from '@/app/teams/credentials/resourceDelete';
import { writeSessionTeamCredentialBindingsInTx, stampSessionTeamCredentialNativeDeliveryInTx,
    submitSessionTeamCredentialNativeDeliveryInTx } from '@/app/teams/credentials/sessionBinding';

import { deleteOwnedSession, deleteSessionWithRecipientsInTx } from "./deleteOwnedSession";
import { commitSessionAgentCurrentView } from '@/app/session/agentTransition/commitSessionAgentCurrentView';

const PUBLIC_KEY_PREFIX = "session-delete-publication-contention-";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")(
    "owned Session deletion under PostgreSQL publication contention",
    () => {
        let connected = false;

        beforeAll(async () => {
            if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
                || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error("Run with the disposable PostgreSQL DB-contract harness");
            }
            vi.stubEnv('HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED', '1');
            vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', `srv_${'a'.repeat(32)}`);
            initDbPostgres();
            await db.$connect();
            connected = true;
        });

        beforeEach(() => vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0"));

        afterEach(async () => {
            await db.sessionMessage.deleteMany({
                where: { session: { account: { publicKey: { startsWith: PUBLIC_KEY_PREFIX } } } },
            });
            await db.session.deleteMany({
                where: { account: { publicKey: { startsWith: PUBLIC_KEY_PREFIX } } },
            });
            await db.account.deleteMany({
                where: { publicKey: { startsWith: PUBLIC_KEY_PREFIX } },
            });
        });

        afterAll(async () => {
            if (connected) await db.$disconnect();
            vi.unstubAllEnvs();
        });

        // Exercise the actual FK/parent-lock boundary: hold a completed mutation
        // uncommitted until its opponent blocks in PostgreSQL or finishes.
        async function afterUncommittedMutation<T>(mutate: (tx: Tx) => Promise<unknown>, compete: (tx: Tx) => Promise<T>) {
            let release!: () => void;
            let ready!: () => void;
            let opponentReady!: (pid: number) => void;
            const held = new Promise<void>(resolve => { release = resolve; });
            const started = new Promise<void>(resolve => { ready = resolve; });
            const opponentStarted = new Promise<number>(resolve => { opponentReady = resolve; });
            const holder = inTx(async tx => {
                await mutate(tx);
                ready();
                await held;
            }, { isolationLevel: 'ReadCommitted' });
            const holderOutcome = Promise.allSettled([holder]);
            let opponent: Promise<ResolvedTransactionResult<T>> | undefined;
            try {
                await Promise.race([started, holder.then(() => { throw new Error('Mutation missed rendezvous'); })]);
                let finished = false;
                opponent = inTx(async tx => {
                    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    opponentReady(pid);
                    return compete(tx);
                }, { isolationLevel: 'ReadCommitted' }).finally(() => { finished = true; });
                const opponentOutcome = Promise.allSettled([opponent]);
                const pid = await opponentStarted;
                while (!finished) {
                    const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked
                    `;
                    if (blocked) break;
                }
                release();
                await holder;
                await opponentOutcome;
                return await opponent;
            } finally {
                release();
                await holderOutcome;
                await Promise.allSettled(opponent ? [opponent] : []);
            }
        }

        it('deletes the Session after submitted insertion and wakes its native controller', async () => {
            // An uncommitted first binding is invisible to the initial Account
            // census. Exercise the transaction owner's normal audience replay,
            // not the zero-retry override used by the lock-only cases below.
            vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', undefined);
            const f = await createNativeSessionTeamCredentialFixture();
            await expect(afterUncommittedMutation(async tx => {
                expect(await writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
                    accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION })).toEqual({ ok: true });
                const prepared = await stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
                    accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION });
                if (!prepared.ok) throw new Error('Expected prepared native delivery');
                expect(await submitSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
                    accountId: f.creator.id, bindingKey: prepared.binding.safeFacet.bindingKey,
                    expectedResourceRevision: f.credential.revision, expectedSourceRevision: f.nativeSource.sourceRevision,
                    expectedProviderTicket: f.nativeSource.providerTicket, operation: 'install', requestId: randomUUID(),
                    authentication: TEST_AUTHENTICATION })).toEqual({ ok: true, submitted: true });
            }, tx => deleteSessionWithRecipientsInTx(tx, { sessionId: f.session.id,
                ownerAccountId: f.creator.id, reason: 'user_request' }))).resolves.toEqual({ ok: true });
            expect(await db.session.findUnique({ where: { id: f.session.id }, select: { seq: true } })).toBeNull();
            expect(await db.sessionTeamCredentialBinding.findMany({ where: { sessionId: f.session.id },
                select: { nativeManagedId: true } })).toEqual([]);
        });

        it('clears native authority during Agent cutover with the controller audience admitted', async () => {
            const f = await createNativeSessionTeamCredentialFixture();
            expect(await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
                accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).toEqual({ ok: true });
            await db.session.update({ where: { id: f.session.id }, data: { active: false } });
            await expect(commitSessionAgentCurrentView({ actorUserId: f.creator.id, sessionId: f.session.id,
                currentView: { kind: 'legacy_v0', metadataCiphertext: JSON.stringify({ agent: 'codex' }),
                    expectedMetadataVersion: f.session.metadataVersion, agentStateCiphertext: null,
                    expectedAgentStateVersion: f.session.agentStateVersion } })).resolves.toMatchObject({ ok: true });
            expect(await db.sessionTeamCredentialBinding.count({ where: { sessionId: f.session.id } })).toBe(0);
        });

        it('deletes a native resource when its controller has a recipient outside the Team', async () => {
            const f = await createNativeSessionTeamCredentialFixture();
            const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
            await db.machineAccountGrant.create({ data: { machineId: f.controller.id, accountId: recipient.id,
                accessLevel: 'view', createdByAccountId: f.custodian.id } });
            expect(await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
                accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).toEqual({ ok: true });
            await expect(inTx(tx => deleteTeamCredentialResourceInTx(tx, { actorAccountId: f.custodian.id,
                resourceId: f.credential.id, expectedRevision: f.credential.revision,
                authentication: TEST_TEAM_AUTHENTICATION }))).resolves.toEqual({ ok: true });
            expect(await db.teamCredentialResource.findUnique({ where: { id: f.credential.id } })).toBeNull();
        });

        it.each(['submission-first', 'deletion-first'] as const)(
            'serializes prepared Session deletion against native submission: %s', async order => {
                const f = await createNativeSessionTeamCredentialFixture();
                expect(await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
                    accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).toEqual({ ok: true });
                const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
                    accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
                if (!prepared.ok) throw new Error('Expected prepared native delivery');
                const submit = (tx: Tx) => submitSessionTeamCredentialNativeDeliveryInTx(tx, {
                    sessionId: f.session.id, accountId: f.creator.id, bindingKey: prepared.binding.safeFacet.bindingKey,
                    expectedResourceRevision: f.credential.revision, expectedSourceRevision: f.nativeSource.sourceRevision,
                    expectedProviderTicket: f.nativeSource.providerTicket, operation: 'install', requestId: randomUUID(),
                    authentication: TEST_AUTHENTICATION,
                });
                const remove = (tx: Tx) => deleteSessionWithRecipientsInTx(tx, { sessionId: f.session.id,
                    ownerAccountId: f.creator.id, reason: 'user_request' });
                if (order === 'submission-first') {
                    await expect(afterUncommittedMutation(async tx => {
                        expect(await submit(tx)).toEqual({ ok: true, submitted: true });
                    }, remove)).resolves.toEqual({ ok: true });
                    expect(await db.session.findUnique({ where: { id: f.session.id }, select: { seq: true } })).toBeNull();
                    expect(await db.sessionTeamCredentialBinding.count({ where: { sessionId: f.session.id } })).toBe(0);
                } else {
                    const result = await afterUncommittedMutation(async tx => {
                        expect(await remove(tx)).toEqual({ ok: true });
                    }, submit);
                    expect(result).toEqual({ ok: false, code: 'resource_changed' });
                    expect(await db.session.findUnique({ where: { id: f.session.id } })).toBeNull();
                    expect(await db.sessionTeamCredentialBinding.findMany({ where: { sessionId: f.session.id } })).toEqual([]);
                }
            },
        );

        it('cannot accept a new native binding after Session deletion wins', async () => {
            const f = await createNativeSessionTeamCredentialFixture();
            const result = await afterUncommittedMutation(async tx => {
                expect(await deleteSessionWithRecipientsInTx(tx, { sessionId: f.session.id,
                    ownerAccountId: f.creator.id, reason: 'user_request' })).toEqual({ ok: true });
            }, async tx => {
                try {
                    return await writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
                        accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION });
                } catch (error) {
                    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2003') {
                        return { ok: false, reason: 'foreign_key_refused' } as const;
                    }
                    throw error;
                }
            });
            expect(result.ok).toBe(false);
            expect(await db.session.findUnique({ where: { id: f.session.id } })).toBeNull();
            expect(await db.sessionTeamCredentialBinding.findMany({ where: { sessionId: f.session.id } })).toEqual([]);
        });

        it("commits one guarded delete while a canonical same-Account publisher advances", async () => {
            const account = await db.account.create({
                data: { publicKey: `${PUBLIC_KEY_PREFIX}${randomUUID()}`, encryptionMode: "plain" },
            });
            const session = await db.session.create({
                data: {
                    accountId: account.id,
                    tag: randomUUID(),
                    metadata: "{}",
                    encryptionMode: "plain",
                    active: false,
                },
            });
            await db.sessionMessage.create({
                data: {
                    sessionId: session.id,
                    seq: 1,
                    localId: randomUUID(),
                    content: { t: "plain", v: { role: "assistant", content: "delete me" } },
                },
            });

            const transaction = db.$transaction;
            let advanced = false;
            const failedStatements: string[] = [];
            db.$transaction = new Proxy(transaction, {
                apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                        get(inner, property, innerReceiver) {
                            if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, innerReceiver);
                            return async (query: string, ...values: unknown[]) => {
                                if (!advanced && query.includes('FROM "Account"') && query.includes("FOR NO KEY UPDATE")) {
                                    advanced = true;
                                    await inTx(async peerTx => {
                                        await markAccountChanged(peerTx, {
                                            accountId: account.id,
                                            kind: "account",
                                            entityId: "contention-peer",
                                        });
                                    }, {
                                        isolationLevel: "ReadCommitted",
                                        transactionClass: "session-delete-contention-peer",
                                    });
                                }
                                try {
                                    return await inner.$queryRawUnsafe(query, ...values);
                                } catch (error) {
                                    failedStatements.push(query);
                                    throw error;
                                }
                            };
                        },
                    })), ...args.slice(1)]);
                },
            });

            try {
                await expect(deleteOwnedSession({
                    sessionId: session.id,
                    ownerAccountId: account.id,
                    reason: "user_request",
                })).resolves.toEqual({ ok: true });
            } finally {
                db.$transaction = transaction;
            }

            expect(advanced).toBe(true);
            expect(failedStatements).toEqual([]);
            expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
            expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 2 });
            expect(await db.accountChange.findMany({
                where: { accountId: account.id },
                orderBy: { cursor: "asc" },
                select: { kind: true, entityId: true, cursor: true },
            })).toEqual([
                { kind: "account", entityId: "contention-peer", cursor: 1 },
                { kind: "session", entityId: session.id, cursor: 2 },
            ]);
        });

        it("keeps the Session and emits no deletion publication when its supplied guard changes before admission", async () => {
            const account = await db.account.create({
                data: { publicKey: `${PUBLIC_KEY_PREFIX}${randomUUID()}`, encryptionMode: "plain" },
            });
            const session = await db.session.create({
                data: {
                    accountId: account.id,
                    tag: randomUUID(),
                    metadata: "{}",
                    encryptionMode: "plain",
                    active: false,
                },
            });

            const transaction = db.$transaction;
            let changed = false;
            db.$transaction = new Proxy(transaction, {
                apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                        get(inner, property, innerReceiver) {
                            if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, innerReceiver);
                            return async (query: string, ...values: unknown[]) => {
                                if (!changed && query.includes('FROM "Session"') && query.includes("FOR NO KEY UPDATE")) {
                                    changed = true;
                                    await db.session.update({ where: { id: session.id },
                                        data: { metadataLayoutVersion: { increment: 1 } } });
                                }
                                return inner.$queryRawUnsafe(query, ...values);
                            };
                        },
                    })), ...args.slice(1)]);
                },
            });

            try {
                await expect(deleteOwnedSession({
                    sessionId: session.id,
                    ownerAccountId: account.id,
                    reason: "user_request",
                    sessionWhereGuard: { metadataLayoutVersion: 0 },
                })).resolves.toEqual({ ok: false, error: "not-found" });
            } finally {
                db.$transaction = transaction;
            }

            expect(changed).toBe(true);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
                .toMatchObject({ metadataLayoutVersion: 1 });
            expect(await db.accountChange.count({
                where: { accountId: account.id, kind: "session", entityId: session.id },
            })).toBe(0);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 0 });
        });
    },
);
