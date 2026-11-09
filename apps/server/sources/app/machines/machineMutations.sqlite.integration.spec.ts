import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import { encodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, signMachineInstallationProof } from "@happier-dev/protocol";

import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createSessionMachineAccessKeyInTx } from "@/app/accessKeys/sessionMachineAccessKeyMutations";
import { eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { validateMachineInstallationProof } from "./installationProof";
import {
    createMachineWithInstallationIdentityInTx,
    revokeMachineInTx,
} from "./machineMutations";

describe("Machine transaction-composable mutations (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-machine-mutations-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accessKey.deleteMany(),
            () => db.session.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createAccount(publicKey: string | null) {
        return db.account.create({
            data: { publicKey, encryptionMode: "plain" },
            select: { id: true },
        });
    }

    it("validates installation proof and creates the ordinary Machine through the canonical owner", async () => {
        const account = await createAccount(null);
        const installationKeyPair = tweetnacl.sign.keyPair();
        const payload = {
            version: 1 as const,
            installationId: "installation-1",
            machineId: "machine-create",
            accountId: account.id,
        };
        const validated = validateMachineInstallationProof({
            accountId: account.id,
            machineId: payload.machineId,
            installationId: payload.installationId,
            installationPublicKey: encodeBase64(installationKeyPair.publicKey, "base64url"),
            installationProof: signMachineInstallationProof({
                payload,
                privateKey: installationKeyPair.secretKey,
            }),
            replacesMachineId: null,
            replacementReason: null,
            contentPublicKeyFingerprint: null,
        });
        expect(validated.ok).toBe(true);
        if (!validated.ok) return;

        const beforeCreation = Date.now();
        const created = await inTx(async (tx) => createMachineWithInstallationIdentityInTx(tx, {
            accountId: account.id,
            machineId: payload.machineId,
            metadata: encodePlainMachineStoredContent({ host: "ordinary" }),
            daemonState: null,
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            installationIdentity: validated.identity,
            contentPublicKeyFingerprint: null,
            replacementReason: "machine_rotation",
        }));
        const afterCreation = Date.now();

        expect(created.machine).toMatchObject({
            id: payload.machineId,
            kind: "persistent",
            accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: "ordinary" }),
            active: false,
            installationId: payload.installationId,
        });
        expect(created.machine.installationPublicKey).toEqual(installationKeyPair.publicKey);
        expect(created.machineReplacement).toBeNull();
        const stored = await db.machine.findUniqueOrThrow({ where: { id: payload.machineId },
            select: { active: true, lastActiveAt: true } });
        expect(stored.active).toBe(false);
        expect(stored.lastActiveAt).toEqual(created.machine.lastActiveAt);
        expect(stored.lastActiveAt.getTime()).toBeGreaterThanOrEqual(Math.floor(beforeCreation / 1_000) * 1_000);
        expect(stored.lastActiveAt.getTime()).toBeLessThanOrEqual(afterCreation);
        await expect(db.accountChange.count({
            where: { accountId: account.id, machineId: payload.machineId },
        })).resolves.toBe(1);
    });

    it.each([
        { mode: "plain", mismatch: "metadata", metadata: "ciphertext", daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
        { mode: "plain", mismatch: "daemonState", metadata: encodePlainMachineStoredContent({}), daemonState: "ciphertext", dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
        { mode: "plain", mismatch: "dataEncryptionKey", metadata: encodePlainMachineStoredContent({}), daemonState: null, dataEncryptionKey: null },
        { mode: "e2ee", mismatch: "metadata", metadata: encodePlainMachineStoredContent({}), daemonState: null, dataEncryptionKey: null },
        { mode: "e2ee", mismatch: "daemonState", metadata: "ciphertext", daemonState: encodePlainMachineStoredContent({}), dataEncryptionKey: null },
        { mode: "e2ee", mismatch: "dataEncryptionKey", metadata: "ciphertext", daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
    ] as const)("rejects $mode Machine creation with mismatched $mismatch before any durable mutation", async ({ mode, metadata, daemonState, dataEncryptionKey }) => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: mode } });
        await expect(inTx(async (tx) => createMachineWithInstallationIdentityInTx(tx, {
            accountId: account.id,
            machineId: "mismatch",
            metadata,
            daemonState,
            dataEncryptionKey,
            installationIdentity: null,
            contentPublicKeyFingerprint: null,
            replacementReason: "machine_rotation",
        }))).rejects.toMatchObject({ code: "machine_storage_mode_mismatch" });
        await expect(db.machine.count({ where: { accountId: account.id } })).resolves.toBe(0);
        await expect(db.accountChange.count({ where: { accountId: account.id } })).resolves.toBe(0);
    });

    it("preserves E2EE creation with an absent historical Account-key envelope", async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const created = await inTx(async (tx) => createMachineWithInstallationIdentityInTx(tx, {
            accountId: account.id,
            machineId: "historical-e2ee",
            metadata: "encrypted-metadata",
            daemonState: "encrypted-state",
            dataEncryptionKey: null,
            installationIdentity: null,
            contentPublicKeyFingerprint: null,
            replacementReason: "machine_rotation",
        }));
        expect(created.machine).toMatchObject({ id: "historical-e2ee", metadata: "encrypted-metadata", daemonState: "encrypted-state", dataEncryptionKey: null });
        await expect(db.accountChange.count({ where: { accountId: account.id } })).resolves.toBe(1);
    });

    it.each(["persistent", "ephemeral_session_runner"] as const)("revokes a %s Machine without leaking temporary inventory", async (kind) => {
        const account = await createAccount("pk-machine-revoke");
        const machine = await db.machine.create({
            data: { id: "machine-revoke", accountId: account.id, metadata: "plain-metadata", kind },
        });
        const session = await db.session.create({
            data: { accountId: account.id, tag: "machine-revoke-session", encryptionMode: "plain", metadata: "{}" },
        });
        const accessKey = await inTx(tx => createSessionMachineAccessKeyInTx(tx, {
            accountId: account.id,
            machineId: machine.id,
            sessionId: session.id,
            data: "access-key",
        }));
        expect(accessKey.ok).toBe(true);

        const disconnectedRooms: string[] = [];
        eventRouter.setIo({ to: (rooms) => ({
            emit: () => undefined,
            disconnectSockets: () => disconnectedRooms.push(...(Array.isArray(rooms) ? rooms : [rooms])),
        }) });
        const emit = vi.spyOn(eventRouter, "emitUpdate");

        let disconnectedInsideTransaction = false;
        const revoked = await inTx(async (tx) => {
            const result = await revokeMachineInTx(tx, {
                accountId: account.id,
                machineId: machine.id,
            });
            disconnectedInsideTransaction = disconnectedRooms.length > 0;
            return result;
        });

        expect(revoked).toMatchObject({ ok: true, machine: { id: machine.id, active: false } });
        expect(disconnectedInsideTransaction).toBe(false);
        expect(disconnectedRooms).toEqual(expect.arrayContaining([
            `machine:${machine.id}:${account.id}`,
            `session:${session.id}:machine:${machine.id}:${account.id}`,
        ]));
        await expect(db.accessKey.count({ where: { accountId: account.id, machineId: machine.id } })).resolves.toBe(0);
        await expect(db.machine.findUniqueOrThrow({ where: { id: machine.id } })).resolves.toMatchObject({
            active: false,
            revokedAt: expect.any(Date),
        });

        eventRouter.clearIo();
        const machineUpdates = emit.mock.calls.map(([event]) => event)
            .filter((event) => event.payload.body.t === "update-machine");
        emit.mockRestore();
        expect(machineUpdates).toContainEqual(expect.objectContaining({
            recipientFilter: kind === "persistent"
                ? { type: "user-scoped-only" }
                : { type: "machine-scoped-only", machineId: machine.id },
        }));
    });

    it("keeps temporary creation out of the ordinary legacy Machine inventory broadcast", async () => {
        const account = await createAccount("pk-machine-temporary");
        // Socket emission is the external boundary; Machine construction and
        // transactional durable changes remain real.
        const emit = vi.spyOn(eventRouter, "emitUpdate");
        try {
            const created = await inTx(async (tx) => createMachineWithInstallationIdentityInTx(tx, {
                accountId: account.id,
                machineId: "temporary",
                kind: "ephemeral_session_runner",
                metadata: "plain-metadata",
                daemonState: null,
                dataEncryptionKey: null,
                runnerContentKeyBinding: { v: 1, purpose: "test-runner-key-binding" },
                installationIdentity: null,
                contentPublicKeyFingerprint: null,
                replacementReason: "machine_rotation",
            }));
            expect(created.machine).toMatchObject({
                kind: "ephemeral_session_runner",
                runnerContentKeyBinding: { v: 1, purpose: "test-runner-key-binding" },
            });
            expect(emit.mock.calls.some(([event]) => event.payload.body.t === "new-machine")).toBe(false);
            expect(emit.mock.calls.some(([event]) => event.recipientFilter?.type === "machine-scoped-only")).toBe(true);
            expect(await db.accountChange.count({ where: { accountId: account.id, machineId: "temporary" } })).toBe(1);
        } finally {
            emit.mockRestore();
        }
    });
});
