import { randomUUID } from "node:crypto";

import type { Socket } from "socket.io";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
    computeContentPublicKeyFingerprint,
    sealEncryptedDataKeyEnvelopeV1,
    openEncryptedDataKeyEnvelopeV1,
    encodePlainMachineStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER,
} from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1 } from "@happier-dev/protocol/teams";
import { auth } from "@/app/auth/auth";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { encodeBase64, decodeBase64 } from "privacy-kit";
import { sealSessionDataKeyBundleV0, openSessionDataKeyBundleV0 } from "@happier-dev/protocol/crypto/sessionDataKeyBundleWebCrypto";
import * as machineAccess from "@/app/machines/machineAccess";
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from "@/app/clientCompatibility/accountStoredContentCompatibility";

import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";
import { machineUpdateHandler } from "./machineUpdateHandler";
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from "./machineSocketInstallationProof";
import { withAuthenticatedTestApp } from "../testkit/sqliteFastify";
import { currentAccountStoredContentCompatibilityHeaders } from "../testkit/accountStoredContentCompatibility";
import { machinesRoutes } from "../routes/machines/machinesRoutes";
import { MachinePublishedRowV1Schema } from "@happier-dev/protocol/machines/machineContentKeyTransitionV1";

const HANDLER_OPTIONS = {
    operationSocketBatchLimits: {
        ok: true as const,
        limits: { maxItems: 200, maxSerializedBytes: 524_288 },
    },
};

const PUBLISHED_METADATA = {
    host: "policy-host", platform: "linux", happyCliVersion: "0.3.0",
    homeDir: "/home/policy", happyHomeDir: "/home/policy/.happier",
};

async function createEstablishedMachineFixture(label: string) {
    const installationId = randomUUID();
    const content = tweetnacl.box.keyPair();
    const account = await db.account.create({
        data: createSignedAccountContentBinding(content.publicKey),
        select: { id: true },
    });
    const machine = await db.machine.create({
        data: {
            id: `machine-${label}-${randomUUID()}`,
            accountId: account.id,
            metadata: "metadata-0",
            daemonState: "daemon-state-0",
            installationId,
        },
        select: { id: true },
    });
    const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });

    // The socket is already admitted: the handshake token it presented at
    // connect is the only credential an established socket carries.
    const disconnect = vi.fn();
    const socket = Object.assign(
        createFakeSocket({ data: {
            clientType: "machine-scoped", machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: installationId,
        } }),
        { handshake: { auth: { token } }, disconnect },
    );
    machineUpdateHandler(account.id, socket as unknown as Socket, HANDLER_OPTIONS);

    return { accountId: account.id, machineId: machine.id, socket, content };
}

type Fixture = Awaited<ReturnType<typeof createEstablishedMachineFixture>>;

async function attestInstallation(fixture: Fixture) {
    const installationId = randomUUID();
    await db.machine.update({ where: { id: fixture.machineId }, data: { installationId } });
    // This harness begins after the socket handshake has verified the installation proof.
    fixture.socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = installationId;
}

async function createBrokerOperation(fixture: Fixture) {
    await attestInstallation(fixture);
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

async function emit(fixture: Fixture, event: string, payload: unknown) {
    const callback = vi.fn();
    await getSocketHandler(fixture.socket, event)(payload, callback);
    return callback;
}

async function createSharedMetadataFixture() {
    const owner = await createEstablishedMachineFixture("shared-custodian");
    const manager = await createEstablishedMachineFixture("shared-manager");
    const dataKey = tweetnacl.randomBytes(32);
    const ownerEnvelope = new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
        dataKey, recipientPublicKey: owner.content.publicKey, randomBytes: tweetnacl.randomBytes,
    }));
    const originalMetadata = encodeBase64(await sealSessionDataKeyBundleV0({ finitePolicyV1: { accepting: false, runAtMost: null } }, dataKey));
    await db.machine.update({ where: { id: owner.machineId }, data: {
        dataEncryptionKey: ownerEnvelope, metadata: originalMetadata,
        daemonState: encodeBase64(await sealSessionDataKeyBundleV0({ status: "offline" }, dataKey)), active: false,
    } });
    const grant = (level: "view" | "admin") => inTx(tx => machineAccess.setMachineAccessGrantInTx(tx, {
        actorAccountId: owner.accountId, machineId: owner.machineId,
        principal: { kind: "account", accountId: manager.accountId }, level,
    }));
    expect(await grant("admin")).toMatchObject({ kind: "saved", readiness: "key_pending" });
    const census = await inTx(tx => machineAccess.readMachineRecipientCensusInTx(tx, {
        actorAccountId: owner.accountId, machineId: owner.machineId,
    }));
    if ("kind" in census) throw new Error(census.code);
    const recipientEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
        dataKey, recipientPublicKey: manager.content.publicKey, randomBytes: tweetnacl.randomBytes,
    }));
    expect(await inTx(tx => machineAccess.commitMachineRecipientKeyEnvelopesInTx(tx, {
        actorAccountId: owner.accountId, machineId: owner.machineId,
        expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!,
        expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!,
        expectedMetadataVersion: census.content.metadataVersion,
        expectedDaemonStateVersion: census.content.daemonStateVersion,
        recipientKeyEnvelopes: [{ recipientAccountId: manager.accountId, encryptedDataKey: recipientEnvelope,
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(manager.content.publicKey) }],
    }))).toMatchObject({ appliedRecipientAccountIds: [manager.accountId] });
    const openedKey = openEncryptedDataKeyEnvelopeV1({
        envelope: decodeBase64(recipientEnvelope), recipientSecretKeyOrSeed: manager.content.secretKey,
    });
    expect(openedKey).toEqual(dataKey);
    manager.socket.data!.clientType = "user-scoped";
    const metadata = encodeBase64(await sealSessionDataKeyBundleV0({ finitePolicyV1: { accepting: true, runAtMost: null } }, openedKey!));
    let expectedDataEncryptionKey = encodeBase64(ownerEnvelope);
    await withAuthenticatedTestApp(machinesRoutes, async app => {
        const response = await app.inject({ method: "GET", url: `/v1/machines/${owner.machineId}`, headers: { "x-test-user-id": manager.accountId } });
        expect(response.statusCode).toBe(200);
        const published = MachinePublishedRowV1Schema.parse(response.json().machine);
        expect(published.dataEncryptionKey).toBe(recipientEnvelope);
        expect(published.keyBasis).toEqual({ dataEncryptionKey: encodeBase64(ownerEnvelope), metadataVersion: 0, daemonStateVersion: 0 });
        if (!published.keyBasis || published.keyBasis.dataEncryptionKey === null) throw new Error("Missing canonical Machine key basis");
        expectedDataEncryptionKey = published.keyBasis.dataEncryptionKey;
    });
    return { owner, manager, grant, dataKey, originalMetadata, metadata, recipientEnvelope,
        request: { machineId: owner.machineId, metadata, expectedVersion: 0, expectedDataEncryptionKey } };
}

async function suspend(fixture: Fixture) {
    // The eager eviction leg is stubbed to a no-op: this is exactly the state a
    // lost cross-node disconnect publication leaves behind, and the only state
    // this guard exists for.
    const eviction = vi.spyOn(eventRouter, "disconnectAccountSockets").mockImplementation(() => {});
    const applied = await inTx(async (tx) => await setAccountStatusInTx(tx, {
        actorAccountId: fixture.accountId,
        targetAccountId: fixture.accountId,
        status: "suspended",
        authority: "account_erasure",
    }));
    expect(applied).toEqual({ status: "applied" });
    expect(eviction).toHaveBeenCalledWith(fixture.accountId);
}

describe("Machine authority mutations on an established socket", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-machine-update-currentness-",
            // A Machine mutation must not need a second pool connection while its transaction is open.
            sqliteConnectionLimit: 1,
            initAuth: true,
            env: {
                HANDY_MASTER_SECRET: "machine-update-currentness-secret",
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
    }, 120_000);

    afterEach(async () => {
        vi.restoreAllMocks();
        harness.resetEnv({
            HANDY_MASTER_SECRET: "machine-update-currentness-secret",
            AUTH_REQUIRED_LOGIN_PROVIDERS: "",
        });
        await db.teamCredentialExternalApiKey.deleteMany();
        await db.team.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("retires only the exact authenticated Machine operation and leaves a newer operation intact on stale replay", async () => {
        const subject = await createEstablishedMachineFixture("retire");
        const broker = await createBrokerOperation(subject);
        const retire = () => emit(subject, TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, broker.request);
        expect(await retire()).toHaveBeenCalledWith({ ok: true, retired: true });
        expect(await broker.read()).toBeNull();
        expect(await retire()).toHaveBeenCalledWith({ ok: true, retired: false });
        const newer = JSON.stringify({ ...broker.operation, operationId: randomUUID() });
        await db.teamCredentialExternalApiKey.update({ where: { id: broker.keyId }, data: { currentBrokerOperationJson: newer } });
        expect(await retire()).toHaveBeenCalledWith({ ok: true, retired: false });
        expect(await broker.read()).toBe(newer);
    });

    it("denies another Account and another Machine in the custodian Account", async () => {
        const subject = await createEstablishedMachineFixture("retire-owner");
        const broker = await createBrokerOperation(subject);
        const foreign = await createEstablishedMachineFixture("retire-foreign");
        await attestInstallation(foreign);
        expect(await emit(foreign, TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, broker.request))
            .toHaveBeenCalledWith({ ok: false, reasonCode: "resource_forbidden" });
        const otherMachine = await db.machine.create({ data: {
            id: randomUUID(), accountId: subject.accountId, metadata: "{}", installationId: randomUUID(),
        } });
        subject.socket.data!.machineId = otherMachine.id;
        subject.socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = otherMachine.installationId;
        expect(await emit(subject, TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, broker.request))
            .toHaveBeenCalledWith({ ok: false, reasonCode: "resource_forbidden" });
        expect(await broker.read()).toBe(JSON.stringify(broker.operation));
    });

    it("rejects body identity spoofing, unverified installations and replaced installation identity", async () => {
        const subject = await createEstablishedMachineFixture("retire-proof");
        const broker = await createBrokerOperation(subject);
        const event = TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1;
        expect(await emit(subject, event, { ...broker.request, machineId: subject.machineId }))
            .toHaveBeenCalledWith({ ok: false, reasonCode: "invalid_request" });
        subject.socket.data!.clientType = "user-scoped";
        expect(await emit(subject, event, broker.request))
            .toHaveBeenCalledWith({ ok: false, reasonCode: "resource_forbidden" });
        subject.socket.data!.clientType = "machine-scoped";
        const installationId = subject.socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY];
        delete subject.socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY];
        expect(await emit(subject, event, broker.request))
            .toHaveBeenCalledWith({ ok: false, reasonCode: "resource_forbidden" });
        subject.socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = installationId;
        await db.machine.update({ where: { id: subject.machineId }, data: { installationId: randomUUID() } });
        expect(await emit(subject, event, broker.request))
            .toHaveBeenCalledWith({ ok: false, reasonCode: "resource_forbidden" });
        expect(await broker.read()).toBe(JSON.stringify(broker.operation));
    });

    it("allows the selected installation to release custody after the Machine becomes ineligible", async () => {
        const subject = await createEstablishedMachineFixture("retire-ineligible");
        const broker = await createBrokerOperation(subject);
        await db.machine.update({ where: { id: subject.machineId }, data: { revokedAt: new Date() } });
        expect(await emit(subject, TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, broker.request))
            .toHaveBeenCalledWith({ ok: true, retired: true });
        expect(await broker.read()).toBeNull();
    });

    it("preserves custody when an established socket outlives Account credential revocation", async () => {
        const subject = await createEstablishedMachineFixture("retire-revoked");
        const broker = await createBrokerOperation(subject);
        await suspend(subject);
        expect(await emit(subject, TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, broker.request))
            .toHaveBeenCalledWith({ ok: false, reasonCode: "resource_forbidden" });
        expect(await broker.read()).toBe(JSON.stringify(broker.operation));
    });

    it("refuses a daemon-state write and disconnects when the Account credential is no longer current", async () => {
        const subject = await createEstablishedMachineFixture("state");
        const control = await createEstablishedMachineFixture("state-control");

        const admitted = await emit(subject, "machine-update-state", {
            machineId: subject.machineId,
            daemonState: "daemon-state-1",
            expectedVersion: 0,
            expectedDataEncryptionKey: null,
        });
        expect(admitted).toHaveBeenCalledWith(expect.objectContaining({ result: "success", version: 1 }));

        await suspend(subject);

        const refused = await emit(subject, "machine-update-state", {
            machineId: subject.machineId,
            daemonState: "daemon-state-2",
            expectedVersion: 1,
            expectedDataEncryptionKey: null,
        });
        expect(refused).toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        expect(subject.socket.disconnect).toHaveBeenCalledWith(true);

        const stored = await db.machine.findUnique({
            where: { id: subject.machineId },
            select: { daemonState: true, daemonStateVersion: true },
        });
        expect(stored).toEqual({ daemonState: "daemon-state-1", daemonStateVersion: 1 });

        const unaffected = await emit(control, "machine-update-state", {
            machineId: control.machineId,
            daemonState: "daemon-state-1",
            expectedVersion: 0,
            expectedDataEncryptionKey: null,
        });
        expect(unaffected).toHaveBeenCalledWith(expect.objectContaining({ result: "success", version: 1 }));
        expect(control.socket.disconnect).not.toHaveBeenCalled();
    });

    it("rejects unverified and replaced installations before daemon-state or capability publication", async () => {
        const subject = await createEstablishedMachineFixture("publication-installation");
        const publish = async () => {
            expect(await emit(subject, "machine-update-state", {
                machineId: subject.machineId, daemonState: "spoofed-state", expectedVersion: 0,
                expectedDataEncryptionKey: null,
            })).toHaveBeenCalledWith(expect.objectContaining({ result: "error" }));
            expect(await emit(subject, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, {
                machineId: subject.machineId, capabilities: { sessionSpawn: { protocolVersions: [1] } },
            })).toHaveBeenCalledWith({ v: 1, result: "error", code: "machine_unavailable" });
            expect(await db.machine.findUniqueOrThrow({ where: { id: subject.machineId } })).toMatchObject({
                daemonState: "daemon-state-0", daemonStateVersion: 0,
                operationProtocolCapabilities: null, operationProtocolCapabilitiesRevision: null,
            });
        };
        const installationId = subject.socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY];
        delete subject.socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY];
        await publish();
        subject.socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = installationId;
        await db.machine.update({ where: { id: subject.machineId }, data: { installationId: randomUUID() } });
        await publish();
    });

    it("replaces the complete capability projection, withdraws omitted leaves and rejects unknown fields", async () => {
        const subject = await createEstablishedMachineFixture("capability-projection");
        const event = MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1;
        const capabilities = { sessionSpawn: { protocolVersions: [1] } };
        expect(await emit(subject, event, { machineId: subject.machineId, capabilities }))
            .toHaveBeenCalledWith({ v: 1, result: "success", revision: 1 });
        expect(await db.machine.findUniqueOrThrow({ where: { id: subject.machineId } })).toMatchObject({
            operationProtocolCapabilities: capabilities, operationProtocolCapabilitiesRevision: 1,
        });
        expect(await emit(subject, event, { capabilities: {} }))
            .toHaveBeenCalledWith({ v: 1, result: "success", revision: 2 });
        expect(await emit(subject, event, {
            capabilities: { sessionSpawn: { protocolVersions: [1], stale: true } },
        })).toHaveBeenCalledWith({ v: 1, result: "error", code: "invalid_request" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: subject.machineId } })).toMatchObject({
            operationProtocolCapabilities: {}, operationProtocolCapabilitiesRevision: 2,
        });
    });

    it.each([
        { revokedAt: new Date(1) },
        { replacedByMachineId: "replacement-machine" },
    ])("preserves the prior capability projection when the Machine becomes unavailable ($revokedAt $replacedByMachineId)", async (unavailable) => {
        const subject = await createEstablishedMachineFixture("capability-unavailable");
        await db.machine.update({ where: { id: subject.machineId }, data: {
            ...unavailable,
            operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 7,
        } });
        expect(await emit(subject, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, { capabilities: {} }))
            .toHaveBeenCalledWith({ v: 1, result: "error", code: "machine_unavailable" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: subject.machineId } })).toMatchObject({
            operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 7,
        });
    });

    it("refuses a metadata write and disconnects when the Account credential is no longer current", async () => {
        const subject = await createEstablishedMachineFixture("metadata");

        const admitted = await emit(subject, "machine-update-metadata", {
            machineId: subject.machineId,
            metadata: "metadata-1",
            expectedVersion: 0,
            expectedDataEncryptionKey: null,
        });
        expect(admitted).toHaveBeenCalledWith(expect.objectContaining({ result: "success", version: 1 }));

        await suspend(subject);

        const refused = await emit(subject, "machine-update-metadata", {
            machineId: subject.machineId,
            metadata: "metadata-2",
            expectedVersion: 1,
            expectedDataEncryptionKey: null,
        });
        expect(refused).toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        expect(subject.socket.disconnect).toHaveBeenCalledWith(true);

        const stored = await db.machine.findUnique({
            where: { id: subject.machineId },
            select: { metadata: true, metadataVersion: true },
        });
        expect(stored).toEqual({ metadata: "metadata-1", metadataVersion: 1 });
    });

    it("admits a legacy owner's user-scoped metadata edit without making that row RPC-installation-ready", async () => {
        const subject = await createEstablishedMachineFixture("legacy-metadata");
        subject.socket.data!.clientType = "user-scoped";
        await db.machine.update({ where: { id: subject.machineId }, data: { installationId: null } });
        expect(await emit(subject, "machine-update-metadata", {
            machineId: subject.machineId, metadata: "legacy-updated", expectedVersion: 0, expectedDataEncryptionKey: null,
        })).toHaveBeenCalledWith({ result: "success", metadata: "legacy-updated", version: 1 });
        expect(await machineAccess.resolveMachineAdmission({ actorAccountId: subject.accountId, machineId: subject.machineId }))
            .toEqual({ kind: "denied", code: "machine_unavailable" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: subject.machineId } })).toMatchObject({ installationId: null, metadata: "legacy-updated", metadataVersion: 1 });
    });

    it("admits offline Manage metadata with its published owner basis, while Use cannot change encrypted policy", async () => {
        const f = await createSharedMetadataFixture();
        await f.grant("view");
        expect(await emit(f.manager, "machine-update-metadata", f.request))
            .toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: f.owner.machineId } })).toMatchObject({
            metadata: f.originalMetadata, metadataVersion: 0,
        });
        await f.grant("admin");
        expect(await emit(f.manager, "machine-update-metadata", { ...f.request, expectedDataEncryptionKey: f.recipientEnvelope }))
            .toHaveBeenCalledWith({ result: "key-mismatch" });
        const ownerCursor = (await db.account.findUniqueOrThrow({ where: { id: f.owner.accountId } })).seq;
        const managerCursor = (await db.account.findUniqueOrThrow({ where: { id: f.manager.accountId } })).seq;
        const published = vi.spyOn(eventRouter, "emitUpdate");
        expect(await emit(f.manager, "machine-update-metadata", f.request))
            .toHaveBeenCalledWith({ result: "success", version: 1, metadata: f.metadata });
        const stored = await db.machine.findUniqueOrThrow({ where: { id: f.owner.machineId } });
        expect(await openSessionDataKeyBundleV0(decodeBase64(stored.metadata), f.dataKey))
            .toEqual({ status: "authenticated", value: { finitePolicyV1: { accepting: true, runAtMost: null } } });
        expect(stored.metadataVersion).toBe(1);
        expect(stored.active).toBe(false);
        expect(published.mock.calls.map(([event]) => event.payload.body).filter(body => body.t === "update-machine")).toEqual([
            expect.objectContaining({ keyBasis: { dataEncryptionKey: f.request.expectedDataEncryptionKey, metadataVersion: 1, daemonStateVersion: 0 } }),
            expect.objectContaining({ keyBasis: { dataEncryptionKey: f.request.expectedDataEncryptionKey, metadataVersion: 1, daemonStateVersion: 0 } }),
        ]);
        expect((await db.account.findUniqueOrThrow({ where: { id: f.owner.accountId } })).seq).toBeGreaterThan(ownerCursor);
        expect((await db.account.findUniqueOrThrow({ where: { id: f.manager.accountId } })).seq).toBeGreaterThan(managerCursor);
    });

    it.each(["user-scoped", undefined] as const)("keeps %s metadata ingress and publishes the committed cursor", async (clientType) => {
        const subject = await createEstablishedMachineFixture("metadata-scope");
        subject.socket.data!.clientType = clientType;
        // Socket publication is the network boundary; keep the real cursor and builder.
        const published = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        const request = { machineId: subject.machineId, metadata: "metadata-1", expectedVersion: 0, expectedDataEncryptionKey: null };
        expect(await emit(subject, "machine-update-metadata", { ...request, unexpectedAuthority: true }))
            .toHaveBeenCalledWith({ result: "error", message: "Invalid parameters" });
        expect(await emit(subject, "machine-update-metadata", request))
            .toHaveBeenCalledWith({ result: "success", version: 1, metadata: "metadata-1" });
        const account = await db.account.findUniqueOrThrow({ where: { id: subject.accountId } });
        expect(published).toHaveBeenCalledWith(expect.objectContaining({
            userId: subject.accountId,
            payload: expect.objectContaining({ seq: account.seq, body: expect.objectContaining({
                t: "update-machine", machineId: subject.machineId, metadata: { value: "metadata-1", version: 1 },
            }) }),
        }));
    });

    it("publishes committed daemon state, cursor and browser freshness from the current custodian installation", async () => {
        const subject = await createEstablishedMachineFixture("state-projection");
        const published = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        expect(await emit(subject, "machine-update-state", {
            machineId: subject.machineId, daemonState: "daemon-state-1", expectedVersion: 0, expectedDataEncryptionKey: null,
        })).toHaveBeenCalledWith({ result: "success", version: 1, daemonState: "daemon-state-1" });
        const machine = await db.machine.findUniqueOrThrow({ where: { id: subject.machineId } });
        const account = await db.account.findUniqueOrThrow({ where: { id: subject.accountId } });
        expect(machine).toMatchObject({ active: true, daemonState: "daemon-state-1", daemonStateVersion: 1 });
        expect(published).toHaveBeenCalledWith(expect.objectContaining({
            userId: subject.accountId,
            payload: expect.objectContaining({ seq: account.seq, body: expect.objectContaining({
                t: "update-machine", machineId: subject.machineId,
                keyBasis: { dataEncryptionKey: null, metadataVersion: 0, daemonStateVersion: 1 },
                daemonState: { value: "daemon-state-1", version: 1 }, active: true, activeAt: machine.lastActiveAt.getTime(),
            }) }),
        }));
    });

    it.each(["metadata", "state"] as const)("rejects the actual predecessor %s publisher shape without a write basis", async (field) => {
        const subject = await createEstablishedMachineFixture("predecessor-write");
        const dataKey = tweetnacl.randomBytes(32);
        const dataEncryptionKey = new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: subject.content.publicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const metadata = encodeBase64(await sealSessionDataKeyBundleV0(PUBLISHED_METADATA, dataKey));
        const daemonState = encodeBase64(await sealSessionDataKeyBundleV0({ status: "offline" }, dataKey));
        await db.machine.update({ where: { id: subject.machineId }, data: { metadata, daemonState, dataEncryptionKey } });
        expect(await machineAccess.resolveMachineAdmission({ actorAccountId: subject.accountId, machineId: subject.machineId }))
            .toMatchObject({ kind: "admitted", custodianAccountId: subject.accountId });
        const oldPublisherContent = encodeBase64(await sealSessionDataKeyBundleV0(field === "metadata"
            ? { ...PUBLISHED_METADATA, privateWork: { token: "old-private-value" } }
            : { status: "running", credentialSlots: { token: "old-private-value" } }, dataKey));
        const account = await db.account.findUniqueOrThrow({ where: { id: subject.accountId } });
        const published = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        // Clean ../0.2 HEAD 37a6541578749067b49d4579be8c752c9591b8c8
        // apiMachine publishers send only machineId, content and expectedVersion.
        expect(await emit(subject, `machine-update-${field}`, {
            machineId: subject.machineId, [field === "metadata" ? "metadata" : "daemonState"]: oldPublisherContent,
            expectedVersion: 0,
        })).toHaveBeenCalledWith({ result: "error", message: "Invalid parameters" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: subject.machineId } })).toMatchObject({
            metadata, metadataVersion: 0, daemonState, daemonStateVersion: 0,
        });
        expect((await db.account.findUniqueOrThrow({ where: { id: subject.accountId } })).seq).toBe(account.seq);
        expect(published).not.toHaveBeenCalled();
    });

    it.each(["metadata", "state"] as const)("preserves marked Plain %s upgrade and mode refusal", async (field) => {
        const subject = await createEstablishedMachineFixture("plain-upgrade");
        await db.account.update({ where: { id: subject.accountId }, data: {
            encryptionMode: "plain", publicKey: null, contentPublicKey: null, contentPublicKeySig: null,
        } });
        const metadata = encodePlainMachineStoredContent({ ...PUBLISHED_METADATA, host: "plain-host" });
        const daemonState = encodePlainMachineStoredContent({ status: "offline" });
        await db.machine.update({ where: { id: subject.machineId }, data: {
            metadata, daemonState, dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
        const request = { machineId: subject.machineId, [field === "metadata" ? "metadata" : "daemonState"]: field === "metadata" ? metadata : daemonState,
            expectedVersion: 0, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER };
        expect(await emit(subject, `machine-update-${field}`, request)).toHaveBeenCalledWith({
            error: "client-upgrade-required", requirement: { v: 1, kind: "account-stored-content", minimumProtocolVersion: 2 },
        });
        writeAccountStoredContentCompatibilityForSocket(subject.socket as unknown as Socket,
            evaluateAccountStoredContentSocketCompatibility({ accountStoredContentCompatibility: { v: 1, protocolVersion: 4 } }));
        expect(await emit(subject, `machine-update-${field}`, { ...request, [field === "metadata" ? "metadata" : "daemonState"]: "opaque-encrypted-bytes" }))
            .toHaveBeenCalledWith({ result: "error", message: "Invalid parameters" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: subject.machineId } })).toMatchObject({
            metadata, metadataVersion: 0, daemonState, daemonStateVersion: 0,
        });
        expect(await emit(subject, `machine-update-${field}`, request)).toHaveBeenCalledWith(expect.objectContaining({ result: "success", version: 1 }));
    });

    it("leaves metadata and publication unchanged for revoked or deleted Machines", async () => {
        const subject = await createEstablishedMachineFixture("metadata-unavailable");
        const published = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        const account = await db.account.findUniqueOrThrow({ where: { id: subject.accountId } });
        const request = { machineId: subject.machineId, metadata: "metadata-1", expectedVersion: 0, expectedDataEncryptionKey: null };
        await db.machine.update({ where: { id: subject.machineId }, data: { revokedAt: new Date(1) } });
        expect(await emit(subject, "machine-update-metadata", request)).toHaveBeenCalledWith(expect.objectContaining({ result: "error" }));
        expect(await db.machine.findUniqueOrThrow({ where: { id: subject.machineId } })).toMatchObject({ metadata: "metadata-0", metadataVersion: 0 });
        await db.machine.delete({ where: { id: subject.machineId } });
        expect(await emit(subject, "machine-update-metadata", request)).toHaveBeenCalledWith(expect.objectContaining({ result: "error" }));
        expect((await db.account.findUniqueOrThrow({ where: { id: subject.accountId } })).seq).toBe(account.seq);
        expect(published).not.toHaveBeenCalled();
    });

    it("does not treat Manage or a held current DEK as custodian installation publication authority", async () => {
        const f = await createSharedMetadataFixture();
        f.manager.socket.data!.clientType = "machine-scoped";
        f.manager.socket.data!.machineId = f.owner.machineId;
        f.manager.socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] =
            f.owner.socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY];
        const state = (await db.machine.findUniqueOrThrow({ where: { id: f.owner.machineId } })).daemonState;
        expect(await emit(f.manager, "machine-update-state", {
            machineId: f.owner.machineId, daemonState: f.metadata, expectedVersion: 0,
            expectedDataEncryptionKey: f.recipientEnvelope,
        })).toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        expect(await emit(f.manager, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, { capabilities: {} }))
            .toHaveBeenCalledWith({ v: 1, result: "error", code: "machine_unavailable" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: f.owner.machineId } })).toMatchObject({
            daemonState: state, daemonStateVersion: 0, operationProtocolCapabilitiesRevision: null,
        });
    });

    it("retires recipient readiness and wakes its current row after an owner content-key transition", async () => {
        const f = await createSharedMetadataFixture();
        const beforeCursor = (await db.account.findUniqueOrThrow({ where: { id: f.manager.accountId } })).seq;
        const nextKey = tweetnacl.randomBytes(32);
        const next = {
            dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: nextKey, recipientPublicKey: f.owner.content.publicKey, randomBytes: tweetnacl.randomBytes })),
            metadata: encodeBase64(await sealSessionDataKeyBundleV0({ finitePolicyV1: { accepting: false, runAtMost: null } }, nextKey)),
            daemonState: encodeBase64(await sealSessionDataKeyBundleV0({ status: "offline" }, nextKey)),
        };
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const result = await app.inject({ method: "POST", url: `/v1/machines/${f.owner.machineId}/content-key/transition`, headers: { "x-test-user-id": f.owner.accountId }, payload: {
                machineId: f.owner.machineId, expected: { dataEncryptionKey: f.request.expectedDataEncryptionKey, metadataVersion: 0, daemonStateVersion: 0 }, next,
            } });
            expect(result.statusCode).toBe(200);
            expect(result.json().kind).toBe("committed");
        });
        expect((await db.account.findUniqueOrThrow({ where: { id: f.manager.accountId } })).seq).toBeGreaterThan(beforeCursor);
        expect(await inTx(tx => machineAccess.readAccessibleMachineAccessInTx(tx, { actorAccountId: f.manager.accountId, machineId: f.owner.machineId })))
            .toMatchObject({ accessState: "key_pending" });
        expect(await emit(f.manager, "machine-update-metadata", { ...f.request, expectedVersion: 1 }))
            .toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: f.owner.machineId } })).toMatchObject({ ...next, dataEncryptionKey: new Uint8Array(decodeBase64(next.dataEncryptionKey)), metadataVersion: 1, daemonStateVersion: 1 });
    });

    it.each(["metadata", "state"] as const)("rejects unsafe whole Plain %s before shared publication", async (field) => {
        const owner = await createEstablishedMachineFixture("plain-safe-owner");
        const recipient = await createEstablishedMachineFixture("plain-safe-recipient");
        await db.account.update({ where: { id: owner.accountId }, data: {
            encryptionMode: "plain", publicKey: null, contentPublicKey: null, contentPublicKeySig: null,
        } });
        const metadata = encodePlainMachineStoredContent(PUBLISHED_METADATA);
        const daemonState = encodePlainMachineStoredContent({ status: "offline" });
        await db.machine.update({ where: { id: owner.machineId }, data: {
            metadata, daemonState, dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), active: false,
        } });
        expect(await inTx(tx => machineAccess.setMachineAccessGrantInTx(tx, {
            actorAccountId: owner.accountId, machineId: owner.machineId,
            principal: { kind: "account", accountId: recipient.accountId }, level: "admin",
        }))).toMatchObject({ kind: "saved", readiness: "ready" });
        for (const fixture of [owner, recipient]) {
            writeAccountStoredContentCompatibilityForSocket(fixture.socket as unknown as Socket,
                evaluateAccountStoredContentSocketCompatibility({ accountStoredContentCompatibility: { v: 1, protocolVersion: 4 } }));
        }
        recipient.socket.data!.clientType = "user-scoped";
        const actor = field === "metadata" ? recipient : owner;
        const unsafe = encodePlainMachineStoredContent(field === "metadata"
            ? { ...PUBLISHED_METADATA, privateWork: { token: "private-value" } }
            : { status: "running", credentialSlots: { token: "private-value" } });
        const cursors = await Promise.all([owner, recipient].map(f => db.account.findUniqueOrThrow({ where: { id: f.accountId } })));
        const published = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        expect(await emit(actor, `machine-update-${field}`, {
            machineId: owner.machineId, [field === "metadata" ? "metadata" : "daemonState"]: unsafe,
            expectedVersion: 0, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        })).toHaveBeenCalledWith({ result: "error", message: "Invalid parameters" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: owner.machineId } })).toMatchObject({
            metadata, metadataVersion: 0, daemonState, daemonStateVersion: 0, active: false,
        });
        for (const account of cursors) expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(account.seq);
        expect(published).not.toHaveBeenCalled();
    });

    it("admits offline shared Plain Manage without client keys using the opaque owner write basis", async () => {
        const owner = await createEstablishedMachineFixture("shared-plain-owner");
        const manager = await createEstablishedMachineFixture("shared-plain-manager");
        for (const accountId of [owner.accountId, manager.accountId]) {
            await db.account.update({ where: { id: accountId }, data: {
                encryptionMode: "plain", publicKey: null, contentPublicKey: null, contentPublicKeySig: null,
            } });
        }
        const originalMetadata = encodePlainMachineStoredContent({ ...PUBLISHED_METADATA, finitePolicyV1: { accepting: false, runAtMost: null } });
        const metadata = encodePlainMachineStoredContent({ ...PUBLISHED_METADATA, finitePolicyV1: { accepting: true, runAtMost: null } });
        await db.machine.update({ where: { id: owner.machineId }, data: {
            metadata: originalMetadata, daemonState: encodePlainMachineStoredContent({ status: "offline" }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), active: false,
        } });
        expect(await inTx(tx => machineAccess.setMachineAccessGrantInTx(tx, {
            actorAccountId: owner.accountId, machineId: owner.machineId,
            principal: { kind: "account", accountId: manager.accountId }, level: "admin",
        }))).toMatchObject({ kind: "saved", readiness: "ready" });
        manager.socket.data!.clientType = "user-scoped";
        writeAccountStoredContentCompatibilityForSocket(manager.socket as unknown as Socket,
            evaluateAccountStoredContentSocketCompatibility({ accountStoredContentCompatibility: { v: 1, protocolVersion: 4 } }));
        let expectedDataEncryptionKey = MACHINE_PLAIN_DATA_KEY_MARKER;
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const response = await app.inject({ method: "GET", url: `/v1/machines/${owner.machineId}`, headers: { "x-test-user-id": manager.accountId, ...currentAccountStoredContentCompatibilityHeaders } });
            expect(response.statusCode).toBe(200);
            const published = MachinePublishedRowV1Schema.parse(response.json().machine);
            expect(published.dataEncryptionKey).toBeNull();
            expect(published.keyBasis).toEqual({ dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadataVersion: 0, daemonStateVersion: 0 });
            if (!published.keyBasis || published.keyBasis.dataEncryptionKey === null) throw new Error("Missing canonical Plain Machine key basis");
            expectedDataEncryptionKey = published.keyBasis.dataEncryptionKey;
        });
        const request = { machineId: owner.machineId, metadata, expectedVersion: 0, expectedDataEncryptionKey };
        expect(await emit(manager, "machine-update-metadata", { ...request, expectedDataEncryptionKey: null }))
            .toHaveBeenCalledWith({ result: "key-mismatch" });
        expect(await emit(manager, "machine-update-metadata", request))
            .toHaveBeenCalledWith({ result: "success", version: 1, metadata });
        expect(await db.machine.findUniqueOrThrow({ where: { id: owner.machineId } })).toMatchObject({
            metadata, metadataVersion: 1, active: false, dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        });
    });

    it("rechecks downgraded/revoked Manage and current envelope/version before changing content", async () => {
        const f = await createSharedMetadataFixture();
        expect(await emit(f.manager, "machine-update-metadata", { ...f.request, expectedVersion: 1 }))
            .toHaveBeenCalledWith({ result: "version-mismatch", version: 0, metadata: f.originalMetadata });
        await f.grant("view");
        expect(await emit(f.manager, "machine-update-metadata", f.request))
            .toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        await f.grant("admin");
        await inTx(tx => machineAccess.removeMachineAccessGrantInTx(tx, {
            actorAccountId: f.owner.accountId, machineId: f.owner.machineId,
            principal: { kind: "account", accountId: f.manager.accountId },
        }));
        expect(await emit(f.manager, "machine-update-metadata", f.request))
            .toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        await f.grant("admin");
        await db.machine.update({ where: { id: f.owner.machineId }, data: {
            dataEncryptionKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
                dataKey: tweetnacl.randomBytes(32), recipientPublicKey: f.owner.content.publicKey, randomBytes: tweetnacl.randomBytes,
            })),
        } });
        expect(await emit(f.manager, "machine-update-metadata", f.request))
            .toHaveBeenCalledWith({ result: "error", message: "Forbidden" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: f.owner.machineId } })).toMatchObject({
            metadata: f.originalMetadata, metadataVersion: 0,
        });
    });

    it.each(["metadata", "state"] as const)("rejects %s ciphertext encoded with a retired envelope even after the writer refreshes content revisions", async (field) => {
        const subject = await createEstablishedMachineFixture("key-currentness");
        await attestInstallation(subject);
        const retiredKey = tweetnacl.randomBytes(32);
        const currentKey = tweetnacl.randomBytes(32);
        const envelope = (key: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey: key, recipientPublicKey: subject.content.publicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const retiredEnvelope = encodeBase64(envelope(retiredKey));
        const currentEnvelope = envelope(currentKey);
        const metadata = encodeBase64(await sealSessionDataKeyBundleV0({ host: "current-host" }, currentKey));
        const daemonState = encodeBase64(await sealSessionDataKeyBundleV0({ status: "running" }, currentKey));
        const retiredContent = encodeBase64(await sealSessionDataKeyBundleV0({ stale: true }, retiredKey));
        await db.machine.update({ where: { id: subject.machineId }, data: {
            dataEncryptionKey: currentEnvelope, metadata, metadataVersion: 3,
            daemonState, daemonStateVersion: 4,
        } });
        if (field === "metadata") expect(await emit(subject, "machine-update-metadata", {
            machineId: subject.machineId, metadata: retiredContent, expectedVersion: 3, expectedDataEncryptionKey: retiredEnvelope,
        })).toHaveBeenCalledWith({ result: "key-mismatch" });
        else expect(await emit(subject, "machine-update-state", {
            machineId: subject.machineId, daemonState: retiredContent, expectedVersion: 4, expectedDataEncryptionKey: retiredEnvelope,
        })).toHaveBeenCalledWith({ result: "key-mismatch" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: subject.machineId } })).toMatchObject({
            metadata, metadataVersion: 3, daemonState, daemonStateVersion: 4,
        });
        const nextContent = encodeBase64(await sealSessionDataKeyBundleV0({ current: true }, currentKey));
        expect(await emit(subject, `machine-update-${field}`, {
            machineId: subject.machineId, [field === "metadata" ? "metadata" : "daemonState"]: nextContent,
            expectedVersion: field === "metadata" ? 3 : 4, expectedDataEncryptionKey: encodeBase64(currentEnvelope),
        })).toHaveBeenCalledWith(expect.objectContaining({ result: "success" }));
        const stored = await db.machine.findUniqueOrThrow({ where: { id: subject.machineId } });
        expect(await openSessionDataKeyBundleV0(decodeBase64(field === "metadata" ? stored.metadata : stored.daemonState!), currentKey))
            .toEqual({ status: "authenticated", value: { current: true } });
    });

    it("uses the exact Plain marker identity without requiring any client Account encryption material", async () => {
        const subject = await createEstablishedMachineFixture("plain-keyless");
        await db.account.update({ where: { id: subject.accountId }, data: {
            encryptionMode: "plain", publicKey: null, contentPublicKey: null, contentPublicKeySig: null,
        } });
        const metadata = encodePlainMachineStoredContent({ ...PUBLISHED_METADATA, host: "plain-host", finitePolicyV1: { accepting: false, runAtMost: 2 } });
        // A stored predecessor envelope may carry additive fields; this state-only
        // mutation must not re-admit unchanged metadata as a new strict write.
        const storedMetadata = encodeBase64(new TextEncoder().encode(JSON.stringify({
            ...JSON.parse(new TextDecoder().decode(decodeBase64(metadata))), futureEnvelopeField: true,
        })));
        const daemonState = encodePlainMachineStoredContent({ status: "running" });
        await db.machine.update({ where: { id: subject.machineId }, data: {
            metadata: storedMetadata, daemonState, dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
        writeAccountStoredContentCompatibilityForSocket(subject.socket as unknown as Socket,
            evaluateAccountStoredContentSocketCompatibility({ accountStoredContentCompatibility: { v: 1, protocolVersion: 4 } }));
        expect(await emit(subject, "machine-update-state", { machineId: subject.machineId, daemonState, expectedVersion: 0, expectedDataEncryptionKey: null }))
            .toHaveBeenCalledWith({ result: "key-mismatch" });
        expect(await emit(subject, "machine-update-state", { machineId: subject.machineId, daemonState, expectedVersion: 0, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }))
            .toHaveBeenCalledWith({ result: "success", version: 1, daemonState });
        expect(await emit(subject, "machine-update-metadata", { machineId: subject.machineId, metadata, expectedVersion: 0, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }))
            .toHaveBeenCalledWith({ result: "success", version: 1, metadata });
        await db.account.update({ where: { id: subject.accountId }, data: { encryptionMode: "e2ee" } });
        expect(await emit(subject, "machine-update-state", { machineId: subject.machineId, daemonState, expectedVersion: 1, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }))
            .toHaveBeenCalledWith(expect.objectContaining({ result: "error" }));
        expect(await db.machine.findUniqueOrThrow({ where: { id: subject.machineId } })).toMatchObject({ daemonState, daemonStateVersion: 1 });
    });

    it("refuses an operation-capability projection and disconnects when the Account credential is no longer current", async () => {
        const subject = await createEstablishedMachineFixture("capabilities");

        const admitted = await emit(subject, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, {
            machineId: subject.machineId,
            capabilities: { sessionSpawn: { protocolVersions: [1] } },
        });
        expect(admitted).toHaveBeenCalledWith(expect.objectContaining({ v: 1, result: "success", revision: 1 }));

        await suspend(subject);

        const refused = await emit(subject, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, {
            machineId: subject.machineId,
            capabilities: { sessionSpawn: { protocolVersions: [1] }, pluginWebhookClaim: { protocolVersions: [1] } },
        });
        expect(refused).toHaveBeenCalledWith({ v: 1, result: "error", code: "machine_unavailable" });
        expect(subject.socket.disconnect).toHaveBeenCalledWith(true);

        const stored = await db.machine.findUnique({
            where: { id: subject.machineId },
            select: { operationProtocolCapabilitiesRevision: true },
        });
        expect(stored?.operationProtocolCapabilitiesRevision).toBe(1);
    });
});
