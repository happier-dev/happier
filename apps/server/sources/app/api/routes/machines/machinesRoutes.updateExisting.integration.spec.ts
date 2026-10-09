import { randomBytes, randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1";
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { encryptWithDataKey, decryptWithDataKey } from "../../../../../../cli/src/api/encryption";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { machinesRoutes } from "./machinesRoutes";

describe("machinesRoutes canonical repeated registration (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-registration-", initAuth: false });
    }, 120_000);
    afterEach(async () => {
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });
    afterAll(async () => { if (harness) await harness.close(); });

    it("returns the winning envelope and matching ciphertexts without replacing user edits with a distinct proposal", async () => {
        const recipient = tweetnacl.box.keyPair();
        const binding = createSignedAccountContentBinding(recipient.publicKey);
        const account = await db.account.create({ data: { ...binding, encryptionMode: "e2ee" } });
        const winningKey = randomBytes(32);
        const proposedKey = randomBytes(32);
        const seal = (key: Uint8Array) => sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: recipient.publicKey, randomBytes });
        const encode = (value: unknown, key: Uint8Array) => Buffer.from(encryptWithDataKey(value, key)).toString("base64");
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id,
            metadata: encode({ host: "host", displayName: "User name" }, winningKey), metadataVersion: 4,
            daemonState: encode({ status: "running" }, winningKey), daemonStateVersion: 8,
            dataEncryptionKey: seal(winningKey),
        } });
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const response = await app.inject({ method: "POST", url: "/v1/machines", headers: { "x-test-user-id": account.id }, payload: {
                id: machine.id, metadata: encode({ host: "bootstrap" }, proposedKey),
                daemonState: encode({ status: "starting" }, proposedKey), dataEncryptionKey: Buffer.from(seal(proposedKey)).toString("base64"),
                contentPublicKey: Buffer.from(binding.contentPublicKey).toString("base64"),
            } });
            expect(response.statusCode).toBe(200);
            const published = response.json().machine;
            expect(published.dataEncryptionKey).toBe(Buffer.from(machine.dataEncryptionKey!).toString("base64"));
            expect(openEncryptedDataKeyEnvelopeV1({
                envelope: Buffer.from(published.dataEncryptionKey, "base64"),
                recipientSecretKeyOrSeed: recipient.secretKey,
            })).toEqual(new Uint8Array(winningKey));
            expect(published.storageMode).toBe("e2ee");
            expect(published.metadataVersion).toBe(4);
            expect(published.daemonStateVersion).toBe(8);
            expect(decryptWithDataKey(Buffer.from(published.metadata, "base64"), winningKey)).toEqual({ host: "host", displayName: "User name" });
            expect(decryptWithDataKey(Buffer.from(published.daemonState, "base64"), winningKey)).toEqual({ status: "running" });
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toEqual(machine);
        });
    });

    it("projects the persistent Machine envelope and custodian mode to authenticated SDK bootstrap", async () => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({ data: { ...binding, encryptionMode: "e2ee" } });
        const envelope = sealEncryptedDataKeyEnvelopeV1({ dataKey: randomBytes(32), recipientPublicKey: binding.contentPublicKey, randomBytes });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, metadata: "opaque", dataEncryptionKey: envelope,
        } });
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const result = await app.inject({ method: "GET", url: "/v1/machines", headers: {
                "x-test-user-id": account.id, "x-test-auth-token-kind": "api_token",
            } });
            expect(result.statusCode).toBe(200);
            expect(result.json()).toEqual([expect.objectContaining({ id: machine.id, dataEncryptionKey: Buffer.from(envelope).toString("base64"), access: expect.objectContaining({ resourceMode: "e2ee", accessState: "ready" }) })]);
            expect(result.json()[0]).not.toHaveProperty("metadata");
        });
    });

    it("adopts one complete winner when distinct registration proposals race", async () => {
        const recipient = tweetnacl.box.keyPair();
        const binding = createSignedAccountContentBinding(recipient.publicKey);
        const account = await db.account.create({ data: { ...binding, encryptionMode: "e2ee" } });
        const id = randomUUID();
        const proposals = ["first", "second"].map((label) => {
            const key = randomBytes(32);
            return {
                id,
                metadata: Buffer.from(encryptWithDataKey({ host: label }, key)).toString("base64"),
                daemonState: Buffer.from(encryptWithDataKey({ status: label }, key)).toString("base64"),
                dataEncryptionKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: recipient.publicKey, randomBytes })).toString("base64"),
                contentPublicKey: Buffer.from(recipient.publicKey).toString("base64"),
            };
        });
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const responses = await Promise.all(proposals.map((payload) => app.inject({ method: "POST", url: "/v1/machines", headers: { "x-test-user-id": account.id }, payload })));
            responses.forEach((response) => expect(response.statusCode).toBe(200));
            const stored = await db.machine.findUniqueOrThrow({ where: { id } });
            const winner = proposals.find((proposal) => proposal.dataEncryptionKey === Buffer.from(stored.dataEncryptionKey!).toString("base64"));
            expect(winner).toBeDefined();
            expect(stored).toMatchObject({ metadata: winner!.metadata, daemonState: winner!.daemonState, metadataVersion: 1, daemonStateVersion: 1 });
            responses.forEach((response) => expect(response.json().machine).toMatchObject({
                metadata: winner!.metadata, daemonState: winner!.daemonState, dataEncryptionKey: winner!.dataEncryptionKey,
                metadataVersion: 1, daemonStateVersion: 1,
            }));
        });
    });

    it("withholds contradictory owner content while projecting the persisted custodian mode", async () => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({ data: { ...binding, encryptionMode: "e2ee" } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: "private-host" }),
            daemonState: encodePlainMachineStoredContent({ status: "running" }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64")),
        } });
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const result = await app.inject({ method: "GET", url: `/v1/machines/${machine.id}`, headers: { "x-test-user-id": account.id } });
            expect(result.statusCode).toBe(200);
            expect(result.json().machine).toMatchObject({ storageMode: "e2ee", metadata: null, daemonState: null,
                dataEncryptionKey: null, access: { resourceMode: "e2ee", accessState: "refused" } });
            const registration = await app.inject({ method: "POST", url: "/v1/machines", headers: { "x-test-user-id": account.id }, payload: {
                id: machine.id, metadata: machine.metadata, daemonState: machine.daemonState,
            } });
            expect(registration.statusCode).toBe(400);
            expect(registration.json()).toMatchObject({ reason: "machine_storage_mode_mismatch" });
        });
    });
});
