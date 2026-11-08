import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, PluginReleaseFactsV1Schema } from "@happier-dev/protocol";
import type { PluginAvailabilityIntentSetActionInputV1, PluginAvailabilityReleasePublishActionInputV1 } from "@happier-dev/protocol/plugins/availability/actions";
import { decodeBase64 } from "privacy-kit";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

import { createPluginAvailabilityOperations } from "./operations";

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported Availability contract provider: ${raw}`);
}

function deferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const provider = resolveContractProvider();
const accountIdPrefix = "plugin-availability-interleave-";

describe("plugin Availability report transaction contract", () => {
    let activeAccountId: string | null = null;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL for Availability DB contract test");
        }
        if (provider === "postgres" && process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
    });

    afterEach(async () => {
        if (activeAccountId !== null) {
            await db.machine.deleteMany({ where: { accountId: activeAccountId } });
            await db.account.deleteMany({ where: { id: activeAccountId } });
            activeAccountId = null;
        }
    });

    afterAll(async () => {
        await db.$disconnect();
    });

    it("persists changed writer claims and clears declarations on release selection", async () => {
        const accountId = `${accountIdPrefix}${randomUUID()}`;
        activeAccountId = accountId;
        await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
        const pluginId = `com.acme.intent-write-${randomUUID()}`;
        const manifest = { schemaVersion: 2 as const, id: pluginId, version: "1.0.0",
            displayName: "Intent storage", engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 }, contributes: {} };
        const operations = createPluginAvailabilityOperations();
        await operations.claimCollectionWriters({ accountId, input: { manifest } });
        const initial = await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: { accountId, pluginId } } });
        const changed = await operations.claimCollectionWriters({ accountId, input: { manifest: { ...manifest, version: "1.0.1" } } });
        expect(changed.intent).toMatchObject({ revision: "1", desiredVersion: null, enabled: true, writableCollections: [] });
        const stored = await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: { accountId, pluginId } } });
        expect(stored.releaseLessDeclaration).toMatchObject({ manifest: { version: "1.0.1" } });
        expect(stored.updatedAt.getTime()).toBeGreaterThanOrEqual(initial.updatedAt.getTime());
        const facts = PluginReleaseFactsV1Schema.parse({ ref: { pluginId, version: manifest.version },
            archiveDigestSha256: `sha256:${"a".repeat(64)}`, normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${"b".repeat(64)}`, resources: [] } });
        await operations.publishRelease({ accountId, input: { facts, sourceClass: "registryPackage" } satisfies PluginAvailabilityReleasePublishActionInputV1 });
        const selected = await operations.setIntent({ accountId, input: { pluginId, desiredVersion: manifest.version,
            enabled: true, offlineUiHosting: "disabled", writableCollections: [], expectedRevision: changed.intent.revision } satisfies PluginAvailabilityIntentSetActionInputV1 });
        expect(selected.intent).toMatchObject({ revision: "2", desiredVersion: manifest.version });
        const released = await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: { accountId, pluginId } } });
        expect(released.releaseLessDeclaration).toBeNull();
        expect(released.writableCollections).toEqual([]);
    });

    it.skipIf(provider !== "postgres").each([
        { kind: "ui", change: "cursor" }, { kind: "package", change: "cursor" },
        { kind: "ui", change: "inconsistent-mode" }, { kind: "package", change: "inconsistent-mode" },
    ] as const)("preserves hosted $kind removal under $change contention", async ({ kind, change }) => {
        const suffix = randomUUID();
        const accountId = `${accountIdPrefix}${suffix}`;
        activeAccountId = accountId;
        await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
        const ref = { pluginId: `com.acme.removal-${suffix}`, version: "1.0.0" };
        const slot = { contributionId: "panel", artifactId: "panel", tier: "hostedWeb", platform: "web",
            artifactDigest: `sha256:${"b".repeat(64)}`, hostUiApiRange: "^1.0.0" };
        const facts = PluginReleaseFactsV1Schema.parse({
            ref, archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            normalizedManifest: { schemaVersion: 2, id: ref.pluginId, version: ref.version,
                displayName: "Removal fixture", engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 }, contributes: {} },
            collectionContracts: [], uiSlots: [slot],
            packageAssetArchive: { archiveDigestSha256: `sha256:${"c".repeat(64)}`, resources: [] },
        });
        const release = await db.accountPluginRelease.create({ data: { accountId, pluginId: ref.pluginId,
            version: ref.version, archiveDigestSha256: facts.archiveDigestSha256,
            normalizedManifest: facts.normalizedManifest, collectionContracts: [], uiSlots: facts.uiSlots,
            packageAssetArchive: facts.packageAssetArchive } });
        const artifactId = randomUUID();
        await db.artifact.create({ data: { id: artifactId, accountId,
            header: Buffer.from("header"), body: Buffer.from("body"), dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        if (kind === "ui") {
            await db.accountPluginUiArtifact.create({ data: { releaseId: release.id, contributionId: slot.contributionId,
                tier: slot.tier, platform: slot.platform, artifactId, artifactDigest: slot.artifactDigest,
                compatibility: { hostUiApiRange: slot.hostUiApiRange } } });
        } else {
            await db.accountPluginRelease.update({ where: { id: release.id }, data: { packageAssetArtifactId: artifactId } });
        }
        const service = createPluginAvailabilityOperations();
        const original = db.$transaction;
        let advances = 0;
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                const find = tx.account.findUnique.bind(tx.account);
                let observed = false;
                const account = new Proxy(tx.account, { get(owner, property, receiver) {
                    if (property !== "findUnique") return Reflect.get(owner, property, receiver);
                    return async (...values: Parameters<typeof find>) => {
                        const row = await find(...values);
                        if (!observed && (change === "cursor" || advances === 0)) {
                            observed = true;
                            await db.account.update({ where: { id: accountId }, data: change === "cursor"
                                ? { seq: { increment: 1 } } : { encryptionMode: "e2ee" } });
                            advances++;
                        }
                        return row;
                    };
                } });
                return callback(new Proxy(tx, { get(owner, property, receiver) {
                    return property === "account" ? account : Reflect.get(owner, property, receiver);
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            const remove = async () => kind === "ui"
                ? await service.removeUiArtifact({ accountId, input: { release: ref, contributionId: slot.contributionId,
                    artifactId: slot.artifactId, tier: slot.tier, platform: slot.platform } })
                : await service.removePackageAsset({ accountId, input: { release: ref } });
            if (change === "inconsistent-mode") {
                await expect(remove()).rejects.toMatchObject({ code: kind === "ui"
                    ? "plugin_ui_artifact_invalid_content" : "plugin_package_asset_invalid_content" });
                expect(await db.artifact.count({ where: { id: artifactId } })).toBe(1);
                expect(await db.accountChange.count({ where: { accountId } })).toBe(0);
                return;
            }
            const result = await remove();
            expect(result.removed).toBe(true);
            expect(await db.artifact.count({ where: { id: artifactId } })).toBe(0);
            expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } }))
                .toEqual({ seq: advances + 1 });
            expect(await db.accountChange.count({ where: { accountId, kind: "pluginDomain" } })).toBe(1);
        } finally {
            db.$transaction = original;
            await db.accountPluginUiArtifact.deleteMany({ where: { artifactId } });
            await db.accountPluginRelease.update({ where: { id: release.id }, data: { packageAssetArtifactId: null } });
            await db.artifact.deleteMany({ where: { id: artifactId } });
        }
    });

    it.skipIf(provider !== "postgres").each(["account cursor", "machine metadata"] as const)("publishes despite an unrelated %s writer during every report attempt", async writer => {
        const suffix = randomUUID();
        const accountId = `${accountIdPrefix}${suffix}`;
        const machineId = `machine-${suffix}`;
        const serverIdentityId = `srv_availabilityContention_${suffix.replace(/-/gu, "")}`;
        const pluginId = `com.acme.availability-contention-${suffix}`;
        activeAccountId = accountId;
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
        await db.machine.create({ data: { id: machineId, accountId, metadata: "{}" } });
        const service = createPluginAvailabilityOperations({
            resolveHostingCapability: () => ({ enabled: false }),
            resolveServerIdentityId: async () => serverIdentityId,
        });
        const originalTransaction = db.$transaction.bind(db);
        let interleavings = 0;
        // Interleave at the real database boundary, keeping reconciliation,
        // revision admission, publication and PostgreSQL transaction logic real.
        db.$transaction = (async (callback: (tx: Tx) => Promise<unknown>, options?: unknown) => (
            await originalTransaction(async tx => {
                const findMany = tx.pluginMachineMaterialization.findMany.bind(tx.pluginMachineMaterialization);
                tx.pluginMachineMaterialization.findMany = (async (args: Parameters<typeof findMany>[0]) => {
                    const rows = await findMany(args);
                    // This also represents a publisher on an older server;
                    // neither unrelated field is part of the report's CAS.
                    if (writer === "account cursor") {
                        await db.account.update({ where: { id: accountId }, data: { seq: { increment: 1 } } });
                    } else {
                        await db.machine.update({ where: { id: machineId }, data: { metadataVersion: { increment: 1 } } });
                    }
                    interleavings++;
                    return rows;
                }) as typeof tx.pluginMachineMaterialization.findMany;
                return await callback(tx);
            }, options as never)
        )) as typeof db.$transaction;
        try {
            await expect(service.reportMaterializations({ accountId, publisherMachineId: machineId, input: {
                expectedRevision: null,
                snapshot: { serverIdentityId, machineId, materializations: [{
                    serverIdentityId, machineId, materializationId: "installation", pluginId, version: "1.0.0",
                    sourceClass: "registryPackage", portableRelease: true, uiArtifacts: [], enabled: true,
                    trustState: "trusted", observedAt: 1_700_000_000_000,
                }] },
            } })).resolves.toEqual({ outcome: "replaced", revision: 1 });
        } finally {
            db.$transaction = originalTransaction;
        }
        expect(interleavings).toBeGreaterThan(0);
        const expectedCursor = writer === "account cursor" ? interleavings + 1 : 1;
        await expect(db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } }))
            .resolves.toEqual({ seq: expectedCursor });
        await expect(db.pluginMachineMaterialization.findMany({ where: { accountId, machineId }, select: { version: true } }))
            .resolves.toEqual([{ version: "1.0.0" }]);
        await expect(db.accountChange.findMany({ where: { accountId }, select: { cursor: true } }))
            .resolves.toEqual([{ cursor: expectedCursor }]);
    });

    it.each(["body", "revision"] as const)(`rejects a predecessor report paused after its %s read until its successor commits on ${provider}`, async pausedRead => {
        const suffix = randomUUID();
        const accountId = `${accountIdPrefix}${suffix}`;
        const machineId = `machine-${suffix}`;
        const serverIdentityId = `srv_availabilityInterleave_${suffix.replace(/-/gu, "")}`;
        const pluginId = `com.acme.availability-interleave-${suffix}`;
        activeAccountId = accountId;
        await db.account.create({
            data: {
                id: accountId,
                publicKey: null,
                encryptionMode: "plain",
            },
        });
        await db.machine.create({
            data: {
                id: machineId,
                accountId,
                metadata: "{}",
                installationId: `installation-${suffix}`,
            },
        });
        const service = createPluginAvailabilityOperations({
            resolveHostingCapability: () => ({ enabled: false }),
            resolveServerIdentityId: async () => serverIdentityId,
        });
        const materialization = (version: string, observedAt: number) => ({
            serverIdentityId,
            machineId,
            materializationId: "install-epoch-1",
            pluginId,
            version,
            sourceClass: "registryPackage" as const,
            portableRelease: true,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted" as const,
            observedAt,
        });
        const report = async (expectedRevision: number | null, version: string, observedAt: number) => (
            await service.reportMaterializations({
                accountId,
                publisherMachineId: machineId,
                input: {
                    expectedRevision,
                    snapshot: {
                        serverIdentityId,
                        machineId,
                        materializations: [materialization(version, observedAt)],
                    },
                },
            })
        );

        await expect(report(null, "1.0.0", 1_700_000_000_000))
            .resolves.toEqual({ outcome: "replaced", revision: 1 });

        const predecessorRead = deferred();
        const resumePredecessor = deferred();
        const runTransaction = db.$transaction.bind(db);
        let pauseRead = true;
        const pausingTransaction = (async (
            callback: (tx: Tx) => Promise<unknown>,
            options?: unknown,
        ) => await runTransaction(async (tx) => {
            const delegate = pausedRead === "body" ? tx.pluginMachineMaterialization : tx.machine;
            const pausedDelegate = new Proxy(delegate, {
                get(target, property, receiver) {
                    const value = Reflect.get(target, property, receiver);
                    if (property === (pausedRead === "body" ? "findMany" : "findFirst") && pauseRead) {
                        pauseRead = false;
                        return async (...args: unknown[]) => {
                            const rows = await Reflect.apply(value as (...input: unknown[]) => unknown, target, args);
                            predecessorRead.resolve();
                            await resumePredecessor.promise;
                            return rows;
                        };
                    }
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            const pausedTx = new Proxy(tx, {
                get(target, property, receiver) {
                    if (property === (pausedRead === "body" ? "pluginMachineMaterialization" : "machine")) {
                        return pausedDelegate;
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
            return await callback(pausedTx);
        }, options as never)) as typeof db.$transaction;

        db.$transaction = pausingTransaction;
        // Pausing the revision read makes the resumed body match the successor.
        // Its old revision must not be returned as an idempotent rejoin.
        const predecessor = report(1, pausedRead === "body" ? "1.1.0-predecessor" : "1.2.0-successor", 1_700_000_001_000);
        await predecessorRead.promise;
        db.$transaction = runTransaction as typeof db.$transaction;
        try {
            await expect(report(1, "1.2.0-successor", 1_700_000_002_000))
                .resolves.toEqual({ outcome: "replaced", revision: 2 });
        } finally {
            resumePredecessor.resolve();
        }
        await expect(predecessor).resolves.toEqual({ outcome: "conflict", revision: 2 });

        await expect(db.machine.findUnique({
            where: { id: machineId },
            select: { pluginMaterializationRevision: true },
        })).resolves.toEqual({ pluginMaterializationRevision: BigInt(2) });
        await expect(db.pluginMachineMaterialization.findMany({
            where: { accountId, machineId },
            select: { version: true, observedAt: true },
        })).resolves.toEqual([{
            version: "1.2.0-successor",
            observedAt: new Date(1_700_000_002_000),
        }]);
        await expect(db.account.findUnique({
            where: { id: accountId },
            select: { seq: true },
        })).resolves.toEqual({ seq: 2 });
        await expect(db.accountChange.findMany({
            where: { accountId, kind: "pluginDomain" },
            select: { cursor: true, hint: true },
        })).resolves.toEqual([{
            cursor: 2,
            hint: { pluginDomain: "availability", pluginId },
        }]);
    });
});
