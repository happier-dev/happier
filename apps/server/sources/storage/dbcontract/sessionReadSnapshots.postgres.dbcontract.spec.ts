import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, signAccountContentKeyBindingV1 } from "@happier-dev/protocol";
import { decodeBase64 } from "privacy-kit";

import { listSessionDrafts, readSessionDraft } from "@/app/account/sessionDrafts/sessionDraftService";
import { sessionDraftPhysicalKey } from "@/app/account/sessionDrafts/sessionDraftPhysicalKey";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { authorizeSessionFollowSourceKeyPreparer } from "@/app/session/follow/sessionFollowEdgeService";
import { sourceKeyForSessionFollowSourceV1 } from "@/app/session/follow/sessionFollowSourceIdentity";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { readSessionTurns } from "@/app/api/routes/session/registerSessionTurnMutationRoute";
import { listSessionResponsibilityCandidates } from "@/app/session/access/sessionResponsibilityService";
import { readSessionMessagePage, registerSessionMessageRoutes } from "@/app/api/routes/session/registerSessionMessageRoutes";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionListingRoutes } from "@/app/api/routes/session/registerSessionListingRoutes";
import { readMembershipSessionDataKeyEnvelopePage } from "@/app/session/encryption/membershipSessionDataKeyEnvelopeService";
import { admitTeamMemberInTx } from "@/app/teams/memberships/membershipService";
import { registerSessionAccessGrantRoutes } from "@/app/api/routes/session/registerSessionAccessGrantRoutes";
import { loadPendingActivationPublication } from "@/app/session/pending/publishPendingMutation";
import { listPendingMessages } from "@/app/session/pending/pendingMessageService";
import { buildSessionInputAdmissionReceipt, readCurrentSessionInputMachineTargetInTx } from "@/app/session/messages/sessionInputAdmission";
import { resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Session coherent read snapshots", () => {
    let connected = false;
    let originalDatabaseUrl: string | undefined;
    const applicationName = `serialaudit-session-${randomUUID()}`;
    const authentication = createPresentUserSessionAccessAuthentication();

    beforeAll(async () => {
        const suppliedDatabaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!suppliedDatabaseUrl || process.env.DATABASE_URL !== suppliedDatabaseUrl
            || !process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) {
            throw new Error("Run against the disposable PostgreSQL DB-contract container");
        }
        originalDatabaseUrl = suppliedDatabaseUrl;
        vi.stubEnv("HAPPIER_FEATURE_TEAMS__ENABLED", "1");
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", `srv_${randomUUID().replaceAll("-", "")}`);
        const databaseUrl = new URL(suppliedDatabaseUrl);
        databaseUrl.searchParams.set("application_name", applicationName);
        process.env.DATABASE_URL = databaseUrl.toString();
        initDbPostgres();
        await db.$connect();
        connected = true;
        expect(await db.$queryRaw`SELECT current_setting('application_name') AS name`).toEqual([{ name: applicationName }]);
    });

    afterAll(async () => {
        if (connected) await db.$disconnect();
        if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
        vi.unstubAllEnvs();
    });

    // The writer holds the second relation read by the real owner. Its commit
    // changes both facts while the reader is paused between statements.
    async function acrossCommit<T>(input: {
        lock: (tx: Tx) => Promise<unknown>;
        write: (tx: Tx) => Promise<unknown>;
        read: () => Promise<T>;
    }): Promise<{ before: T; after: T; predicateLocks: number }> {
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: (pid: number) => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        const writer = inTx(async tx => {
            await input.lock(tx);
            await input.write(tx);
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            ready(pid);
            await released;
        }, { isolationLevel: "Serializable" });
        const writerOutcome = Promise.allSettled([writer]);
        let reader: Promise<T> | undefined;
        try {
            const writerPid = await Promise.race([started, writer.then(() => { throw new Error("Writer exited before rendezvous"); })]);
            let settled = false;
            reader = input.read();
            const readerOutcome = Promise.allSettled([reader]).finally(() => { settled = true; });
            let readerPid: number | undefined;
            while (!settled) {
                const blocked = await db.$queryRaw<Array<{ pid: number }>>`
                    SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                    AND application_name = ${applicationName}
                    AND ${writerPid} = ANY(pg_blocking_pids(pid))
                `;
                if (blocked[0]) { readerPid = blocked[0].pid; break; }
            }
            if (readerPid === undefined) await reader;
            expect(readerPid).toBeDefined();
            const [locks] = await db.$queryRaw<Array<{ count: number }>>`
                SELECT count(*)::int AS count FROM pg_locks WHERE mode = 'SIReadLock' AND pid = ${readerPid!}
                AND virtualtransaction IN (
                    SELECT virtualtransaction FROM pg_locks
                    WHERE pid = ${readerPid!} AND locktype = 'virtualxid' AND mode = 'ExclusiveLock' AND granted
                )
            `;
            release();
            await writer;
            const before = await reader;
            await readerOutcome;
            return { before, after: await input.read(), predicateLocks: locks.count };
        } finally {
            release();
            await writerOutcome;
            if (reader) await Promise.allSettled([reader]);
        }
    }

    it.each(["read", "list"] as const)("keeps Session draft %s content and access coherent without predicate locks", async operation => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const other = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        const address = { kind: "session" as const, sessionId: session.id };
        const key = sessionDraftPhysicalKey(address);
        if (!key) throw new Error("Draft address is not persistable");
        const content = (value: string) => ({ t: "encrypted" as const, c: value });
        await db.userKVStore.create({ data: { accountId: account.id, key,
            value: new TextEncoder().encode(JSON.stringify(content("before"))), version: 0 } });
        try {
            const result = await acrossCommit({
                lock: tx => operation === "read"
                    ? tx.$executeRaw`LOCK TABLE "UserKVStore" IN ACCESS EXCLUSIVE MODE`
                    : tx.$executeRaw`LOCK TABLE "Session" IN ACCESS EXCLUSIVE MODE`,
                write: async tx => {
                    await tx.session.update({ where: { id: session.id }, data: { accountId: other.id } });
                    await tx.userKVStore.update({ where: { accountId_key: { accountId: account.id, key } },
                        data: { value: new TextEncoder().encode(JSON.stringify(content("after"))), version: 1 } });
                },
                read: async () => operation === "read"
                    ? readSessionDraft({ accountId: account.id, address, authentication })
                    : listSessionDrafts({ accountId: account.id, authentication }),
            });
            if (operation === "read") {
                expect(result.before).toMatchObject({ status: "present", record: { revision: 0, content: content("before") } });
                expect(result.after).toEqual({ status: "absent" });
            } else {
                expect(result.before).toMatchObject({ items: [{ revision: 0, content: content("before") }] });
                expect(result.after).toEqual({ items: [] });
            }
            expect(result.predicateLocks).toBe(0);
        } finally {
            await db.userKVStore.deleteMany({ where: { accountId: account.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
            await db.account.delete({ where: { id: other.id } });
        }
    });

    it("captures Follow key-preparer eligibility before a concurrent archive without predicate locks", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        const destination = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        await db.sessionFollowEdge.create({ data: {
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: "session", sessionId: source.id }),
            sourceSessionId: source.id, destinationSessionId: destination.id,
            policyJson: JSON.stringify({ preset: "quiet" }),
        } });
        try {
            const result = await acrossCommit({
                lock: tx => tx.$executeRaw`LOCK TABLE "SessionFollowEdge" IN ACCESS EXCLUSIVE MODE`,
                write: tx => tx.session.update({ where: { id: source.id }, data: { archivedAt: new Date() } }),
                read: () => authorizeSessionFollowSourceKeyPreparer({ accountId: account.id,
                    sourceSessionId: source.id, destinationSessionId: destination.id, authentication }),
            });
            expect(result.before).toEqual({ ok: true, value: { destinationRuntimeAccountId: account.id } });
            expect(result.after).toEqual({ ok: false, error: "session_archived" });
            expect(result.predicateLocks).toBe(0);
        } finally {
            await db.session.deleteMany({ where: { id: { in: [source.id, destination.id] } } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(["stop", "projection"] as const)("captures publisher %s authority coherently without predicate locks", async operation => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const fence = new Date();
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}",
            active: true, lastActiveAt: fence, publisherGeneration: 1n, publisherGenerationLastActiveAt: fence } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.accessKey.create({ data: { accountId: account.id, sessionId: session.id, machineId: machine.id, data: "opaque" } });
        const presence = createSessionPublisherPresence();
        const binding = { accountId: account.id, sessionId: session.id, machineId: machine.id };
        try {
            const result = await acrossCommit({
                lock: tx => operation === "stop"
                    ? tx.$executeRaw`LOCK TABLE "AccessKey" IN ACCESS EXCLUSIVE MODE`
                    : tx.$executeRaw`LOCK TABLE "Account" IN ACCESS EXCLUSIVE MODE`,
                write: async tx => {
                    await tx.session.update({ where: { id: session.id }, data: { publisherGeneration: 2n } });
                    await tx.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
                },
                read: async () => operation === "stop"
                    ? presence.captureExplicitMachineStop({ binding })
                    : presence.resolveProjectedCurrentPublisher({ expectedAccountId: account.id, expectedSessionId: session.id,
                        projection: { v: 1, ...binding, committedFenceMs: fence.getTime(), publisherGeneration: "1" } }),
            });
            if (operation === "stop") {
                expect(result.before).toMatchObject({ status: "captured", target: { authority: { kind: "generation", publisherGeneration: 1n } } });
                expect(result.after).toEqual({ status: "rejected", reason: "machine_control_unavailable" });
            } else {
                expect(result.before).toEqual({ ...binding, committedFence: fence });
                expect(result.after).toBeNull();
            }
            expect(result.predicateLocks).toBe(0);
        } finally {
            await db.accessKey.deleteMany({ where: { sessionId: session.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("captures turn rows and Session latest-turn state coherently without predicate locks", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", latestTurnId: "turn-before" } });
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId: "turn-before", status: "in_progress", startedAt: 1n, updatedAt: 1n } });
        try {
            const result = await acrossCommit({
                lock: tx => tx.$executeRaw`LOCK TABLE "SessionTurn" IN ACCESS EXCLUSIVE MODE`,
                write: async tx => {
                    await tx.sessionTurn.update({ where: { sessionId_turnId: { sessionId: session.id, turnId: "turn-before" } },
                        data: { status: "completed", updatedAt: 2n, terminalAt: 2n } });
                    await tx.session.update({ where: { id: session.id }, data: { latestTurnId: null } });
                },
                read: () => readSessionTurns({ userId: account.id, sessionId: session.id, authentication }),
            });
            expect(result.before).toMatchObject({ status: 200, body: { latestTurnId: "turn-before", turns: [{ turnId: "turn-before", status: "in_progress" }] } });
            expect(result.after).toMatchObject({ status: 200, body: { turns: [{ turnId: "turn-before", status: "completed" }] } });
            expect(result.after.body).not.toHaveProperty("latestTurnId");
            expect(result.predicateLocks).toBe(0);
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("captures responsibility candidates with the Session admission snapshot without predicate locks", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), name: "before" } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        try {
            const result = await acrossCommit({
                lock: tx => tx.$executeRaw`LOCK TABLE "Account" IN ACCESS EXCLUSIVE MODE`,
                write: async tx => {
                    await tx.session.update({ where: { id: session.id }, data: { archivedAt: new Date() } });
                    await tx.account.update({ where: { id: account.id }, data: { name: "after" } });
                },
                read: () => listSessionResponsibilityCandidates({ actorAccountId: account.id,
                    sessionId: session.id, purpose: "mention", authentication }),
            });
            expect(result.before).toMatchObject({ ok: true, candidates: [{ accountId: account.id, profile: { name: "before" } }] });
            expect(result.after).toEqual({ ok: false, error: "forbidden" });
            expect(result.predicateLocks).toBe(0);
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(["page", "exact"] as const)("captures transcript %s publication and message content coherently without predicate locks", async operation => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", seq: 1 } });
        const message = await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, localId: "snapshot-message", content: { t: "encrypted", c: "before" } } });
        const app = createAuthenticatedTestApp();
        registerSessionMessageRoutes(app);
        await app.ready();
        try {
            const result = await acrossCommit({
                lock: tx => tx.$executeRaw`LOCK TABLE "SessionMessage" IN ACCESS EXCLUSIVE MODE`,
                write: async tx => {
                    await tx.session.update({ where: { id: session.id }, data: { seq: 2 } });
                    await tx.sessionMessage.update({ where: { id: message.id }, data: { content: { t: "encrypted", c: "after" } } });
                },
                read: async () => {
                    if (operation === "page") return readSessionMessagePage({ userId: account.id, sessionId: session.id, authentication });
                    const response = await app.inject({ method: "GET", url: `/v2/sessions/${session.id}/messages/by-local-id/snapshot-message`,
                        headers: { "x-test-user-id": account.id } });
                    return { status: response.statusCode, body: response.json() as unknown };
                },
            });
            const expected = (value: string) => {
                const row = { id: message.id, content: { t: "encrypted", c: value } };
                return { status: 200, body: operation === "page" ? { messages: [row] } : { message: row } };
            };
            expect(result.before).toMatchObject(expected("before"));
            expect(result.after).toMatchObject(expected("after"));
            expect(result.predicateLocks).toBe(0);
        } finally {
            await app.close();
            await db.sessionMessage.deleteMany({ where: { sessionId: session.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("captures the metadata-upgrade census and recipient set coherently without predicate locks", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const recipient = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: account.id,
            accountId: recipient.id, accessLevel: "view" } });
        const app = createAuthenticatedTestApp();
        registerSessionListingRoutes(app);
        await app.ready();
        try {
            const result = await acrossCommit({
                lock: tx => tx.$executeRaw`LOCK TABLE "SessionShare" IN ACCESS EXCLUSIVE MODE`,
                write: async tx => {
                    await tx.session.update({ where: { id: session.id }, data: { metadataLayoutVersion: 1 } });
                    await tx.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: session.id } });
                },
                read: async () => {
                    const response = await app.inject({ method: "GET", url: "/v2/sessions/metadata-upgrades", headers: { "x-test-user-id": account.id } });
                    expect(response.statusCode).toBe(200);
                    return response.json() as unknown;
                },
            });
            expect(result.before).toEqual({ sessionIds: [session.id] });
            expect(result.after).toEqual({ sessionIds: [] });
            expect(result.predicateLocks).toBe(0);
        } finally {
            await app.close();
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [account.id, recipient.id] } } });
        }
    });

    it("captures membership authority and recipient key readiness coherently without predicate locks", async () => {
        const manager = await db.account.create({ data: { publicKey: randomUUID() } });
        const target = await db.account.create({ data: { publicKey: randomUUID() } });
        const team = await db.team.create({ data: { name: randomUUID() } });
        await inTx(tx => admitTeamMemberInTx(tx, { teamId: team.id, accountId: manager.id, role: "owner", historyAccess: "all_existing" }));
        const membership = await inTx(tx => admitTeamMemberInTx(tx, { teamId: team.id, accountId: target.id, role: "member", historyAccess: "all_existing" }));
        if (!membership.ok) throw new Error("Target membership admission failed");
        const signing = tweetnacl.sign.keyPair();
        const content = tweetnacl.box.keyPair();
        const contentPublicKeySig = signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: content.publicKey });
        try {
            const result = await acrossCommit({
                lock: tx => tx.$executeRaw`LOCK TABLE "Account" IN ACCESS EXCLUSIVE MODE`,
                write: tx => tx.account.update({ where: { id: target.id }, data: {
                    publicKey: Buffer.from(signing.publicKey).toString("hex"),
                    contentPublicKey: new Uint8Array(content.publicKey), contentPublicKeySig: new Uint8Array(contentPublicKeySig),
                } }),
                read: () => readMembershipSessionDataKeyEnvelopePage({ actorAccountId: manager.id,
                    subject: { kind: "team", teamId: team.id, teamMembershipId: membership.membership.teamMembershipId },
                    query: { state: "action_required", limit: 10 }, authentication }),
            });
            expect(result.before).toMatchObject({ ok: true, page: { status: "recipient_unavailable", recipientAccountId: target.id } });
            expect(result.after).toMatchObject({ ok: true, page: { status: "ready", recipientAccountId: target.id, items: [] } });
            expect(result.predicateLocks).toBe(0);
        } finally {
            await db.team.delete({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [manager.id, target.id] } } });
        }
    });

    it.each(["principals", "inspection"] as const)("captures access %s projections coherently without predicate locks", async operation => {
        const manager = await db.account.create({ data: { publicKey: randomUUID() } });
        const target = await db.account.create({ data: { publicKey: randomUUID(), name: "before" } });
        const team = await db.team.create({ data: { name: "before" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "before", nameKey: "before" } });
        const session = await db.session.create({ data: { accountId: manager.id, tag: randomUUID(), metadata: "{}", primaryTeamId: team.id } });
        await inTx(tx => admitTeamMemberInTx(tx, { teamId: team.id, accountId: manager.id, role: "owner", historyAccess: "all_existing" }));
        await inTx(tx => admitTeamMemberInTx(tx, { teamId: team.id, accountId: target.id, role: "member", historyAccess: "all_existing" }));
        const app = createAuthenticatedTestApp();
        registerSessionAccessGrantRoutes(app);
        await app.ready();
        try {
            const result = await acrossCommit({
                lock: tx => operation === "principals"
                    ? tx.$executeRaw`LOCK TABLE "TeamGroup" IN ACCESS EXCLUSIVE MODE`
                    : tx.$executeRaw`LOCK TABLE "Team" IN ACCESS EXCLUSIVE MODE`,
                write: async tx => {
                    await tx.account.update({ where: { id: target.id }, data: { name: "after" } });
                    await tx.teamGroup.update({ where: { id: group.id }, data: { name: "after", nameKey: "after" } });
                    await tx.team.update({ where: { id: team.id }, data: { name: "after" } });
                    await tx.session.update({ where: { id: session.id }, data: { primaryTeamId: null } });
                },
                read: async () => {
                    const response = await app.inject({ method: "POST",
                        url: operation === "principals" ? "/v1/session-access/principals/resolve" : "/v2/sessions/access-candidates/inspect",
                        headers: { "x-test-user-id": manager.id },
                        payload: operation === "principals"
                            ? { v: 1, subjects: [{ kind: "account", accountId: target.id }, { kind: "group", teamId: team.id, groupId: group.id }] }
                            : { v: 1, sessionId: session.id, subjects: [] },
                    });
                    expect(response.statusCode).toBe(200);
                    return response.json() as unknown;
                },
            });
            if (operation === "principals") {
                expect(result.before).toMatchObject({ principals: [
                    { kind: "account", accountId: target.id, name: "before" }, { kind: "group", groupId: group.id, name: "before" },
                ] });
                expect(result.after).toMatchObject({ principals: [
                    { kind: "account", accountId: target.id, name: "after" }, { kind: "group", groupId: group.id, name: "after" },
                ] });
            } else {
                expect(result.before).toMatchObject({ context: { teamId: team.id, name: "before" } });
                expect(result.after).toMatchObject({ context: null });
            }
            expect(result.predicateLocks).toBe(0);
        } finally {
            await app.close();
            await db.session.delete({ where: { id: session.id } });
            await db.team.delete({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [manager.id, target.id] } } });
        }
    });

    it("captures Pending activation authorization and its selected target coherently without predicate locks", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const requestId = "snapshot-activation";
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}",
            pendingActivationStatus: "waiting", pendingActivationRequestId: requestId, pendingActivationRequestedAt: new Date() } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.accessKey.create({ data: { accountId: account.id, sessionId: session.id, machineId: machine.id, data: "opaque" } });
        const target = await inTx(tx => readCurrentSessionInputMachineTargetInTx(tx, { accountId: account.id, sessionId: session.id, machineId: machine.id }));
        if (!target) throw new Error("Machine target admission failed");
        const decision = await resolveSessionAccessForOperation(db, { accountId: account.id, sessionId: session.id, authentication });
        if (decision.status !== "allowed") throw new Error("Session admission failed");
        await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId: requestId, position: 0,
            messageRole: "user", authorAccountId: account.id, content: { t: "plain", v: "before" },
            requestedAction: { v: 1, kind: "enqueue" },
            inputAdmissionReceipt: buildSessionInputAdmissionReceipt({ issuer: "authenticatedAccount", access: decision.access, admittedTarget: target }) } });
        try {
            const result = await acrossCommit({
                lock: tx => tx.$executeRaw`LOCK TABLE "SessionPendingMessage" IN ACCESS EXCLUSIVE MODE`,
                write: async tx => {
                    await tx.sessionPendingMessage.updateMany({ where: { sessionId: session.id }, data: { status: "discarded" } });
                    await tx.session.update({ where: { id: session.id }, data: { pendingActivationStatus: "failed", pendingActivationFailureCode: "runtime_start_failed" } });
                },
                read: () => loadPendingActivationPublication(session.id),
            });
            expect(result.before).toMatchObject({ status: "waiting", requestId, admittedTarget: target });
            expect(result.after).toMatchObject({ status: "failed", requestId, failureCode: "runtime_start_failed" });
            expect(result.after).not.toHaveProperty("admittedTarget");
            expect(result.predicateLocks).toBe(0);
        } finally {
            await db.sessionPendingMessage.deleteMany({ where: { sessionId: session.id } });
            await db.accessKey.deleteMany({ where: { sessionId: session.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("captures a target Pending queue, counts, version and actor profile coherently without predicate locks", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), name: "before" } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", pendingVersion: 1 } });
        const decision = await resolveSessionAccessForOperation(db, { accountId: account.id, sessionId: session.id, authentication });
        if (decision.status !== "allowed") throw new Error("Session admission failed");
        await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId: "snapshot-pending", position: 0,
            targetExecutionRunId: "snapshot-run", messageRole: "user", authorAccountId: account.id,
            content: { t: "encrypted", c: "before" }, requestedAction: { v: 1, kind: "enqueue" },
            inputAdmissionReceipt: buildSessionInputAdmissionReceipt({ issuer: "authenticatedAccount", access: decision.access }) } });
        let releaseGate!: () => void;
        const releasedGate = new Promise<void>(resolve => { releaseGate = resolve; });
        let gateReady!: (pid: number) => void;
        const gateStarted = new Promise<number>(resolve => { gateReady = resolve; });
        const gate = inTx(async tx => {
            await tx.$executeRaw`LOCK TABLE "SessionPendingMessage" IN ACCESS EXCLUSIVE MODE`;
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            gateReady(pid);
            await releasedGate;
        });
        const gateOutcome = Promise.allSettled([gate]);
        const read = () => listPendingMessages({ actorUserId: account.id, sessionId: session.id,
            targetExecutionRunId: "snapshot-run", authentication });
        let reader: ReturnType<typeof read> | undefined;
        try {
            const gatePid = await Promise.race([gateStarted, gate.then(() => { throw new Error("Queue gate exited before rendezvous"); })]);
            reader = read();
            let settled = false;
            const readerOutcome = Promise.allSettled([reader]).finally(() => { settled = true; });
            let entered = false;
            while (!settled) {
                const blocked = await db.$queryRaw<Array<{ pid: number }>>`
                    SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                    AND application_name = ${applicationName} AND ${gatePid} = ANY(pg_blocking_pids(pid))
                `;
                if (blocked.length > 0) { entered = true; break; }
            }
            expect(entered).toBe(true);
            let first = true;
            const result = await acrossCommit({
                lock: async tx => {
                    // The public owner has completed its outside admission. Hold
                    // its later actor-profile read before releasing the queue read.
                    await tx.$executeRaw`LOCK TABLE "Account" IN ACCESS EXCLUSIVE MODE`;
                    releaseGate();
                    await gate;
                },
                write: async tx => {
                    await tx.sessionPendingMessage.updateMany({ where: { sessionId: session.id }, data: { status: "discarded" } });
                    await tx.session.update({ where: { id: session.id }, data: { pendingVersion: 2 } });
                    await tx.account.update({ where: { id: account.id }, data: { name: "after" } });
                },
                read: async () => { if (first) { first = false; return reader!; } return read(); },
            });
            await readerOutcome;
            expect(result.before).toMatchObject({ ok: true, pending: [{ localId: "snapshot-pending", accountActor: { profile: { name: "before" } } }],
                targetPendingState: { pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 } });
            expect(result.after).toMatchObject({ ok: true, pending: [], targetPendingState: { pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 } });
            expect(result.predicateLocks).toBe(0);
        } finally {
            releaseGate();
            await gateOutcome;
            if (reader) await Promise.allSettled([reader]);
            await db.sessionPendingMessage.deleteMany({ where: { sessionId: session.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
