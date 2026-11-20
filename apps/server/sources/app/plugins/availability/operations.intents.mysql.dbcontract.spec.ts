import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PluginManifestV2Schema } from "@happier-dev/protocol/plugins/manifest/v2";
import { MAX_PLUGIN_IDENTIFIER_BYTES } from "@happier-dev/protocol/plugins/plugin-id";
import { db, getDbProviderFromEnv, initDbMysql } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { observePrismaRequests } from "@/testkit/observeSqliteRequests";
import { createPluginAvailabilityOperations, resolveCurrentClaimablePluginMachineMaterializationTx } from "./operations";
import { compactReleaseLessDeclarations, createReleaseLessDeclarationV1, mergeReleaseLessDeclarationV2, readCurrentMachinePluginDeclarationsV1, readCurrentPluginDeclarationV1,
    resolveCurrentPluginDeclarationsTx } from "./currentDeclaration";

const operations = createPluginAvailabilityOperations({ resolveHostingCapability: () => ({ enabled: false }) });

/** Count manifest-body copies returned by the real MySQL engine boundary. */
async function observeBodyCopies<T>(marker: string, run: () => Promise<T>): Promise<{ result: T; copies: number }> {
    let copies = 0;
    const stop = observePrismaRequests(db, { after: (_request, result) => {
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

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "mysql")("Availability intent reads on MySQL", () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL for the MySQL Availability contract");
        await initDbMysql();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it("lists declaration digests from the body-free summary and rejoins digest claims without bodies", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const pluginId = "com.acme.mysql-summary";
        const marker = "mysql-intent-list-body";
        const declaration = wideDeclaration(pluginId, marker);
        const publishers = Array.from({ length: 5 }, (_, index) => ({ machineId: `machine-${index}`, installationId: `installation-${index}` }));
        const admitted = await operations.claimCollectionWriters({ accountId: account.id, input: { manifest: declaration.manifest }, publisher: publishers[0] });
        for (const publisher of publishers.slice(1)) {
            await operations.claimCollectionWriters({ accountId: account.id,
                input: { pluginId, manifestDigestSha256: declaration.manifestDigestSha256 }, publisher });
        }

        const listed = await observeBodyCopies(marker, () => operations.listIntentIds({ accountId: account.id, input: {} }));
        const response = listed.result.intentReads[0]?.response;
        expect(response?.currentDeclaration).toEqual({ declarationDigestSha256: declaration.manifestDigestSha256 });
        expect(response?.machineDeclarations?.map(entry => entry.machineId)).toEqual(publishers.map(publisher => publisher.machineId));
        expect(listed.copies).toBe(0);

        const rejoin = await observeBodyCopies(marker, () => operations.claimCollectionWriters({ accountId: account.id,
            input: { pluginId, manifestDigestSha256: declaration.manifestDigestSha256 }, publisher: publishers[3] }));
        expect(rejoin.copies).toBe(0);
        const stored = await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: { accountId: account.id, pluginId } } });
        expect(rejoin.result.intent.revision).toBe(String(stored.revision));
        expect(BigInt(rejoin.result.intent.revision)).toBe(BigInt(admitted.intent.revision) + 4n);
        const exact = await operations.readIntent({ accountId: account.id, input: { pluginId,
            declarationDigests: [declaration.manifestDigestSha256] } });
        expect(exact.declarationBodies).toEqual([{ declarationDigestSha256: declaration.manifestDigestSha256, manifest: declaration.manifest }]);
    });

    it("reads a requested body at the canonical plugin identifier width", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const prefix = "com.acme.";
        const pluginId = prefix + "a".repeat(MAX_PLUGIN_IDENTIFIER_BYTES - prefix.length);
        const declaration = wideDeclaration(pluginId, "mysql-max-plugin-id");
        const inline = compactReleaseLessDeclarations(declaration, pluginId);
        const where = { accountId_pluginId: { accountId: account.id, pluginId } };
        await db.accountPluginIntent.create({ data: { ...where.accountId_pluginId, enabled: true,
            desiredVersion: null, writableCollections: [], releaseLessDeclaration: inline } });
        const readBody = () => operations.readIntent({ accountId: account.id, input: { pluginId,
            declarationDigests: [declaration.manifestDigestSha256] } });
        const expected = [{ declarationDigestSha256: declaration.manifestDigestSha256, manifest: declaration.manifest }];
        expect((await readBody()).declarationBodies).toEqual(expected);
        const { manifests: _bodies, ...references } = inline;
        await inTx(async tx => {
            await tx.accountPluginIntent.update({ where, data: { releaseLessDeclaration: { ...references, schemaVersion: 4 } } });
            await tx.accountPluginDeclarationBody.create({ data: { ...where.accountId_pluginId,
                declarationDigest: declaration.manifestDigestSha256, manifest: declaration.manifest } });
        });
        expect((await readBody()).declarationBodies).toEqual(expected);
    });

    it("transfers only the selected manifest to the current-declaration reader and never a replaced body", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const pluginId = "com.acme.mysql-current-declaration";
        const marker = "mysql-current-declaration-body";
        const machineId = randomUUID();
        const declaration = wideDeclaration(pluginId, marker);
        const stored = { schemaVersion: 2, legacyDeclaration: null, machines: Array.from({ length: 5 }, (_, index) => ({
            machineId: index === 4 ? machineId : `machine-${index}`, machineInstallationId: `installation-${index}`, declaration })) };
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId, enabled: true,
            desiredVersion: null, writableCollections: [], releaseLessDeclaration: stored } });
        await db.machine.create({ data: { id: machineId, accountId: account.id, installationId: "installation-4",
            metadata: "{}", pluginMaterializationRevision: 1n } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, machineId,
            serverIdentityId: "srv_mysql_declaration_test", materializationId: "test-materialization", pluginId, version: "1.0.0",
            sourceClass: "bundledFirstParty", portableRelease: false, uiArtifacts: [], enabled: true,
            trustState: "trusted", observedAt: new Date() } });

        const current = await observeBodyCopies(marker, () => inTx(tx => resolveCurrentPluginDeclarationsTx({ tx,
            accountId: account.id, refs: [{ pluginId, version: "1.0.0", machineId }] })));
        expect([...current.result.values()][0]).toEqual({ manifest: declaration.manifest,
            declarationDigestSha256: declaration.manifestDigestSha256 });
        expect(current.copies).toBe(1);

        const digests = await observeBodyCopies(marker, () => inTx(tx => resolveCurrentClaimablePluginMachineMaterializationTx({ tx,
            accountId: account.id, serverIdentityId: "srv_mysql_declaration_test", machineId, machineInstallationId: "installation-4",
            materializationId: "test-materialization", pluginId, version: "1.0.0" })));
        expect(digests.result).toMatchObject({ kind: "current", declarationDigestSha256: declaration.manifestDigestSha256 });
        expect(digests.copies).toBe(0);

        const next = createReleaseLessDeclarationV1({ ...declaration.manifest, version: "2.0.0" });
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
            data: { releaseLessDeclaration: { ...stored, machines: [...stored.machines.slice(0, -1), { ...stored.machines[4]!, declaration: next }] } } });
        const replaced = await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId: account.id,
            refs: [{ pluginId, version: "1.0.0", machineId }] }));
        expect(replaced.size).toBe(0);
    });

    it("projects the same declarations as the domain owner reading the full stored body, for malformed and legacy envelopes", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const pluginId = "com.acme.mysql-envelope-projection";
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
