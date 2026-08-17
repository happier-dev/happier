import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    normalizePluginReleaseFactsV1,
} from "@happier-dev/protocol";

import { eventRouter } from "@/app/events/eventRouter";
import {
    claimPluginWebhookDeliveryV1,
    renewPluginWebhookDeliveryV1,
    validateCurrentPluginWebhookInvocationReferenceTxV1,
} from "@/app/plugins/webhooks/claimStore";
import { retargetPluginWebhookEndpointV1 } from "@/app/plugins/webhooks/endpointStore";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    AutomationEventSourceStatusReportError,
    reportAutomationEventSourceStatusV1,
} from "./automationEventSourceStatusService";
import { getAutomation } from "./automationCrudService";
import { loadAutomationV3EventStatusProjections } from "./automationV3EventStatusProjection";

const ACCOUNT_ID = "account-automation-source-status";
const MACHINE_ID = "machine-automation-source-status";
const MACHINE_INSTALLATION_ID = "installation-automation-source-status";
const MATERIALIZATION_ID = "materialization-automation-source-status";
const SERVER_IDENTITY_ID = "srv_automationSourceStatusCurrent1";
const PLUGIN_ID = "com.acme.github";
const PLUGIN_VERSION = "1.0.0";
const EVENT_LOCAL_ID = "repository-event";
const AUTOMATION_ID = "automation-source-status";
const SOURCE_SELECTOR_ID = "48d496d6-2105-465a-b363-a0ce80d6594f";
const DURABLE_PUSH_ENDPOINT_ID = "wh_ep_AAECAwQFBgcICQoLDA0ODw";

const caller = {
    pluginId: PLUGIN_ID,
    machineId: MACHINE_ID,
    machineInstallationId: MACHINE_INSTALLATION_ID,
    materializationId: MATERIALIZATION_ID,
    immutableGenerationId: "github-immutable-generation-a",
} as const;

function releaseFacts(params: Readonly<{
    version?: string;
    supportedObservationTransports?: readonly ("checkpointedPull" | "durablePush")[];
    includeEligibleEvent?: boolean;
}> = {}) {
    const version = params.version ?? PLUGIN_VERSION;
    const supportedObservationTransports = params.supportedObservationTransports ?? ["checkpointedPull"];
    const supportsDurablePush = supportedObservationTransports.includes("durablePush");
    return normalizePluginReleaseFactsV1({
        ref: { pluginId: PLUGIN_ID, version },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        normalizedManifest: {
            schemaVersion: 2,
            id: PLUGIN_ID,
            version,
            displayName: "Automation source status fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: "./dist/index.js" },
            contributes: {
                actions: supportsDurablePush ? [{
                    id: "receive-repository-events",
                    title: "Receive repository events",
                    scopes: ["global"],
                    surfaces: ["plugin"],
                    dangerLevel: "safe",
                }] : [],
                events: params.includeEligibleEvent === false ? [] : [{
                    id: EVENT_LOCAL_ID,
                    kind: "event",
                    title: "Repository event",
                    payloadSchema: { type: "object", additionalProperties: false },
                    automation: {
                        v: 1,
                        eligible: true,
                        source: {
                            sourceContractVersion: 1,
                            supportedObservationTransports,
                            ...(supportsDurablePush ? {
                                webhookContributionRef: {
                                    pluginId: PLUGIN_ID,
                                    localId: "repository-events",
                                },
                            } : {}),
                            sourceConfigSchema: { type: "object", additionalProperties: false },
                        },
                    },
                }],
                webhooks: supportsDurablePush ? [{
                    id: "repository-events",
                    title: "Repository events",
                    verifier: { kind: "github_hmac_sha256_v1", routing: "accountEndpoint" },
                    handlerAction: { localId: "receive-repository-events" },
                }] : [],
            },
        },
        collectionContracts: [],
        uiSlots: [],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"d".repeat(64)}`,
            resources: [],
        },
    });
}

describe("Automation Event source status", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-source-status-",
            initAuth: false,
            env: { HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID },
        });
    }, 120_000);

    afterAll(async () => await harness?.close());

    afterEach(async () => {
        vi.restoreAllMocks();
        harness?.resetEnv();
        await harness?.resetDbTables([
            () => db.automationEventSourceCatalogStatus.deleteMany(),
            () => db.automationEventSourceStatus.deleteMany(),
            () => db.automationEventCatalogState.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.pluginWebhookDelivery.deleteMany(),
            () => db.pluginWebhookEndpoint.deleteMany(),
            () => db.pluginWebhookRoute.deleteMany(),
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seed(options: Readonly<{
        catalogState?: boolean;
        supportedObservationTransports?: readonly ("checkpointedPull" | "durablePush")[];
    }> = {}): Promise<void> {
        const release = releaseFacts({
            ...(options.supportedObservationTransports === undefined
                ? {}
                : { supportedObservationTransports: options.supportedObservationTransports }),
        });
        await db.account.create({
            data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" },
        });
        await db.machine.create({
            data: {
                id: MACHINE_ID,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: MACHINE_INSTALLATION_ID,
                pluginMaterializationRevision: 1n,
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                desiredVersion: PLUGIN_VERSION,
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                archiveDigestSha256: release.archiveDigestSha256,
                normalizedManifest: release.normalizedManifest,
                collectionContracts: [],
                uiSlots: [],
                packageAssetArchive: release.packageAssetArchive,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: MATERIALIZATION_ID,
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: release.archiveDigestSha256,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-10T00:00:00.000Z"),
            },
        });
        await db.automation.create({
            data: {
                id: AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                name: "Observe repository events",
                enabled: true,
                scheduleKind: null,
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_plain_v1",
                    payload: { prompt: "observe" },
                }),
                templateVersion: 7,
                triggerKind: "pluginEvent",
                triggerEventPluginId: PLUGIN_ID,
                triggerEventLocalId: EVENT_LOCAL_ID,
                triggerSourceSelectorId: SOURCE_SELECTOR_ID,
                triggerSourceContractVersion: 1,
                triggerObservationTransport: "checkpointedPull",
                watcherMachineId: MACHINE_ID,
                watcherMachineInstallationId: MACHINE_INSTALLATION_ID,
                watcherPluginId: PLUGIN_ID,
                watcherMaterializationId: MATERIALIZATION_ID,
                triggerDefinitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
            },
        });
        if (options.catalogState ?? true) {
            await db.automationEventCatalogState.create({
                data: { accountId: ACCOUNT_ID, eventSourceDefinitionsRevision: 7n },
            });
        }
    }

    async function seedCurrentDurablePushEndpoint(): Promise<void> {
        const now = new Date();
        await db.machine.update({
            where: { accountId_id: { accountId: ACCOUNT_ID, id: MACHINE_ID } },
            data: {
                operationProtocolCapabilities: {
                    pluginWebhookClaim: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        const route = await db.pluginWebhookRoute.create({
            data: {
                id: "route-automation-source-status",
                opaqueRouteId: "opaque-automation-source-status",
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "accountEndpoint",
            },
        });
        const endpoint = await db.pluginWebhookEndpoint.create({
            data: {
                id: DURABLE_PUSH_ENDPOINT_ID,
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                webhookContributionId: "repository-events",
                handlerActionId: "receive-repository-events",
                sourceInstanceId: "repository-source-status",
                ensureIdempotencyKey: "automation-source-status-endpoint-key",
                ensureRequestFingerprint: "a".repeat(64),
                setupKind: "githubAccountEndpointV1",
                routeId: route.id,
                routingKind: "accountEndpoint",
                targetMachineId: MACHINE_ID,
                targetMachineInstallationId: MACHINE_INSTALLATION_ID,
                targetMaterializationId: MATERIALIZATION_ID,
                targetPluginVersion: PLUGIN_VERSION,
            },
        });
        await db.pluginWebhookRoute.update({
            where: { id: route.id },
            data: { accountEndpointId: endpoint.id },
        });
        const leaseId = "wh_lease_AAECAwQFBgcICQoLDA0ODw";
        await db.pluginWebhookDelivery.create({
            data: {
                id: "delivery-automation-source-status",
                endpointId: endpoint.id,
                accountId: ACCOUNT_ID,
                routeId: route.id,
                deliveryIdentityDigest: "b".repeat(64),
                verifierKind: "github_hmac_sha256_v1",
                targetMachineId: MACHINE_ID,
                targetMachineInstallationId: MACHINE_INSTALLATION_ID,
                targetMaterializationId: MATERIALIZATION_ID,
                targetPluginId: PLUGIN_ID,
                targetPluginVersion: PLUGIN_VERSION,
                endpointRevision: endpoint.revision,
                endpointWebhookContributionId: "repository-events",
                endpointHandlerActionId: "receive-repository-events",
                endpointSourceInstanceId: "repository-source-status",
                payloadKind: "plain",
                payload: { t: "plain", v: {} },
                payloadBytes: 2n,
                wireVersion: 1,
                payloadVersion: 1,
                state: "claimed",
                nextAttemptAt: now,
                leaseId,
                claimedByMachineId: MACHINE_ID,
                claimedByMachineInstallationId: MACHINE_INSTALLATION_ID,
                firstClaimAt: now,
                executionStartedAt: now,
                leaseExpiresAt: new Date(now.getTime() + 120_000),
                revision: 1,
                metadataDeleteAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
                receivedAt: now,
            },
        });
    }

    it("writes one bounded source summary only for the exact current source watcher", async () => {
        await seed();

        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "source",
                automationId: AUTOMATION_ID,
                templateVersion: 7,
                eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId: SOURCE_SELECTOR_ID,
                state: "observing",
                code: "none",
                lastObservedAt: 1_723_247_200_000,
                lastDispositionAt: 1_723_247_200_001,
                nextRetryAt: null,
                observedDelta: 2,
                admittedDelta: 1,
                skippedDelta: 1,
            },
        })).resolves.toEqual({});

        await expect(db.automationEventSourceStatus.findUnique({
            where: {
                automationId_eventPluginId_eventLocalId_sourceSelectorId: {
                    automationId: AUTOMATION_ID,
                    eventPluginId: PLUGIN_ID,
                    eventLocalId: EVENT_LOCAL_ID,
                    sourceSelectorId: SOURCE_SELECTOR_ID,
                },
            },
        })).resolves.toMatchObject({
            reporterMachineId: MACHINE_ID,
            reporterMachineInstallationId: MACHINE_INSTALLATION_ID,
            reporterMaterializationId: MATERIALIZATION_ID,
            reporterImmutableGenerationId: "github-immutable-generation-a",
            state: "observing",
            code: null,
            observedCount: 2,
            admittedCount: 1,
            skippedCount: 1,
        });
    });

    it("batch-projects only the exact current Event source and catalog reconciliation status", async () => {
        await seed();
        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "source",
                automationId: AUTOMATION_ID,
                templateVersion: 7,
                eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId: SOURCE_SELECTOR_ID,
                state: "observing",
                code: "none",
                lastObservedAt: 1_723_247_200_000,
                lastDispositionAt: 1_723_247_200_001,
                nextRetryAt: null,
                observedDelta: 1,
                admittedDelta: 1,
                skippedDelta: 0,
            },
        });
        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "catalogReconciliation",
                scope: { kind: "checkpointedPull" },
                observedRevision: "7",
                adoptedRevision: "6",
                state: "reconciling",
                scanStartedAt: 1_723_247_200_000,
                nextRetryAt: 1_723_247_260_000,
            },
        });
        const automation = await getAutomation({
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
        });
        if (!automation) throw new Error("Expected seeded Automation");

        const current = await loadAutomationV3EventStatusProjections({ automations: [automation] });
        expect(current.get(AUTOMATION_ID)).toMatchObject({
            sourceStatus: {
                state: "observing",
                observedCount: 1,
            },
            sourceCatalogStatus: {
                observedRevision: "7",
                adoptedRevision: "6",
                state: "reconciling",
                scanStartedAt: 1_723_247_200_000,
                nextRetryAt: 1_723_247_260_000,
            },
        });

        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: { watcherMaterializationId: "materialization-moved" },
        });
        const staleAutomation = await getAutomation({
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
        });
        if (!staleAutomation) throw new Error("Expected stale Automation");
        const staleMaterialization = await loadAutomationV3EventStatusProjections({
            automations: [staleAutomation],
        });
        expect(staleMaterialization.get(AUTOMATION_ID)?.sourceCatalogStatus).toBeNull();

        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: { watcherMaterializationId: MATERIALIZATION_ID },
        });
        await db.automationEventSourceCatalogStatus.deleteMany({ where: { accountId: ACCOUNT_ID } });
        await db.automationEventSourceCatalogStatus.create({
            data: {
                accountId: ACCOUNT_ID,
                eventPluginId: PLUGIN_ID,
                reporterMachineId: MACHINE_ID,
                reporterMachineInstallationId: MACHINE_INSTALLATION_ID,
                reporterMaterializationId: MATERIALIZATION_ID,
                scopeKey: `durablePush:${DURABLE_PUSH_ENDPOINT_ID}`,
                observedRevision: 7n,
                adoptedRevision: 6n,
                state: "reconciling",
                scanStartedAt: new Date(1_723_247_200_000),
                nextRetryAt: new Date(1_723_247_260_000),
                reportedAt: new Date(1_723_247_200_000),
                revision: 1,
            },
        });
        const scopeAutomation = await getAutomation({
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
        });
        if (!scopeAutomation) throw new Error("Expected scope Automation");
        const staleScope = await loadAutomationV3EventStatusProjections({
            automations: [scopeAutomation],
        });
        expect(staleScope.get(AUTOMATION_ID)?.sourceCatalogStatus).toBeNull();
    });

    it("projects a durable-push catalog status only while its endpoint still has the reporter materialization", async () => {
        await seed({ supportedObservationTransports: ["durablePush"] });
        await seedCurrentDurablePushEndpoint();
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: {
                triggerObservationTransport: "durablePush",
                triggerWebhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                triggerObservationStartsAt: new Date(1_723_247_200_000),
                watcherMachineId: null,
                watcherMachineInstallationId: null,
                watcherPluginId: null,
                watcherMaterializationId: null,
            },
        });
        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "catalogReconciliation",
                scope: { kind: "durablePush", webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID },
                observedRevision: "7",
                adoptedRevision: null,
                state: "reconciling",
                scanStartedAt: 1_723_247_200_000,
                nextRetryAt: 1_723_247_260_000,
            },
        });
        const automation = await getAutomation({
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
        });
        if (!automation) throw new Error("Expected durable-push Automation");

        const current = await loadAutomationV3EventStatusProjections({ automations: [automation] });
        expect(current.get(AUTOMATION_ID)?.sourceCatalogStatus).toEqual({
            observedRevision: "7",
            adoptedRevision: null,
            state: "reconciling",
            scanStartedAt: 1_723_247_200_000,
            nextRetryAt: 1_723_247_260_000,
        });

        await db.pluginWebhookEndpoint.update({
            where: { id: DURABLE_PUSH_ENDPOINT_ID },
            data: { targetMaterializationId: "materialization-moved" },
        });
        const stale = await loadAutomationV3EventStatusProjections({ automations: [automation] });
        expect(stale.get(AUTOMATION_ID)?.sourceCatalogStatus).toBeNull();
    });

    it("publishes one content-free Automation invalidation after each committed source and catalog status", async () => {
        await seed();
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        const changeKey = {
            accountId: ACCOUNT_ID,
            kind: "automation",
            entityId: "automation-source-status",
        };

        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "source",
                automationId: AUTOMATION_ID,
                templateVersion: 7,
                eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId: SOURCE_SELECTOR_ID,
                state: "observing",
                code: "none",
                lastObservedAt: 1_723_247_200_000,
                lastDispositionAt: 1_723_247_200_001,
                nextRetryAt: null,
                observedDelta: 1,
                admittedDelta: 1,
                skippedDelta: 0,
            },
        });

        const sourceChange = await db.accountChange.findUnique({
            where: { accountId_kind_entityId: changeKey },
            select: { cursor: true, kind: true, entityId: true },
        });
        expect(sourceChange).toMatchObject({ cursor: 1, kind: "automation", entityId: "automation-source-status" });
        const sourceStatusUpdates = emitUpdate.mock.calls.filter(([update]) => (
            update.payload.body.t === "automation-source-status-updated"
        ));
        expect(sourceStatusUpdates).toHaveLength(1);
        expect(sourceStatusUpdates[0]?.[0]).toEqual(expect.objectContaining({
            userId: ACCOUNT_ID,
            payload: expect.objectContaining({
                seq: sourceChange?.cursor,
                body: { t: "automation-source-status-updated" },
            }),
            recipientFilter: { type: "user-scoped-only" },
        }));

        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "catalogReconciliation",
                scope: { kind: "checkpointedPull" },
                observedRevision: "7",
                adoptedRevision: "7",
                state: "current",
                scanStartedAt: 1_723_247_200_000,
                nextRetryAt: null,
            },
        });

        const catalogChange = await db.accountChange.findUnique({
            where: { accountId_kind_entityId: changeKey },
            select: { cursor: true, kind: true, entityId: true },
        });
        expect(catalogChange).toMatchObject({ cursor: 2, kind: "automation", entityId: "automation-source-status" });
        const catalogStatusUpdates = emitUpdate.mock.calls.filter(([update]) => (
            update.payload.body.t === "automation-source-status-updated"
        ));
        expect(catalogStatusUpdates).toHaveLength(2);
        expect(catalogStatusUpdates[1]?.[0]).toEqual(expect.objectContaining({
            userId: ACCOUNT_ID,
            payload: expect.objectContaining({
                seq: catalogChange?.cursor,
                body: { t: "automation-source-status-updated" },
            }),
            recipientFilter: { type: "user-scoped-only" },
        }));
    });

    it("does not create an Automation change or event for a rejected source report", async () => {
        await seed();
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: { watcherMaterializationId: "materialization-moved" },
        });

        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "source",
                automationId: AUTOMATION_ID,
                templateVersion: 7,
                eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId: SOURCE_SELECTOR_ID,
                state: "attention",
                code: "definitionStale",
                lastObservedAt: null,
                lastDispositionAt: null,
                nextRetryAt: null,
                observedDelta: 0,
                admittedDelta: 0,
                skippedDelta: 0,
            },
        })).rejects.toMatchObject({ code: "observation_target_changed" });

        await expect(db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: ACCOUNT_ID,
                    kind: "automation",
                    entityId: "automation-source-status",
                },
            },
        })).resolves.toBeNull();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("rejects a stale watcher report without overwriting the last current summary", async () => {
        await seed();
        const report = {
            kind: "source" as const,
            automationId: AUTOMATION_ID,
            templateVersion: 7,
            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            sourceSelectorId: SOURCE_SELECTOR_ID,
            state: "observing" as const,
            code: "none" as const,
            lastObservedAt: 1_723_247_200_000,
            lastDispositionAt: 1_723_247_200_000,
            nextRetryAt: null,
            observedDelta: 1,
            admittedDelta: 1,
            skippedDelta: 0,
        };
        await reportAutomationEventSourceStatusV1({ accountId: ACCOUNT_ID, caller, input: report });
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: { watcherMaterializationId: "materialization-moved" },
        });

        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { ...report, state: "attention", code: "definitionStale", observedDelta: 0, admittedDelta: 0 },
        })).rejects.toBeInstanceOf(AutomationEventSourceStatusReportError);

        await expect(db.automationEventSourceStatus.findUnique({
            where: {
                automationId_eventPluginId_eventLocalId_sourceSelectorId: {
                    automationId: AUTOMATION_ID,
                    eventPluginId: PLUGIN_ID,
                    eventLocalId: EVENT_LOCAL_ID,
                    sourceSelectorId: SOURCE_SELECTOR_ID,
                },
            },
        })).resolves.toMatchObject({ state: "observing", observedCount: 1, admittedCount: 1 });
    });

    it("rejects a source report when the caller's current Event no longer supports its stored transport", async () => {
        await seed();
        const nextRelease = releaseFacts({
            version: "2.0.0",
            supportedObservationTransports: ["durablePush"],
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                version: "2.0.0",
                archiveDigestSha256: nextRelease.archiveDigestSha256,
                normalizedManifest: nextRelease.normalizedManifest,
                collectionContracts: [],
                uiSlots: [],
                packageAssetArchive: nextRelease.packageAssetArchive,
            },
        });
        await db.accountPluginIntent.update({
            where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
            data: { desiredVersion: "2.0.0" },
        });
        await db.pluginMachineMaterialization.update({
            where: { machineId_materializationId: { machineId: MACHINE_ID, materializationId: MATERIALIZATION_ID } },
            data: { version: "2.0.0" },
        });

        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "source",
                automationId: AUTOMATION_ID,
                templateVersion: 7,
                eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId: SOURCE_SELECTOR_ID,
                state: "attention",
                code: "sourceContractIncompatible",
                lastObservedAt: null,
                lastDispositionAt: null,
                nextRetryAt: null,
                observedDelta: 0,
                admittedDelta: 0,
                skippedDelta: 0,
            },
        })).rejects.toMatchObject({ code: "event_contribution_not_current" });

        await expect(db.automationEventSourceStatus.count()).resolves.toBe(0);
    });

    it("rejects a catalog report when the caller's current plugin exposes no eligible checkpointed-pull Event", async () => {
        await seed();
        const nextRelease = releaseFacts({
            version: "2.0.0",
            includeEligibleEvent: false,
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                version: "2.0.0",
                archiveDigestSha256: nextRelease.archiveDigestSha256,
                normalizedManifest: nextRelease.normalizedManifest,
                collectionContracts: [],
                uiSlots: [],
                packageAssetArchive: nextRelease.packageAssetArchive,
            },
        });
        await db.accountPluginIntent.update({
            where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
            data: { desiredVersion: "2.0.0" },
        });
        await db.pluginMachineMaterialization.update({
            where: { machineId_materializationId: { machineId: MACHINE_ID, materializationId: MATERIALIZATION_ID } },
            data: { version: "2.0.0" },
        });

        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "catalogReconciliation",
                scope: { kind: "checkpointedPull" },
                observedRevision: "7",
                adoptedRevision: "7",
                state: "current",
                scanStartedAt: 1_723_247_200_000,
                nextRetryAt: null,
            },
        })).rejects.toMatchObject({ code: "event_contribution_not_current" });

        await expect(db.automationEventSourceCatalogStatus.count()).resolves.toBe(0);
        await expect(db.accountChange.count()).resolves.toBe(0);
    });

    it("refuses a catalog current claim that is not the Automation owner's current revision", async () => {
        await seed();

        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "catalogReconciliation",
                scope: { kind: "checkpointedPull" },
                observedRevision: "6",
                adoptedRevision: "6",
                state: "current",
                scanStartedAt: 1_723_247_200_000,
                nextRetryAt: null,
            },
        })).rejects.toMatchObject({ code: "catalog_revision_not_current" });

        await expect(db.automationEventSourceCatalogStatus.count()).resolves.toBe(0);
    });

    it("records a catalog current claim only at the Automation owner's current revision", async () => {
        await seed();

        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "catalogReconciliation",
                scope: { kind: "checkpointedPull" },
                observedRevision: "7",
                adoptedRevision: "7",
                state: "current",
                scanStartedAt: 1_723_247_200_000,
                nextRetryAt: null,
            },
        })).resolves.toEqual({});

        await expect(db.automationEventSourceCatalogStatus.findMany({
            where: {
                accountId: ACCOUNT_ID,
                eventPluginId: PLUGIN_ID,
                reporterMaterializationId: MATERIALIZATION_ID,
                scopeKey: "checkpointedPull",
            },
        })).resolves.toEqual([expect.objectContaining({
            reporterMachineId: MACHINE_ID,
            reporterMachineInstallationId: MACHINE_INSTALLATION_ID,
            observedRevision: 7n,
            adoptedRevision: 7n,
            state: "current",
            nextRetryAt: null,
        })]);
    });

    it("rejoins catalog adoption status when its reporter materialization moves machines", async () => {
        await seed();
        const secondCaller = {
            pluginId: PLUGIN_ID,
            machineId: "machine-automation-source-status-second",
            machineInstallationId: "installation-automation-source-status-second",
            materializationId: MATERIALIZATION_ID,
        } as const;
        await db.machine.create({
            data: {
                id: secondCaller.machineId,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: secondCaller.machineInstallationId,
                pluginMaterializationRevision: 1n,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: secondCaller.machineId,
                materializationId: secondCaller.materializationId,
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: releaseFacts().archiveDigestSha256,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-10T00:00:00.000Z"),
            },
        });
        const input = {
            kind: "catalogReconciliation" as const,
            scope: { kind: "checkpointedPull" as const },
            observedRevision: "7",
            adoptedRevision: "7",
            state: "current" as const,
            scanStartedAt: 1_723_247_200_000,
            nextRetryAt: null,
        };

        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        });
        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller: secondCaller,
            input,
        });

        await expect(db.automationEventSourceCatalogStatus.findMany({
            where: {
                accountId: ACCOUNT_ID,
                eventPluginId: PLUGIN_ID,
                reporterMaterializationId: MATERIALIZATION_ID,
                scopeKey: "checkpointedPull",
            },
            select: {
                reporterMachineId: true,
                reporterMachineInstallationId: true,
                revision: true,
            },
        })).resolves.toEqual([
            {
                reporterMachineId: secondCaller.machineId,
                reporterMachineInstallationId: secondCaller.machineInstallationId,
                revision: 2,
            },
        ]);
    });

    it("does not let the first catalog report create an absent catalog revision", async () => {
        await seed({ catalogState: false });

        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "catalogReconciliation",
                scope: { kind: "checkpointedPull" },
                observedRevision: "0",
                adoptedRevision: "0",
                state: "current",
                scanStartedAt: 1_723_247_200_000,
                nextRetryAt: null,
            },
        })).rejects.toMatchObject({ code: "catalog_state_unavailable" });

        await expect(db.automationEventSourceCatalogStatus.count()).resolves.toBe(0);
    });

    it("accepts durable-push source status from the current reporter and definition without delivery correspondence", async () => {
        await seed();
        const durableRelease = releaseFacts({ supportedObservationTransports: ["durablePush"] });
        await db.accountPluginRelease.update({
            where: {
                accountId_pluginId_version: {
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                    version: PLUGIN_VERSION,
                },
            },
            data: { normalizedManifest: durableRelease.normalizedManifest },
        });
        await seedCurrentDurablePushEndpoint();
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: {
                triggerObservationTransport: "durablePush",
                triggerWebhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                triggerObservationStartsAt: new Date(1_723_247_200_000),
                watcherMachineId: null,
                watcherMachineInstallationId: null,
                watcherPluginId: null,
                watcherMaterializationId: null,
            },
        });

        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "source",
                automationId: AUTOMATION_ID,
                templateVersion: 7,
                eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId: SOURCE_SELECTOR_ID,
                state: "observing",
                code: "none",
                lastObservedAt: 1_723_247_200_000,
                lastDispositionAt: 1_723_247_200_001,
                nextRetryAt: null,
                observedDelta: 1,
                admittedDelta: 1,
                skippedDelta: 0,
            },
        })).resolves.toEqual({});

        await expect(db.automationEventSourceStatus.count()).resolves.toBe(1);
        await expect(db.automationEventSourceCatalogStatus.count()).resolves.toBe(0);
    });

    it("rejects the old durable-push reporter after retarget while preserving its frozen delivery", async () => {
        await seed();
        await db.machine.update({
            where: { accountId_id: { accountId: ACCOUNT_ID, id: caller.machineId } },
            data: {
                operationProtocolCapabilities: {
                    pluginWebhookClaim: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        const durableRelease = releaseFacts({ supportedObservationTransports: ["durablePush"] });
        await db.accountPluginRelease.update({
            where: {
                accountId_pluginId_version: {
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                    version: PLUGIN_VERSION,
                },
            },
            data: { normalizedManifest: durableRelease.normalizedManifest },
        });
        await seedCurrentDurablePushEndpoint();
        const invocationNow = new Date();
        await db.pluginWebhookDelivery.update({
            where: { id: "delivery-automation-source-status" },
            data: {
                state: "queued",
                nextAttemptAt: invocationNow,
                leaseId: null,
                claimedByMachineId: null,
                claimedByMachineInstallationId: null,
                firstClaimAt: null,
                executionStartedAt: null,
                leaseExpiresAt: null,
                payload: {
                    t: "plain",
                    v: {
                        v: 1,
                        receivedAtMs: 1_723_248_000_000,
                        contentType: "application/json",
                        headers: [],
                        rawBodyBytes: 2,
                        rawBodyBase64: "e30=",
                        verified: {
                            verifier: "github_hmac_sha256_v1",
                            providerDeliveryId: "retarget-frozen-delivery",
                            credentialVersionId: "credential-retarget-frozen",
                        },
                    },
                },
                payloadBytes: 128n,
            },
        });
        const nextCaller = {
            pluginId: PLUGIN_ID,
            machineId: "machine-automation-source-status-retargeted",
            machineInstallationId: "installation-automation-source-status-retargeted",
            materializationId: "materialization-automation-source-status-retargeted",
        } as const;
        await db.machine.create({
            data: {
                id: nextCaller.machineId,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: nextCaller.machineInstallationId,
                pluginMaterializationRevision: 1n,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: nextCaller.machineId,
                materializationId: nextCaller.materializationId,
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: durableRelease.archiveDigestSha256,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-10T00:00:00.000Z"),
            },
        });
        await expect(retargetPluginWebhookEndpointV1({
            accountId: ACCOUNT_ID,
            webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
            expectedRevision: 1,
            idempotencyKey: "retarget-frozen-delivery-0001",
            target: {
                materialization: {
                    machineId: nextCaller.machineId,
                    materializationId: nextCaller.materializationId,
                    pluginId: nextCaller.pluginId,
                },
                machineInstallationId: nextCaller.machineInstallationId,
                pluginVersion: PLUGIN_VERSION,
            },
        })).resolves.toMatchObject({
            kind: "retargeted",
            previousTargetMaterialization: {
                machineId: caller.machineId,
                materializationId: caller.materializationId,
                pluginId: caller.pluginId,
            },
            targetMaterialization: {
                machineId: nextCaller.machineId,
                materializationId: nextCaller.materializationId,
                pluginId: nextCaller.pluginId,
            },
        });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({
            where: { id: "delivery-automation-source-status" },
            select: {
                endpointRevision: true,
                targetMachineId: true,
                targetMachineInstallationId: true,
                targetMaterializationId: true,
                targetPluginId: true,
            },
        })).resolves.toMatchObject({
            endpointRevision: 1,
            targetMachineId: caller.machineId,
            targetMachineInstallationId: caller.machineInstallationId,
            targetMaterializationId: caller.materializationId,
            targetPluginId: caller.pluginId,
        });
        await expect(db.pluginWebhookEndpoint.findUniqueOrThrow({
            where: { id: DURABLE_PUSH_ENDPOINT_ID },
            select: {
                revision: true,
                targetMachineId: true,
                targetMachineInstallationId: true,
                targetMaterializationId: true,
            },
        })).resolves.toEqual({
            revision: 2,
            targetMachineId: nextCaller.machineId,
            targetMachineInstallationId: nextCaller.machineInstallationId,
            targetMaterializationId: nextCaller.materializationId,
        });
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: {
                triggerObservationTransport: "durablePush",
                triggerWebhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                triggerObservationStartsAt: new Date(1_723_248_000_000),
                watcherMachineId: null,
                watcherMachineInstallationId: null,
                watcherPluginId: null,
                watcherMaterializationId: null,
            },
        });

        const claimed = await claimPluginWebhookDeliveryV1({
            accountId: ACCOUNT_ID,
            target: {
                materialization: {
                    machineId: caller.machineId,
                    materializationId: caller.materializationId,
                    pluginId: caller.pluginId,
                },
                machineInstallationId: caller.machineInstallationId,
            },
            now: invocationNow,
            randomBytes: () => new Uint8Array(16).fill(9),
        });
        if (claimed.kind !== "delivery") throw new Error("expected frozen-target delivery claim");
        expect(claimed.endpoint).toEqual({
            webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
            revision: 1,
            webhookContribution: { pluginId: PLUGIN_ID, localId: "repository-events" },
            handlerActionLocalId: "receive-repository-events",
            sourceInstanceId: "repository-source-status",
        });
        const started = await renewPluginWebhookDeliveryV1({
            accountId: ACCOUNT_ID,
            deliveryId: claimed.deliveryId,
            target: {
                materialization: {
                    machineId: caller.machineId,
                    materializationId: caller.materializationId,
                    pluginId: caller.pluginId,
                },
                machineInstallationId: caller.machineInstallationId,
            },
            lease: claimed.lease,
            transition: "executionStarted",
            now: new Date(invocationNow.getTime() + 1_000),
        });
        if (started.kind !== "renewed") throw new Error("expected frozen-target execution start");

        const webhookInvocationReference = {
            v: 1,
            deliveryId: claimed.deliveryId,
            endpoint: claimed.endpoint,
            target: {
                materialization: {
                    machineId: caller.machineId,
                    materializationId: caller.materializationId,
                    pluginId: caller.pluginId,
                },
                machineInstallationId: caller.machineInstallationId,
            },
            lease: { leaseId: claimed.lease.leaseId, revision: started.revision },
        } as const;
        await expect(inTx(async (tx) => await validateCurrentPluginWebhookInvocationReferenceTxV1({
            tx,
            accountId: ACCOUNT_ID,
            reference: webhookInvocationReference,
            serverIdentityId: SERVER_IDENTITY_ID,
            now: new Date(invocationNow.getTime() + 2_000),
        }))).resolves.toEqual({
            kind: "ready",
            webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
            revision: 1,
            webhookContribution: { pluginId: PLUGIN_ID, localId: "repository-events" },
            sourceInstanceId: "repository-source-status",
            target: webhookInvocationReference.target,
        });

        const sourceStatus = {
            kind: "source" as const,
            automationId: AUTOMATION_ID,
            templateVersion: 7,
            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            sourceSelectorId: SOURCE_SELECTOR_ID,
            state: "observing" as const,
            code: "none" as const,
            lastObservedAt: 1_723_248_000_000,
            lastDispositionAt: 1_723_248_000_001,
            nextRetryAt: null,
            observedDelta: 1,
            admittedDelta: 1,
            skippedDelta: 0,
        };
        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: sourceStatus,
        })).rejects.toMatchObject({ code: "observation_target_changed" });
        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller: nextCaller,
            input: sourceStatus,
        })).resolves.toEqual({});
        await expect(db.automationEventSourceStatus.count()).resolves.toBe(1);
    });

    it("records durable-push catalog reconciliation only for the current endpoint scope", async () => {
        await seed();
        const durableRelease = releaseFacts({ supportedObservationTransports: ["durablePush"] });
        await db.accountPluginRelease.update({
            where: {
                accountId_pluginId_version: {
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                    version: PLUGIN_VERSION,
                },
            },
            data: { normalizedManifest: durableRelease.normalizedManifest },
        });
        await seedCurrentDurablePushEndpoint();
        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "catalogReconciliation",
                scope: {
                    kind: "durablePush",
                    webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                },
                observedRevision: "7",
                adoptedRevision: "7",
                state: "current",
                scanStartedAt: 1_723_247_200_000,
                nextRetryAt: null,
            },
        })).resolves.toEqual({});

        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "catalogReconciliation",
                scope: {
                    kind: "durablePush",
                    webhookEndpointId: "wh_ep_AQIDBAUGBwgJCgsMDQ4PEA",
                },
                observedRevision: "7",
                adoptedRevision: "7",
                state: "current",
                scanStartedAt: 1_723_247_200_000,
                nextRetryAt: null,
            },
        })).rejects.toMatchObject({ code: "observation_target_changed" });

        await db.pluginWebhookEndpoint.update({
            where: { id: DURABLE_PUSH_ENDPOINT_ID },
            data: { webhookContributionId: "different-event-route" },
        });
        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "catalogReconciliation",
                scope: {
                    kind: "durablePush",
                    webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                },
                observedRevision: "7",
                adoptedRevision: "7",
                state: "current",
                scanStartedAt: 1_723_247_200_000,
                nextRetryAt: null,
            },
        })).rejects.toMatchObject({ code: "event_contribution_not_current" });

        await expect(db.automationEventSourceCatalogStatus.findMany({
            select: { scopeKey: true, observedRevision: true, adoptedRevision: true },
        })).resolves.toEqual([{
            scopeKey: `durablePush:${DURABLE_PUSH_ENDPOINT_ID}`,
            observedRevision: 7n,
            adoptedRevision: 7n,
        }]);
    });

});
