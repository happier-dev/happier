import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { Redis } from "ioredis";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { startSilentPartitionProxy } from "@/testkit/redisSilentPartitionProxy";
import { startRedisAdapterRecoveryCluster, holdRedisAdapterDiscoveryRequests } from "@/testkit/redisAdapterRecoveryCluster";
import { readSocketRoomSnapshot } from './socket/socketRoomDiscovery';

import { RedisStreamsRoomEmitter } from "@/app/events/createRedisStreamsRoomEmitter";
import { emitSocketPlannedRestart } from "./socket";
import {
    REDIS_STREAMS_ADAPTER_CHANNEL_PREFIX,
    REDIS_STREAMS_ADAPTER_STREAM_NAME,
    readRedisStreamsAdapterOptionsFromEnv,
} from "@/config/socketAdapter";

import { resolveRedisAdapterValidationRedisUrl } from "../../../scripts/resolveRedisAdapterValidationRedisUrl";

/**
 * Owner-level proof for the Socket.IO Redis Streams adapter 0.3.1 upgrade.
 *
 * 0.3 splits the cluster transport: ordinary broadcasts keep using Redis
 * Streams while `fetchSockets`, `serverSideEmit`, and broadcast acknowledgement
 * control traffic move to Redis Pub/Sub. Both backplanes are load-bearing for
 * existing RPC discovery, external-action routing, and peer/tunnel
 * coordination, so this suite exercises real two-node behavior, real Redis
 * restart recovery, real shutdown, and a real restricted ACL rather than
 * asserting Redis calls.
 */

const SOCKET_PATH = "/v1/updates";
const SOCKET_CLUSTER_CONNECTION_NAME_PREFIX = "happier-socket-cluster:";
const REDIS_STALE_TIMER_GRACE_MS = 6_000;

type ProductCluster = Awaited<ReturnType<typeof startRedisAdapterRecoveryCluster>>;

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
            // Probing across a deliberate Redis outage is expected to fail
            // until the transport recovers; the timeout below is the real gate.
            lastError = error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
        `Timed out waiting for ${description}${lastError ? ` (last error: ${String(lastError)})` : ""}`,
    );
}

async function connectClient(
    port: number,
    auth: Record<string, unknown> = {},
): Promise<ClientSocket> {
    const socket = createClient(`http://127.0.0.1:${port}`, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        timeout: 10_000,
        auth,
    });
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out connecting to port ${port}`)), 12_000);
        socket.once("connect", () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once("connect_error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
    return socket;
}

function parseSocketClusterConnectionNames(clientList: string): string[] {
    return clientList
        .split("\n")
        .map((line) => /(?:^|\s)name=(\S*)/.exec(line)?.[1] ?? "")
        .filter((name) => name.startsWith(SOCKET_CLUSTER_CONNECTION_NAME_PREFIX))
        .sort();
}

describe("socket.io redis streams adapter cluster integration", () => {
    let redisUrl: string;
    let redisMemory: Awaited<ReturnType<typeof resolveRedisAdapterValidationRedisUrl>>["redisMemory"];
    let verifier: Redis;
    const openClusters: ProductCluster[] = [];
    const openClients: ClientSocket[] = [];

    async function readSocketClusterConnectionNames(): Promise<string[]> {
        return parseSocketClusterConnectionNames(await verifier.call("CLIENT", "LIST") as string);
    }

    beforeAll(async () => {
        // These topology and lifecycle claims are specific to the approved
        // upstream boundary, including on a remote executor's installed tree.
        expect(createRequire(import.meta.url)("@socket.io/redis-streams-adapter/package.json"))
            .toMatchObject({ version: "0.3.1" });
        // Deliberately ignore an ambient REDIS_URL: this suite owns a real
        // Redis stop/start and ACL mutations.
        const resolved = await resolveRedisAdapterValidationRedisUrl({ env: {} as NodeJS.ProcessEnv });
        if (!resolved.redisMemory) {
            throw new Error("Redis Streams adapter cluster proof requires an embedded Redis instance");
        }
        redisUrl = resolved.redisUrl;
        redisMemory = resolved.redisMemory;
        verifier = new Redis(redisUrl, {
            connectionName: "happier-adapter-test-verifier",
            maxRetriesPerRequest: 3,
        });
        verifier.on("error", () => {
            // Expected while this suite deliberately stops Redis.
        });
        await verifier.ping();
    });

    afterAll(async () => {
        verifier?.disconnect(false);
        await redisMemory?.stop();
    });

    afterEach(async () => {
        while (openClients.length > 0) openClients.pop()?.disconnect();
        while (openClusters.length > 0) await openClusters.pop()?.close();
        vi.resetModules();
    });

    async function startCluster(url: string = redisUrl): Promise<ProductCluster> {
        const cluster = await startRedisAdapterRecoveryCluster({ redisUrl: url });
        for (const { io } of cluster.nodes) {
            io.on("connection", (socket) => {
                const room = socket.handshake.auth?.room;
                if (typeof room === "string" && room.length > 0) socket.join(room);
            });
        }
        openClusters.push(cluster);
        return cluster;
    }

    async function connect(port: number, auth?: Record<string, unknown>): Promise<ClientSocket> {
        const socket = await connectClient(port, auth);
        openClients.push(socket);
        return socket;
    }

    it('admits a current-version positive room reply while an unrelated peer remains silent', async () => {
        const cluster = await startRedisAdapterRecoveryCluster({ redisUrl, nodeCount: 3 });
        openClusters.push(cluster);
        const [caller, target, unrelated] = cluster.nodes;
        const room = 'current-positive-room';
        target.io.on('connection', socket => { void socket.join(room); });
        const client = await connect(target.port);
        const held = holdRedisAdapterDiscoveryRequests(unrelated!.io);
        const targetHeld = holdRedisAdapterDiscoveryRequests(target.io);
        try {
            const reading = readSocketRoomSnapshot({ io: caller.io, room, timeoutMs: 1_000,
                acceptPartial: async sockets => sockets.some(socket => 'id' in socket && socket.id === client.id) });
            await Promise.all([held.received, targetHeld.received]);
            targetHeld.release();
            const snapshot = await reading;
            expect(held.count).toBeGreaterThan(0);
            // The peer has still not answered. A current-version positive reply is enough
            // for this existential read, not for absence or global uniqueness.
            expect(snapshot.sockets.map(socket => 'id' in socket ? socket.id : null)).toContain(client.id);
            expect(snapshot.complete).toBe(false);
            expect(snapshot.error).toBeUndefined();
        } finally {
            held.release();
            targetHeld.release();
        }
    });

    it("announces a node shutdown only to that node's sockets, preserving healthy peer connections", async () => {
        const cluster = await startCluster();
        const [retiring, healthy] = cluster.nodes;
        const local = await connect(retiring.port);
        const remote = await connect(healthy.port);
        const remoteRestarts: unknown[] = [];
        remote.on("server:restarting", payload => remoteRestarts.push(payload));
        const localRestart = new Promise<unknown>(resolve => local.once("server:restarting", resolve));
        const delivered = new Promise<void>(resolve => remote.once("shutdown-test-barrier", resolve));

        emitSocketPlannedRestart(retiring.io, 7_000);
        // The same publisher/stream orders this marker after any cluster-wide
        // restart broadcast. Its delivery makes the negative assertion decisive.
        retiring.io.emit("shutdown-test-barrier");
        await delivered;

        expect(await localRestart).toEqual({ retryAfterMs: 7_000 });
        expect(remoteRestarts).toEqual([]);
        expect(remote.connected).toBe(true);
    });

    it("opens one root, one blocking stream reader, and one Pub/Sub subscriber per API node", async () => {
        await startCluster();

        await waitFor(
            async () => (await readSocketClusterConnectionNames()).length === 6,
            "six named socket-cluster connections across two nodes",
        );

        const readConnectionIds = async (): Promise<string[]> => (await verifier.call("CLIENT", "LIST") as string)
            .split("\n")
            .filter((line) => line.includes(`name=${SOCKET_CLUSTER_CONNECTION_NAME_PREFIX}`))
            .map((line) => /(?:^|\s)id=(\d+)/.exec(line)?.[1] ?? "")
            .sort();
        const initialIds = await readConnectionIds();
        // More than two stall-timeout windows distinguishes a healthy BLOCK
        // reader from one continually reconnecting at the 5-second default.
        await new Promise<void>((resolve) => setTimeout(resolve, 11_000));
        expect(await readConnectionIds()).toEqual(initialIds);
        const names = await readSocketClusterConnectionNames();
        expect(names).toEqual([
            "happier-socket-cluster:adapter-1",
            "happier-socket-cluster:adapter-1",
            "happier-socket-cluster:adapter-2",
            "happier-socket-cluster:adapter-2",
            "happier-socket-cluster:root",
            "happier-socket-cluster:root",
        ]);
    });

    it("bounds idle empty XREAD returns per replica per minute", async () => {
        let emptyReturns = 0;
        const sendCommand = Redis.prototype.sendCommand;
        // Observe the real external Redis boundary; every command and adapter
        // read-loop decision still executes unchanged.
        const observed = vi.spyOn(Redis.prototype, "sendCommand").mockImplementation(function (this: Redis, command, stream) {
            const result = sendCommand.call(this, command, stream);
            if (command.name === "xread" && this.options.connectionName?.startsWith("happier-socket-cluster:adapter-")) {
                void Promise.resolve(result).then(response => {
                    if (response === null) emptyReturns += 1;
                }, () => {});
            }
            return result;
        });
        try {
            const cluster = await startCluster();
            const initialReturns = emptyReturns;
            await new Promise<void>(resolve => setTimeout(resolve, 60_000));
            const idleReturns = emptyReturns - initialReturns;
            console.info("redis-xread-idle", JSON.stringify({
                blockTimeInMs: readRedisStreamsAdapterOptionsFromEnv({}).blockTimeInMs,
                replicas: cluster.nodes.length,
                emptyReturnsPerReplicaPerMinute: idleReturns / cluster.nodes.length,
            }));
            // Derived from the fixed 5-second socket deadline minus ioredis'
            // 100-ms response grace and the retry owner's 50-ms timer grace.
            expect(idleReturns).toBeGreaterThan(0);
            expect(idleReturns).toBeLessThanOrEqual(cluster.nodes.length * Math.ceil(60_000 / (5_000 - 100 - 50)));
            for (const node of cluster.nodes) {
                // Pin the derived margin to actual ioredis defaults and the
                // production factory, not just duplicated fixture constants.
                expect(readRedisStreamsAdapterOptionsFromEnv({}).blockTimeInMs
                    + node.redis.options.blockingTimeoutGrace! + 50).toBe(node.redis.options.socketTimeout);
            }
        } finally {
            observed.mockRestore();
        }
    }, 90_000);

    it("fans out ordered binary room broadcasts during a blocking XREAD without waiting for its expiry", async () => {
        const cluster = await startCluster();
        const room = "session:binary-fanout";
        const receiver = await connect(cluster.nodes[1].port, { room });
        // Shaped like a machine transfer / live-stream relay frame: metadata
        // around a nested binary chunk. `onlyPlaintext: false` is what keeps the
        // adapter's nested `hasBinary` detection on for this corridor.
        const chunk = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f]);
        const frames = [7, 8, 9].map((seq) => ({ transferId: "transfer-1", seq, chunk }));
        const received = new Promise<typeof frames>((resolve) => {
            const delivered: typeof frames = [];
            receiver.on("update", (value: (typeof frames)[number]) => {
                delivered.push(value);
                if (delivered.length === frames.length) resolve(delivered);
            });
        });
        await waitFor(
            async () => (await cluster.nodes[0].io.in(room).fetchSockets()).length === 1,
            "the remote socket to become visible from the publishing node",
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const beforeBlockExpires = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Stream delivery waited for BLOCK expiry")),
                    readRedisStreamsAdapterOptionsFromEnv({}).blockTimeInMs);
            });
            for (const frame of frames) cluster.nodes[0].io.to(room).emit("update", frame);
            expect(await Promise.race([received, beforeBlockExpires])).toEqual(frames);
        } finally {
            clearTimeout(timer);
        }
    });

    it("discovers remote sockets with fetchSockets before and after a remote disconnect", async () => {
        const cluster = await startCluster();
        const room = "session:discovery";
        const remote = await connect(cluster.nodes[1].port, { room });

        await waitFor(
            async () => (await cluster.nodes[0].io.in(room).fetchSockets()).length === 1,
            "cross-node fetchSockets to discover the remote socket",
        );
        const discovered = await cluster.nodes[0].io.in(room).fetchSockets();
        expect(discovered.map((socket) => socket.id)).toEqual([remote.id]);

        remote.disconnect();

        await waitFor(
            async () => (await cluster.nodes[0].io.in(room).fetchSockets()).length === 0,
            "cross-node fetchSockets to report no remaining target",
        );
    });

    it("carries serverSideEmit and serverSideEmitWithAck, including binary values, across nodes", async () => {
        const cluster = await startCluster();
        const binary = Buffer.from([0x10, 0x20, 0x00, 0xff]);

        const observed = new Promise<{ note: string; blob: Buffer }>((resolve) => {
            cluster.nodes[1].io.on("relay-detach", (value: { note: string; blob: Buffer }) => resolve(value));
        });
        cluster.nodes[1].io.on("relay-attach", (value: { attemptId: string }, respond: (result: unknown) => void) => {
            respond({ acceptedBy: "node-b", attemptId: value.attemptId, blob: binary });
        });

        await waitFor(
            async () => await cluster.nodes[0].io.of("/").adapter.serverCount() === 2,
            "both nodes to be visible as Pub/Sub peers",
        );

        cluster.nodes[0].io.serverSideEmit("relay-detach", { note: "detach", blob: binary });
        const detach = await observed;
        expect(detach.note).toBe("detach");
        expect(Buffer.from(detach.blob)).toEqual(binary);

        const responses = await cluster.nodes[0].io.serverSideEmitWithAck("relay-attach", { attemptId: "attempt-1" });
        expect(responses).toHaveLength(1);
        const [response] = responses as Array<{ acceptedBy: string; attemptId: string; blob: Buffer }>;
        expect(response.acceptedBy).toBe("node-b");
        expect(response.attemptId).toBe("attempt-1");
        expect(Buffer.from(response.blob)).toEqual(binary);
    });

    it("delivers worker-emitted stream envelopes to clients on both API nodes", async () => {
        const cluster = await startCluster();
        const room = "session:worker-fanout";
        const onA = await connect(cluster.nodes[0].port, { room });
        const onB = await connect(cluster.nodes[1].port, { room });

        const receivedA = new Promise<unknown>((resolve) => onA.once("update", resolve));
        const receivedB = new Promise<unknown>((resolve) => onB.once("update", resolve));

        // The worker role publishes the adapter's Stream envelope directly
        // rather than joining the cluster as a peer. Prove the exact envelope
        // still decodes under 0.3.1.
        const workerRedis = new Redis(redisUrl, { connectionName: "happier-adapter-test-worker" });
        const emitter = new RedisStreamsRoomEmitter(workerRedis, {
            maxLen: readRedisStreamsAdapterOptionsFromEnv({}).maxLen,
            streamName: REDIS_STREAMS_ADAPTER_STREAM_NAME,
        });
        try {
            await waitFor(
                async () => (await cluster.nodes[0].io.in(room).fetchSockets()).length === 2,
                "both clients to be visible in the room",
            );
            emitter.to(room).emit("update", { source: "worker" });

            expect(await receivedA).toEqual({ source: "worker" });
            expect(await receivedB).toEqual({ source: "worker" });
        } finally {
            workerRedis.disconnect(false);
        }
    });

    it("recovers Stream and Pub/Sub after Redis restart, rejects outage requests, and closes every connection", async () => {
        const cluster = await startCluster();
        const room = "session:restart";
        const remote = await connect(cluster.nodes[1].port, { room });

        await waitFor(
            async () => (await cluster.nodes[0].io.in(room).fetchSockets()).length === 1,
            "cross-node discovery before the outage",
        );

        const assertBroadcastAcknowledgement = async (): Promise<void> => {
            const binary = Buffer.from([0, 255, 17]);
            remote.once("restart-broadcast-ack", (value, respond) => respond(value));
            const responses = await cluster.nodes[0].io.to(room).timeout(5_000)
                .emitWithAck("restart-broadcast-ack", binary);
            expect(responses).toHaveLength(1);
            expect(Buffer.from(responses[0])).toEqual(binary);
        };
        await assertBroadcastAcknowledgement();

        await redisMemory!.stop();

        // The transient Pub/Sub path is deliberately not durable. The request
        // must settle through the existing ioredis retry/error contract instead
        // of hanging forever or answering as if the cluster were healthy.
        const inOutage = cluster.nodes[0].io.in(room).fetchSockets();
        await expect(inOutage).rejects.toThrow();

        await redisMemory!.start();

        await waitFor(
            async () => (await readSocketClusterConnectionNames()).length === 6,
            "all six adapter connections to reconnect after the restart",
            40_000,
        );

        await waitFor(
            async () => (await cluster.nodes[0].io.in(room).fetchSockets()).length === 1,
            "cross-node fetchSockets to recover after the restart",
            40_000,
        );

        // Streams path recovered too.
        const received = new Promise<unknown>((resolve) => remote.once("update", resolve));
        await waitFor(async () => {
            cluster.nodes[0].io.to(room).emit("update", { phase: "recovered" });
            return await Promise.race([
                received.then(() => true),
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
            ]);
        }, "a post-restart Stream broadcast to reach the remote client", 40_000);
        expect(await received).toEqual({ phase: "recovered" });

        // Pub/Sub server-side emission recovered too.
        cluster.nodes[1].io.on("relay-attach", (_value: unknown, respond: (result: unknown) => void) => {
            respond({ acceptedBy: "node-b" });
        });
        await waitFor(
            async () => await cluster.nodes[0].io.of("/").adapter.serverCount() === 2,
            "Pub/Sub peer visibility to recover",
            40_000,
        );
        await expect(
            cluster.nodes[0].io.serverSideEmitWithAck("relay-attach", { attemptId: "after-restart" }),
        ).resolves.toEqual([{ acceptedBy: "node-b" }]);
        await assertBroadcastAcknowledgement();
        const emitted = new Promise<unknown>((resolve) => cluster.nodes[1].io.once("restart-emit", resolve));
        cluster.nodes[0].io.serverSideEmit("restart-emit", { phase: "recovered" });
        expect(await emitted).toEqual({ phase: "recovered" });
        await cluster.close();
        // This is the recovered cluster, not a fresh happy-boot substitute.
        await new Promise<void>((resolve) => setTimeout(resolve, REDIS_STALE_TIMER_GRACE_MS));
        expect(await readSocketClusterConnectionNames()).toEqual([]);
    }, 120_000);

    it("recovers remote discovery after a silent partition of idle subscriber connections", async () => {
        const proxy = await startSilentPartitionProxy(redisUrl);
        try {
            const cluster = await startCluster(proxy.url);
            const room = "session:silent-partition";
            const remote = await connect(cluster.nodes[1].port, { room });
            await waitFor(
                async () => (await cluster.nodes[0].io.in(room).fetchSockets()).some((socket) => socket.id === remote.id),
                "remote discovery before silent partition",
            );
            const assertBackplanes = async (phase: string): Promise<void> => {
                const payload = { phase, binary: Buffer.from([0, 255, 17]) };
                const assertPayload = (value: { phase: string; binary: Uint8Array }): void => {
                    expect(value.phase).toBe(phase);
                    expect(Buffer.from(value.binary)).toEqual(payload.binary);
                };
                const broadcast = new Promise<{ phase: string; binary: Uint8Array }>((resolve) => remote.once("partition-broadcast", resolve));
                cluster.nodes[0].io.to(room).emit("partition-broadcast", payload);
                assertPayload(await broadcast);
                const emitted = new Promise<{ phase: string; binary: Uint8Array }>((resolve) => cluster.nodes[1].io.once("partition-emit", resolve));
                cluster.nodes[0].io.serverSideEmit("partition-emit", payload);
                assertPayload(await emitted);
                cluster.nodes[1].io.once("partition-ack", (value, respond) => respond(value));
                const responses = await cluster.nodes[0].io.serverSideEmitWithAck("partition-ack", payload);
                expect(responses).toHaveLength(1);
                assertPayload(responses[0]);
            };
            await assertBackplanes("before");
            // Preserve established TCP connections but silently discard their
            // traffic. This is distinct from the existing socket-close fixture.
            proxy.partition();
            await new Promise<void>((resolve) => setTimeout(resolve, 7_000));
            proxy.heal();
            await waitFor(
                async () => (await cluster.nodes[0].io.in(room).fetchSockets()).some((socket) => socket.id === remote.id),
                "remote discovery after silent partition heals",
                25_000,
            );
            await assertBackplanes("after");
        } finally {
            while (openClusters.length > 0) await openClusters.pop()?.close();
            await proxy.close();
        }
    }, 60_000);

    describe("least-privilege Redis ACL", () => {
        const ACL_PASSWORD = "adapter-acl-password";

        /**
         * The exact non-sharded 0.3.1 command surface Happier invokes:
         * `XADD`/`XREAD` on the one stream, `PUBLISH`/`SUBSCRIBE` plus
         * `PUBSUB NUMSUB` on the adapter channels, and the connection commands
         * ioredis itself issues (`AUTH`, `INFO` ready check, `CLIENT SETNAME`
         * for the diagnostic connection name).
         *
         * `SPUBLISH`, `SSUBSCRIBE`, and `PUBSUB SHARDNUMSUB` are intentionally
         * absent because sharded Pub/Sub stays off, and `SET`/`GETDEL`/`XRANGE`
         * are only required when Socket.IO connection-state recovery is enabled.
         */
        const REQUIRED_COMMANDS = [
            "+auth",
            "+info",
            "+client|setname",
            "+xadd",
            "+xread",
            "+publish",
            "+subscribe",
            "+pubsub|numsub",
        ] as const;

        async function createAclUser(input: Readonly<{
            username: string;
            commands: readonly string[];
        }>): Promise<string> {
            await verifier.call(
                "ACL",
                "SETUSER",
                input.username,
                "reset",
                "on",
                `>${ACL_PASSWORD}`,
                `~${REDIS_STREAMS_ADAPTER_STREAM_NAME}`,
                `&${REDIS_STREAMS_ADAPTER_CHANNEL_PREFIX}#*`,
                ...input.commands,
            );
            const url = new URL(redisUrl);
            url.username = input.username;
            url.password = ACL_PASSWORD;
            return url.toString();
        }

        it("serves cross-node Streams and Pub/Sub under the documented restricted ACL", async () => {
            const restrictedUrl = await createAclUser({
                username: "happier-adapter-acl-ok",
                commands: REQUIRED_COMMANDS,
            });
            const cluster = await startCluster(restrictedUrl);
            const room = "session:acl";
            const remote = await connect(cluster.nodes[1].port, { room });

            // Pub/Sub path.
            await waitFor(
                async () => (await cluster.nodes[0].io.in(room).fetchSockets()).length === 1,
                "restricted-ACL cross-node discovery",
            );

            // Streams path.
            const received = new Promise<unknown>((resolve) => remote.once("update", resolve));
            cluster.nodes[0].io.to(room).emit("update", { acl: "restricted" });
            expect(await received).toEqual({ acl: "restricted" });
        }, 60_000);

        it("fails visibly at the real adapter boundary when SUBSCRIBE permission is missing", async () => {
            const restrictedUrl = await createAclUser({
                username: "happier-adapter-acl-no-subscribe",
                commands: REQUIRED_COMMANDS.filter((command) => command !== "+subscribe"),
            });
            // Upstream does not await SUBSCRIBE. Exercise its real startup in a
            // child process so the resulting unhandled rejection is observed
            // without suppressing Vitest's own unhandled-error detection.
            const startup = promisify(execFile)(process.execPath, [
                "--input-type=module",
                "--eval",
                `import { Redis } from "ioredis";
                 import { Server } from "socket.io";
                 import { createAdapter } from "@socket.io/redis-streams-adapter";
                 new Server({ adapter: createAdapter(new Redis(process.env.ADAPTER_ACL_TEST_URL), {
                     blockTimeInMs: 100, useShardedPubSub: false,
                 }) });`,
            ], {
                env: { ...process.env, ADAPTER_ACL_TEST_URL: restrictedUrl },
                timeout: 10_000,
                maxBuffer: 64 * 1024,
            });
            await expect(startup).rejects.toMatchObject({
                code: 1,
                stderr: expect.stringMatching(/NOPERM.*subscribe/i),
            });
        }, 20_000);
    });
});
