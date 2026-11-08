import { PrismaClient, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE } from "@happier-dev/protocol/plugins/availability/v1";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { createPluginAvailabilityOperations } from "./operations";
import { readStoredPluginManifestV2 } from "./currentDeclaration";
import { createReleaseLessDeclarationV1, mergeReleaseLessDeclarationV2 } from "./currentDeclaration";
import { PluginManifestV2Schema } from "@happier-dev/protocol/plugins/manifest/v2";
import historicalUiGraphPublication from "./historicalUiGraphPublication.fixture.json";

const operations = createPluginAvailabilityOperations({ resolveHostingCapability: () => ({ enabled: false }) });

async function fixture(count: number) {
    const account = await db.account.create({ data: { encryptionMode: "plain" } });
    const pluginIds = Array.from({ length: count }, (_, index) => `com.acme.intent${String(index).padStart(4, "0")}`);
    await db.accountPluginRelease.createMany({ data: pluginIds.map(pluginId => ({
        accountId: account.id, pluginId, version: "1.0.0", archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        normalizedManifest: { schemaVersion: 2, id: pluginId, version: "1.0.0", displayName: "Intent batch",
            engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 }, contributes: {} },
        collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${"b".repeat(64)}`, resources: [] },
    })) });
    await db.accountPluginIntent.createMany({ data: pluginIds.map(pluginId => ({
        accountId: account.id, pluginId, desiredVersion: "1.0.0", enabled: true, writableCollections: [],
    })) });
    return { accountId: account.id, pluginIds };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Availability intent PostgreSQL batches", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it("fetches one consumed declaration body for a 490-Machine list, with set reads and fresh divergent claims", async () => {
        // The retained busy Account had 490 envelopes and about 65 MB of declarations.
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const pluginId = "com.acme.wide-intent";
        const bodyMarker = "intent-page-consumed-body";
        const declaration = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({
            schemaVersion: 2, id: pluginId, version: "1.0.0", displayName: "Wide intent",
            engines: { happier: "^1.0.0" }, contributes: {},
            metadata: { measuredBody: bodyMarker + "x".repeat(128 * 1024) },
        }));
        let stored: unknown = null;
        for (let index = 0; index < 490; index++) {
            stored = mergeReleaseLessDeclarationV2({ stored, declaration,
                publisher: { machineId: `machine-${index}`, installationId: `installation-${index}` } }).stored;
        }
        await db.accountPluginIntent.create({ data: {
            accountId: account.id, pluginId, enabled: true, desiredVersion: null, writableCollections: [],
            releaseLessDeclaration: JSON.parse(JSON.stringify(stored)),
        } });
        const transaction = db.$transaction;
        const captured: unknown[] = [];
        const client = new PrismaClient({ errorFormat: "minimal", log: [{ emit: "event", level: "query" }] });
        let physicalStatements = 0;
        client.$on("query", (event: Prisma.QueryEvent) => { if (/^\s*SELECT\b/i.test(event.query)) physicalStatements++; });
        await client.$connect();
        // Observe bytes returned by the real database boundary; no domain logic is mocked.
        db.$transaction = new Proxy(transaction, { apply(_target, _receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(client.$transaction, client, args);
            return Reflect.apply(client.$transaction, client, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                const operation = Reflect.get(inner, property, innerReceiver);
                if (property !== "$queryRaw") return operation;
                return async (...queryArgs: unknown[]) => {
                    const result = await Reflect.apply(operation, inner, queryArgs);
                    if (Array.isArray(result) && result.some(row => row && typeof row === "object" && "pluginId" in row)) captured.push(result);
                    return result;
                };
            } })), ...args.slice(1)]);
        } });
        const read = async () => {
            captured.length = 0;
            physicalStatements = 0;
            const result = await operations.listIntentIds({ accountId: account.id, input: {} });
            const text = JSON.stringify(captured, (_key, value) => typeof value === "bigint" ? String(value) : value);
            return { result, statements: physicalStatements, bodyCopies: text.split(bodyMarker).length - 1, fetchedBytes: Buffer.byteLength(text) };
        };
        try {
            const agreed = await read();
            expect(agreed.result.failedPluginIds).toEqual([]);
            expect(agreed.result.intentReads[0]?.response.currentDeclaration?.manifest).toEqual(declaration.manifest);
            expect(agreed.result.intentReads[0]?.response.machineDeclarations).toHaveLength(490);
            expect.soft(agreed.bodyCopies).toBe(1);
            expect.soft(agreed.statements).toBeLessThanOrEqual(2);
            expect(agreed.fetchedBytes).toBeLessThan(Buffer.byteLength(JSON.stringify(stored)));

            const secondPluginId = "com.acme.wide-intent-second";
            const secondDeclaration = createReleaseLessDeclarationV1({ ...declaration.manifest, id: secondPluginId });
            await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: secondPluginId,
                enabled: true, desiredVersion: null, writableCollections: [],
                releaseLessDeclaration: JSON.parse(JSON.stringify(secondDeclaration)) } });
            const multiple = await read();
            expect(multiple.result.intentReads).toHaveLength(2);
            expect(multiple.bodyCopies).toBe(2);
            expect(multiple.statements).toBe(2);
            await db.accountPluginIntent.delete({ where: { accountId_pluginId: { accountId: account.id, pluginId: secondPluginId } } });
            const exact = await operations.readIntent({ accountId: account.id, input: { pluginId } });
            expect(exact.machineDeclarations?.at(-1)?.declaration.manifest).toEqual(declaration.manifest);

            const divergent = createReleaseLessDeclarationV1({ ...declaration.manifest, version: "2.0.0" });
            const changed = mergeReleaseLessDeclarationV2({ stored, declaration: divergent,
                publisher: { machineId: "machine-489", installationId: "installation-489" } }).stored;
            await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
                data: { releaseLessDeclaration: JSON.parse(JSON.stringify(changed)) } });
            await db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            const mixed = await read();
            expect(mixed.result.availabilityCursor).toBeGreaterThan(agreed.result.availabilityCursor);
            expect(mixed.result.intentReads[0]?.response.currentDeclaration).toBeNull();
            expect(mixed.result.intentReads[0]?.response.machineDeclarations?.find(entry => entry.machineId === "machine-489")?.declaration.declarationDigestSha256)
                .toBe(divergent.manifestDigestSha256);
            expect.soft(mixed.bodyCopies).toBe(0);
            expect.soft(mixed.statements).toBe(1);
            expect(mixed.fetchedBytes).toBeLessThan(agreed.fetchedBytes);
            console.info("INTENT_PAGE_BYTES", JSON.stringify({ physicalStatements: true, agreed: { statements: agreed.statements, bytes: agreed.fetchedBytes,
                bodyCopies: agreed.bodyCopies }, multiple: { statements: multiple.statements, bodyCopies: multiple.bodyCopies },
                divergent: { statements: mixed.statements, bytes: mixed.fetchedBytes, bodyCopies: mixed.bodyCopies } }));
        } finally {
            db.$transaction = transaction;
            await client.$disconnect();
        }
    });

    it("keeps body-free list filtering identical to exact reads for malformed and legacy envelopes", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const pluginId = "com.acme.envelope-projection";
        const declaration = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({ schemaVersion: 2,
            id: pluginId, version: "1.0.0", displayName: "Envelope", engines: { happier: "^1.0.0" }, contributes: {} }));
        const machine = { machineId: "valid-machine", machineInstallationId: "valid-installation", declaration };
        const invalid = { ...machine, declaration: { ...declaration, manifest: { ...declaration.manifest, contributes: [] } } };
        const cases = [declaration,
            { schemaVersion: 2, machines: [null, invalid, machine], legacyDeclaration: null },
            { schemaVersion: 2, machines: [invalid], legacyDeclaration: declaration },
            { schemaVersion: 2, machines: [machine, { ...machine, machineId: "divergent-machine",
                declaration: createReleaseLessDeclarationV1({ ...declaration.manifest, version: "2.0.0" }) }], legacyDeclaration: declaration },
            { ...declaration, schemaVersion: 2, machines: "malformed" },
            { schemaVersion: 2, machines: [], legacyDeclaration: null },
        ];
        for (const stored of cases) {
            await db.accountPluginIntent.upsert({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
                create: { accountId: account.id, pluginId, enabled: true, desiredVersion: null, writableCollections: [],
                    releaseLessDeclaration: JSON.parse(JSON.stringify(stored)) },
                update: { releaseLessDeclaration: JSON.parse(JSON.stringify(stored)) } });
            const listed = await operations.listIntentIds({ accountId: account.id, input: {} });
            const exact = await operations.readIntent({ accountId: account.id, input: { pluginId } });
            expect(listed.failedPluginIds).toEqual([]);
            expect(listed.intentReads[0]?.response.currentDeclaration).toEqual(exact.currentDeclaration);
            expect(listed.intentReads[0]?.response.machineDeclarations ?? []).toEqual((exact.machineDeclarations ?? []).map(entry => ({
                machineId: entry.machineId, machineInstallationId: entry.machineInstallationId,
                declaration: { declarationDigestSha256: entry.declaration.declarationDigestSha256 },
            })));
        }
    });

    it("rejoins racing first publishers through one decision, then adds a later UI graph without losing it", async () => {
        const { historicalFacts, currentFacts } = historicalUiGraphPublication;
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const normalizedManifest = readStoredPluginManifestV2(currentFacts.normalizedManifest, currentFacts.ref.pluginId);
        const older = { ...currentFacts, normalizedManifest, uiSlots: historicalFacts.uiSlots };
        const publish = (facts: unknown) => operations.publishRelease({ accountId: account.id,
            input: { facts, sourceClass: "versionedArchive" } });

        const racing = await Promise.all([publish(older), publish(older)]);
        expect(racing.map(result => result.outcome).sort()).toEqual(["created", "rejoined"]);

        await expect(publish({ ...currentFacts, normalizedManifest })).resolves.toMatchObject({ outcome: "rejoined" });
        await expect(publish(older)).resolves.toMatchObject({ outcome: "rejoined" });
        const stored = await db.accountPluginRelease.findFirstOrThrow({ where: { accountId: account.id }, select: { uiSlots: true } });
        expect(stored.uiSlots).toEqual(expect.arrayContaining(currentFacts.uiSlots));
    });

    it("keeps physical Account and intent/release SELECTs constant for 1 versus 88 plugins while fresh changes remain visible", async () => {
        const small = await fixture(1);
        const large = await fixture(88);
        const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
        let counts = { selects: 0, account: 0, intent: 0, release: 0 };
        client.$on("query", (event: Prisma.QueryEvent) => {
            if (!/^\s*SELECT\b/i.test(event.query)) return;
            counts.selects++;
            // Part E reads Account and intents in one joined statement.
            if (/(?:FROM|JOIN) "(?:public"\.")?Account"(?:\s|$)/.test(event.query)) counts.account++;
            if (/(?:FROM|JOIN) "(?:public"\.")?AccountPluginIntent"(?:\s|$)/.test(event.query)) counts.intent++;
            if (/(?:FROM|JOIN) "(?:public"\.")?AccountPluginRelease"(?:\s|$)/.test(event.query)) counts.release++;
        });
        await client.$connect();
        const transaction = db.$transaction;
        // Observe actual engine SQL at the DB transport; all internal logic stays real.
        db.$transaction = new Proxy(transaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        const read = async (accountId: string) => {
            counts = { selects: 0, account: 0, intent: 0, release: 0 };
            const result = await operations.listIntentIds({ accountId, input: {} });
            return { result, counts: { ...counts } };
        };
        try {
            const one = await read(small.accountId);
            const many = await read(large.accountId);
            expect(one.result.intentReads).toHaveLength(1);
            expect(many.result.intentReads).toHaveLength(88);
            expect(many.result.failedPluginIds).toEqual([]);
            const pluginId = large.pluginIds[0]!;
            await operations.setIntent({ accountId: large.accountId, input: { pluginId, desiredVersion: null,
                enabled: false, offlineUiHosting: "disabled", writableCollections: [], expectedRevision: "0" } });
            const changed = await read(large.accountId);
            expect(changed.result.availabilityCursor).toBeGreaterThan(many.result.availabilityCursor);
            expect(changed.result.intentReads[0]?.response).toMatchObject({
                availabilityCursor: changed.result.availabilityCursor,
                intent: { enabled: false, desiredVersion: null, revision: "1" }, release: null, uiArtifacts: [], packageAssets: [],
            });
            await db.accountPluginIntent.delete({ where: { accountId_pluginId: { accountId: large.accountId, pluginId } } });
            const removed = await operations.listIntentIds({ accountId: large.accountId, input: { knownPluginIds: [pluginId] } });
            expect(removed.pluginIds).not.toContain(pluginId);
            expect(removed.intentReads.find(entry => entry.pluginId === pluginId)?.response.intent).toBeNull();
            console.info("INTENTBATCH_SQL", JSON.stringify({ one: one.counts, many: many.counts, changed: changed.counts }));
            expect.soft(one.counts.account).toBe(1);
            expect.soft(many.counts.account).toBe(1);
            expect.soft(many.counts.intent).toBe(1);
            expect.soft(many.counts.release).toBe(1);
            expect.soft(many.counts.selects).toBe(one.counts.selects);
        } finally {
            db.$transaction = transaction;
            await client.$disconnect();
        }
    });

    it.each(["release", "claim"] as const)("fences listed %s bodies with the cursor during a concurrent selection change", async source => {
        const { accountId, pluginIds } = await fixture(2);
        const declaration = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({ schemaVersion: 2,
            id: pluginIds[0], version: "1.0.0", displayName: "Snapshot body", engines: { happier: "^1.0.0" }, contributes: {} }));
        if (source === "claim") await db.accountPluginIntent.update({
            where: { accountId_pluginId: { accountId, pluginId: pluginIds[0]! } },
            data: { desiredVersion: null, releaseLessDeclaration: JSON.parse(JSON.stringify(declaration)) },
        });
        const transaction = db.$transaction;
        let advanced = false;
        // A real peer commit after the Account read must not leak into its read snapshot.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                const operation = Reflect.get(inner, property, innerReceiver);
                if (property !== "$queryRaw") return operation;
                return async (...queryArgs: unknown[]) => {
                        const rows = await Reflect.apply(operation, inner, queryArgs);
                        if (!advanced && Array.isArray(rows) && rows.some(row => row && typeof row === "object" && "availabilityCursor" in row)) {
                            advanced = true;
                            await operations.setIntent({ accountId, input: { pluginId: pluginIds[0], desiredVersion: null,
                                enabled: false, offlineUiHosting: "disabled", writableCollections: [], expectedRevision: "0" } });
                        }
                        return rows;
                };
            } })), ...args.slice(1)]);
        } });
        try {
            const listed = await operations.listIntentIds({ accountId, input: {} });
            expect(advanced).toBe(true);
            expect(listed.intentReads).toHaveLength(2);
            for (const entry of listed.intentReads) {
                expect(entry.response.availabilityCursor).toBe(listed.availabilityCursor);
                expect(entry.response.intent).toMatchObject({ enabled: true,
                    desiredVersion: source === "claim" && entry.pluginId === pluginIds[0] ? null : "1.0.0", revision: "0" });
            }
            if (source === "claim") expect(listed.intentReads[0]?.response.currentDeclaration?.manifest).toEqual(declaration.manifest);
            const fresh = await operations.listIntentIds({ accountId, input: {} });
            expect(fresh.availabilityCursor).toBeGreaterThan(listed.availabilityCursor);
            expect(fresh.intentReads[0]?.response.intent).toMatchObject({ enabled: false, desiredVersion: null, revision: "1" });
        } finally {
            db.$transaction = transaction;
        }
    });

    it("retains paging, known/deleted identities, Account isolation and per-plugin content refusals", async () => {
        const { accountId, pluginIds } = await fixture(PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE + 1);
        const stranger = await fixture(0);
        const malformed = pluginIds[0]!;
        const legacy = pluginIds[1]!;
        const brokenRelease = pluginIds[2]!;
        const undeclaredLink = pluginIds[3]!;
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId, pluginId: malformed } }, data: { writableCollections: {} } });
        await db.accountPluginRelease.update({ where: { accountId_pluginId_version: { accountId, pluginId: legacy, version: "1.0.0" } },
            data: { packageAssetArchive: Prisma.DbNull } });
        await db.accountPluginRelease.update({ where: { accountId_pluginId_version: { accountId, pluginId: brokenRelease, version: "1.0.0" } },
            data: { uiSlots: {} } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: stranger.accountId,
            header: new Uint8Array([1]), body: new Uint8Array([1]), dataEncryptionKey: new Uint8Array([1]) } });
        const release = await db.accountPluginRelease.findUniqueOrThrow({ where: {
            accountId_pluginId_version: { accountId, pluginId: undeclaredLink, version: "1.0.0" },
        } });
        // Corrupt persisted links must remain isolated/refused, including a
        // package Artifact that belongs to another Account.
        await db.accountPluginUiArtifact.create({ data: { releaseId: release.id, contributionId: "undeclared",
            tier: "hostedWeb", platform: "web", artifactId: artifact.id,
            artifactDigest: `sha256:${"c".repeat(64)}`, compatibility: {} } });
        await db.accountPluginRelease.update({ where: { accountId_pluginId_version: { accountId, pluginId: pluginIds[4]!, version: "1.0.0" } },
            data: { packageAssetArtifactId: artifact.id } });
        const first = await operations.listIntentIds({ accountId, input: { knownPluginIds: [malformed, malformed] } });
        expect(first.pluginIds).toHaveLength(PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE);
        expect(first.failedPluginIds).toEqual([malformed, brokenRelease, undeclaredLink]);
        expect(first.intentReads.find(entry => entry.pluginId === legacy)?.response.release).toBeNull();
        expect(first.intentReads.find(entry => entry.pluginId === pluginIds[4])?.response.packageAssets).toEqual([]);
        expect(first.nextCursor).toBe(pluginIds[PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE - 1]);
        const last = await operations.listIntentIds({ accountId, input: { cursor: first.nextCursor, knownPluginIds: [malformed] } });
        expect(last.pluginIds).toEqual(pluginIds.slice(-1));
        expect(last.nextCursor).toBeUndefined();
        expect(last.failedPluginIds).toEqual([]);
        const isolated = await operations.listIntentIds({ accountId: stranger.accountId, input: { knownPluginIds: [pluginIds[3]] } });
        expect(isolated.pluginIds).toEqual([]);
        expect(isolated.intentReads[0]?.response).toMatchObject({ intent: null, release: null, uiArtifacts: [], packageAssets: [] });
        await expect(operations.readIntent({ accountId, input: { pluginId: brokenRelease } })).rejects.toMatchObject({ code: "plugin_release_content_conflict" });
        await expect(operations.readIntent({ accountId, input: { pluginId: undeclaredLink } })).rejects.toMatchObject({ code: "plugin_release_content_conflict" });
        await expect(operations.listIntentIds({ accountId: "missing-account", input: {} })).rejects.toMatchObject({ code: "plugin_account_not_found" });
        await expect(operations.readIntent({ accountId: "missing-account", input: { pluginId: legacy } })).rejects.toMatchObject({ code: "plugin_account_not_found" });
        await expect(operations.listIntentIds({ accountId, input: { knownPluginIds: ["invalid plugin id"] } })).rejects.toMatchObject({ code: "plugin_availability_invalid_request" });
    });

    it("keeps controller Home, Account, installation and retirement admission fresh", async () => {
        const { accountId, pluginIds } = await fixture(1);
        const foreign = await fixture(0);
        const homeId = "srv_intentBatchPostgres";
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", homeId);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId,
            metadata: "fixture", installationId: "intent-controller-installation" } });
        const input = { pluginId: pluginIds[0], includeManagedResources: true, homeId,
            controller: { machineId: machine.id, installationId: machine.installationId } };
        const refused = { code: "plugin_availability_invalid_request" };
        try {
            await expect(operations.readIntent({ accountId, input })).resolves.toMatchObject({ managedResources: [], managedResourcesReviewed: true });
            await expect(operations.readIntent({ accountId, input: { ...input, homeId: "srv_anotherHome" } })).rejects.toMatchObject(refused);
            await expect(operations.readIntent({ accountId: foreign.accountId, input })).rejects.toMatchObject(refused);
            await expect(operations.readIntent({ accountId, input: { ...input, controller: { ...input.controller, machineId: "missing-machine" } } })).rejects.toMatchObject(refused);
            await db.machine.update({ where: { id: machine.id }, data: { installationId: "new-installation" } });
            await expect(operations.readIntent({ accountId, input })).rejects.toMatchObject(refused);
            await db.machine.update({ where: { id: machine.id }, data: { installationId: machine.installationId, revokedAt: new Date() } });
            await expect(operations.readIntent({ accountId, input })).rejects.toMatchObject(refused);
        } finally { vi.unstubAllEnvs(); }
    });
});
