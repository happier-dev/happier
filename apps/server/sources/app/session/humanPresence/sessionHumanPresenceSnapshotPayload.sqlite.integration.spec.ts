import type { Server, Socket } from "socket.io";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { setTeamPolicyInTx } from "@/app/teams/policy";
import { sessionDraftPhysicalKey } from "@/app/account/sessionDrafts/sessionDraftPhysicalKey";
import { updateTeamIdentityConnectionInTx } from "@/app/teams/identity/teamIdentityConnectionLifecycle";
import {
    replaceIdentityProviderSecretsInTx,
    setIdentityProviderInstanceEnabledInTx,
} from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import { SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT } from "@happier-dev/protocol/sessions";
import {
    SESSION_HUMAN_PRESENCE_ACCESS_CHANGED_SERVER_EVENT,
    createSessionHumanPresenceService,
    notifySessionHumanPresenceAccessChanged,
    registerSessionHumanPresenceAccessChangePublisher,
} from "./sessionHumanPresenceService";
import { RedisStreamsRoomEmitter } from "@/app/events/createRedisStreamsRoomEmitter";
import type { Redis } from "ioredis";
import { deleteSessionAccessGrantInTx, putSessionAccessGrantInTx } from "@/app/session/access/sessionAccessGrantService";

const presenceRoomPrefix = "session-human-presence:";

/**
 * Minimal fixture of the genuine Socket.IO transport boundary, mirroring the
 * final-currentness spec. Sockets are pre-joined to the presence room, which is
 * the legitimate admitted state this projection observes after any access or
 * membership transition.
 */
type PresenceSocketFixture = {
    id: string;
    connected: boolean;
    data: Socket["data"];
    rooms: Set<string>;
    join(rooms: string | readonly string[]): Promise<void>;
    leave(room: string): Promise<void>;
};

function createAdmittedPresenceSocketFixture(params: Readonly<{ id: string; accountId: string; sessionId: string }>): PresenceSocketFixture {
    return {
        id: params.id,
        connected: true,
        data: { clientType: "user-scoped", userId: params.accountId, authAuthority: "present_user" },
        rooms: new Set<string>([presenceRoomPrefix + params.sessionId]),
        async join(rooms) {
            for (const room of Array.isArray(rooms) ? rooms : [rooms]) this.rooms.add(room);
        },
        async leave(room) {
            this.rooms.delete(room);
        },
    };
}

function setAuthenticationEvidence(
    socket: PresenceSocketFixture,
    evidence: Socket["data"]["authTokenAuthenticationEvidence"],
): void {
    socket.data.authTokenAuthenticationEvidence = evidence;
}

function createFixtureIo(allSockets: readonly PresenceSocketFixture[]): {
    io: Server;
    emissions: Array<{ event: string; payload: unknown; socketIds: readonly string[] }>;
} {
    const emissions: Array<{ event: string; payload: unknown; socketIds: readonly string[] }> = [];
    const io = {
        in(room: string) {
            return {
                fetchSockets: async () => allSockets.filter(socket => socket.rooms.has(room)),
            };
        },
        to(socketIds: string | readonly string[]) {
            const ids = Array.isArray(socketIds) ? [...socketIds] : [socketIds];
            return {
                emit: (event: string, payload: unknown) => {
                    emissions.push({ event, payload, socketIds: ids });
                },
            };
        },
        sockets: {
            sockets: new Map<string, Socket>(allSockets.map(socket => [socket.id, socket as unknown as Socket])),
            adapter: undefined,
        },
    };
    return { io: io as unknown as Server, emissions };
}

function snapshotPayloads(emissions: ReturnType<typeof createFixtureIo>["emissions"]): Array<{
    sessionId: string;
    viewers: Array<{ account: { accountId: string }; typing: boolean }>;
}> {
    return emissions.filter(entry => entry.event === SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT)
        .map(entry => entry.payload as { sessionId: string; viewers: Array<{ account: { accountId: string }; typing: boolean }> });
}

describe("human presence snapshot is not bounded by the inbound transport limit", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-human-presence-payload-", initAuth: true, initEncrypt: true,
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("emits the full snapshot beyond the former transport-derived threshold once, with no deterministic retry", async () => {
        const longName = "Presence".padEnd(180, "x");
        const [owner, first, second] = await Promise.all(["Owner Viewer", longName, longName].map(name =>
            db.account.create({ data: { publicKey: crypto.randomUUID(), name } })));
        const session = await db.session.create({
            data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: "{}" },
        });
        await Promise.all([first, second].map(account => db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: account.id, accessLevel: "view",
        } })));
        const sockets = [owner, first, second].map((account, index) =>
            createAdmittedPresenceSocketFixture({ id: `payload-socket-${index}`, accountId: account.id, sessionId: session.id }));
        const { io, emissions } = createFixtureIo(sockets);
        const presence = createSessionHumanPresenceService({ io });
        try {
            notifySessionHumanPresenceAccessChanged({ sessionId: session.id });
            // The full deduplicated observation must leave the process as one
            // replacement regardless of its byte size: the engine's inbound
            // maxHttpBufferSize is not an outbound presence ceiling.
            await expect.poll(() => snapshotPayloads(emissions).at(-1)?.viewers).toHaveLength(3);
            const lastSnapshot = snapshotPayloads(emissions).at(-1)!;
            expect(lastSnapshot.sessionId).toBe(session.id);
            expect(lastSnapshot.viewers.map(value => value.account.accountId).sort())
                .toEqual([owner.id, first.id, second.id].sort());
            const lastEmission = emissions.filter(entry => entry.event === SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT).at(-1)!;
            expect([...lastEmission.socketIds].sort()).toEqual(sockets.map(socket => socket.id).sort());
            // A successful projection schedules no repair retry: once converged, the
            // observation must not repeat.
            const convergedEmissionCount = snapshotPayloads(emissions).length;
            await new Promise(resolve => setTimeout(resolve, 300));
            expect(snapshotPayloads(emissions)).toHaveLength(convergedEmissionCount);
        } finally {
            presence.close();
        }
    }, 30_000);

    it("filters two credentials for one Account independently before deduplicating the qualified viewer", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
        });
        const [owner, member] = await Promise.all(["Credential Owner", "Credential Member"].map(name =>
            db.account.create({ data: { publicKey: crypto.randomUUID(), name, encryptionMode: "e2ee" } })));
        const session = await db.session.create({
            data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: "{}" },
        });
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: member.id, role: "member" },
        ] });
        await db.sessionGrant.create({ data: { principalKind: 'team',
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "view",
            effectiveAt: new Date(),
        } });
        const draftKey = sessionDraftPhysicalKey({ kind: "session", sessionId: session.id });
        if (!draftKey) throw new Error("Expected Session draft key");
        await Promise.all([
            db.accountSessionFollow.create({ data: {
                accountId: member.id, sessionId: session.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
            } }),
            db.accountSessionReadState.create({ data: {
                accountId: member.id, sessionId: session.id, lastViewedSessionSeq: 7,
            } }),
            db.userKVStore.create({ data: {
                accountId: member.id, key: draftKey, value: new Uint8Array([1, 2, 3]), version: 1,
            } }),
        ]);

        const ownerSocket = createAdmittedPresenceSocketFixture({ id: "credential-owner", accountId: owner.id, sessionId: session.id });
        const qualifiedSocket = createAdmittedPresenceSocketFixture({ id: "credential-qualified", accountId: member.id, sessionId: session.id });
        const unqualifiedSocket = createAdmittedPresenceSocketFixture({ id: "credential-unqualified", accountId: member.id, sessionId: session.id });
        setAuthenticationEvidence(qualifiedSocket, [{ kind: "home_method", methodId: "key_challenge" }]);
        setAuthenticationEvidence(unqualifiedSocket, []);
        const { io, emissions } = createFixtureIo([ownerSocket, qualifiedSocket, unqualifiedSocket]);
        const presence = createSessionHumanPresenceService({ io });
        try {
            notifySessionHumanPresenceAccessChanged({ sessionId: session.id });
            await expect.poll(() => snapshotPayloads(emissions).at(-1)?.viewers).toHaveLength(2);
            expect([...snapshotPayloads(emissions).at(-1)!.viewers].map(viewer => viewer.account.accountId).sort())
                .toEqual([owner.id, member.id].sort());

            const policyResult = await inTx(tx => setTeamPolicyInTx(tx, {
                actorAccountId: owner.id,
                teamId: team.id,
                env: process.env,
                previousAuthenticationPolicy: null,
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
                authentication: {
                    authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
                    authenticationAuthority: "present_user",
                },
            }));
            expect(policyResult.ok).toBe(true);
            expect(await db.accountChange.findUnique({
                where: {
                    accountId_kind_entityId: {
                        accountId: member.id,
                        kind: "session",
                        entityId: session.id,
                    },
                },
            })).not.toBeNull();

            // The Team-policy owner must enqueue the affected Session through the
            // canonical access-transition seam. Projection then evaluates each
            // socket's own evidence before collapsing the remaining Account rows.
            await expect.poll(() => [...(emissions.at(-1)?.socketIds ?? [])].sort())
                .toEqual([ownerSocket.id, qualifiedSocket.id].sort());
            const lastEmission = emissions.filter(entry => entry.event === SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT).at(-1)!;
            expect([...lastEmission.socketIds].sort()).toEqual([ownerSocket.id, qualifiedSocket.id].sort());
            expect(unqualifiedSocket.rooms.has(presenceRoomPrefix + session.id)).toBe(false);
            expect(snapshotPayloads(emissions).at(-1)?.viewers.map(viewer => viewer.account.accountId).sort())
                .toEqual([owner.id, member.id].sort());
            // Credential applicability changed, not structural entitlement.
            // The narrow successor must not run Account-wide access-loss cleanup.
            expect(await db.accountSessionFollow.findUnique({
                where: { accountId_sessionId: { accountId: member.id, sessionId: session.id } },
            })).toMatchObject({ following: true, followPolicy: JSON.stringify({ preset: "important" }) });
            expect(await db.accountSessionReadState.findUnique({
                where: { accountId_sessionId: { accountId: member.id, sessionId: session.id } },
            })).toMatchObject({ lastViewedSessionSeq: 7 });
            expect(await db.userKVStore.findUnique({
                where: { accountId_key: { accountId: member.id, key: draftKey } },
            })).toMatchObject({ value: new Uint8Array([1, 2, 3]) });
        } finally {
            presence.close();
        }
    }, 30_000);

    // Deleting a Direct View while a same-level restricted Team View survives leaves
    // the structural capabilities equal, yet a password socket has just lost its
    // only qualified read source. The real grant owner must still enqueue the
    // room recheck, which then evaluates each socket's own credential.
    it("evicts the unqualified socket when a real Direct grant removal leaves only a restricted Team source", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
        });
        // Key-challenge evidence qualifies only an Account that holds a key.
        const [owner, member] = await Promise.all(["Source Owner", "Source Member"].map(name =>
            db.account.create({ data: { publicKey: crypto.randomUUID(), name, encryptionMode: "e2ee" } })));
        const session = await db.session.create({
            data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: "{}" },
        });
        const team = await db.team.create({ data: {
            name: crypto.randomUUID(),
            authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "key_challenge" }] },
        } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: member.id, role: "member" },
        ] });
        const ownerAuthentication = { env: process.env, authority: "present_user" as const, authenticationEvidence: [] };
        for (const subject of [
            { kind: "team" as const, teamId: team.id },
            { kind: "account" as const, accountId: member.id },
        ]) {
            expect(await inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject,
                grant: { accessLevel: "view", canApprovePermissions: false },
                authentication: ownerAuthentication,
            }))).toMatchObject({ ok: true });
        }

        const qualifiedSocket = createAdmittedPresenceSocketFixture({ id: "source-qualified", accountId: member.id, sessionId: session.id });
        const passwordSocket = createAdmittedPresenceSocketFixture({ id: "source-password", accountId: member.id, sessionId: session.id });
        setAuthenticationEvidence(qualifiedSocket, [{ kind: "home_method", methodId: "key_challenge" }]);
        setAuthenticationEvidence(passwordSocket, []);
        const { io, emissions } = createFixtureIo([qualifiedSocket, passwordSocket]);
        const presence = createSessionHumanPresenceService({ io });
        try {
            expect(await inTx(tx => deleteSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "account", accountId: member.id },
                authentication: ownerAuthentication,
            }))).toMatchObject({ ok: true, changed: true });

            await expect.poll(() => passwordSocket.rooms.has(presenceRoomPrefix + session.id)).toBe(false);
            expect(qualifiedSocket.rooms.has(presenceRoomPrefix + session.id)).toBe(true);
            await expect.poll(() => [...(emissions.filter(entry => entry.event === SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT).at(-1)?.socketIds ?? [])])
                .toEqual([qualifiedSocket.id]);
        } finally {
            presence.close();
        }
    }, 30_000);

    // A worker-role process owns no Socket.IO server and no presence service, yet
    // its directory reconciliation commits real access transitions. The same
    // transition owner must reach the API nodes through the worker's own Redis
    // Streams emitter (Redis is the true boundary here).
    it("publishes a transition committed in a worker-role process to the API nodes' presence owners", async () => {
        const [owner, member] = await Promise.all(["Worker Owner", "Worker Member"].map(name =>
            db.account.create({ data: { publicKey: crypto.randomUUID(), name, encryptionMode: "plain" } })));
        const session = await db.session.create({
            data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: "{}" },
        });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: member.id, status: "friend" } });
        const ownerAuthentication = { env: process.env, authority: "present_user" as const, authenticationEvidence: [] };
        const xadd = vi.fn(async (..._args: Array<string | number>) => "1-0");
        const emitter = new RedisStreamsRoomEmitter({ xadd } as unknown as Pick<Redis, "xadd">, { maxLen: 100, streamName: "worker-stream" });
        const unregister = registerSessionHumanPresenceAccessChangePublisher(emitter);
        try {
            expect(await inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "account", accountId: member.id },
                grant: { accessLevel: "view", canApprovePermissions: false },
                authentication: ownerAuthentication,
            }))).toMatchObject({ ok: true });
            await expect.poll(() => xadd.mock.calls.length).toBeGreaterThan(0);
            const serverSideEvents = xadd.mock.calls.map((args) => {
                const fields = Object.fromEntries(Array.from({ length: (args.length - 5) / 2 }, (_, index) => [args[5 + index * 2], args[6 + index * 2]]));
                return fields.type === "9" ? JSON.parse(String(fields.data)).packet : null;
            }).filter(Boolean);
            expect(serverSideEvents).toEqual([
                [SESSION_HUMAN_PRESENCE_ACCESS_CHANGED_SERVER_EVENT, { v: 1, sessionId: session.id }],
            ]);
        } finally {
            unregister();
        }
    }, 30_000);

    it("rechecks admitted rooms after connection revision, provider security revision, and provider disable", async () => {
        harness.resetEnv();
        const owner = await db.account.create({ data: {
            publicKey: crypto.randomUUID(), name: "Applicability owner", encryptionMode: "plain",
        } });
        const makeAffectedRoom = async (suffix: string) => {
            const member = await db.account.create({ data: {
                publicKey: crypto.randomUUID(), name: `Applicability ${suffix}`, encryptionMode: "plain",
            } });
            const team = await db.team.create({ data: { name: `Applicability ${suffix}` } });
            await db.teamMembership.createMany({ data: [
                { teamId: team.id, accountId: owner.id, role: "owner" },
                { teamId: team.id, accountId: member.id, role: "member" },
            ] });
            const provider = await db.identityProviderInstance.create({ data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: `Provider ${suffix}`,
                enabled: true,
                firstEnabledAt: new Date(),
                config: { v: 1, kind: "workos_sso" },
            } });
            const connection = await db.teamIdentityConnection.create({ data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: {
                    v: 1, kind: "workos_sso", organizationId: `org_${suffix}`, connectionId: `conn_${suffix}`,
                },
                settings: { v: 1, kind: "workos_sso" },
                enabled: true,
                firstEnabledAt: new Date(),
            } });
            await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "team_connection", connectionId: connection.id }],
            } } });
            const session = await db.session.create({ data: {
                accountId: owner.id,
                tag: crypto.randomUUID(),
                encryptionMode: "plain",
                metadata: "{}",
                grants: { create: [{ principalKind: 'team',  teamId: team.id, accessLevel: "view", effectiveAt: new Date()  }] },
            } });
            const socket = createAdmittedPresenceSocketFixture({
                id: `applicability-${suffix}`, accountId: member.id, sessionId: session.id,
            });
            setAuthenticationEvidence(socket, [{ kind: "team_connection", connectionId: connection.id }]);
            return { team, provider, connection, session, socket };
        };

        const connectionRevision = await makeAffectedRoom("connection-revision");
        const providerRevision = await makeAffectedRoom("provider-revision");
        const providerDisable = await makeAffectedRoom("provider-disable");
        const { io } = createFixtureIo([
            connectionRevision.socket,
            providerRevision.socket,
            providerDisable.socket,
        ]);
        const presence = createSessionHumanPresenceService({ io });
        try {
            const connectionResult = await inTx(tx => updateTeamIdentityConnectionInTx(tx, {
                id: connectionRevision.connection.id,
                teamId: connectionRevision.team.id,
                expectedRevision: connectionRevision.connection.revision,
                settings: { v: 1, kind: "workos_sso" },
            }));
            expect(connectionResult.status).toBe("applied");
            await expect.poll(() => connectionRevision.socket.rooms.has(
                presenceRoomPrefix + connectionRevision.session.id,
            )).toBe(false);

            const providerRevisionResult = await inTx(tx => replaceIdentityProviderSecretsInTx(tx, {
                id: providerRevision.provider.id,
                owner: { kind: "team", teamId: providerRevision.team.id },
                expectedRevision: providerRevision.provider.revision,
                secrets: null,
            }));
            expect(providerRevisionResult.status).toBe("applied");
            await expect.poll(() => providerRevision.socket.rooms.has(
                presenceRoomPrefix + providerRevision.session.id,
            )).toBe(false);

            const providerResult = await inTx(tx => setIdentityProviderInstanceEnabledInTx(tx, {
                id: providerDisable.provider.id,
                owner: { kind: "team", teamId: providerDisable.team.id },
                expectedRevision: providerDisable.provider.revision,
                expectedSecurityRevision: providerDisable.provider.securityRevision,
                enabled: false,
            }));
            expect(providerResult.status).toBe("applied");
            await expect.poll(() => providerDisable.socket.rooms.has(
                presenceRoomPrefix + providerDisable.session.id,
            )).toBe(false);
        } finally {
            presence.close();
        }
    }, 30_000);
});
