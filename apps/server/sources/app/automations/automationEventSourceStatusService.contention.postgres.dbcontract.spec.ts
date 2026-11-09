import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizePluginReleaseFactsV1 } from "@happier-dev/protocol/plugins/availability/v1";
import { createPluginEventAutomationSetupResultV1JsonSchema } from "@happier-dev/protocol/automations/event-setup-result";
import { AutomationEventActionHttpRequestSchemasV1 } from "@happier-dev/protocol/automations/event";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { eventRouter } from "@/app/events/eventRouter";
import { deleteAutomation, ensureAutomationEventCatalogStateTx } from "./automationCrudService";
import { reportAutomationEventSourceStatusV1 } from "./automationEventSourceStatusService";

const serverIdentityId = "srv_serialAuditAutomationStatusPg1";
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

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Automation source status contention (PostgreSQL)", () => {
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

    it.each(["catalog", "source"] as const)("does not write or publish repeated HTTP-admitted %s facts for two Machines", async kind => {
        const first = await fixture();
        const second = await fixture({ account: first.account, materializationId: first.caller.materializationId });
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        const published = () => emitUpdate.mock.calls.filter(([update]) => (
            update.payload.body.t === "automation-source-status-updated"
        )).length;
        const input = kind === "catalog" ? first.catalog : first.source(0);
        await first.report(input);
        await second.report(kind === "catalog" ? second.catalog : second.source(0));
        expect(published()).toBe(2);
        const before = await db.account.findUniqueOrThrow({ where: { id: first.account.id }, select: { seq: true } });
        let writes = 0;
        const observeWrites = (tx: Tx) => {
            // Count mutations at the real persistence boundary; all implementations run normally.
            if (kind === "catalog") {
                const update = tx.automationEventSourceCatalogStatus.updateMany.bind(tx.automationEventSourceCatalogStatus);
                tx.automationEventSourceCatalogStatus.updateMany = args => {
                    writes++;
                    return update(args);
                };
            } else {
                const update = tx.automationEventSourceStatus.updateMany.bind(tx.automationEventSourceStatus);
                tx.automationEventSourceStatus.updateMany = args => {
                    writes++;
                    return update(args);
                };
            }
        };
        await observeTransactions(observeWrites, async () => {
            await first.report(input);
            await second.report(kind === "catalog" ? second.catalog : second.source(0));
        }, false);
        expect(writes).toBe(0);
        expect(published()).toBe(2);
        expect(await db.account.findUniqueOrThrow({ where: { id: first.account.id }, select: { seq: true } })).toEqual(before);

        const changed = kind === "catalog"
            ? { ...first.catalog, state: "reconciling" as const, adoptedRevision: null }
            : first.source(1);
        writes = 0;
        await observeTransactions(observeWrites, () => first.report(changed), false);
        expect(writes).toBe(1);
        expect(published()).toBe(3);
        const afterChange = await db.account.findUniqueOrThrow({ where: { id: first.account.id }, select: { seq: true } });
        writes = 0;
        await observeTransactions(observeWrites, () => first.report(kind === "catalog" ? changed : first.source(0)), false);
        expect(writes).toBe(0);
        expect(published()).toBe(3);
        expect(await db.account.findUniqueOrThrow({ where: { id: first.account.id }, select: { seq: true } })).toEqual(afterChange);
        const revisions = kind === "catalog"
            ? await db.automationEventSourceCatalogStatus.findMany({ where: { accountId: first.account.id }, select: { reporterMachineId: true, revision: true } })
            : await db.automationEventSourceStatus.findMany({ where: { triggerId: { in: [first.trigger.id, second.trigger.id] } }, select: { reporterMachineId: true, revision: true } });
        expect(revisions).toEqual(expect.arrayContaining([
            { reporterMachineId: first.caller.machineId, revision: 2 },
            { reporterMachineId: second.caller.machineId, revision: 1 },
        ]));
        expect(revisions).toHaveLength(2);
    });

    it("isolates concurrent Machine reporters with the same machine-local materialization id", async () => {
        const first = await fixture();
        const reporters = [first];
        for (let index = 1; index < 16; index++) {
            reporters.push(await fixture({ account: first.account, materializationId: first.caller.materializationId }));
        }
        // Match the 150-Machine incident without making irrelevant Machines reporters.
        await db.machine.createMany({ data: Array.from({ length: 134 }, () => ({
            id: randomUUID(), accountId: first.account.id, metadata: "{}", installationId: randomUUID(),
        })) });
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        let transactions = 0;
        const results = await observeTransactions(() => { transactions++; }, () => Promise.allSettled(
            reporters.map(reporter => reporter.report(reporter.catalog)),
        ), false);
        expect(results.map(result => result.status)).toEqual(reporters.map(() => "fulfilled"));
        expect(transactions).toBe(reporters.length);
        expect(await db.automationEventSourceCatalogStatus.count({ where: { accountId: first.account.id } }))
            .toBe(reporters.length);
        const published = () => emitUpdate.mock.calls.filter(([update]) => (
            update.payload.body.t === "automation-source-status-updated"
        )).length;
        expect(published()).toBe(reporters.length);
        const before = await db.account.findUniqueOrThrow({ where: { id: first.account.id }, select: { seq: true } });
        transactions = 0;
        await observeTransactions(() => { transactions++; }, () => Promise.all(
            reporters.map(reporter => reporter.report(reporter.catalog)),
        ), false);
        expect(transactions).toBe(reporters.length);
        expect(await db.account.findUniqueOrThrow({ where: { id: first.account.id }, select: { seq: true } }))
            .toEqual(before);
        expect(published()).toBe(reporters.length);
        expect(await db.automationEventSourceCatalogStatus.findMany({
            where: { accountId: first.account.id }, select: { revision: true },
        })).toEqual(reporters.map(() => ({ revision: 1 })));
        await first.report({ ...first.catalog, state: "reconciling", adoptedRevision: null });
        expect(published()).toBe(reporters.length + 1);

        transactions = 0;
        await observeTransactions(() => { transactions++; }, () => Promise.all(
            reporters.map(reporter => reporter.report(reporter.source(1))),
        ), false);
        expect(transactions).toBe(reporters.length);
        expect(await db.automationEventSourceStatus.count({ where: {
            triggerId: { in: reporters.map(reporter => reporter.trigger.id) },
        } })).toBe(reporters.length);
        expect(published()).toBe(reporters.length * 2 + 1);
        const beforeEqualSources = await db.account.findUniqueOrThrow({
            where: { id: first.account.id }, select: { seq: true },
        });
        await Promise.all(reporters.map(reporter => reporter.report(reporter.source(0))));
        expect(await db.account.findUniqueOrThrow({ where: { id: first.account.id }, select: { seq: true } }))
            .toEqual(beforeEqualSources);
        expect(await db.automationEventSourceStatus.findMany({
            where: { triggerId: { in: reporters.map(reporter => reporter.trigger.id) } }, select: { revision: true },
        })).toEqual(reporters.map(() => ({ revision: 1 })));
        expect(published()).toBe(reporters.length * 2 + 1);
    });

    it.each([true, false])("preserves concurrent source deltas when a status row already exists: %s", async exists => {
        const input = await fixture();
        if (exists) await input.report(input.source(1));
        let interleaved = false;
        await observeTransactions(tx => {
            const find = tx.automationEventSourceStatus.findUnique.bind(tx.automationEventSourceStatus);
            tx.automationEventSourceStatus.findUnique = (async (args: Parameters<typeof find>[0]) => {
                const row = await find(args);
                if (!interleaved) { interleaved = true; await input.report(input.source(5)); }
                return row;
            }) as unknown as typeof tx.automationEventSourceStatus.findUnique;
        }, () => input.report(input.source(2)));
        expect(await db.automationEventSourceStatus.findUniqueOrThrow({ where: { triggerId: input.trigger.id } }))
            .toMatchObject({ observedCount: exists ? 8 : 7, admittedCount: exists ? 8 : 7, revision: exists ? 3 : 2 });
        expect(interleaved).toBe(true);
    });

    it.each([true, false])("coalesces concurrent equal catalog receipts and publishes one semantic change: %s", async exists => {
        const input = await fixture();
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        if (exists) await input.report(input.catalog);
        let interleaved = false;
        await observeTransactions(tx => {
            const find = tx.automationEventSourceCatalogStatus.findUnique.bind(tx.automationEventSourceCatalogStatus);
            tx.automationEventSourceCatalogStatus.findUnique = (async (args: Parameters<typeof find>[0]) => {
                const row = await find(args);
                if (!interleaved) { interleaved = true; await input.report(input.catalog); }
                return row;
            }) as unknown as typeof tx.automationEventSourceCatalogStatus.findUnique;
        }, () => input.report(input.catalog));
        expect(await db.automationEventSourceCatalogStatus.findFirstOrThrow({ where: { accountId: input.account.id } }))
            .toMatchObject({ revision: 1, observedRevision: 7n, state: "current" });
        expect(emitUpdate.mock.calls.filter(([update]) => (
            update.payload.body.t === "automation-source-status-updated"
        ))).toHaveLength(1);

        await input.report({
            ...input.catalog,
            adoptedRevision: null,
            state: "reconciling",
            nextRetryAt: Date.now() + 60_000,
        });
        expect(await db.automationEventSourceCatalogStatus.findFirstOrThrow({ where: { accountId: input.account.id } }))
            .toMatchObject({ revision: 2, observedRevision: 7n, adoptedRevision: null, state: "reconciling" });
        expect(emitUpdate.mock.calls.filter(([update]) => (
            update.payload.body.t === "automation-source-status-updated"
        ))).toHaveLength(2);
        expect(interleaved).toBe(true);
    });

    it("refuses a catalog current report if the definition revision advances after its initial admission", async () => {
        const input = await fixture();
        let interleaved = false;
        await expect(observeTransactions(tx => {
            const find = tx.automationEventCatalogState.findUnique.bind(tx.automationEventCatalogState);
            tx.automationEventCatalogState.findUnique = (async (args: Parameters<typeof find>[0]) => {
                const row = await find(args);
                if (!interleaved) {
                    interleaved = true;
                    await inTx(async peer => {
                        await ensureAutomationEventCatalogStateTx({ tx: peer, accountId: input.account.id, projectionChanged: true });
                        await markAccountChanged(peer, { accountId: input.account.id, kind: "automation", entityId: input.automation.id });
                    });
                }
                return row;
            }) as unknown as typeof tx.automationEventCatalogState.findUnique;
        }, () => input.report(input.catalog))).rejects.toMatchObject({ code: "catalog_revision_not_current" });
        expect(await db.automationEventSourceCatalogStatus.count({ where: { accountId: input.account.id } })).toBe(0);
        expect(interleaved).toBe(true);
    });

    it("does not recreate a source summary if definition deletion commits after initial admission", async () => {
        const input = await fixture();
        let interleaved = false;
        await expect(observeTransactions(tx => {
            const find = tx.automationEventSourceStatus.findUnique.bind(tx.automationEventSourceStatus);
            tx.automationEventSourceStatus.findUnique = (async (args: Parameters<typeof find>[0]) => {
                const row = await find(args);
                if (!interleaved) {
                    interleaved = true;
                    expect(await deleteAutomation({ accountId: input.account.id, automationId: input.automation.id })).not.toBe(false);
                }
                return row;
            }) as unknown as typeof tx.automationEventSourceStatus.findUnique;
        }, () => input.report(input.source(1)))).rejects.toMatchObject({ code: "definition_not_current" });
        expect(await db.automationEventSourceStatus.count({ where: { triggerId: input.trigger.id } })).toBe(0);
        expect(interleaved).toBe(true);
    });

    it.each(["source", "catalog"] as const)("commits a %s report while the Account cursor changes on every attempt", async kind => {
        const input = await fixture();
        let interleavings = 0;
        await observeTransactions(tx => {
            let observed = false;
            const advance = async () => {
                if (observed) return;
                observed = true;
                interleavings++;
                await db.account.update({ where: { id: input.account.id }, data: { seq: { increment: 1 } } });
            };
            if (kind === "source") {
                const find = tx.automationEventSourceStatus.findUnique.bind(tx.automationEventSourceStatus);
                tx.automationEventSourceStatus.findUnique = (async (args: Parameters<typeof find>[0]) => {
                    const row = await find(args); await advance(); return row;
                }) as unknown as typeof tx.automationEventSourceStatus.findUnique;
            } else {
                const find = tx.automationEventSourceCatalogStatus.findUnique.bind(tx.automationEventSourceCatalogStatus);
                tx.automationEventSourceCatalogStatus.findUnique = (async (args: Parameters<typeof find>[0]) => {
                    const row = await find(args); await advance(); return row;
                }) as unknown as typeof tx.automationEventSourceCatalogStatus.findUnique;
            }
        }, () => input.report(kind === "source" ? input.source(1) : input.catalog), false);
        expect(interleavings).toBeGreaterThan(0);
    });
});
