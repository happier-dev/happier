import { decodeMachineStoredContent } from '@/storage/sessionMachineStoredContent';
import { randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { sealEncryptedDataKeyEnvelopeV1, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, decodePlainMachineStoredContent, computeContentPublicKeyFingerprint, signMachineInstallationProof } from "@happier-dev/protocol";
import predecessor from "../../../../cli/src/api/machine/machineLegacyContent.predecessor.fixture.json";
import plainPredecessor from "../../../../cli/src/api/machine/machinePlainContent.current02.fixture.json";
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from "@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1";
import { randomBytes } from "node:crypto";
import { encryptWithDataKey, decryptWithDataKey } from "../../../../cli/src/api/encryption";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { machinesRoutes } from "@/app/api/routes/machines/machinesRoutes";
import { eventRouter } from "@/app/events/eventRouter";

describe("Machine content key transition (real route and SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-key-transition-", initAuth: false });
    }, 120_000);
    afterEach(async () => { vi.restoreAllMocks(); await db.machine.deleteMany(); await db.account.deleteMany(); });
    afterAll(async () => { if (harness) await harness.close(); });

    it("commits the complete basis once, identifies post-state on replay and leaves all content untouched on a stale envelope", async () => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({ data: { ...binding, encryptionMode: "e2ee" } });
        const oldKey = randomBytes(32);
        const nextKey = randomBytes(32);
        const content = { host: "old-host", displayName: "User edit", finitePolicyV1: { accepting: false, runAtMost: 2 } };
        const daemonState = { status: "running", pid: 42 };
        const seal = (key: Uint8Array) => sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: binding.contentPublicKey, randomBytes });
        const encode = (value: unknown, key: Uint8Array) => Buffer.from(encryptWithDataKey(value, key)).toString("base64");
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, metadata: encode(content, oldKey), metadataVersion: 2,
            daemonState: encode(daemonState, oldKey), daemonStateVersion: 3, dataEncryptionKey: seal(oldKey),
        } });
        const expected = { dataEncryptionKey: Buffer.from(machine.dataEncryptionKey!).toString("base64"), metadataVersion: 2, daemonStateVersion: 3 };
        const next = { dataEncryptionKey: Buffer.from(seal(nextKey)).toString("base64"), metadata: encode(content, nextKey), daemonState: encode(daemonState, nextKey) };
        // Observe the real producer at its socket transport boundary; owner/serialization logic stays real.
        const published = vi.spyOn(eventRouter, "emitUpdate");
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const send = (body: unknown, userId = account.id) => app.inject({ method: "POST", url: `/v1/machines/${machine.id}/content-key/transition`, headers: { "x-test-user-id": userId }, payload: body });
            const foreign = await db.account.create({ data: { encryptionMode: "plain" } });
            expect((await send({ machineId: machine.id, expected, next }, foreign.id)).json()).toEqual({ kind: "refused", code: "forbidden" });
            const committed = await send({ machineId: machine.id, expected, next });
            expect(committed.statusCode).toBe(200);
            expect(committed.json()).toMatchObject({ kind: "committed", machine: { ...next, metadataVersion: 3, daemonStateVersion: 4 } });
            const stored = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
            const decoded = decodeMachineStoredContent(stored);
            expect(decryptWithDataKey(Buffer.from(decoded.metadata, "base64"), nextKey)).toEqual(content);
            expect(decryptWithDataKey(Buffer.from(decoded.daemonState!, "base64"), nextKey)).toEqual(daemonState);
            expect(published.mock.calls.map(([event]) => event.payload.body).filter((body) => body.t === "update-machine")).toEqual([
                expect.objectContaining({ machineId: machine.id, dataEncryptionKey: next.dataEncryptionKey,
                    keyBasis: { dataEncryptionKey: next.dataEncryptionKey, metadataVersion: 3, daemonStateVersion: 4 },
                    metadata: { value: next.metadata, version: 3 }, daemonState: { value: next.daemonState, version: 4 } }),
            ]);
            // Lost acknowledgement recovery observes exact ciphertext and revisions, without re-publishing the proposal.
            const current = await app.inject({ method: "GET", url: `/v1/machines/${machine.id}`, headers: { "x-test-user-id": account.id } });
            expect(current.json().machine).toMatchObject({ ...next, metadataVersion: 3, daemonStateVersion: 4 });
            const stale = await send({ machineId: machine.id, expected: { ...expected, metadataVersion: 3, daemonStateVersion: 4 }, next: { ...next, metadata: "stale" } });
            expect(stale.json()).toEqual({ kind: "conflict", current: { dataEncryptionKey: next.dataEncryptionKey, metadataVersion: 3, daemonStateVersion: 4 } });
            const replay = await send({ machineId: machine.id, expected, next });
            expect(replay.json().kind).toBe("conflict");
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toEqual(stored);
            expect((await send({ machineId: "another-id", expected, next })).statusCode).toBe(400);
        });
    });

    it("reads actual current 0.2 plain Machine carriers without a database mode column or key migration", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const source = plainPredecessor.machine;
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, metadata: source.metadata,
            metadataVersion: source.metadataVersion, daemonState: source.daemonState,
            daemonStateVersion: source.daemonStateVersion,
            dataEncryptionKey: Buffer.from(source.dataEncryptionKey, "base64"),
        } });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const response = await app.inject({ method: "GET", url: `/v1/machines/${machine.id}`,
                headers: { "x-test-user-id": account.id,
                    ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } });
            expect(response.statusCode).toBe(200);
            expect(response.json().machine).toMatchObject({ storageMode: "plain", metadata: source.metadata,
                daemonState: source.daemonState, dataEncryptionKey: source.dataEncryptionKey,
                access: { resourceMode: "plain", accessState: "ready" },
                keyBasis: { dataEncryptionKey: source.dataEncryptionKey,
                    metadataVersion: source.metadataVersion, daemonStateVersion: source.daemonStateVersion } });
            expect(decodePlainMachineStoredContent(response.json().machine.metadata)).toEqual(plainPredecessor.metadata);
            expect(decodePlainMachineStoredContent(response.json().machine.daemonState)).toEqual(plainPredecessor.daemonState);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toEqual(machine);
        });
    });

    it("recovers an already-plain Account's predecessor Machine through its own exact snapshot and whole-content CAS", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const foreign = await db.account.create({ data: { encryptionMode: "plain" } });
        const fixture = predecessor.rows.find(row => row.credentialKind === "dataKey")!;
        const installation = tweetnacl.sign.keyPair();
        const installationId = randomUUID();
        const contentPublicKeyFingerprint = computeContentPublicKeyFingerprint(randomBytes(32));
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, metadata: fixture.machine.metadata,
            metadataVersion: 4, daemonState: fixture.machine.daemonState, daemonStateVersion: 3,
            dataEncryptionKey: Buffer.from(fixture.machine.dataEncryptionKey!, "base64"),
            contentPublicKeyFingerprint, installationId, installationPublicKey: new Uint8Array(installation.publicKey),
        } });
        const expected = { dataEncryptionKey: fixture.machine.dataEncryptionKey, metadataVersion: 4, daemonStateVersion: 3 };
        const next = { dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            metadata: encodePlainMachineStoredContent(predecessor.openedMetadata),
            daemonState: encodePlainMachineStoredContent(predecessor.openedDaemonState) };
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const path = `/v1/machines/${machine.id}/content-key/transition`;
            const snapshot = await app.inject({ method: "GET", url: path, headers: { "x-test-user-id": account.id } });
            expect(snapshot.statusCode).toBe(200);
            expect(snapshot.json().machine).toMatchObject({ metadata: machine.metadata, daemonState: machine.daemonState,
                dataEncryptionKey: expected.dataEncryptionKey, keyBasis: expected, storageMode: "e2ee" });
            expect((await app.inject({ method: "GET", url: path, headers: { "x-test-user-id": foreign.id } })).statusCode).toBe(404);
            const send = (body: unknown) => app.inject({ method: "POST", url: path,
                headers: { "x-test-user-id": account.id }, payload: body });
            const stale = await send({ machineId: machine.id, expected: { ...expected, dataEncryptionKey: null }, next });
            expect(stale.json()).toEqual({ kind: "conflict", current: expected });
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toEqual(machine);
            const wrong = await send({ machineId: machine.id, expected, next: { ...next, daemonState: machine.daemonState } });
            expect(wrong.json()).toEqual({ kind: "refused", code: "machine_storage_mode_mismatch" });
            const committed = await send({ machineId: machine.id, expected, next });
            expect(committed.json()).toMatchObject({ kind: "committed", machine: { ...next, storageMode: "plain",
                metadataVersion: 5, daemonStateVersion: 4, contentPublicKeyFingerprint: null } });
            const stored = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
            expect(decodePlainMachineStoredContent(stored.metadata)).toEqual(predecessor.openedMetadata);
            expect(decodePlainMachineStoredContent(stored.daemonState!)).toEqual(predecessor.openedDaemonState);
            expect((await send({ machineId: machine.id, expected, next })).json()).toMatchObject({ kind: "conflict" });
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toEqual(stored);
            const repeated = await app.inject({ method: "POST", url: "/v1/machines", headers: {
                "x-test-user-id": account.id,
                ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
            }, payload: {
                id: machine.id, ...next, installationId,
                installationPublicKey: Buffer.from(installation.publicKey).toString("base64url"),
                contentPublicKeyFingerprint,
                installationProof: signMachineInstallationProof({
                    payload: { version: 1, installationId, machineId: machine.id, accountId: account.id, contentPublicKeyFingerprint },
                    privateKey: installation.secretKey,
                }),
            } });
            expect(repeated.statusCode, repeated.body).toBe(200);
            expect(repeated.json().machine).toMatchObject({ contentPublicKeyFingerprint: null, installationId });
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toEqual(stored);
        });
    });

    it.each(["plain", "e2ee"] as const)("stores the content-key pin only for %s Machine content after verifying the complete signed proof", async (mode) => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: mode } });
        const installation = tweetnacl.sign.keyPair();
        const installationId = randomUUID();
        const machineId = randomUUID();
        const contentPublicKeyFingerprint = computeContentPublicKeyFingerprint(randomBytes(32));
        const proposal = {
            id: machineId, installationId,
            metadata: mode === "plain" ? encodePlainMachineStoredContent({ host: "plain" }) : "encrypted-metadata",
            dataEncryptionKey: mode === "plain" ? MACHINE_PLAIN_DATA_KEY_MARKER : null,
            installationPublicKey: Buffer.from(installation.publicKey).toString("base64url"),
            contentPublicKeyFingerprint,
            installationProof: signMachineInstallationProof({
                payload: { version: 1, installationId, machineId, accountId: account.id, contentPublicKeyFingerprint },
                privateKey: installation.secretKey,
            }),
        };
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const register = (payload: unknown) => app.inject({ method: "POST", url: "/v1/machines", headers: {
                "x-test-user-id": account.id,
                ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
            }, payload });
            const forged = await register({ ...proposal, contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(randomBytes(32)) });
            expect(forged.statusCode).toBe(400);
            expect(forged.json()).toMatchObject({ reason: "installation_proof_invalid" });
            expect(await db.machine.count({ where: { id: machineId } })).toBe(0);
            const created = await register(proposal);
            expect(created.statusCode, created.body).toBe(200);
            const expectedFingerprint = mode === "plain" ? null : contentPublicKeyFingerprint;
            expect(created.json().machine).toMatchObject({ contentPublicKeyFingerprint: expectedFingerprint, installationId });
            const stored = await db.machine.findUniqueOrThrow({ where: { id: machineId } });
            expect(stored.contentPublicKeyFingerprint).toBe(expectedFingerprint);
            expect(stored.installationPublicKey).toEqual(installation.publicKey);
            if (mode === "e2ee") {
                await db.machine.update({ where: { id: machineId }, data: { contentPublicKeyFingerprint: null } });
                const repeated = await register(proposal);
                expect(repeated.statusCode, repeated.body).toBe(200);
                expect((await db.machine.findUniqueOrThrow({ where: { id: machineId } })).contentPublicKeyFingerprint).toBe(contentPublicKeyFingerprint);
            }
        });
    });

    it("clears an obsolete plain pin after verifying a different valid historical signed fingerprint", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const installation = tweetnacl.sign.keyPair();
        const installationId = randomUUID();
        const incomingFingerprint = computeContentPublicKeyFingerprint(randomBytes(32));
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, metadata: encodePlainMachineStoredContent({ host: "plain" }),
            dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"),
            installationId, installationPublicKey: new Uint8Array(installation.publicKey),
            contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(randomBytes(32)),
        } });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const response = await app.inject({ method: "POST", url: "/v1/machines", headers: {
                "x-test-user-id": account.id,
                ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
            }, payload: {
                id: machine.id, metadata: machine.metadata, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                installationId, installationPublicKey: Buffer.from(installation.publicKey).toString("base64url"),
                contentPublicKeyFingerprint: incomingFingerprint,
                installationProof: signMachineInstallationProof({
                    payload: { version: 1, installationId, machineId: machine.id, accountId: account.id,
                        contentPublicKeyFingerprint: incomingFingerprint },
                    privateKey: installation.secretKey,
                }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toMatchObject({
                contentPublicKeyFingerprint: null, installationId, installationPublicKey: installation.publicKey,
                metadata: machine.metadata, metadataVersion: machine.metadataVersion,
            });
        });
    });

    it("advances the null-state basis and refuses malformed material without any content write", async () => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({ data: { ...binding, encryptionMode: "e2ee" } });
        const key = randomBytes(32);
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id,
            metadata: Buffer.from(encryptWithDataKey({ host: "host" }, key)).toString("base64"),
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0, dataEncryptionKey: null,
        } });
        const expected = { dataEncryptionKey: null, metadataVersion: 0, daemonStateVersion: 0 };
        const next = { dataEncryptionKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: binding.contentPublicKey, randomBytes })).toString("base64"), metadata: machine.metadata, daemonState: null };
        const malformedEnvelope = Buffer.from(next.dataEncryptionKey, "base64");
        malformedEnvelope[0] = 255;
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const send = (value: typeof next, dataEncryptionKey: string | null = null) => app.inject({ method: "POST", url: `/v1/machines/${machine.id}/content-key/transition`, headers: { "x-test-user-id": account.id }, payload: { machineId: machine.id, expected: { ...expected, dataEncryptionKey }, next: value } });
            expect((await send({ ...next, dataEncryptionKey: malformedEnvelope.toString("base64") })).json()).toEqual({ kind: "refused", code: "encryption_material_unavailable" });
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toEqual(machine);
            await db.machine.update({ where: { id: machine.id }, data: { dataEncryptionKey: malformedEnvelope } });
            expect((await send(next, malformedEnvelope.toString("base64"))).json()).toEqual({ kind: "refused", code: "encryption_material_unavailable" });
            expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).metadataVersion).toBe(0);
            await db.machine.update({ where: { id: machine.id }, data: { dataEncryptionKey: null } });
            expect((await send(next)).json()).toMatchObject({ kind: "committed", machine: { daemonState: null, metadataVersion: 1, daemonStateVersion: 1,
                keyBasis: { dataEncryptionKey: next.dataEncryptionKey, metadataVersion: 1, daemonStateVersion: 1 } } });
        });
    });
});
