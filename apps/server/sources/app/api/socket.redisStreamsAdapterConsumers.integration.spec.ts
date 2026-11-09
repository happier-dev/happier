import { Buffer } from "node:buffer";

import { API_TOKEN_FULL_GRANT_V1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import {
    ExternalActionDaemonDispatchRequestSchema,
    ExternalActionExecutionAuthorizationV1Schema,
    prepareExternalActionResponseEnvelopeV1,
} from "@happier-dev/protocol/actions";
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from "@happier-dev/protocol/socketRpc";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startRedisAdapterRecoveryCluster } from "@/testkit/redisAdapterRecoveryCluster";

import {
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    createExternalActionDaemonDispatcher,
} from "./socket/externalActionDispatcher";
import { machineTransferHandler } from "./socket/machineTransferHandler";
import { buildRpcMethodRoom } from "./socket/rpc/rpcMethodRoom";

const machineFindFirst = vi.hoisted(() => vi.fn(async () => ({
    revokedAt: null,
    replacedByMachineId: null,
    dataEncryptionKey: null,
})));

vi.mock("@/storage/db", () => ({
    db: { machine: { findFirst: machineFindFirst } },
}));

type ProductCluster = Awaited<ReturnType<typeof startRedisAdapterRecoveryCluster>>;

const openClusters: ProductCluster[] = [];
const openClients: ClientSocket[] = [];

async function connectClient(
    port: number,
    auth: Record<string, unknown> = {},
): Promise<ClientSocket> {
    const socket = createClient(`http://127.0.0.1:${port}`, {
        path: "/v1/updates",
        transports: ["websocket"],
        timeout: 10_000,
        auth,
    });
    openClients.push(socket);
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out connecting to port ${port}`)), 12_000);
        socket.once("connect", () => {
            clearTimeout(timeout);
            resolve();
        });
        socket.once("connect_error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
    return socket;
}

async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
): Promise<void> {
    await vi.waitFor(async () => {
        if (!await predicate()) throw new Error(`Waiting for ${description}`);
    }, { timeout: 20_000, interval: 100 });
}

async function startCluster(): Promise<ProductCluster> {
    const cluster = await startRedisAdapterRecoveryCluster();
    for (const { io } of cluster.nodes) {
        io.on("connection", (socket) => {
            const room = socket.handshake.auth?.room;
            if (typeof room === "string" && room.length > 0) socket.join(room);
        });
    }
    openClusters.push(cluster);
    return cluster;
}

afterEach(async () => {
    while (openClients.length > 0) openClients.pop()?.disconnect();
    while (openClusters.length > 0) await openClusters.pop()?.close();
    machineFindFirst.mockReset();
    machineFindFirst.mockResolvedValue({
        revokedAt: null,
        replacedByMachineId: null,
        dataEncryptionKey: null,
    });
});

describe("Redis Streams adapter current consumer composition", () => {
    it("routes the exact remote external Action target and preserves a binary multibyte acknowledgement", async () => {
        const cluster = await startCluster();
        const accountId = "account:external-action:cluster";
        const machineId = "machine:external-action:exact";
        const installationId = "installation:external-action:exact";
        const actionId = "session.spawn_new" as const;
        const requestId = "request:external-action:cluster";
        const method = `${machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`;
        const methodRoom = buildRpcMethodRoom({ userId: accountId, method });

        const candidates = [
            await connectClient(cluster.nodes[1].port),
            await connectClient(cluster.nodes[1].port),
        ].sort((left, right) => left.id!.localeCompare(right.id!));
        // Deliberately make the first target selected by the generic RPC
        // chooser the decoy. The test therefore fails if the dispatcher's
        // exact-Machine guard stops filtering the adapter-projected data.
        const [decoyTarget, exactTarget] = candidates;
        if (!exactTarget || !decoyTarget) {
            throw new Error("Expected two external Action target candidates");
        }
        const exactServerSocket = cluster.nodes[1].io.of("/").sockets.get(exactTarget.id!);
        const decoyServerSocket = cluster.nodes[1].io.of("/").sockets.get(decoyTarget.id!);
        if (!exactServerSocket || !decoyServerSocket) {
            throw new Error("Expected both external Action targets on the remote node");
        }
        Object.assign(exactServerSocket.data, {
            clientType: "machine-scoped",
            userId: accountId,
            machineId,
            verifiedMachineInstallationId: installationId,
        });
        Object.assign(decoyServerSocket.data, {
            clientType: "machine-scoped",
            userId: accountId,
            machineId: "machine:external-action:decoy",
            verifiedMachineInstallationId: "installation:external-action:decoy",
        });
        await Promise.all([exactServerSocket.join(methodRoom), decoyServerSocket.join(methodRoom)]);
        await waitFor(
            async () => (await cluster.nodes[0].io.in(methodRoom).fetchSockets()).length === 2,
            "both remote candidate projections",
        );

        let decoyRequestCount = 0;
        decoyTarget.on(SOCKET_RPC_EVENTS.REQUEST, () => {
            decoyRequestCount += 1;
        });
        const responseEnvelope = {
            v: 1 as const,
            actionId,
            requestId,
            execution: {
                ok: true as const,
                result: {
                    message: "cross-node café 🚀",
                    payloadBase64: Buffer.from([0x00, 0xff, 0x10, 0x80]).toString("base64"),
                },
            },
        };
        const preparedResponse = prepareExternalActionResponseEnvelopeV1(responseEnvelope);
        const binaryAcknowledgement = new TextEncoder().encode(preparedResponse.body);
        expect(binaryAcknowledgement.byteLength).toBeGreaterThan(preparedResponse.body.length);

        let exactRequest: ReturnType<typeof ExternalActionDaemonDispatchRequestSchema.parse> | null = null;
        exactTarget.on(SOCKET_RPC_EVENTS.REQUEST, (raw: unknown, acknowledge: (response: unknown) => void) => {
            exactRequest = ExternalActionDaemonDispatchRequestSchema.parse(
                (raw as SocketRpcRequestPayload).params,
            );
            acknowledge({ kind: "response", body: binaryAcknowledgement });
        });

        const envelope = {
            v: 1 as const,
            requestId,
            target: { kind: "machine" as const, machineId },
            input: {
                message: "send café 🚀",
                payloadBase64: Buffer.from([0x00, 0xfe, 0x7f]).toString("base64"),
            },
        };
        const dispatch = createExternalActionDaemonDispatcher({
            io: cluster.nodes[0].io,
            resolveMachine: async () => "available",
            getServerIdentityId: async () => "server:external-action:cluster",
            mintExecutionAuthorization: async (binding) => ExternalActionExecutionAuthorizationV1Schema.parse({
                v: 1,
                token: "test-external-action-authorization",
                binding: { ...binding, custodianAccountId: binding.accountId, installationId },
            }),
        });

        await expect(dispatch({
            actionId,
            envelope,
            principal: {
                accountId,
                principalId: "principal:external-action:cluster",
                credentialId: "credential:external-action:cluster",
                authority: "account_automation",
                grant: API_TOKEN_FULL_GRANT_V1,
            },
        })).resolves.toEqual({ kind: "response", prepared: preparedResponse });
        expect(exactRequest).toMatchObject({ actionId, envelope });
        expect(decoyRequestCount).toBe(0);
    }, 60_000);

    it("relays one current Machine transfer byte sequence through the production handler across nodes", async () => {
        const cluster = await startCluster();
        const accountId = "account:machine-transfer:cluster";
        const sourceMachineId = "machine:transfer:source";
        const targetMachineId = "machine:transfer:target";
        const targetRoom = `machine:${targetMachineId}:${accountId}`;

        cluster.nodes[0].io.on("connection", (socket) => {
            if (socket.handshake.auth?.machineId !== sourceMachineId) return;
            Object.assign(socket.data, {
                clientType: "machine-scoped",
                userId: accountId,
                machineId: sourceMachineId,
            });
            machineTransferHandler(accountId, socket, {
                io: cluster.nodes[0].io,
                serverRoutedTransferEnabled: true,
            });
        });

        const target = await connectClient(cluster.nodes[1].port, { room: targetRoom });
        const source = await connectClient(cluster.nodes[0].port, { machineId: sourceMachineId });
        await waitFor(
            async () => (await cluster.nodes[0].io.in(targetRoom).fetchSockets()).length === 1,
            "the remote exact Machine target",
        );

        const originalBytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x42]);
        let received: {
            sourceMachineId: string;
            targetMachineId: string;
            envelope: {
                transferId: string;
                kind: string;
                sequence: number;
                payloadBase64: string;
            };
        } | null = null;
        target.once(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, (payload) => {
            received = payload;
        });
        source.emit(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
            targetMachineId,
            envelope: {
                transferId: "transfer:redis-streams:binary",
                kind: "chunk",
                sequence: 1,
                payloadBase64: originalBytes.toString("base64"),
            },
        });

        await waitFor(() => received !== null, "the Machine transfer frame");
        expect(received).toMatchObject({
            sourceMachineId,
            targetMachineId,
            envelope: {
                transferId: "transfer:redis-streams:binary",
                kind: "chunk",
                sequence: 1,
            },
        });
        expect(Buffer.from(received!.envelope.payloadBase64, "base64")).toEqual(originalBytes);
    }, 60_000);
});
