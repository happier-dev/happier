import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PluginManifestV2Schema } from "@happier-dev/protocol/plugins/manifest/v2";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { observeSqliteRequests } from "@/testkit/observeSqliteRequests";
import { createPluginAvailabilityOperations, resolveCurrentClaimablePluginMachineMaterializationTx } from "./operations";
import { createReleaseLessDeclarationV1, mergeReleaseLessDeclarationV2, readCurrentMachinePluginDeclarationsV1, readCurrentPluginDeclarationV1,
    resolveCurrentPluginDeclarationsTx } from "./currentDeclaration";

const operations = createPluginAvailabilityOperations({ resolveHostingCapability: () => ({ enabled: false }) });

/** Count manifest-body copies returned by the real SQLite engine boundary (every client, read snapshots included). */
async function observeBodyCopies<T>(marker: string, run: () => Promise<T>): Promise<{ result: T; copies: number }> {
    let copies = 0;
    const stop = observeSqliteRequests({ after: (_request, result) => {
        const text = JSON.stringify(result, (_key, value) => typeof value === "bigint" ? String(value) : value) ?? "";
        copies += text.split(marker).length - 1;
    } });
    try {
        return { result: await run(), copies };
    } finally {
        stop();
    }
}

function wideDeclaration(pluginId: string, marker: string) {
    return createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({
        schemaVersion: 2, id: pluginId, version: "1.0.0", displayName: "Wide intent",
        engines: { happier: "^1.0.0" }, contributes: {},
        metadata: { measuredBody: marker + "x".repeat(64 * 1024) },
    }));
}

describe("Availability intent reads on SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-plugin-intents-sqlite-", initAuth: false, initFiles: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it("stores a project restriction in Account enablement and preserves it across existing writers", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const accountId = account.id;
        const pluginId = "com.acme.project-reach";
        const enable = { pluginId, desiredVersion: null, enabled: true,
            offlineUiHosting: "disabled", writableCollections: [] };
        const projectScope = { kind: "only" as const, projectKeys: ["project-a", "project-b"] };
        const selected = await operations.setIntent({ accountId, input: { ...enable, expectedRevision: null, projectScope } });
        expect(selected.intent).toMatchObject({ projectScope });
        const inPlace = await operations.setIntent({ accountId, input: { ...enable, expectedRevision: selected.intent.revision } });
        expect(inPlace.intent).toEqual(selected.intent);
        const read = await operations.readIntent({ accountId, input: { pluginId } });
        expect(read.intent).toEqual(selected.intent);
        const listed = await operations.listIntentIds({ accountId, input: {} });
        expect(listed.intentReads[0]?.response.intent).toEqual(selected.intent);
        const cleared = await operations.setIntent({ accountId, input: { ...enable,
            expectedRevision: selected.intent.revision, projectScope: null } });
        expect(cleared.intent.projectScope).toBeUndefined();
        expect(cleared.intent.revision).not.toBe(selected.intent.revision);
    });

    it("keeps the stored declaration out of a metadata-only intent update", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const pluginId = "com.acme.metadata-only-intent";
        const declaration = wideDeclaration(pluginId, "unchanged-declaration");
        const claimed = await operations.claimCollectionWriters({ accountId: account.id, input: { manifest: declaration.manifest },
            publisher: { machineId: "machine-a", installationId: "installation-a" } });
        const where = { accountId_pluginId: { accountId: account.id, pluginId } };
        const stored = await db.accountPluginIntent.findUniqueOrThrow({ where, select: { releaseLessDeclaration: true } });
        await db.$executeRaw`CREATE TRIGGER prevent_unchanged_declaration_write
            BEFORE UPDATE OF "releaseLessDeclaration" ON "AccountPluginIntent"
            BEGIN SELECT RAISE(ABORT, 'metadata edit rewrote declaration'); END`;
        try {
            const projectScope = { kind: "only" as const, projectKeys: ["project"] };
            const result = await operations.setIntent({ accountId: account.id, input: { pluginId, desiredVersion: null,
                enabled: true, offlineUiHosting: "disabled", writableCollections: [], projectScope,
                expectedRevision: claimed.intent.revision } });
            expect(result.intent).toMatchObject({ projectScope });
            expect(result.intent.revision).not.toBe(claimed.intent.revision);
            await expect(db.accountPluginIntent.findUniqueOrThrow({ where, select: { releaseLessDeclaration: true } }))
                .resolves.toEqual(stored);
        } finally {
            await db.$executeRaw`DROP TRIGGER prevent_unchanged_declaration_write`;
        }
    });

    it.each([1, 2, 3])("upgrades a V%i declaration without rewriting held bodies on subsequent claims", async (version) => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const accountId = account.id;
        const pluginId = `com.acme.split-declaration-v${version}`;
        const first = wideDeclaration(pluginId, "first-child");
        const machine = (id: string) => ({ machineId: id, installationId: `installation-${id}` });
        const initial = version === 1 ? first : version === 2
            ? { schemaVersion: 2, legacyDeclaration: null, machines: [
                { machineId: "a", machineInstallationId: "installation-a", declaration: first }] }
            : mergeReleaseLessDeclarationV2({ stored: null, declaration: first, publisher: machine("a") }).stored;
        const where = { accountId_pluginId: { accountId, pluginId } };
        await db.accountPluginIntent.create({ data: { accountId, pluginId, enabled: true, desiredVersion: null,
            writableCollections: [], releaseLessDeclaration: JSON.parse(JSON.stringify(initial)) } });
        const claim = (declaration: typeof first, id: string) => operations.claimCollectionWriters({ accountId,
            input: { manifest: declaration.manifest }, publisher: machine(id) });
        const read = (declaration: typeof first) => operations.readIntent({ accountId,
            input: { pluginId, declarationDigests: [declaration.manifestDigestSha256] } });
        expect((await read(first)).declarationBodies).toEqual([
            { declarationDigestSha256: first.manifestDigestSha256, manifest: first.manifest },
        ]);
        // A real claim upgrades the old row, without a bulk rewrite on open.
        await claim(first, "b");
        const upgraded = await db.accountPluginIntent.findUniqueOrThrow({ where, select: { releaseLessDeclaration: true } });
        expect(upgraded.releaseLessDeclaration).toMatchObject({ schemaVersion: 4 });
        expect(JSON.stringify(upgraded.releaseLessDeclaration)).not.toContain("first-child");
        const childDigests = () => db.$queryRaw<{ declarationDigest: string }[]>`
            SELECT "declarationDigest" FROM "AccountPluginDeclarationBody"
            WHERE "accountId" = ${accountId} AND "pluginId" = ${pluginId} ORDER BY "declarationDigest"
        `;
        expect(await childDigests()).toEqual([{ declarationDigest: first.manifestDigestSha256 }]);
        const changed = createReleaseLessDeclarationV1({ ...first.manifest, version: "2.0.0" });
        await db.$executeRaw`CREATE TRIGGER prevent_declaration_body_rewrite
            BEFORE UPDATE ON "AccountPluginDeclarationBody"
            BEGIN SELECT RAISE(ABORT, 'immutable declaration updated'); END`;
        try {
            await claim(changed, "b");
            // The V1 legacy root and the V2/V3 first Machine continue holding the first digest.
            expect((await childDigests()).map(row => row.declarationDigest)).toEqual(
                [first.manifestDigestSha256, changed.manifestDigestSha256].sort());
            expect((await read(changed)).declarationBodies).toEqual([
                { declarationDigestSha256: changed.manifestDigestSha256, manifest: changed.manifest },
            ]);
            const restored = await operations.claimCollectionWriters({ accountId, publisher: machine("b"),
                input: { pluginId, manifestDigestSha256: first.manifestDigestSha256 } });
            expect(restored.intent.pluginId).toBe(pluginId);
            expect(await childDigests()).toEqual([{ declarationDigest: first.manifestDigestSha256 }]);
            const resolved = await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId,
                refs: [{ pluginId, version: "1.0.0", machineId: "b" }] }));
            expect([...resolved.values()][0]?.manifest).toEqual(first.manifest);
        } finally {
            await db.$executeRaw`DROP TRIGGER prevent_declaration_body_rewrite`;
        }
        await db.accountPluginIntent.delete({ where });
        expect(await childDigests()).toEqual([]);
    });


    it("lists declaration digests from the body-free summary for compacted and per-Machine stores", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const compactedId = "com.acme.sqlite-compacted";
        const machineCopiesId = "com.acme.sqlite-machine-copies";
        const marker = "sqlite-intent-list-body";
        const compacted = wideDeclaration(compactedId, marker);
        let compactedStore: unknown = null;
        for (let index = 0; index < 5; index++) {
            compactedStore = mergeReleaseLessDeclarationV2({ stored: compactedStore, declaration: compacted,
                publisher: { machineId: `machine-${index}`, installationId: `installation-${index}` } }).stored;
        }
        // The supported schemaVersion 2 shape keeps one body per Machine entry.
        const machineCopies = wideDeclaration(machineCopiesId, marker);
        const machineCopiesStore = { schemaVersion: 2, legacyDeclaration: null, machines: Array.from({ length: 5 }, (_, index) => ({
            machineId: `machine-${index}`, machineInstallationId: `installation-${index}`, declaration: machineCopies })) };
        await db.accountPluginIntent.createMany({ data: [
            { accountId: account.id, pluginId: compactedId, enabled: true, desiredVersion: null, writableCollections: [],
                releaseLessDeclaration: JSON.parse(JSON.stringify(compactedStore)) },
            { accountId: account.id, pluginId: machineCopiesId, enabled: true, desiredVersion: null, writableCollections: [],
                releaseLessDeclaration: machineCopiesStore },
        ] });

        const listed = await observeBodyCopies(marker, () => operations.listIntentIds({ accountId: account.id, input: {} }));
        expect(listed.result.failedPluginIds).toEqual([]);
        const responses = new Map(listed.result.intentReads.map(read => [read.pluginId, read.response]));
        expect(responses.get(compactedId)?.currentDeclaration).toEqual({ declarationDigestSha256: compacted.manifestDigestSha256 });
        expect(responses.get(compactedId)?.machineDeclarations).toHaveLength(5);
        expect(responses.get(machineCopiesId)?.currentDeclaration).toEqual({ declarationDigestSha256: machineCopies.manifestDigestSha256 });
        expect(responses.get(machineCopiesId)?.machineDeclarations).toHaveLength(5);
        expect(listed.copies).toBe(0);
    });

    it("transfers only the selected manifest to the current-declaration reader and none to digest readers", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const pluginId = "com.acme.sqlite-current-declaration";
        const marker = "sqlite-current-declaration-body";
        const machineId = randomUUID();
        const declaration = wideDeclaration(pluginId, marker);
        const stored = { schemaVersion: 2, legacyDeclaration: null, machines: Array.from({ length: 5 }, (_, index) => ({
            machineId: index === 4 ? machineId : `machine-${index}`, machineInstallationId: `installation-${index}`, declaration })) };
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId, enabled: true,
            desiredVersion: null, writableCollections: [], releaseLessDeclaration: stored } });
        await db.machine.create({ data: { id: machineId, accountId: account.id, installationId: "installation-4",
            metadata: "{}", pluginMaterializationRevision: 1n } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, machineId,
            serverIdentityId: "srv_sqlite_declaration_test", materializationId: "test-materialization", pluginId, version: "1.0.0",
            sourceClass: "bundledFirstParty", portableRelease: false, uiArtifacts: [], enabled: true,
            trustState: "trusted", observedAt: new Date() } });

        const current = await observeBodyCopies(marker, () => inTx(tx => resolveCurrentPluginDeclarationsTx({ tx,
            accountId: account.id, refs: [{ pluginId, version: "1.0.0", machineId }] })));
        expect([...current.result.values()][0]).toEqual({ manifest: declaration.manifest,
            declarationDigestSha256: declaration.manifestDigestSha256 });
        expect(current.copies).toBe(1);

        const digests = await observeBodyCopies(marker, () => inTx(tx => resolveCurrentClaimablePluginMachineMaterializationTx({ tx,
            accountId: account.id, serverIdentityId: "srv_sqlite_declaration_test", machineId, machineInstallationId: "installation-4",
            materializationId: "test-materialization", pluginId, version: "1.0.0" })));
        expect(digests.result).toMatchObject({ kind: "current", declarationDigestSha256: declaration.manifestDigestSha256 });
        expect(digests.copies).toBe(0);

        // A replaced body at the selected path is never paired with the previously selected digest.
        const next = createReleaseLessDeclarationV1({ ...declaration.manifest, version: "2.0.0" });
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
            data: { releaseLessDeclaration: { ...stored, machines: [...stored.machines.slice(0, -1), { ...stored.machines[4]!, declaration: next }] } } });
        const replaced = await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId: account.id,
            refs: [{ pluginId, version: "1.0.0", machineId }] }));
        expect(replaced.size).toBe(0);
    });

    it("rejoins digest claims without transferring stored manifest bodies, and a new Machine's digest claim stores the full body", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const pluginId = "com.acme.sqlite-digest-claim";
        const marker = "sqlite-digest-claim-body";
        const declaration = wideDeclaration(pluginId, marker);
        const machineA = { machineId: "digest-machine-a", installationId: "digest-installation-a" };
        const machineB = { machineId: "digest-machine-b", installationId: "digest-installation-b" };
        const identity = { pluginId, manifestDigestSha256: declaration.manifestDigestSha256 };
        const admitted = await operations.claimCollectionWriters({ accountId: account.id,
            input: { manifest: declaration.manifest }, publisher: machineA });

        // A daemon restart claims every bundled plugin by digest; an unchanged rejoin needs no body.
        const rejoin = await observeBodyCopies(marker, () => operations.claimCollectionWriters({ accountId: account.id,
            input: identity, publisher: machineA }));
        expect(rejoin.result.intent.revision).toBe(admitted.intent.revision);
        expect(rejoin.copies).toBe(0);

        // A disabled intent still holds its declaration: the rejoin finds it without a body upload.
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } }, data: { enabled: false } });
        const disabled = await observeBodyCopies(marker, () => operations.claimCollectionWriters({ accountId: account.id,
            input: identity, publisher: machineA }));
        expect(disabled.result.intent).toMatchObject({ enabled: false, revision: admitted.intent.revision });
        expect(disabled.copies).toBe(0);
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } }, data: { enabled: true } });

        // A second Machine adopting the held digest writes its entry; the stored body stays complete.
        await operations.claimCollectionWriters({ accountId: account.id, input: identity, publisher: machineB });
        const stored = await operations.readIntent({ accountId: account.id, input: { pluginId,
            declarationDigests: [declaration.manifestDigestSha256] } });
        expect(stored.machineDeclarations?.map(entry => entry.machineId)).toEqual([machineA.machineId, machineB.machineId]);
        expect(stored.declarationBodies).toEqual([{ declarationDigestSha256: declaration.manifestDigestSha256, manifest: declaration.manifest }]);

        const missing = await operations.claimCollectionWriters({ accountId: account.id,
            input: { pluginId, manifestDigestSha256: `sha256:${"0".repeat(64)}` }, publisher: machineA }).then(() => null, (error: unknown) => error);
        expect(missing).toMatchObject({ code: "plugin_declaration_not_found" });
    });

    it("projects the same declarations as the domain owner reading the full stored body, for malformed and legacy envelopes", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const pluginId = "com.acme.sqlite-envelope-projection";
        const declaration = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({ schemaVersion: 2,
            id: pluginId, version: "1.0.0", displayName: "Envelope", engines: { happier: "^1.0.0" }, contributes: {} }));
        const machine = { machineId: "valid-machine", machineInstallationId: "valid-installation", declaration };
        const invalid = { ...machine, declaration: { ...declaration, manifest: { ...declaration.manifest, contributes: [] } } };
        let compacted: unknown = null;
        for (const publisher of ["machine-a", "machine-b"]) {
            compacted = mergeReleaseLessDeclarationV2({ stored: compacted, declaration,
                publisher: { machineId: publisher, installationId: `${publisher}-installation` } }).stored;
        }
        const cases: unknown[] = [declaration,
            { schemaVersion: 2, machines: [null, "malformed", invalid, machine], legacyDeclaration: null },
            { schemaVersion: 2, machines: [invalid], legacyDeclaration: declaration },
            { schemaVersion: 2, machines: [machine, { ...machine, machineId: "divergent-machine",
                declaration: createReleaseLessDeclarationV1({ ...declaration.manifest, version: "2.0.0" }) }], legacyDeclaration: declaration },
            { ...declaration, schemaVersion: 2, machines: "malformed" },
            { schemaVersion: 2, machines: [], legacyDeclaration: null },
            JSON.parse(JSON.stringify(compacted)),
            "not an object",
        ];
        for (const stored of cases) {
            await db.accountPluginIntent.upsert({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
                create: { accountId: account.id, pluginId, enabled: true, desiredVersion: null, writableCollections: [],
                    releaseLessDeclaration: stored as never },
                update: { releaseLessDeclaration: stored as never } });
            // Oracle: the canonical owner applied to the complete stored body.
            const intent = { enabled: true, desiredVersion: null, releaseLessDeclaration: stored };
            const owner = readCurrentPluginDeclarationV1({ pluginId, intent, release: null });
            const expectedMachines = readCurrentMachinePluginDeclarationsV1(intent, pluginId).map(entry => ({
                machineId: entry.machineId, machineInstallationId: entry.machineInstallationId,
                declaration: { declarationDigestSha256: entry.declaration.declarationDigestSha256 },
            }));
            const listed = await operations.listIntentIds({ accountId: account.id, input: {} });
            const exact = await operations.readIntent({ accountId: account.id, input: { pluginId } });
            expect(listed.failedPluginIds).toEqual([]);
            for (const response of [listed.intentReads[0]?.response, exact]) {
                expect(response?.currentDeclaration ?? null).toEqual(owner ? { declarationDigestSha256: owner.declarationDigestSha256 } : null);
                expect(response?.machineDeclarations ?? []).toEqual(expectedMachines);
            }
        }
    });
});
