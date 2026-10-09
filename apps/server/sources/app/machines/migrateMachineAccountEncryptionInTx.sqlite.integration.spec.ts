import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import { encryptWithDataKey, decryptWithDataKey } from "../../../../cli/src/api/encryption";
import {
    encodePlainMachineStoredContent,
    decodePlainMachineStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    sealEncryptedDataKeyEnvelopeV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

import { migrateMachineAccountEncryptionInTx } from "./migrateMachineAccountEncryptionInTx";

const TARGETS = [
    {
        name: "plain",
        sourceAccountMode: "e2ee",
        toMode: "plain",
        metadata: encodePlainMachineStoredContent({ host: "target-plain" }),
        daemonState: encodePlainMachineStoredContent({ status: "running" }),
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        contentPublicKeyFingerprint: null,
    },
    {
        name: "e2ee legacy",
        sourceAccountMode: "plain",
        toMode: "e2ee",
        metadata: "target-e2ee-metadata-ciphertext",
        daemonState: "target-e2ee-daemon-ciphertext",
        dataEncryptionKey: null,
        contentPublicKeyFingerprint: null,
    },
    {
        name: "e2ee rekey",
        sourceAccountMode: "plain",
        toMode: "e2ee",
        metadata: "target-rekeyed-metadata-ciphertext",
        daemonState: "target-rekeyed-daemon-ciphertext",
        dataEncryptionKey: Buffer.from([41, 42, 43]).toString("base64"),
        contentPublicKeyFingerprint: "target-content-key-fingerprint",
    },
] as const;

describe("migrateMachineAccountEncryptionInTx (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-machine-account-encryption-migrate-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.accessKey.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("preserves finite Machine policy and user edits through the existing whole-inventory Plain/E2EE conversion", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        // Plan30's finitePolicy projection is carried by metadata, never a separate Account KV writer.
        const metadata = { host: "host", displayName: "User name", finitePolicyV1: { accepting: false, runAtMost: 2 } };
        const machines = await Promise.all([1, 2].map(() => db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, metadata: encodePlainMachineStoredContent(metadata), metadataVersion: 2,
            daemonState: encodePlainMachineStoredContent({ status: "running" }), daemonStateVersion: 3,
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64")),
        } })));
        const recipient = await db.account.create({ data: { encryptionMode: "plain" } });
        await db.machineAccountGrant.create({ data: {
            machineId: machines[0].id, accountId: recipient.id, accessLevel: "view", createdByAccountId: account.id,
        } });
        const recipientCursor = recipient.seq;
        const key = randomBytes(32);
        const envelope = Buffer.from(sealEncryptedDataKeyEnvelopeV1({
            dataKey: key, recipientPublicKey: tweetnacl.box.keyPair().publicKey, randomBytes,
        })).toString("base64");
        const items = machines.map((machine) => ({
            machineId: machine.id, expectedMetadataVersion: 2, expectedDaemonStateVersion: 3,
            metadata: Buffer.from(encryptWithDataKey(metadata, key)).toString("base64"),
            daemonState: Buffer.from(encryptWithDataKey({ status: "running" }, key)).toString("base64"),
            dataEncryptionKey: envelope, contentPublicKeyFingerprint: null,
        }));
        const migrate = (selected: typeof items) => inTx((tx) => migrateMachineAccountEncryptionInTx({
            tx, accountId: account.id, toMode: "e2ee", directive: { action: "migrate", items: selected },
        }));
        expect(await migrate(items.slice(0, 1))).toEqual({ status: "migration_incomplete" });
        expect(await migrate(items.map((item, index) => index ? { ...item, expectedMetadataVersion: 1 } : item))).toEqual({ status: "migration_incomplete" });
        expect(await db.machine.findMany({ where: { accountId: account.id }, orderBy: { id: "asc" } }))
            .toEqual([...machines].sort((a, b) => a.id.localeCompare(b.id)));
        expect(await migrate(items)).toEqual({ status: "applied" });
        expect((await db.account.findUniqueOrThrow({ where: { id: recipient.id } })).seq).toBeGreaterThan(recipientCursor);
        for (const item of items) {
            const encrypted = await db.machine.findUniqueOrThrow({ where: { id: item.machineId } });
            expect(decryptWithDataKey(Buffer.from(encrypted.metadata, "base64"), key)).toEqual(metadata);
        }
        expect(await inTx((tx) => migrateMachineAccountEncryptionInTx({
            tx, accountId: account.id, toMode: "plain", directive: { action: "migrate", items: items.map((item) => ({
                ...item, expectedMetadataVersion: 3, expectedDaemonStateVersion: 4,
                metadata: encodePlainMachineStoredContent(metadata), daemonState: encodePlainMachineStoredContent({ status: "running" }),
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            })) },
        }))).toEqual({ status: "applied" });
        for (const machine of machines) {
            expect(decodePlainMachineStoredContent((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).metadata)).toEqual(metadata);
        }
    });

    it.each(
        TARGETS.flatMap((target) => [false, true].map((revoked) => ({
            ...target,
            revoked,
            state: revoked ? "revoked" : "active",
        }))),
    )(
        "rejects a complete $name directive containing an $state Runner before any durable change",
        async (target) => {
            const account = await db.account.create({
                data: {
                    encryptionMode: target.sourceAccountMode,
                    settings: "account-settings-before",
                    settingsVersion: 7,
                    seq: 11,
                },
            });
            const runner = await db.machine.create({
                data: {
                    id: `runner-${target.name.replace(/ /g, "-")}-${target.revoked ? "revoked" : "active"}`,
                    kind: "ephemeral_session_runner",
                    accountId: account.id,
                    metadata: "runner-metadata-before",
                    metadataVersion: 2,
                    daemonState: "runner-daemon-before",
                    daemonStateVersion: 3,
                    dataEncryptionKey: new Uint8Array([1, 2, 3]),
                    runnerContentKeyBinding: {
                        v: 1,
                        purpose: "runner-binding-before",
                    },
                    contentPublicKeyFingerprint:
                        "runner-content-key-fingerprint-before",
                    active: !target.revoked,
                    revokedAt: target.revoked
                        ? new Date("2026-09-13T10:00:00.000Z")
                        : null,
                },
            });
            const session = await db.session.create({
                data: {
                    accountId: account.id,
                    tag: `session-${runner.id}`,
                    encryptionMode: target.sourceAccountMode,
                    metadata: "session-metadata-before",
                    metadataVersion: 5,
                },
            });
            const accessKey = await db.accessKey.create({
                data: {
                    accountId: account.id,
                    machineId: runner.id,
                    sessionId: session.id,
                    data: "access-key-before",
                },
            });

            const accountBefore = await db.account.findUniqueOrThrow({
                where: { id: account.id },
            });
            const machineBefore = await db.machine.findUniqueOrThrow({
                where: { id: runner.id },
            });
            const sessionBefore = await db.session.findUniqueOrThrow({
                where: { id: session.id },
            });
            const accessKeyBefore = await db.accessKey.findUniqueOrThrow({
                where: { id: accessKey.id },
            });
            const markChanged = vi.fn(async () => undefined);

            const result = await inTx(async (tx) =>
                await migrateMachineAccountEncryptionInTx({
                    tx,
                    accountId: account.id,
                    toMode: target.toMode,
                    directive: {
                        action: "migrate",
                        items: [{
                            machineId: runner.id,
                            expectedMetadataVersion:
                                runner.metadataVersion,
                            expectedDaemonStateVersion:
                                runner.daemonStateVersion,
                            metadata: target.metadata,
                            daemonState: target.daemonState,
                            dataEncryptionKey: target.dataEncryptionKey,
                            contentPublicKeyFingerprint:
                                target.contentPublicKeyFingerprint,
                        }],
                    },
                    markChanged,
                }),
            );

            expect(result).toEqual({
                status: "unsupported_machine_kind",
            });
            expect(markChanged).not.toHaveBeenCalled();
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
            })).resolves.toEqual(accountBefore);
            await expect(db.machine.findUniqueOrThrow({
                where: { id: runner.id },
            })).resolves.toEqual(machineBefore);
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
            })).resolves.toEqual(sessionBefore);
            await expect(db.accessKey.findUniqueOrThrow({
                where: { id: accessKey.id },
            })).resolves.toEqual(accessKeyBefore);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        },
    );
});
