import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE } from "@happier-dev/protocol/plugins/availability/v1";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { resolveCurrentClaimablePluginMachineMaterializationTx, resolveCurrentClaimablePluginMachineMaterializationsTx, createPluginAvailabilityOperations } from "./operations";
import { resolveCurrentPluginDeclarationsTx, readStoredPluginManifestV2 } from "./currentDeclaration";
import { createReleaseLessDeclarationV1, mergeReleaseLessDeclarationV2 } from "./currentDeclaration";
import { PluginManifestV2Schema } from "@happier-dev/protocol/plugins/manifest/v2";
import historicalUiGraphPublication from "./historicalUiGraphPublication.fixture.json";
import { acquireAccountChangePublicationLocksInTx } from "@/app/changes/markAccountChanged";
import { createDbMaintenanceClient, onDbClientQuery } from "@/storage/prisma";

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

    it("transfers only one selected manifest per concurrent current-declaration reader while the connection is held", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const pluginId = "com.acme.current-declaration";
        const machineId = randomUUID();
        const marker = "current-declaration-body-marker";
        const declaration = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({
            schemaVersion: 2, id: pluginId, version: "1.0.0", displayName: "Current declaration",
            engines: { happier: "^1.0.0" }, contributes: {},
            metadata: { measuredBody: marker + "x".repeat(128 * 1024) },
        }));
        // Stress fixture: 490 Machine envelopes in a single intent.
        const stored = { schemaVersion: 2, machines: Array.from({ length: 490 }, (_, index) => ({
            machineId: index === 489 ? machineId : `machine-${index}`, machineInstallationId: `installation-${index}`, declaration,
        })), legacyDeclaration: null };
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId, enabled: true,
            desiredVersion: null, writableCollections: [], releaseLessDeclaration: stored } });
        await db.machine.create({ data: { id: machineId, accountId: account.id, installationId: "installation-489",
            metadata: "{}", pluginMaterializationRevision: 1n } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, machineId,
            serverIdentityId: "srv_declaration_transfer_test", materializationId: "test-materialization", pluginId, version: "1.0.0",
            sourceClass: "bundledFirstParty", portableRelease: false, uiArtifacts: [], enabled: true,
            trustState: "trusted", observedAt: new Date() } });
        let replaceAfterIdentity: (() => Promise<unknown>) | undefined;
        const original = db.$transaction;
        const copies: number[] = [];
        const bytes: number[] = [];
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let transferredCopies = 0;
                let transferredBytes = 0;
                const observe = async (owner: object, method: (...args: unknown[]) => unknown, values: unknown[]) => {
                    const result = await Reflect.apply(method, owner, values);
                    const text = JSON.stringify(result, (_key, value) => typeof value === "bigint" ? String(value) : value);
                    transferredCopies += text.split(marker).length - 1;
                    transferredBytes += Buffer.byteLength(text);
                    if (replaceAfterIdentity && Array.isArray(result) && result.some(row => row
                        && typeof row === "object" && "releaseLessDeclaration" in row)) {
                        const replace = replaceAfterIdentity; replaceAfterIdentity = undefined;
                        await replace();
                    }
                    return result;
                };
                const observed = new Proxy(tx, { get(inner, property, receiver) {
                    const value = Reflect.get(inner, property, receiver);
                    if (property === "$queryRaw") return (...values: unknown[]) => observe(inner, value, values);
                    if (property === "accountPluginIntent") return new Proxy(value, { get(delegate, method, receiver) {
                        const operation = Reflect.get(delegate, method, receiver);
                        return typeof operation === "function" ? (...values: unknown[]) => observe(delegate, operation, values) : operation;
                    } });
                    return value;
                } });
                const result = await callback(observed);
                // Real backend is still in this interactive transaction after the observed transfer.
                const [{ held }] = await tx.$queryRaw<Array<{ held: boolean }>>`
                    SELECT xact_start IS NOT NULL AS held FROM pg_stat_activity WHERE pid = pg_backend_pid()`;
                expect(held).toBe(true);
                copies.push(transferredCopies); bytes.push(transferredBytes);
                return result;
            }, ...args.slice(1)]);
        } });
        try {
            const read = () => inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId: account.id,
                refs: [{ pluginId, version: "1.0.0", machineId }] }));
            const results = await Promise.all([read(), read()]);
            for (const result of results) expect([...result.values()][0]?.manifest).toEqual(declaration.manifest);
            console.info("CURRENT_DECLARATION_TRANSFER", JSON.stringify({ copies, bytes }));
            expect(copies).toEqual([1, 1]);
            const admittedDeclaration = [...results[0]!.values()][0]!;
            const revalidate = () => inTx(async tx => {
                await acquireAccountChangePublicationLocksInTx(tx, [account.id], { includeSingleAccount: true, intent: "serializing" });
                return resolveCurrentPluginDeclarationsTx({ tx, accountId: account.id,
                    refs: [{ pluginId, version: "1.0.0", machineId, machineInstallationId: "installation-489", admittedDeclaration }] });
            });
            expect([...(await revalidate()).values()][0]).toBe(admittedDeclaration);
            expect(copies.at(-1)).toBe(0);
            const wrongInstallation = await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId: account.id,
                refs: [{ pluginId, version: "1.0.0", machineId, machineInstallationId: "other-installation", admittedDeclaration }] }));
            expect(wrongInstallation.size).toBe(0);
            await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
                data: { enabled: false } });
            expect((await revalidate()).size).toBe(0);
            await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
                data: { enabled: true } });
            const readDigests = () => inTx(async tx => {
                const exact = await resolveCurrentClaimablePluginMachineMaterializationTx({ tx, accountId: account.id,
                    serverIdentityId: "srv_declaration_transfer_test", machineId, machineInstallationId: "installation-489",
                    materializationId: "test-materialization", pluginId, version: "1.0.0" });
                const batch = await resolveCurrentClaimablePluginMachineMaterializationsTx({ tx, accountId: account.id,
                    serverIdentityId: "srv_declaration_transfer_test", machineId, machineInstallationId: "installation-489" });
                return { exact, batch };
            });
            const initialDigests = await readDigests();
            expect(initialDigests.exact).toMatchObject({ kind: "current", declarationDigestSha256: declaration.manifestDigestSha256 });
            expect(initialDigests.batch).toHaveLength(1);
            expect(copies.at(-1)).toBe(0);
            console.info("CURRENT_DECLARATION_DIGEST_TRANSFER", JSON.stringify({ copies: copies.at(-1), bytes: bytes.at(-1) }));
            const next = createReleaseLessDeclarationV1({ ...declaration.manifest, version: "2.0.0" });
            await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
                data: { releaseLessDeclaration: { ...stored, machines: [...stored.machines.slice(0, -1),
                    { ...stored.machines[489]!, declaration: next }] } } });
            expect((await read()).size).toBe(0);
            expect((await revalidate()).size).toBe(0);
            const changedDigests = await readDigests();
            expect(changedDigests.exact.kind).toBe("notCurrent");
            expect(changedDigests.batch).toHaveLength(0);
            await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
                data: { releaseLessDeclaration: stored } });
            const replacement = createReleaseLessDeclarationV1({ ...declaration.manifest, displayName: "Replacement" });
            replaceAfterIdentity = () => db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
                data: { releaseLessDeclaration: { ...stored, machines: [...stored.machines.slice(0, -1),
                    { ...stored.machines[489]!, declaration: replacement }] } } });
            // READ COMMITTED may see a new body at the selected path. Never stamp it with the old digest.
            expect((await read()).size).toBe(0);
            expect([...((await read()).values())][0]?.declarationDigestSha256).toBe(replacement.manifestDigestSha256);
            expect((await revalidate()).size).toBe(0);
            expect(copies.at(-1)).toBe(0);
        } finally { db.$transaction = original; }
    });

    it("revalidates an admitted portable declaration without fetching its manifest", async () => {
        const { accountId, pluginIds: [pluginId] } = await fixture(1);
        const ref = { pluginId: pluginId!, version: "1.0.0" };
        const admittedDeclaration = [...(await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId, refs: [ref] }))).values()][0]!;
        const read = () => inTx(async tx => {
            await acquireAccountChangePublicationLocksInTx(tx, [accountId], { includeSingleAccount: true, intent: "serializing" });
            const originalFind = tx.accountPluginRelease.findMany;
            const find = originalFind.bind(tx.accountPluginRelease);
            let bodyReads = 0;
            tx.accountPluginRelease.findMany = (async (args: Parameters<typeof find>[0]) => {
                const rows = await find(args);
                bodyReads += rows.filter(row => "normalizedManifest" in row).length;
                return rows;
            }) as typeof tx.accountPluginRelease.findMany;
            try {
                const result = await resolveCurrentPluginDeclarationsTx({ tx, accountId, refs: [{ ...ref, admittedDeclaration }] });
                expect(bodyReads).toBe(0);
                return result;
            } finally {
                tx.accountPluginRelease.findMany = originalFind;
            }
        });
        expect([...(await read()).values()][0]).toBe(admittedDeclaration);
        await db.accountPluginRelease.update({ where: { accountId_pluginId_version: { accountId, ...ref } },
            data: { archiveDigestSha256: `sha256:${"c".repeat(64)}` } });
        expect((await read()).size).toBe(0);
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId, pluginId: ref.pluginId } },
            data: { desiredVersion: "2.0.0" } });
        expect((await read()).size).toBe(0);
    });

    it("fetches one consumed declaration body for a 490-Machine list, with set reads and fresh divergent claims", async () => {
        // Stress fixture: 490 envelopes and about 65 MB of declarations.
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
        const client = await createDbMaintenanceClient("postgres", undefined, { log: [{ emit: "event", level: "query" }] });
        let physicalStatements = 0;
        let declarationStatements = 0;
        onDbClientQuery(client, (event: Prisma.QueryEvent) => {
            if (/^\s*SELECT\b/i.test(event.query)) physicalStatements++;
            if (/\bi\."releaseLessDeclaration"/.test(event.query)) declarationStatements++;
        });
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
        const read = async (omitDeclarations = false) => {
            captured.length = 0;
            physicalStatements = 0;
            declarationStatements = 0;
            const result = await operations.listIntentIds({ accountId: account.id,
                input: omitDeclarations ? { omitDeclarations: true } : {} });
            const text = JSON.stringify(captured, (_key, value) => typeof value === "bigint" ? String(value) : value);
            return { result, statements: physicalStatements, declarationStatements,
                bodyCopies: text.split(bodyMarker).length - 1, fetchedBytes: Buffer.byteLength(text) };
        };
        try {
            // Session creation's Account census consumes enablement, not the
            // retained Account's 490 declaration bodies or their JSONB identity projection.
            // Exact custody revalidation uses the same SQL projection as the census.
            captured.length = 0;
            physicalStatements = 0;
            declarationStatements = 0;
            const custody = await operations.readIntent({ accountId: account.id,
                input: { pluginId, omitDeclarations: true } });
            const custodyRows = JSON.stringify(captured, (_key, value) => typeof value === "bigint" ? String(value) : value);
            expect(physicalStatements).toBe(1);
            expect(declarationStatements).toBe(0);
            expect(custodyRows).not.toContain(bodyMarker);
            expect(custody.intent?.enabled).toBe(true);
            expect(custody).not.toHaveProperty("currentDeclaration");
            expect(custody).not.toHaveProperty("machineDeclarations");
            const census = await read(true);
            expect(census.declarationStatements).toBe(0);
            expect(census.statements).toBe(1);
            expect(census.bodyCopies).toBe(0);
            expect(census.result.intentReads[0]?.response.intent?.enabled).toBe(true);
            expect(census.result.intentReads[0]?.response).not.toHaveProperty("currentDeclaration");
            expect(census.result.intentReads[0]?.response).not.toHaveProperty("machineDeclarations");
            await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
                data: { enabled: false } });
            await db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            const disabledCensus = await read(true);
            expect(disabledCensus.declarationStatements).toBe(0);
            expect(disabledCensus.result.availabilityCursor).toBeGreaterThan(census.result.availabilityCursor);
            expect(disabledCensus.result.intentReads[0]?.response.intent?.enabled).toBe(false);
            await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
                data: { enabled: true } });

            const agreed = await read();
            // The census carries declaration digests only: no body is read or sent.
            expect(agreed.declarationStatements).toBe(1);
            expect(agreed.result.failedPluginIds).toEqual([]);
            expect(agreed.result.intentReads[0]?.response.currentDeclaration)
                .toEqual({ declarationDigestSha256: declaration.manifestDigestSha256 });
            expect(agreed.result.intentReads[0]?.response.machineDeclarations).toHaveLength(490);
            expect.soft(agreed.bodyCopies).toBe(0);
            expect.soft(agreed.statements).toBe(1);
            expect(agreed.fetchedBytes).toBeLessThan(Buffer.byteLength(JSON.stringify(stored)));

            const secondPluginId = "com.acme.wide-intent-second";
            const secondDeclaration = createReleaseLessDeclarationV1({ ...declaration.manifest, id: secondPluginId });
            await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: secondPluginId,
                enabled: true, desiredVersion: null, writableCollections: [],
                releaseLessDeclaration: JSON.parse(JSON.stringify(secondDeclaration)) } });
            const multiple = await read();
            expect(multiple.result.intentReads).toHaveLength(2);
            expect(multiple.bodyCopies).toBe(0);
            expect(multiple.statements).toBe(1);
            await db.accountPluginIntent.delete({ where: { accountId_pluginId: { accountId: account.id, pluginId: secondPluginId } } });
            const exact = await operations.readIntent({ accountId: account.id, input: { pluginId } });
            expect(exact.machineDeclarations?.at(-1)?.declaration).toEqual({ declarationDigestSha256: declaration.manifestDigestSha256 });
            expect(JSON.stringify(exact)).not.toContain(bodyMarker);
            // 490 Machines share one digest: the requested body is sent once.
            const bodies = await operations.readIntent({ accountId: account.id,
                input: { pluginId, declarationDigests: [declaration.manifestDigestSha256] } });
            expect(JSON.stringify(bodies).split(bodyMarker).length - 1).toBe(1);

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
            expect(mixed.fetchedBytes).toBeLessThan(Buffer.byteLength(JSON.stringify(changed)));
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
        const client = await createDbMaintenanceClient("postgres", undefined, { log: [{ emit: "event", level: "query" }] });
        let counts = { selects: 0, account: 0, intent: 0, release: 0 };
        onDbClientQuery(client, (event: Prisma.QueryEvent) => {
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
            if (source === "claim") expect(listed.intentReads[0]?.response.currentDeclaration)
                .toEqual({ declarationDigestSha256: declaration.manifestDigestSha256 });
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

    it("checks portable materialization correspondence using release identity columns only", async () => {
        const { accountId, pluginIds: [pluginId] } = await fixture(1);
        const stranger = await fixture(0);
        const ref = { pluginId: pluginId!, version: "1.0.0" };
        const slot = { contributionId: "hosted", artifactId: "hosted", tier: "hostedWeb", platform: "web",
            artifactDigest: `sha256:${"d".repeat(64)}`, hostUiApiRange: "^1.0.0" };
        const releaseKey = { accountId_pluginId_version: { accountId, ...ref } };
        await db.accountPluginRelease.update({ where: releaseKey, data: { uiSlots: [slot] } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId, metadata: "{}",
            installationId: "portable-identity-installation", pluginMaterializationRevision: 1n } });
        const target = { accountId, serverIdentityId: "srv_portableIdentity", machineId: machine.id,
            machineInstallationId: machine.installationId!, materializationId: "portable-installation", ...ref };
        await db.pluginMachineMaterialization.create({ data: { accountId, serverIdentityId: target.serverIdentityId,
            machineId: machine.id, materializationId: target.materializationId, ...ref, sourceClass: "registryPackage",
            portableRelease: true, archiveDigestSha256: `sha256:${"a".repeat(64)}`, uiArtifacts: [slot],
            enabled: true, trustState: "trusted", observedAt: new Date() } });
        const client = await createDbMaintenanceClient("postgres", undefined, { log: [{ emit: "event", level: "query" }] });
        const releaseSelects: string[] = [];
        onDbClientQuery(client, (event: Prisma.QueryEvent) => {
            if (/^\s*SELECT\b/i.test(event.query) && event.query.includes('"AccountPluginRelease"')) {
                releaseSelects.push(event.query);
            }
        });
        const transaction = db.$transaction;
        await client.$connect();
        // Observe SQL at the genuine PostgreSQL boundary; both currentness owners stay real.
        db.$transaction = new Proxy(transaction, { apply(_target, _receiver, args: unknown[]) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        const read = () => inTx(async tx => {
            await acquireAccountChangePublicationLocksInTx(tx, [accountId], { includeSingleAccount: true, intent: "serializing" });
            return {
                exact: await resolveCurrentClaimablePluginMachineMaterializationTx({ tx, ...target }),
                batch: await resolveCurrentClaimablePluginMachineMaterializationsTx({ tx, ...target }),
            };
        });
        const expectCurrent = (value: Awaited<ReturnType<typeof read>>) => {
            expect(value.exact).toMatchObject({ kind: "current", declarationDigestSha256: `sha256:${"a".repeat(64)}` });
            expect(value.batch).toHaveLength(1);
        };
        const expectNotCurrent = (value: Awaited<ReturnType<typeof read>>) => {
            expect(value.exact).toEqual({ kind: "notCurrent" });
            expect(value.batch).toEqual([]);
        };
        try {
            expectCurrent(await read());
            expect(releaseSelects).toHaveLength(2);
            expect(releaseSelects.filter(sql => /"(?:normalizedManifest|collectionContracts|packageAssetArchive)"/.test(sql)),
                "Currentness must not transfer immutable release bodies under Account serialization").toEqual([]);
            await db.accountPluginRelease.update({ where: releaseKey, data: { archiveDigestSha256: `sha256:${"c".repeat(64)}` } });
            expectNotCurrent(await read());
            await db.accountPluginRelease.update({ where: releaseKey, data: { archiveDigestSha256: `sha256:${"a".repeat(64)}`,
                uiSlots: [{ ...slot, hostUiApiRange: "^2.0.0" }] } });
            expectNotCurrent(await read());
            await db.accountPluginRelease.update({ where: releaseKey, data: { uiSlots: [{ ...slot, artifactDigest: "invalid" }] } });
            expectNotCurrent(await read());
            await db.accountPluginRelease.update({ where: releaseKey, data: { uiSlots: [slot], normalizedManifest: {},
                collectionContracts: {}, packageAssetArchive: Prisma.DbNull } });
            // Immutable content was admitted by its writer; only correspondence facts decide currentness.
            expectCurrent(await read());
            expectNotCurrent(await inTx(async tx => {
                const isolated = { ...target, accountId: stranger.accountId };
                return { exact: await resolveCurrentClaimablePluginMachineMaterializationTx({ tx, ...isolated }),
                    batch: await resolveCurrentClaimablePluginMachineMaterializationsTx({ tx, ...isolated }) };
            }));
        } finally {
            db.$transaction = transaction;
            await client.$disconnect();
        }
    });
});
