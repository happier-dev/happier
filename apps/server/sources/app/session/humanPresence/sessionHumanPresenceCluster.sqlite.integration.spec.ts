import type { Socket } from "socket.io";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import { readSessionAccessAuthenticationFromSocket } from "@/app/session/access/sessionAccessAuthentication";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { startRedisAdapterRecoveryCluster } from "@/testkit/redisAdapterRecoveryCluster";

import { SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT } from "@happier-dev/protocol/sessions";
import {
    createSessionHumanPresenceService,
    notifySessionHumanPresenceAccessChanged,
    SESSION_HUMAN_PRESENCE_ACCESS_CHANGED_SERVER_EVENT,
} from "./sessionHumanPresenceService";
import { sessionHumanPresenceRoom } from "./sessionHumanPresenceRooms";
import {
    registerSessionHumanPresenceSocketHandlers,
    releaseSessionHumanPresenceHoldAfterFinalCurrentness,
} from "./registerSessionHumanPresenceSocketHandlers";

const SOCKET_PATH = "/v1/updates";

async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
    timeoutMs = 20_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            if (await predicate()) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
        `Timed out waiting for ${description}${lastError ? ` (last error: ${String(lastError)})` : ""}`,
    );
}

describe("human presence access transitions across Redis-adapter API nodes", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-human-presence-cluster-",
            initAuth: true,
            initEncrypt: true,
            env: {
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
            },
        });
    }, 120_000);

    afterAll(async () => {
        await harness?.close();
    });

    it("projects remote admitted edit data and publishes editor disconnect to an observer on another node", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: "{}",
        } });
        const cluster = await startRedisAdapterRecoveryCluster();
        const clients: ClientSocket[] = [];
        const services = cluster.nodes.map(node => createSessionHumanPresenceService({ io: node.io }));
        cluster.nodes.forEach((node, index) => node.io.on("connection", socket => {
            // Authentication is the genuine transport boundary in this cluster
            // fixture; admission and database access below are the real owners.
            socket.data.userId = owner.id;
            socket.data.authAuthority = "present_user";
            socket.data.clientType = index === 0 ? "session-scoped" : "user-scoped";
            if (index === 0) socket.data.sessionScopedBinding = { sessionId: session.id, machineId: null, proof: "owner-session" };
            registerSessionHumanPresenceSocketHandlers({ presence: services[index], socket, accountId: owner.id });
            releaseSessionHumanPresenceHoldAfterFinalCurrentness(socket);
        }));
        const connect = async (index: number) => {
            const client = createClient(`http://127.0.0.1:${cluster.nodes[index].port}`, {
                path: SOCKET_PATH, transports: ["websocket"], reconnection: false, autoConnect: false,
            });
            clients.push(client);
            await new Promise<void>((resolve, reject) => {
                client.once("connect", resolve); client.once("connect_error", reject); client.connect();
            });
            return client;
        };
        try {
            const observer = await connect(0);
            const snapshots: Array<{ viewers: unknown[]; pendingMessageEditHoldIds: string[] }> = [];
            observer.on(SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT, value => snapshots.push(value));
            expect(await observer.timeout(5_000).emitWithAck("session-human-presence:visible-replace", {
                v: 1, sessionIds: [session.id], pendingMessageEdits: [],
            })).toMatchObject({ ok: true, admittedSessionIds: [session.id], admittedPendingMessageEdits: [] });
            await waitFor(() => snapshots.at(-1)?.pendingMessageEditHoldIds.length === 0, "initial empty edit observation");
            const editor = await connect(1);
            const hold = { sessionId: session.id, holdId: "remote-edit" };
            expect(await editor.timeout(5_000).emitWithAck("session-human-presence:visible-replace", {
                v: 1, sessionIds: [], pendingMessageEdits: [hold],
            })).toMatchObject({ ok: true, admittedPendingMessageEdits: [hold] });
            await waitFor(() => snapshots.at(-1)?.pendingMessageEditHoldIds.includes(hold.holdId) === true, "remote admitted edit");
            expect(snapshots.at(-1)?.viewers).toEqual([]);
            editor.close();
            await waitFor(() => snapshots.at(-1)?.pendingMessageEditHoldIds.length === 0, "remote editor disconnect");
            expect(snapshots.at(-1)?.viewers).toEqual([]);
        } finally {
            clients.forEach(client => client.close());
            services.forEach(service => service.close());
            await cluster.close();
        }
    }, 60_000);

    it("rechecks remote socket credentials before Account dedupe after a transition on another node", async () => {
        const [owner, member] = await Promise.all([
            // Key-challenge viability requires an e2ee Account, so a `plain` member
            // could never present current `key_challenge` evidence to qualify.
            db.account.create({ data: {
                publicKey: crypto.randomUUID(),
                name: "Cluster owner",
                encryptionMode: "e2ee",
            } }),
            db.account.create({ data: {
                publicKey: crypto.randomUUID(),
                name: "Cluster member",
                encryptionMode: "e2ee",
            } }),
        ]);
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: member.id, role: "member" },
        ] });
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: crypto.randomUUID(),
            encryptionMode: "plain",
            metadata: "{}",
            teamGrants: { create: {
                teamId: team.id,
                accessLevel: "view",
                effectiveAt: new Date(),
            } },
        } });

        const cluster = await startRedisAdapterRecoveryCluster();
        const clients: ClientSocket[] = [];
        let publisher: ReturnType<typeof createSessionHumanPresenceService> | undefined;
        let presence: ReturnType<typeof createSessionHumanPresenceService> | undefined;
        const serverSockets = new Map<string, {
            id: string;
            rooms: Set<string>;
            data: Socket["data"];
        }>();
        cluster.nodes[1].io.on("connection", async (socket) => {
            const accountId = socket.handshake.auth.accountId;
            if (typeof accountId !== "string") return;
            socket.data.clientType = "user-scoped";
            socket.data.userId = accountId;
            socket.data.authAuthority = "present_user";
            socket.data.authTokenAuthenticationEvidence = socket.handshake.auth.authenticationEvidence;
            await socket.join(sessionHumanPresenceRoom(session.id));
            serverSockets.set(socket.handshake.auth.fixtureId, socket);
        });

        const connect = async (params: Readonly<{
            fixtureId: string;
            accountId: string;
            authenticationEvidence: readonly unknown[];
        }>): Promise<ClientSocket> => {
            const client = createClient(`http://127.0.0.1:${cluster.nodes[1].port}`, {
                path: SOCKET_PATH,
                transports: ["websocket"],
                reconnection: false,
                auth: params,
            });
            clients.push(client);
            await new Promise<void>((resolve, reject) => {
                client.once("connect", resolve);
                client.once("connect_error", reject);
            });
            await waitFor(
                () => serverSockets.get(params.fixtureId)?.rooms.has(sessionHumanPresenceRoom(session.id)) === true,
                `${params.fixtureId} to join the human-presence room`,
            );
            return client;
        };

        try {
            publisher = createSessionHumanPresenceService({
                io: cluster.nodes[0].io,
                clusterAccessChangePublicationEnabled: true,
            });
            await waitFor(
                async () => await cluster.nodes[0].io.of("/").adapter.serverCount() === 2,
                "both API nodes to be visible as Pub/Sub peers",
            );
            const published = new Promise<unknown>((resolve) => {
                cluster.nodes[1].io.once(
                    SESSION_HUMAN_PRESENCE_ACCESS_CHANGED_SERVER_EVENT,
                    resolve,
                );
            });
            notifySessionHumanPresenceAccessChanged({ sessionId: session.id });
            await expect(published).resolves.toEqual({ v: 1, sessionId: session.id });
            publisher.close();
            publisher = undefined;

            presence = createSessionHumanPresenceService({
                io: cluster.nodes[1].io,
                clusterAccessChangePublicationEnabled: true,
            });
            const ownerClient = await connect({
                fixtureId: "owner",
                accountId: owner.id,
                authenticationEvidence: [],
            });
            await connect({
                fixtureId: "qualified",
                accountId: member.id,
                authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
            });
            const unqualifiedClient = await connect({
                fixtureId: "unqualified",
                accountId: member.id,
                authenticationEvidence: [],
            });

            const snapshots: Array<{
                viewers: Array<{ account: { accountId: string } }>;
            }> = [];
            const unqualifiedSnapshots: unknown[] = [];
            ownerClient.on(SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT, value => snapshots.push(value));
            unqualifiedClient.on(
                SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT,
                value => unqualifiedSnapshots.push(value),
            );
            presence.schedule([session.id]);
            await waitFor(
                () => snapshots.at(-1)?.viewers.length === 2,
                "the initial Account-deduplicated observation",
            );

            // Model the state committed by node A. This spec owns the presence
            // cluster boundary, not the Team-policy writer, so the direct setup
            // mutation deliberately avoids the process-local afterTx listener.
            await db.team.update({
                where: { id: team.id },
                data: { authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                } },
            });

            // Settling check for the eviction below: the fixture's accepted evidence
            // must already qualify this exact socket under the restricted policy. If
            // this fails, the fixture never established a qualified credential and the
            // eviction that follows is correct; if it holds and the socket is still
            // evicted, the defect is in the projection path, not the fixture.
            const qualifiedSocket = serverSockets.get("qualified");
            if (!qualifiedSocket) throw new Error("Expected the qualified socket to be admitted");
            await expect(resolveSessionAccessForOperation(db, {
                accountId: member.id,
                sessionId: session.id,
                authentication: readSessionAccessAuthenticationFromSocket(qualifiedSocket),
            })).resolves.toMatchObject({ status: "allowed", access: { capabilities: { readTranscript: true } } });

            cluster.nodes[0].io.serverSideEmit(
                SESSION_HUMAN_PRESENCE_ACCESS_CHANGED_SERVER_EVENT,
                { v: 1, sessionId: session.id, accountIds: [member.id] },
            );
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
            expect(serverSockets.get("unqualified")?.rooms.has(sessionHumanPresenceRoom(session.id))).toBe(true);
            const unqualifiedSnapshotCountBeforeTransition = unqualifiedSnapshots.length;

            cluster.nodes[0].io.serverSideEmit(
                SESSION_HUMAN_PRESENCE_ACCESS_CHANGED_SERVER_EVENT,
                { v: 1, sessionId: session.id },
            );

            await waitFor(
                () => serverSockets.get("unqualified")?.rooms.has(sessionHumanPresenceRoom(session.id)) === false,
                "the no-longer-qualified remote socket to leave",
            );
            expect(serverSockets.get("qualified")?.rooms.has(sessionHumanPresenceRoom(session.id))).toBe(true);
            expect(serverSockets.get("owner")?.rooms.has(sessionHumanPresenceRoom(session.id))).toBe(true);
            expect(snapshots.at(-1)?.viewers.map(value => value.account.accountId).sort())
                .toEqual([owner.id, member.id].sort());
            expect(unqualifiedSnapshots).toHaveLength(unqualifiedSnapshotCountBeforeTransition);
        } finally {
            clients.forEach(client => client.close());
            publisher?.close();
            presence?.close();
            await cluster.close();
        }
    }, 90_000);
});
