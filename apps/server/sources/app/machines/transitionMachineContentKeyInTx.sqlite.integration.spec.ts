import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";
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
            expect(decryptWithDataKey(Buffer.from(stored.metadata, "base64"), nextKey)).toEqual(content);
            expect(decryptWithDataKey(Buffer.from(stored.daemonState!, "base64"), nextKey)).toEqual(daemonState);
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
            const send = (value: typeof next) => app.inject({ method: "POST", url: `/v1/machines/${machine.id}/content-key/transition`, headers: { "x-test-user-id": account.id }, payload: { machineId: machine.id, expected, next: value } });
            expect((await send({ ...next, dataEncryptionKey: malformedEnvelope.toString("base64") })).json()).toEqual({ kind: "refused", code: "encryption_material_unavailable" });
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toEqual(machine);
            await db.machine.update({ where: { id: machine.id }, data: { dataEncryptionKey: malformedEnvelope } });
            expect((await send(next)).json()).toEqual({ kind: "refused", code: "encryption_material_unavailable" });
            expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).metadataVersion).toBe(0);
            await db.machine.update({ where: { id: machine.id }, data: { dataEncryptionKey: null } });
            expect((await send(next)).json()).toMatchObject({ kind: "committed", machine: { daemonState: null, metadataVersion: 1, daemonStateVersion: 1,
                keyBasis: { dataEncryptionKey: next.dataEncryptionKey, metadataVersion: 1, daemonStateVersion: 1 } } });
        });
    });
});
