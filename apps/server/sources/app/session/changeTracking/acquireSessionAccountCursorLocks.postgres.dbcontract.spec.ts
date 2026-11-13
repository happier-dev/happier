import { buildSessionFollowReceiverChangeEntityIdV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { encodeAutomationSessionLifecycleConfiguration } from "@/app/automations/automationSessionLifecycleConfigurationCodec";
import { acquireSessionAccountCursorLocksInTx, prepareSessionAccountCursorLocks } from "./acquireSessionAccountCursorLocksInTx";
import { markSessionProjectionRecipientsChanged } from "./markSessionProjectionRecipientsChanged";
import { sourceKeyForSessionFollowSourceV1 } from "@/app/session/follow/sessionFollowSourceIdentity";
import { markAccountChangesForSessionAccounts } from "./markAccountChangesForSessionAccounts";
import { prepareLayout1SessionCreate } from "@/app/session/create/prepareLayout1SessionCreate";
import { createOrRejoinLayout1SessionByTag } from "@/app/session/create/createOrRejoinLayout1SessionByTag";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { removeTeamMemberForActorInTx } from "@/app/teams/memberships/memberAdministration";
import { acquireTeamMutationAccountAdmissionInTx } from "@/app/teams/memberships/sessionAccessEffects";
import { createSessionMessage } from "@/app/session/sessionWriteService";
import { deleteOwnedSession } from "@/app/session/delete/deleteOwnedSession";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Prepared Session cursor audience", () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it("returns the fresh recipient subset on reentry after its own canonical membership removal", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const reader = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}",
            encryptionMode: "plain", currentStorageState: "hosted" } });
        const team = await db.team.create({ data: { name: randomUUID() } });
        try {
            await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
            const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: "member" } });
            await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date() } });
            let attempts = 0;
            await inTx(async tx => {
                attempts++;
                // Team removal can also publish to Home administrators outside
                // this Session. Admit that canonical union before any resource
                // lock so a legitimate broader Team audience is not mistaken
                // for a replay caused by Session-recipient contraction.
                await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: team.id,
                    accountIds: [owner.id, reader.id], affectedAccountIds: [reader.id],
                    membershipChange: { kind: "teamMembership", teamId: team.id } });
                expect(await acquireSessionAccountCursorLocksInTx(tx, [session.id])).toEqual([owner.id, reader.id].sort());
                expect(await removeTeamMemberForActorInTx(tx, { teamId: team.id, membershipId: member.id,
                    actorAccountId: owner.id, authentication: { authenticationAuthority: "present_user", authenticationEvidence: [] } }))
                    .toMatchObject({ ok: true });
                expect(await acquireSessionAccountCursorLocksInTx(tx, [session.id])).toEqual([owner.id]);
            }, { isolationLevel: "ReadCommitted" });
            expect(attempts).toBe(1);
        } finally {
            await deleteOwnedSession({ sessionId: session.id, reason: "retention_policy" });
            await db.team.delete({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id] } } });
        }
    });

    it("excludes a revoked recipient when an append queues behind canonical membership removal", async () => {
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const reader = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}",
            encryptionMode: "plain", currentStorageState: "hosted" } });
        const team = await db.team.create({ data: { name: randomUUID() } });
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let removal: Promise<void> | undefined;
        let append: ReturnType<typeof createSessionMessage> | undefined;
        try {
            await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
            const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: "member" } });
            await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date() } });
            const write = (localId: string) => createSessionMessage({ actorUserId: owner.id, sessionId: session.id,
                inputAdmission: "authenticatedAccount", authentication: createPresentUserSessionAccessAuthentication(),
                localId, messageRole: "user", content: { t: "plain", v: { text: localId } } });
            // The legal earlier serialization still publishes to the current member.
            const before = await write(randomUUID());
            expect(before).toMatchObject({ ok: true });
            if (!before.ok) throw new Error("Earlier append was refused");
            expect(before.recipientCursors.map(row => row.accountId).sort()).toEqual([owner.id, reader.id].sort());
            let entered!: (pid: number) => void;
            const held = new Promise<number>(resolve => { entered = resolve; });
            removal = inTx(async tx => {
                expect(await removeTeamMemberForActorInTx(tx, { teamId: team.id, membershipId: member.id,
                    actorAccountId: owner.id, authentication: { authenticationAuthority: "present_user", authenticationEvidence: [] } }))
                    .toMatchObject({ ok: true });
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                entered(pid);
                await released;
            }, { isolationLevel: "ReadCommitted" });
            void removal.catch(() => undefined);
            const pid = await Promise.race([held, removal.then(() => { throw new Error("Removal never held its transaction"); })]);
            let settled = false;
            append = write(randomUUID()).finally(() => { settled = true; });
            void append.catch(() => undefined);
            let blocked = false;
            while (!settled && !blocked) {
                const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                    SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                        AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
                `;
                blocked = row.blocked;
            }
            expect(blocked).toBe(true);
            release();
            await removal;
            const after = await append;
            expect(after.ok).toBe(true);
            if (!after.ok) throw new Error("Queued append was refused");
            expect(after.recipientCursors.map(row => row.accountId)).toEqual([owner.id]);
            expect(after.message.seq).toBe(before.message.seq + 1);
        } finally {
            release();
            await Promise.allSettled([removal, append]);
            vi.unstubAllEnvs();
            await deleteOwnedSession({ sessionId: session.id, reason: "retention_policy" });
            await db.team.delete({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id] } } });
        }
    });

    it("reuses a held Session audience on nested writes while rereading current recipients", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        try {
            await inTx(async tx => {
                let resourceLocks = 0;
                let audienceReads = 0;
                // Observe real database calls; query results and transaction ownership stay real.
                const observed = new Proxy(tx, { get(target, property, receiver) {
                    const value = Reflect.get(target, property, receiver);
                    if (property === "$queryRawUnsafe" && typeof value === "function") {
                        return (...args: unknown[]) => {
                            if (typeof args[0] === "string" && /FROM "Session".*FOR NO KEY UPDATE/.test(args[0])) resourceLocks += 1;
                            return Reflect.apply(value, target, args);
                        };
                    }
                    if (property === "sessionFollowEdge") {
                        return new Proxy(target.sessionFollowEdge, { get(delegate, key) {
                            const method = Reflect.get(delegate, key, delegate);
                            if (key !== "findMany" || typeof method !== "function") return method;
                            return (...args: unknown[]) => {
                                audienceReads += 1;
                                return Reflect.apply(method, delegate, args);
                            };
                        } });
                    }
                    return value;
                } });
                for (let index = 0; index < 3; index += 1) {
                    expect(await acquireSessionAccountCursorLocksInTx(observed, [session.id])).toEqual([owner.id]);
                }
                expect(resourceLocks).toBe(1);
                // One fresh read per entry: a reentry can observe this transaction's own writes.
                expect(audienceReads).toBe(3);
                await tx.session.update({ where: { id: session.id }, data: { seq: { increment: 1 } } });
                await markAccountChangesForSessionAccounts({ tx, sessionId: session.id, accountIds: [owner.id] });
            }, { isolationLevel: "ReadCommitted" });
            expect(await db.accountChange.findMany({ where: { sessionId: session.id }, select: { accountId: true, cursor: true } }))
                .toEqual([{ accountId: owner.id, cursor: 1 }]);
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it("skips the census reread for a re-entrant caller that adds no audience, and still fences without a held scope", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        try {
            await inTx(async tx => {
                let audienceReads = 0;
                const observed = new Proxy(tx, { get(target, property, receiver) {
                    const value = Reflect.get(target, property, receiver);
                    if (property !== "sessionFollowEdge") return value;
                    return new Proxy(target.sessionFollowEdge, { get(delegate, key) {
                        const method = Reflect.get(delegate, key, delegate);
                        if (key !== "findMany" || typeof method !== "function") return method;
                        return (...args: unknown[]) => {
                            audienceReads += 1;
                            return Reflect.apply(method, delegate, args);
                        };
                    } });
                } });
                // Nothing held yet: the option must still run the full census and fence.
                expect(await acquireSessionAccountCursorLocksInTx(observed, [session.id], [], { reuseHeldAudience: true })).toEqual([owner.id]);
                expect(audienceReads).toBe(1);
                await expect(db.$queryRaw`
                    SELECT id FROM "Session" WHERE id = ${session.id} FOR NO KEY UPDATE NOWAIT
                `).rejects.toMatchObject({ code: "P2010", meta: { code: "55P03" } });
                // The same scope is held: no reread, same admitted audience.
                expect(await acquireSessionAccountCursorLocksInTx(observed, [session.id], [], { reuseHeldAudience: true })).toEqual([owner.id]);
                expect(audienceReads).toBe(1);
                // Without the option a re-entry keeps its fresh read.
                expect(await acquireSessionAccountCursorLocksInTx(observed, [session.id])).toEqual([owner.id]);
                expect(audienceReads).toBe(2);
            }, { isolationLevel: "ReadCommitted" });
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it("replays a grant added between nested audience acquisitions", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        let attempts = 0;
        try {
            await inTx(async tx => {
                attempts += 1;
                await acquireSessionAccountCursorLocksInTx(tx, [session.id]);
                if (attempts === 1) await db.sessionGrant.create({ data: { principalKind: 'account',
                    sessionId: session.id, createdByAccountId: owner.id, accountId: recipient.id,
                } });
                const recipients = await acquireSessionAccountCursorLocksInTx(tx, [session.id]);
                await tx.session.update({ where: { id: session.id }, data: { seq: { increment: 1 } } });
                await markAccountChangesForSessionAccounts({ tx, sessionId: session.id, accountIds: recipients });
            }, { isolationLevel: "ReadCommitted" });
            expect(attempts).toBe(2);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { seq: true } })).toEqual({ seq: 1 });
            expect(await db.accountChange.findMany({ where: { sessionId: session.id }, orderBy: { accountId: "asc" }, select: { accountId: true } }))
                .toEqual([owner.id, recipient.id].sort().map(accountId => ({ accountId })));
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
        }
    });

    it("admits a new same-Account Follow resource through the existing fence rather than replaying its own write", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const sessions = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } })));
        let attempts = 0;
        try {
            await inTx(async tx => {
                attempts += 1;
                await acquireSessionAccountCursorLocksInTx(tx, [sessions[0].id]);
                await tx.sessionFollowEdge.create({ data: {
                    sourceSessionId: sessions[0].id, destinationSessionId: sessions[1].id, relation: 'follower',
                    sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: sessions[0].id }),
                    policyJson: JSON.stringify({ preset: 'important' }),
                } });
                expect(await acquireSessionAccountCursorLocksInTx(tx, [sessions[0].id])).toEqual([owner.id]);
                // Both resources really remain locked, including the newly discovered destination.
                for (const session of sessions) await expect(db.$queryRaw`
                    SELECT id FROM "Session" WHERE id = ${session.id} FOR NO KEY UPDATE NOWAIT
                `).rejects.toMatchObject({ code: "P2010", meta: { code: "55P03" } });
            }, { isolationLevel: "ReadCommitted" });
            expect(attempts).toBe(1);
        } finally {
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it("creates initial foreign access through the complete publication admission cohort", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        try {
            await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: recipient.id, status: "friend" } });
            const prepared = prepareLayout1SessionCreate({
                accountId: owner.id, tag: randomUUID(), metadata: JSON.stringify({ v: 1 }),
                ownerMetadata: { t: "plain", v: { v: 1 } }, agentState: null, dataEncryptionKey: null,
                requestedEncryptionMode: undefined, requestedStorageState: undefined, organizationPlacement: undefined,
                accountEncryptionMode: "plain", storagePolicy: "optional", defaultAccountMode: "plain",
                initialAccess: { grants: [{ subject: { kind: "account", accountId: recipient.id },
                    accessLevel: "view", canApprovePermissions: false }] },
            });
            if (!prepared.ok) throw new Error(`Unexpected preparation refusal: ${prepared.rejection.reason}`);
            const outcome = await createOrRejoinLayout1SessionByTag(prepared.prepared, createPresentUserSessionAccessAuthentication());
            expect(outcome.kind).toBe("created");
            if (outcome.kind !== "created") throw new Error("Expected a new Session");
            expect(await db.sessionGrant.findUnique({ where: { principalKind: 'account', sessionId_accountId: {
                sessionId: outcome.session.id, accountId: recipient.id,
            } }, select: { accessLevel: true } })).toEqual({ accessLevel: "view" });
            const changes = await db.accountChange.findMany({ where: { kind: "session", entityId: outcome.session.id },
                orderBy: { accountId: "asc" }, select: { accountId: true, cursor: true } });
            expect(changes.map(change => change.accountId)).toEqual([owner.id, recipient.id].sort());
            expect(changes.every(change => Number.isSafeInteger(change.cursor) && change.cursor > 0)).toBe(true);
        } finally {
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
        }
    });

    it("publishes the admitted audience when a grant commits after admission, and the next write reaches it", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        let attempts = 0;
        const write = (afterAdmission?: () => Promise<unknown>) => inTx(async tx => {
            attempts += 1;
            const recipients = await acquireSessionAccountCursorLocksInTx(tx, [session.id]);
            await afterAdmission?.();
            await tx.session.update({ where: { id: session.id }, data: { seq: { increment: 1 } } });
            await markAccountChangesForSessionAccounts({ tx, sessionId: session.id, accountIds: recipients });
        }, { isolationLevel: "ReadCommitted" });
        const changed = () => db.accountChange.findMany({ where: { sessionId: session.id },
            orderBy: { accountId: "asc" }, select: { accountId: true } });
        try {
            await write(() => db.sessionGrant.create({ data: { principalKind: 'account',
                sessionId: session.id, createdByAccountId: owner.id, accountId: recipient.id,
            } }));
            // Accepted glitch (owner, 2026-10-31): the newcomer's client learns of
            // this write on its next change or open; reads are authorized at read time.
            expect(attempts).toBe(1);
            expect(await changed()).toEqual([{ accountId: owner.id }]);
            await write();
            expect(await changed()).toEqual([owner.id, recipient.id].sort().map(accountId => ({ accountId })));
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
        }
    });

    describe("audience reads per Session write", () => {
        const statements: Prisma.QueryEvent[] = [];
        let client: PrismaClient<Prisma.PrismaClientOptions, "query">;
        let originalTransaction: typeof db.$transaction;
        beforeAll(async () => {
            client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
            client.$on("query", event => statements.push(event));
            await client.$connect();
            originalTransaction = db.$transaction;
            // Real Postgres through a query-observing twin of the transaction transport.
            db.$transaction = new Proxy(originalTransaction, { apply: (_target, _receiver, args) =>
                Reflect.apply(client.$transaction, client, args) });
        });
        afterAll(async () => {
            db.$transaction = originalTransaction;
            await client.$disconnect();
        });
        const censusReads = () => statements.filter(({ query }) => /FROM\s+"(?:public"\.")?SessionShare"/.test(query)).length;

        it("reads the lock census once when a transcript write re-enters its held admission", async () => {
            vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted",
            } });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id, accountId: recipient.id } });
            try {
                statements.length = 0;
                const written = await createSessionMessage({ actorUserId: owner.id, sessionId: session.id,
                    inputAdmission: "authenticatedAccount", authentication: createPresentUserSessionAccessAuthentication(),
                    localId: randomUUID(), messageRole: "user", content: { t: "plain", v: { text: "once" } } });
                expect(written.ok).toBe(true);
                if (!written.ok) throw new Error("Append was refused");
                expect(written.recipientCursors.map(row => row.accountId).sort()).toEqual([owner.id, recipient.id].sort());
                const lockCensusReads = statements.filter(({ query }) => /sourceExecutionRunSessionId/.test(query)
                    && /FROM\s+"(?:public"\.")?SessionFollowEdge"/.test(query)).length;
                console.info("SESSION_MESSAGE_LOCK_CENSUS", lockCensusReads, "statements", statements.length);
                expect(lockCensusReads).toBe(1);
            } finally {
                vi.unstubAllEnvs();
                await deleteOwnedSession({ sessionId: session.id, reason: "retention_policy" });
                await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
            }
        });

        it("reads no Session row after its own seq update and still stamps a tracked follower unread", async () => {
            vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            const follower = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted",
            } });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id, accountId: follower.id } });
            await db.accountSessionFollow.create({ data: { accountId: follower.id, sessionId: session.id } });
            await db.accountSessionReadState.create({ data: { accountId: follower.id, sessionId: session.id, lastViewedSessionSeq: 0 } });
            try {
                statements.length = 0;
                const written = await createSessionMessage({ actorUserId: owner.id, sessionId: session.id,
                    inputAdmission: "authenticatedAccount", authentication: createPresentUserSessionAccessAuthentication(),
                    localId: randomUUID(), messageRole: "user", content: { t: "plain", v: { text: "once" } } });
                expect(written.ok).toBe(true);
                if (!written.ok) throw new Error("Append was refused");
                expect(written.recipientCursors.map(row => row.accountId).sort()).toEqual([owner.id, follower.id].sort());
                const seqUpdate = statements.findIndex(({ query }) => /UPDATE\s+"(?:public"\.")?Session"\s+SET\s+"seq"/.test(query));
                expect(seqUpdate).toBeGreaterThanOrEqual(0);
                const readsAfterOwnWrite = statements.slice(seqUpdate + 1).filter(({ query }) =>
                    /^\s*SELECT\b/i.test(query) && /FROM\s+"(?:public"\.")?Session"/.test(query));
                expect(readsAfterOwnWrite.map(({ query }) => query)).toEqual([]);
                await expect(db.accountSessionReadState.findUniqueOrThrow({
                    where: { accountId_sessionId: { accountId: follower.id, sessionId: session.id } },
                })).resolves.toMatchObject({ unreadSince: expect.any(Date), lastViewedSessionSeq: 0 });
            } finally {
                vi.unstubAllEnvs();
                await deleteOwnedSession({ sessionId: session.id, reason: "retention_policy" });
                await db.account.deleteMany({ where: { id: { in: [owner.id, follower.id] } } });
            }
        });

        it.each([
            ["admitted in the transaction", (sessionId: string, accountId: string) => inTx(async tx => {
                await acquireSessionAccountCursorLocksInTx(tx, [sessionId], [accountId]);
                await tx.session.update({ where: { id: sessionId }, data: { seq: { increment: 1 } } });
            }, { isolationLevel: "ReadCommitted" })],
            ["prepared before the transaction", (sessionId: string, accountId: string) => inTx(async tx => {
                await tx.session.update({ where: { id: sessionId }, data: { seq: { increment: 1 } } });
            }, { isolationLevel: "ReadCommitted", prepare: () => prepareSessionAccountCursorLocks([sessionId], [accountId]) })],
        ] as const)("takes one census for a write %s", async (_label, write) => {
            const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
            } });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id, accountId: recipient.id } });
            try {
                statements.length = 0;
                await write(session.id, owner.id);
                console.info("SESSION_WRITE_CENSUS", _label, censusReads());
                expect(censusReads()).toBe(1);
            } finally {
                await db.session.delete({ where: { id: session.id } });
                await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
            }
        });
    });

    it.each(["Serializable", "ReadCommitted"] as const)("replays a changed follower audience and fences outgoing, incoming and Archive lifecycle Accounts at %s", async isolationLevel => {
        const accounts = await Promise.all(Array.from({ length: 6 }, () => db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        })));
        const followerOwner = await db.account.create({ data: {
            id: `000-follow-${randomUUID()}`, publicKey: randomUUID(), encryptionMode: "plain",
        } });
        accounts.push(followerOwner);
        const [sourceOwner, leadOwner, childOwner, automationOwner, scopeOwner, recipient] = accounts;
        try {
            const createSession = (accountId: string) => db.session.create({ data: {
                accountId, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
            } });
            const source = await createSession(sourceOwner.id);
            const lead = await createSession(leadOwner.id);
            const child = await createSession(childOwner.id);
            const follower = await createSession(followerOwner.id);
            const scope = await createSession(scopeOwner.id);
            await db.sessionFollowEdge.createMany({ data: [
                { sourceSessionId: source.id, destinationSessionId: lead.id, relation: 'manager', managerSourceSessionId: source.id },
                { sourceSessionId: source.id, destinationSessionId: lead.id, relation: 'follower' },
                { sourceSessionId: child.id, destinationSessionId: source.id, relation: 'manager', managerSourceSessionId: child.id },
                { sourceSessionId: source.id, destinationSessionId: follower.id, relation: 'follower' },
            ].map(edge => ({ ...edge, policyJson: JSON.stringify({ preset: 'important' }),
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: edge.sourceSessionId }) })) });
            const automation = await db.automation.create({ data: {
                accountId: automationOwner.id, name: "Archive audience", templateCiphertext: "{}", scopeSessionId: scope.id,
            } });
            await db.automationTrigger.create({ data: {
                automationId: automation.id, kind: "sessionLifecycle",
                ...encodeAutomationSessionLifecycleConfiguration({
                    kind: "sessionLifecycle", sourceSessionId: source.id,
                    events: ["sessionArchived"], policy: { kind: "everyMatch" },
                }),
            } });
            let preparations = 0;
            await inTx(async tx => {
                expect(await tx.$queryRaw<Array<{ isolation: string }>>`
                    SELECT current_setting('transaction_isolation') AS isolation
                `).toEqual([{ isolation: isolationLevel === "Serializable" ? "serializable" : "read committed" }]);
                // Each independent contender must observe the actual row fence;
                // checking a union would hide a missing later audience member.
                // The first attempt's fan-out discovers the newcomer and replays
                // through Account admission, which never extends its sorted lock set.
                for (const account of preparations === 2 ? accounts : []) {
                    await expect(db.$queryRaw`
                        SELECT id FROM "Account" WHERE id = ${account.id} FOR UPDATE NOWAIT
                    `).rejects.toMatchObject({ code: "P2010", meta: { code: "55P03" } });
                    await expect(db.$queryRaw`
                        SELECT id FROM "Account" WHERE id = ${account.id} FOR NO KEY UPDATE NOWAIT
                    `).resolves.toEqual([{ id: account.id }]);
                }
                await tx.session.update({ where: { id: source.id }, data: { seq: { increment: 1 } } });
                await markSessionProjectionRecipientsChanged({ tx, sessionId: source.id });
                expect(await tx.accountChange.findMany({ where: { sessionId: follower.id },
                    orderBy: { accountId: 'asc' }, select: { accountId: true, hint: true } }))
                    .toEqual([]);
                expect(await tx.account.findUniqueOrThrow({ where: { id: leadOwner.id }, select: { seq: true } }))
                    .toEqual({ seq: 0 });
            }, {
                isolationLevel,
                prepare: async () => {
                    preparations += 1;
                    const fence = await prepareSessionAccountCursorLocks([source.id], [], { includeLifecyclePublications: true });
                    if (preparations === 1) {
                        // A real committed grant between discovery and mutation
                        // must refresh the whole sorted fence, never extend it.
                        await db.sessionGrant.create({ data: { principalKind: 'account',
                            sessionId: follower.id, createdByAccountId: followerOwner.id, accountId: recipient.id,
                        } });
                    }
                    return fence;
                },
            });
            expect(preparations).toBe(2);
            expect(await db.accountChange.findMany({ where: { sessionId: follower.id },
                orderBy: { accountId: 'asc' }, select: { accountId: true, hint: true } }))
                .toEqual([followerOwner.id, recipient.id].sort().map(accountId => ({ accountId, hint: { followReceiverAvailabilityChanged: false } })));
            expect(await db.account.findUniqueOrThrow({ where: { id: leadOwner.id }, select: { seq: true } }))
                .toEqual({ seq: 2 });
            expect(await db.accountChange.findMany({ where: { accountId: leadOwner.id }, orderBy: { cursor: 'asc' },
                select: { kind: true, entityId: true, cursor: true } })).toEqual([
                { kind: 'session', entityId: lead.id, cursor: 1 },
                { kind: 'account', entityId: buildSessionFollowReceiverChangeEntityIdV1(lead.id), cursor: 2 },
            ]);
        } finally {
            await db.session.deleteMany({ where: { accountId: { in: accounts.map(account => account.id) } } });
            await db.account.deleteMany({ where: { id: { in: accounts.map(account => account.id) } } });
        }
    });
});
