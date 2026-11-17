import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";

import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { listProviderDescriptorsInTx } from "@/app/auth/providers/identityProviderCatalog";
import { retireSessionConsumptionAfterAccessChange } from "@/app/api/socket/sessionConsumption";
import { encryptString, initEncrypt } from "@/modules/encrypt";
import { eventRouter } from "./connectionEventRouter";
import { observePrismaRequests } from "@/testkit/observeSqliteRequests";
import type { LocalSocketRoomEmitter } from "./socketRoomEmitter";
import { createDbMaintenanceClient, type PrismaClientType } from "@/storage/prisma";
import { recordDriverStatements, type DriverStatementEvent } from "@/testkit/driverStatements";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Session delivery fresh-admission SQL cost (PostgreSQL)", () => {
    const statements: DriverStatementEvent[] = [];
    const accountIds: string[] = [];
    let client: PrismaClientType;
    let originalTransaction: typeof db.$transaction;
    let completedSnapshots = 0;

    beforeAll(async () => {
        const supplied = process.env.DATABASE_URL;
        if (!supplied || new URL(supplied).hostname !== "127.0.0.1") {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        vi.stubEnv("HANDY_MASTER_SECRET", "delivery-admission-spec-only");
        vi.stubEnv("HAPPIER_PUBLIC_SERVER_URL", "https://home.example.test");
        await initEncrypt();
        initDbPostgres();
        await db.$connect();
        client = await createDbMaintenanceClient("postgres", undefined, { onDriverStatement: recordDriverStatements(event => statements.push(event)) });
        await client.$connect();
        originalTransaction = db.$transaction;
        // Observe the real database transport. No Session read, operation
        // qualifier or transaction owner is replaced.
        db.$transaction = new Proxy(originalTransaction, { async apply(_target, _receiver, args) {
            const result = await Reflect.apply(client.$transaction, client, args);
            completedSnapshots += 1;
            return result;
        } });
    });

    afterEach(async () => {
        eventRouter.clearIo();
        await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.account.deleteMany({ where: { id: { in: accountIds } } });
        await db.homeGovernancePolicy.deleteMany({});
        accountIds.length = 0;
    });
    afterAll(async () => {
        vi.unstubAllEnvs();
        if (originalTransaction) db.$transaction = originalTransaction;
        await client?.$disconnect();
        await shutdownDbClient();
    });

    async function fixture(includeRuntime = false) {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        accountIds.push(owner.id);
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        const sockets: Array<{ id: string; data: Socket["data"] }> = Array.from({ length: 100 }, (_, index) => ({
            id: `qualified-${index}`,
            data: { userId: owner.id, clientType: "user-scoped", authAuthority: "present_user" },
        }));
        const denied: Array<{ id: string; data: Socket["data"] }> = [
            { id: "malformed", data: { userId: owner.id, clientType: "user-scoped" } },
        ];
        if (includeRuntime) denied.push({ id: "stale-runtime", data: {
                userId: owner.id, clientType: "user-scoped", authAuthority: "account_automation",
                ephemeralRunnerAdmission: { kind: "session-runtime", principal: {
                    kind: "ephemeral_session_runner", authority: "session_runtime", accountId: owner.id,
                    activationId: randomUUID(), sessionId: session.id, machineId: randomUUID(),
                } },
        } });
        const delivered: string[] = [];
        const committedAtEmit: number[] = [];
        const io = {
            in: () => ({ fetchSockets: async () => [...sockets, ...denied] }),
            to: (room: string | string[]) => ({ emit: () => {
                for (const socketId of [room].flat()) {
                    delivered.push(socketId);
                    committedAtEmit.push(completedSnapshots);
                }
            }, disconnectSockets: () => {} }),
        } satisfies LocalSocketRoomEmitter;
        eventRouter.setIo(io);
        const deliver = () => eventRouter.emitUpdate({ userId: owner.id,
            payload: { id: "delivery", seq: 1, createdAt: 0, body: { t: "delete-session", sid: session.id } },
            recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
        });
        statements.length = 0;
        completedSnapshots = 0;
        return { owner, session, sockets, delivered, committedAtEmit, deliver };
    }

    function sessionSelects() {
        return statements.filter(({ query }) => /^SELECT\b/.test(query)
            && /\bFROM\s+(?:"public"\.)?"Session"(?:\s|$)/.test(query));
    }

    it("decides a delivery for 100 sockets from one Session statement, with no transaction frame, while preserving denied authentication contexts", async () => {
        const f = await fixture();
        // The transaction transport's statement log cannot see a read on the primary client: count requests too.
        const requests: Array<{ model?: string; action: string }> = [];
        const stop = observePrismaRequests(db, { before: request => { requests.push(request); } });
        try { await f.deliver(); } finally { stop(); }
        expect(f.delivered).toEqual(f.sockets.map(socket => socket.id));
        const counts = { requests: requests.map(({ model, action }) => `${model}.${action}`),
            sessionSelects: sessionSelects().length,
            transactions: statements.filter(({ query }) => /^BEGIN\b/.test(query)).length,
            controls: statements.filter(({ query }) => !/^SELECT\b/.test(query)).length };
        console.info("SESSION_DELIVERY_SQL_COST", JSON.stringify(counts));
        // One statement is its own snapshot: the row read needs no BEGIN/isolation/READ ONLY/timeout/COMMIT.
        expect(counts).toEqual({ requests: ["Session.findUnique"], sessionSelects: 0, transactions: 0, controls: 0 });
    });

    it("refuses a guest from the row alone once its direct grant is withdrawn, with no snapshot", async () => {
        const f = await fixture();
        const guest = await db.account.create({ data: { encryptionMode: "plain" } });
        accountIds.push(guest.id);
        const grant = await db.sessionGrant.create({ data: { principalKind: "account", sessionId: f.session.id,
            createdByAccountId: f.owner.id, accountId: guest.id, accessLevel: "view" } });
        f.sockets.length = 0;
        f.sockets.push({ id: "guest-ui", data: { userId: guest.id, clientType: "user-scoped", authAuthority: "present_user" } });
        const deliverToGuest = async () => {
            statements.length = 0;
            f.delivered.length = 0;
            await eventRouter.emitUpdate({ userId: guest.id,
                payload: { id: "delivery", seq: 1, createdAt: 0, body: { t: "delete-session", sid: f.session.id } },
                recipientFilter: { type: "all-interested-in-session", sessionId: f.session.id } });
            return { delivered: [...f.delivered], transactions: statements.filter(({ query }) => /^BEGIN\b/.test(query)).length };
        };
        expect(await deliverToGuest()).toEqual({ delivered: ["guest-ui"], transactions: 0 });
        // Withdrawal with no access-change push: the next durable delivery must refuse from its one row.
        await db.sessionGrant.delete({ where: { id: grant.id } });
        expect(await deliverToGuest()).toEqual({ delivered: [], transactions: 0 });
    });

    it("refuses another delivery after the Account is suspended", async () => {
        const f = await fixture();
        await f.deliver();
        await db.account.update({ where: { id: f.owner.id }, data: { status: "suspended" } });
        f.delivered.length = 0;
        await f.deliver();
        expect(f.delivered).toEqual([]);
    });

    it("keeps the runtime principal's own read and refuses a stale principal", async () => {
        const f = await fixture(true);
        await f.deliver();
        expect(f.delivered).toEqual(f.sockets.map(socket => socket.id));
        // The runtime verifier reads Session authority before checking activation,
        // a distinct fact from the delivery projection. Its read moves the whole delivery into one
        // snapshot (the row-only pass's single read runs on the primary client, outside this log).
        expect(sessionSelects()).toHaveLength(2);
        expect(statements.filter(({ query }) => /^BEGIN\b/.test(query))).toHaveLength(1);
    });

    it("qualifies the authentication of each captured socket independently", async () => {
        const f = await fixture();
        delete f.sockets[0]!.data.authAuthority;
        await f.deliver();
        expect(f.delivered).toEqual(f.sockets.slice(1).map(socket => socket.id));
        // An unreadable credential is refused by its own decision; the rest stay row-only (no snapshot).
        expect(statements).toEqual([]);
    });

    describe.each([
        { event: "live segment", payload: (sid: string) => ({ type: "transcript-stream-segment-delta", sessionId: sid }) },
        { event: "execution-run update", payload: (sid: string) => ({ type: "execution-run-updated", sessionId: sid }) },
    ])("$event delivery to a socket without declared demand", ({ payload }) => {
        async function live(f: Awaited<ReturnType<typeof fixture>>) {
            statements.length = 0;
            f.delivered.length = 0;
            await eventRouter.emitEphemeral({ userId: f.owner.id, payload: payload(f.session.id) as never,
                recipientFilter: { type: "all-interested-in-session", sessionId: f.session.id } });
            return { delivered: [...f.delivered], sql: statements.length };
        }
        function retire(f: Awaited<ReturnType<typeof fixture>>) {
            retireSessionConsumptionAfterAccessChange(f.sockets as unknown as Iterable<Socket>, f.session.id);
        }

        it("decides each socket once across unchanged events, and once more after the access-change push", async () => {
            const f = await fixture();
            f.sockets.length = 2;
            const first = await live(f);
            expect(first.delivered).toEqual(["qualified-0", "qualified-1"]);
            expect(first.sql).toBeGreaterThan(0);
            for (let event = 0; event < 3; event += 1) {
                expect(await live(f)).toEqual({ delivered: ["qualified-0", "qualified-1"], sql: 0 });
            }
            retire(f);
            expect((await live(f)).sql).toBeGreaterThan(0);
            expect((await live(f)).sql).toBe(0);
        });

        it("stops a socket after the push that follows its withdrawal", async () => {
            const f = await fixture();
            f.sockets.length = 1;
            expect((await live(f)).delivered).toEqual(["qualified-0"]);
            await db.account.update({ where: { id: f.owner.id }, data: { status: "suspended" } });
            retire(f);
            expect((await live(f)).delivered).toEqual([]);
            await db.account.update({ where: { id: f.owner.id }, data: { status: "active" } });
            retire(f);
            expect((await live(f)).delivered).toEqual(["qualified-0"]);
        });

        it("retires only the named Session", async () => {
            const f = await fixture();
            f.sockets.length = 1;
            await live(f);
            retireSessionConsumptionAfterAccessChange(f.sockets as unknown as Iterable<Socket>, randomUUID());
            expect((await live(f)).sql).toBe(0);
        });

        it("does not hold a failed decision", async () => {
            const f = await fixture();
            f.sockets.length = 1;
            const authority = f.sockets[0]!.data.authAuthority;
            delete f.sockets[0]!.data.authAuthority;
            expect((await live(f)).delivered).toEqual([]);
            f.sockets[0]!.data.authAuthority = authority;
            expect((await live(f)).delivered).toEqual(["qualified-0"]);
        });
    });

    it("spends no read on sockets that consume no live segments", async () => {
        const f = await fixture();
        f.sockets.length = 2;
        f.sockets[0]!.data.clientPurpose = "scoped-rpc";
        f.sockets[1]!.data.clientPurpose = "sync";
        statements.length = 0;
        await eventRouter.emitEphemeral({ userId: f.owner.id,
            payload: { type: "transcript-stream-segment-delta", sessionId: f.session.id } as never,
            recipientFilter: { type: "all-interested-in-session", sessionId: f.session.id } });
        expect(f.delivered).toEqual([]);
        expect(statements).toEqual([]);
    });

    it("closes a UI socket whose retirement cannot read storage, so reconnect re-admits it", async () => {
        const f = await fixture();
        const disconnect = vi.fn();
        const socket = { ...f.sockets[0]!, connected: true, disconnect };
        socket.data.clientPurpose = "sync";
        socket.data.sessionConsumption = { liveSessionIds: new Set([f.session.id]), durableSessionIds: new Set() };
        const healthy = db.$transaction;
        db.$transaction = (() => Promise.reject(new Error("storage unavailable"))) as unknown as typeof db.$transaction;
        try {
            retireSessionConsumptionAfterAccessChange([socket] as unknown as Iterable<Socket>, f.session.id);
            await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith(true));
        } finally { db.$transaction = healthy; }
    });

    /** A Team member whose credential qualifies only through one OIDC identity, nothing else. */
    async function restrictedTeamMember() {
        const f = await fixture();
        await db.homeGovernancePolicy.create({ data: { id: "home", teamProviderPolicy: {
            v: 1, allowedTeamProviderKinds: ["oidc"], teamJitAllowed: false, approvedGitHubEnterpriseOrigins: [],
        } } });
        const member = await db.account.create({ data: { encryptionMode: "plain" } });
        accountIds.push(member.id);
        const team = await db.team.create({ data: { name: randomUUID() } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id, kind: "oidc", displayName: "Team login", enabled: true, firstEnabledAt: new Date(),
            config: { v: 1, kind: "oidc", issuer: "https://id.example.test", clientId: "happier",
                clientAuthenticationMethod: "client_secret_post", scopes: "openid profile email", httpTimeoutSeconds: 30,
                claims: { login: "preferred_username", email: "email", groups: "groups" },
                allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                fetchUserInfo: true, storeRefreshToken: false, ui: { buttonColor: null, iconHint: "oidc" } },
        } });
        await db.identityProviderInstance.update({ where: { id: provider.id }, data: { encryptedSecrets: encryptString(
            ["storage", "identity_provider_instance", provider.id, "oidc", "secrets", "v1"],
            JSON.stringify({ v: 1, kind: "oidc", clientSecret: "secret" }),
        ) } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id, externalReference: { v: 1, kind: "oidc" },
            settings: { v: 1, kind: "oidc", allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
            enabled: true, firstEnabledAt: new Date(),
        } });
        const descriptor = await inTx(async tx => (await listProviderDescriptorsInTx(tx, process.env, { kind: "team", teamId: team.id }))
            .find(candidate => candidate.reference.id === provider.id));
        const identity = await db.accountIdentity.create({ data: { accountId: member.id, provider: provider.id, providerUserId: randomUUID() } });
        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: {
            v: 1, mode: "restricted", accepted: [{ kind: "team_connection", connectionId: connection.id }],
        } } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } });
        await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: f.session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date() } });
        const credential = { userId: member.id, clientType: "user-scoped", authAuthority: "present_user",
            authTokenAuthenticationEvidence: [{ kind: "provider", providerId: provider.id, identityId: identity.id,
                runtimeFingerprint: descriptor!.reference.runtimeFingerprint, teamConnectionId: connection.id }] };
        const otherSessionId = randomUUID();
        const ui = { id: "ui", data: { ...credential, clientPurpose: "sync", sessionConsumption: {
            liveSessionIds: new Set([f.session.id, otherSessionId]), durableSessionIds: new Set([f.session.id]),
        } } };
        f.sockets.length = 0;
        f.sockets.push(ui, { id: "cli", data: { ...credential } });
        const recipient = { userId: member.id, recipientFilter: { type: "all-interested-in-session", sessionId: f.session.id } } as const;
        return {
            ui, identity, otherSessionId, session: f.session,
            live: async () => {
                statements.length = 0;
                f.delivered.length = 0;
                await eventRouter.emitEphemeral({ ...recipient,
                    payload: { type: "transcript-stream-segment-delta", sessionId: f.session.id } as never });
                return { delivered: [...f.delivered], sql: statements.length };
            },
            durable: async () => {
                statements.length = 0;
                f.delivered.length = 0;
                await eventRouter.emitUpdate({ ...recipient,
                    payload: { id: "delivery", seq: 1, createdAt: 0, body: { t: "delete-session", sid: f.session.id } } });
                return { delivered: [...f.delivered], sql: statements.length };
            },
        };
    }

    it("stops live delivery at the durable delivery that refuses an offboarded identity, with no push", async () => {
        const member = await restrictedTeamMember();
        expect((await member.durable()).delivered).toEqual(["ui", "cli"]);
        expect((await member.live()).delivered).toEqual(["ui", "cli"]);

        await db.accountIdentity.update({ where: { id: member.identity.id }, data: { eligibilityStatus: "ineligible" } });
        // Nothing has told live delivery yet: this is the accepted window before the next event.
        expect(await member.live()).toEqual({ delivered: ["ui", "cli"], sql: 0 });

        const refused = await member.durable();
        console.info("SESSION_DURABLE_REFUSAL_SQL", JSON.stringify({ sql: refused.sql }));
        expect(refused.delivered).toEqual([]);
        expect((await member.live()).delivered).toEqual([]);
        expect(await member.live()).toEqual({ delivered: [], sql: 0 });
        // Only the refused Session is withdrawn from the socket.
        expect(member.ui.data.sessionConsumption).toEqual({
            liveSessionIds: new Set([member.otherSessionId]), durableSessionIds: new Set(),
        });
    });

    it("does not read Session when the receiving transport has no candidate sockets", async () => {
        const f = await fixture();
        eventRouter.setIo({ in: () => ({ fetchSockets: async () => [] }),
            to: () => ({ emit: () => { throw new Error("Unexpected emit"); }, disconnectSockets: () => {} }),
        } satisfies LocalSocketRoomEmitter);
        await f.deliver();
        expect(statements).toEqual([]);
        expect(completedSnapshots).toBe(0);
    });
});
