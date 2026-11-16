import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizePluginReleaseFactsV1 } from "@happier-dev/protocol/plugins/availability/v1";
import { createPluginEventAutomationSetupResultV1JsonSchema } from "@happier-dev/protocol/automations/event-setup-result";
import { AutomationEventActionHttpRequestSchemasV1 } from "@happier-dev/protocol/automations/event";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { type Tx } from "@/storage/inTx";
import { reportAutomationEventSourceStatusV1 } from "./automationEventSourceStatusService";
import { compactReleaseLessDeclarations, createReleaseLessDeclarationV1 } from "@/app/plugins/availability/currentDeclaration";

const serverIdentityId = "srv_overbuiltAutomationStatusPg1";
const pluginId = "com.happier.automation-status-pg";
const version = "1.0.0";
const eventLocalId = "repository-event";
const sourceConfigSchema = { type: "object", additionalProperties: false } as const;
const release = normalizePluginReleaseFactsV1({
    ref: { pluginId, version }, archiveDigestSha256: `sha256:${"a".repeat(64)}`,
    normalizedManifest: {
        schemaVersion: 2, id: pluginId, version, displayName: "Automation status PostgreSQL contract",
        engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 }, entrypoints: { daemon: "./dist/index.js" },
        contributes: {
            actions: [{ id: "setup", title: "Set up source", scopes: ["global"], surfaces: ["plugin"],
                dangerLevel: "safe", execution: { target: "daemon" }, inputSchema: sourceConfigSchema,
                resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceConfigSchema) }],
            events: [{ id: eventLocalId, kind: "event", title: "Repository event", payloadSchema: sourceConfigSchema,
                automation: { v: 1, eligible: true, source: { sourceContractVersion: 1,
                    supportedObservationTransports: ["checkpointedPull"], sourceConfigSchema,
                    setupActionRef: { pluginId, localId: "setup" } } } }],
        },
    },
    collectionContracts: [], uiSlots: [],
    packageAssetArchive: { archiveDigestSha256: `sha256:${"d".repeat(64)}`, resources: [] },
});

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Automation source status publication lock (PostgreSQL)", () => {
    const accountIds: string[] = [];
    const previousIdentity = process.env.HAPPIER_SERVER_IDENTITY_ID;
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = serverIdentityId;
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
        if (connected) {
            const where = { accountId: { in: accountIds } };
            await db.automationEventSourceCatalogStatus.deleteMany({ where });
            await db.automation.deleteMany({ where });
            await db.pluginMachineMaterialization.deleteMany({ where });
            await db.accountPluginIntent.deleteMany({ where });
            await db.accountPluginRelease.deleteMany({ where });
            await db.machine.deleteMany({ where });
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
            await db.$disconnect();
        }
        if (previousIdentity === undefined) delete process.env.HAPPIER_SERVER_IDENTITY_ID;
        else process.env.HAPPIER_SERVER_IDENTITY_ID = previousIdentity;
    });

    async function fixture(shared?: Readonly<{ account: { id: string }; materializationId: string }>) {
        const account = shared?.account ?? await db.account.create({ data: { encryptionMode: "plain" } });
        if (!shared) accountIds.push(account.id);
        const machineId = randomUUID();
        const machineInstallationId = randomUUID();
        const materializationId = shared?.materializationId ?? `daemon-selected:${pluginId}`;
        await db.machine.create({ data: { id: machineId, accountId: account.id,
            metadata: "{}", installationId: machineInstallationId, pluginMaterializationRevision: 1n } });
        if (!shared) await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId,
            desiredVersion: version, enabled: true, writableCollections: [] } });
        if (!shared) await db.accountPluginRelease.create({ data: { accountId: account.id, pluginId, version,
            archiveDigestSha256: release.archiveDigestSha256, normalizedManifest: release.normalizedManifest,
            collectionContracts: [], uiSlots: [], packageAssetArchive: release.packageAssetArchive } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId,
            machineId, materializationId, pluginId, version, sourceClass: "registryPackage", portableRelease: true,
            archiveDigestSha256: release.archiveDigestSha256, uiArtifacts: [], enabled: true,
            trustState: "trusted", observedAt: new Date() } });
        const automation = await db.automation.create({ data: { accountId: account.id, name: "Source status contract",
            enabled: true, targetType: "new_session", templateVersion: 7,
            templateCiphertext: JSON.stringify({ kind: "happier_automation_template_plain_v1", payload: { prompt: "observe" } }) } });
        const sourceSelectorId = randomUUID();
        const trigger = await db.automationTrigger.create({ data: { automationId: automation.id,
            kind: "pluginEvent", enabled: true, revision: 7, eventPluginId: pluginId, eventLocalId,
            sourceSelectorId, sourceContractVersion: 1, observationTransport: "checkpointedPull",
            watcherMachineId: machineId, watcherMachineInstallationId: machineInstallationId,
            watcherPluginId: pluginId, watcherMaterializationId: materializationId,
            definitionEnvelope: JSON.stringify({ t: "plain", v: {} }) } });
        if (!shared) await db.automationEventCatalogState.create({ data: { accountId: account.id, eventSourceDefinitionsRevision: 7n } });
        const caller = { pluginId, machineId, machineInstallationId, materializationId,
            sourceCustody: { kind: "managed" as const, immutableGenerationId: "status-postgres-generation", installSource: "archive" as const } };
        const source = (delta: number) => ({ kind: "source" as const, automationId: automation.id,
            triggerId: trigger.id, triggerRevision: 7, eventRef: { pluginId, localId: eventLocalId }, sourceSelectorId,
            state: "observing" as const, code: "none" as const, nextRetryAt: null,
            observedDelta: delta, admittedDelta: delta, skippedDelta: 0 });
        const catalog = { kind: "catalogReconciliation" as const, scope: { kind: "checkpointedPull" as const },
            observedRevision: "7", adoptedRevision: "7", state: "current" as const,
            scanStartedAt: Date.now(), nextRetryAt: null };
        const report = (input: unknown) => {
            // Use the actual HTTP admission shape, including validator-neutral custody objects.
            const request = AutomationEventActionHttpRequestSchemasV1["automation.event.source.status.report"].parse({
                v: 1,
                caller: { pluginId, occurrenceId: "status-postgres-occurrence", sourceCustody: caller.sourceCustody,
                    materialization: { machineId, materializationId, pluginId } },
                input,
            });
            return reportAutomationEventSourceStatusV1({ accountId: account.id,
                caller: { ...caller, sourceCustody: request.caller.sourceCustody }, input: request.input });
        };
        return { account, automation, trigger, source, catalog, report, caller };
    }

    /** Select the real DB isolation boundary; no report/currentness logic is mocked. */
    async function observeTransactions<T>(observe: (tx: Tx) => void, run: () => Promise<T>, forceReadCommitted = true): Promise<T> {
        const original = db.$transaction.bind(db);
        db.$transaction = (async <R>(callback: (tx: Tx) => Promise<R>, options?: { isolationLevel?: "Serializable" | "RepeatableRead" | "ReadCommitted"; timeout?: number; maxWait?: number }) =>
            original(async tx => { observe(tx); return await callback(tx); },
                { ...options, ...(forceReadCommitted ? { isolationLevel: "ReadCommitted" as const } : {}) })) as typeof db.$transaction;
        try { return await run(); }
        finally { db.$transaction = original; }
    }

    // OWNER-RULINGS 2026-11-16 "Remove overbuilt re-reads": the report's own admission decides
    // currentness once; the status projection discards rows whose trigger revision or reporter is no
    // longer current. Re-resolving the plugin declaration under the Account publication lock made every
    // other Account writer wait for the multi-second identity/manifest reads (P03-DB-TX, 10:34Z).
    it.each(["catalog", "source"] as const)("runs no plugin declaration read while holding Account publication (%s)", async kind => {
        const input = await fixture();
        await db.accountPluginIntent.update({
            where: { accountId_pluginId: { accountId: input.account.id, pluginId } },
            data: { desiredVersion: null, releaseLessDeclaration: compactReleaseLessDeclarations({
                schemaVersion: 2,
                machines: [{ machineId: input.caller.machineId,
                    machineInstallationId: input.caller.machineInstallationId,
                    declaration: createReleaseLessDeclarationV1(release.normalizedManifest) }],
                legacyDeclaration: null,
            }, pluginId) },
        });
        await db.pluginMachineMaterialization.updateMany({
            where: { accountId: input.account.id },
            data: { sourceClass: "localPath", portableRelease: false, archiveDigestSha256: null },
        });
        let declarationReads = 0;
        let lockedDeclarationReads = 0;
        // Prisma reuses the interactive transaction client object: restore what this case wraps.
        const restores: Array<() => void> = [];
        try { await observeTransactions(tx => {
            const originalRaw = tx.$queryRaw;
            const originalUnsafe = tx.$queryRawUnsafe;
            restores.push(() => { tx.$queryRaw = originalRaw; tx.$queryRawUnsafe = originalUnsafe; });
            let accountLocked = false;
            const isPublicationLock = (text: string) => text.includes('FROM "Account"') && text.includes("FOR NO KEY UPDATE");
            const unsafe = tx.$queryRawUnsafe.bind(tx);
            tx.$queryRawUnsafe = (async (sql: string, ...values: unknown[]) => {
                const rows = await unsafe(sql, ...values);
                if (isPublicationLock(sql)) accountLocked = true;
                return rows;
            }) as typeof tx.$queryRawUnsafe;
            const query = tx.$queryRaw.bind(tx);
            tx.$queryRaw = (async (...args: Parameters<typeof query>) => {
                const sql = args[0];
                const text = typeof sql === "object" && sql !== null && "sql" in sql ? String(sql.sql) : String(sql);
                if (isPublicationLock(text)) accountLocked = true;
                // Identity projection and selected-body reads both scan the stored declaration document.
                if (text.includes('"AccountPluginIntent"') && text.includes('"releaseLessDeclaration"')) {
                    declarationReads++;
                    if (accountLocked) lockedDeclarationReads++;
                }
                return query(...args);
            }) as typeof tx.$queryRaw;
        }, () => input.report(kind === "catalog" ? input.catalog : input.source(1)), false); }
        finally { for (const restore of restores.reverse()) restore(); }
        expect(declarationReads).toBeGreaterThan(0);
        expect(lockedDeclarationReads).toBe(0);
        expect(await db.accountChange.count({ where: { accountId: input.account.id, kind: "automation" } })).toBe(1);
    });

});
