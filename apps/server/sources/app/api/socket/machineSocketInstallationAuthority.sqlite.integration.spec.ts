import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";
import tweetnacl from "tweetnacl";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    buildAccountStoredContentCompatibilitySocketAuthV1,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    decodeBase64,
    encodeBase64,
    encodePlainMachineStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
    signMachineInstallationProof,
} from "@happier-dev/protocol";
import { buildMachineScopedSocketAuth } from "@happier-dev/protocol/machines/ownership/daemonOwnership";
import {
    TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1,
    TeamCredentialExternalProviderOperationRetireResponseV1Schema,
} from "@happier-dev/protocol/teams";
import { auth } from "@/app/auth/auth";
import { startSocket } from "@/app/api/socket";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const PUBLISHED_METADATA = {
    host: "policy-host", platform: "linux", happyCliVersion: "0.3.0",
    homeDir: "/home/policy", happyHomeDir: "/home/policy/.happier",
};

async function createSocketMachine(owner?: { accountId: string; token: string }) {
    const accountId = owner?.accountId ?? (await db.account.create({ data: { encryptionMode: "plain" } })).id;
    const token = owner?.token ?? await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
    const keys = tweetnacl.sign.keyPair();
    const installationId = randomUUID();
    const machine = await db.machine.create({ data: {
        id: randomUUID(), accountId, installationId, installationPublicKey: new Uint8Array(keys.publicKey),
        metadata: encodePlainMachineStoredContent(PUBLISHED_METADATA),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
    } });
    const machineAuth = buildMachineScopedSocketAuth({
        token, machineId: machine.id, installationId,
        installationPublicKey: encodeBase64(keys.publicKey, "base64url"),
        installationProof: signMachineInstallationProof({
            privateKey: keys.secretKey, payload: { version: 1, accountId, machineId: machine.id, installationId },
        }),
    });
    return { accountId, token, machineId: machine.id, machineAuth };
}

async function withSocketIngress(run: (connect: (auth: Record<string, unknown>) => Promise<SocketClient>) => Promise<void>) {
    const app = createAuthenticatedTestApp({ authentication: "real" });
    const closeSockets = startSocket(app);
    try {
        const origin: string = await app.listen({ host: "127.0.0.1", port: 0 });
        await run(async auth => {
            const socket = io(origin, { path: "/v1/updates", auth: {
                ...auth,
                ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
            }, transports: ["websocket"],
                autoConnect: false, reconnection: false, timeout: 5_000 });
            try {
                await new Promise<void>((resolve, reject) => {
                    socket.once("connect", resolve);
                    socket.once("connect_error", reject);
                    socket.connect();
                });
                return socket;
            } catch (error) {
                socket.disconnect();
                throw error;
            }
        });
    } finally {
        try { await closeSockets(); }
        finally { await app.close(); }
    }
}

type SocketClient = ReturnType<typeof io>;

const retireBrokerOperation = async (socket: SocketClient, request: unknown) => TeamCredentialExternalProviderOperationRetireResponseV1Schema.parse(
    await socket.timeout(5_000).emitWithAck(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, request));

async function createBrokerOperation(fixture: { accountId: string; machineId: string }) {
    const team = await db.team.create({ data: { name: "Retirement boundary" } });
    const membership = await db.teamMembership.create({ data: {
        teamId: team.id, accountId: fixture.accountId, role: "owner",
    } });
    const sourceBindingJson = JSON.stringify({
        v: 1, kind: "provider_connection", connectionId: "connection-1",
        connectionSecurityFingerprint: "connection-security:v1:1", credentialSlotId: "apiKey",
    });
    const resource = await db.teamCredentialResource.create({ data: {
        teamId: team.id, custodianAccountId: fixture.accountId, displayName: "Broker",
        disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed", sourceBindingJson,
    } });
    const operation = {
        v: 1 as const, operationId: randomUUID(), brokerMachineId: fixture.machineId,
        brokerPlacementFingerprint: "a".repeat(64), sourceBindingJson,
    };
    const key = await db.teamCredentialExternalApiKey.create({ data: {
        resourceId: resource.id, teamMembershipId: membership.id, label: "Client",
        displayPrefix: "test", secretDigest: randomUUID(), currentBrokerOperationJson: JSON.stringify(operation),
    } });
    return {
        keyId: key.id, operation,
        request: { v: 1, externalApiKeyId: key.id, operationId: operation.operationId },
        read: async () => (await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: key.id } })).currentBrokerOperationJson,
    };
}

describe("Machine installation authority through the Home socket", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-machine-installation-authority-",
            initAuth: true,
            sqliteConnectionLimit: 1,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: "" },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("retires only the exact authenticated Machine operation and leaves a newer operation intact on stale replay", () => withSocketIngress(async connect => {
        const subject = await createSocketMachine();
        const broker = await createBrokerOperation(subject);
        const socket = await connect(subject.machineAuth);
        const retire = () => retireBrokerOperation(socket, broker.request);
        expect(await retire()).toEqual({ ok: true, retired: true });
        expect(await broker.read()).toBeNull();
        expect(await retire()).toEqual({ ok: true, retired: false });
        const newer = JSON.stringify({ ...broker.operation, operationId: randomUUID() });
        await db.teamCredentialExternalApiKey.update({ where: { id: broker.keyId }, data: { currentBrokerOperationJson: newer } });
        expect(await retire()).toEqual({ ok: true, retired: false });
        expect(await broker.read()).toBe(newer);
    }));

    it("denies broker retirement from another Account or another Machine in the custodian Account", () => withSocketIngress(async connect => {
        const subject = await createSocketMachine();
        const broker = await createBrokerOperation(subject);
        const foreign = await createSocketMachine();
        const otherMachine = await createSocketMachine(subject);
        for (const candidate of [foreign, otherMachine]) {
            const socket = await connect(candidate.machineAuth);
            expect(await retireBrokerOperation(socket, broker.request)).toEqual({ ok: false, reasonCode: "resource_forbidden" });
        }
        expect(await broker.read()).toBe(JSON.stringify(broker.operation));
        const owner = await connect(subject.machineAuth);
        expect(await retireBrokerOperation(owner, broker.request)).toEqual({ ok: true, retired: true });
    }));

    it("rejects body identity spoofing, unverified installations and replaced installation identity for broker retirement", () => withSocketIngress(async connect => {
        const subject = await createSocketMachine();
        const broker = await createBrokerOperation(subject);
        const unverified = await connect({ ...subject.machineAuth, installationProof: undefined });
        expect(await retireBrokerOperation(unverified, broker.request)).toEqual({ ok: false, reasonCode: "resource_forbidden" });
        unverified.disconnect();
        const browser = await connect({ token: subject.token, clientType: "user-scoped" });
        expect(await retireBrokerOperation(browser, broker.request)).toEqual({ ok: false, reasonCode: "resource_forbidden" });

        const owner = await connect({ ...subject.machineAuth, takeover: true });
        expect(await retireBrokerOperation(owner, { ...broker.request, machineId: subject.machineId }))
            .toEqual({ ok: false, reasonCode: "invalid_request" });
        // An authentic connection can outlive the installation tuple it proved at its handshake.
        await db.machine.update({ where: { id: subject.machineId }, data: { installationId: randomUUID() } });
        expect(await retireBrokerOperation(owner, broker.request)).toEqual({ ok: false, reasonCode: "resource_forbidden" });
        expect(await broker.read()).toBe(JSON.stringify(broker.operation));
    }));

    it("allows the selected installation to release custody after the Machine becomes ineligible", () => withSocketIngress(async connect => {
        const subject = await createSocketMachine();
        const broker = await createBrokerOperation(subject);
        const socket = await connect(subject.machineAuth);
        await db.machine.update({ where: { id: subject.machineId }, data: { revokedAt: new Date() } });
        expect(await retireBrokerOperation(socket, broker.request)).toEqual({ ok: true, retired: true });
        expect(await broker.read()).toBeNull();
    }));

    it("evicts the Machine socket after Account credential revocation and preserves broker custody", () => withSocketIngress(async connect => {
        const subject = await createSocketMachine();
        const broker = await createBrokerOperation(subject);
        const socket = await connect(subject.machineAuth);
        expect(await socket.timeout(5_000).emitWithAck("ping")).toEqual({});
        const disconnected = vi.fn<(reason: string) => void>();
        socket.once("disconnect", disconnected);
        expect(await inTx(tx => setAccountStatusInTx(tx, {
            actorAccountId: subject.accountId, targetAccountId: subject.accountId, status: "suspended", authority: "account_erasure",
        }))).toEqual({ status: "applied" });
        await vi.waitFor(() => expect(disconnected.mock.calls[0]?.[0]).toBe("io server disconnect"));
        await expect(connect(subject.machineAuth)).rejects.toMatchObject({ data: { statusCode: 401 } });
        expect(await broker.read()).toBe(JSON.stringify(broker.operation));
    }));

    it("rejects unverified and replaced installations before daemon-state or capability publication", () => withSocketIngress(async connect => {
        const subject = await createSocketMachine();
        const differentInstallation = await createSocketMachine(subject);
        const publishState = (socket: SocketClient, expectedVersion: number, daemonState: string) =>
            socket.timeout(5_000).emitWithAck("machine-update-state", {
                machineId: subject.machineId, daemonState, expectedVersion,
                expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            });
        const capabilities = { sessionSpawn: { protocolVersions: [1] } };
        const publishCapabilities = (socket: SocketClient, value: typeof capabilities | Record<string, never>) =>
            socket.timeout(5_000).emitWithAck(MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, {
                machineId: subject.machineId, capabilities: value,
            });
        const readPublication = () => db.machine.findUniqueOrThrow({ where: { id: subject.machineId }, select: {
            daemonState: true, daemonStateVersion: true,
            operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true,
        } });
        const initial = await readPublication();
        const running = encodePlainMachineStoredContent({ status: "running" });
        const forged = await connect({ ...subject.machineAuth, installationProof: differentInstallation.machineAuth.installationProof });
        expect(await publishState(forged, 0, running)).toMatchObject({ result: "error" });
        expect(await publishCapabilities(forged, capabilities)).toEqual({ v: 1, result: "error", code: "machine_unavailable" });
        expect(await readPublication()).toEqual(initial);
        forged.disconnect();

        const current = await connect({ ...subject.machineAuth, takeover: true });
        expect(await publishState(current, 0, running)).toEqual({ result: "success", version: 1, daemonState: running });
        expect(await publishCapabilities(current, capabilities)).toEqual({ v: 1, result: "success", revision: 1 });
        const published = await readPublication();
        expect(published).toMatchObject({ daemonState: running, daemonStateVersion: 1, operationProtocolCapabilities: capabilities });
        await db.machine.update({ where: { id: subject.machineId }, data: { installationId: randomUUID() } });
        expect(await publishState(current, 1, encodePlainMachineStoredContent({ status: "offline" }))).toMatchObject({ result: "error" });
        expect(await publishCapabilities(current, {})).toEqual({ v: 1, result: "error", code: "machine_unavailable" });
        expect(await readPublication()).toEqual(published);
    }));
});
