import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    normalizePluginReleaseFactsV1,
} from "@happier-dev/protocol";
import { createPluginEventAutomationSetupResultV1JsonSchema } from "@happier-dev/protocol/automations/event-setup-result";

import { eventRouter } from "@/app/events/eventRouter";
import {
    claimPluginWebhookDeliveryV1,
    renewPluginWebhookDeliveryV1,
    validateCurrentPluginWebhookInvocationReferenceTxV1,
} from "@/app/plugins/webhooks/claimStore";
import { retargetPluginWebhookEndpointV1 } from "@/app/plugins/webhooks/endpointStore";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    AutomationEventSourceStatusReportError,
    reportAutomationEventSourceStatusV1,
} from "./automationEventSourceStatusService";
import { getAutomation, listAutomations } from "./automationCrudService";
import { toAutomationDefinitionListItemApiDto } from "./automationApiProjection";
import { loadAutomationEventStatusProjections } from "./automationEventStatusProjection";
import { createRouteTestBuilder } from '@/app/api/testkit/routeTestBuilder';
import { registerAutomationV3Routes } from '@/app/api/routes/automations/registerAutomationV3Routes';
import type { Fastify } from '@/app/api/types';

const ACCOUNT_ID = "account-automation-source-status";
const MACHINE_ID = "machine-automation-source-status";
const MACHINE_INSTALLATION_ID = "installation-automation-source-status";
const MATERIALIZATION_ID = "materialization-automation-source-status";
const SERVER_IDENTITY_ID = "srv_automationSourceStatusCurrent1";
const PLUGIN_ID = "com.acme.github";
const PLUGIN_VERSION = "1.0.0";
const EVENT_LOCAL_ID = "repository-event";
const AUTOMATION_ID = "automation-source-status";
const TRIGGER_ID = "automation-source-status-trigger";
const TRIGGER_REVISION = 7;
const SOURCE_SELECTOR_ID = "48d496d6-2105-465a-b363-a0ce80d6594f";
const DURABLE_PUSH_ENDPOINT_ID = "wh_ep_AAECAwQFBgcICQoLDA0ODw";
const SETUP_ACTION_LOCAL_ID = "setup-repository-source";
const SOURCE_CONFIG_SCHEMA = { type: "object", additionalProperties: false } as const;

const caller = {
    pluginId: PLUGIN_ID,
    machineId: MACHINE_ID,
    machineInstallationId: MACHINE_INSTALLATION_ID,
    materializationId: MATERIALIZATION_ID,
    sourceCustody: {
        kind: "managed",
        immutableGenerationId: "github-immutable-generation-a",
        installSource: "archive",
    },
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
                actions: [{
                    id: SETUP_ACTION_LOCAL_ID,
                    title: "Set up repository source",
                    scopes: ["global"],
                    surfaces: ["plugin"],
                    dangerLevel: "safe",
                    execution: { target: "daemon" },
                    inputSchema: SOURCE_CONFIG_SCHEMA,
                    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, SOURCE_CONFIG_SCHEMA),
                }, ...(supportsDurablePush ? [{
                    id: "receive-repository-events",
                    title: "Receive repository events",
                    scopes: ["global"],
                    surfaces: ["plugin"],
                    dangerLevel: "safe",
                    execution: { target: "daemon" },
                }] : [])],
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
                            sourceConfigSchema: SOURCE_CONFIG_SCHEMA,
                            setupActionRef: { pluginId: PLUGIN_ID, localId: SETUP_ACTION_LOCAL_ID },
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
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_plain_v1",
                    payload: { prompt: "observe" },
                }),
                templateVersion: 7,
            },
        });
        await db.automationTrigger.create({
            data: {
                id: TRIGGER_ID,
                automationId: AUTOMATION_ID,
                kind: "pluginEvent",
                enabled: true,
                revision: TRIGGER_REVISION,
                eventPluginId: PLUGIN_ID,
                eventLocalId: EVENT_LOCAL_ID,
                sourceSelectorId: SOURCE_SELECTOR_ID,
                sourceContractVersion: 1,
                observationTransport: "checkpointedPull",
                watcherMachineId: MACHINE_ID,
                watcherMachineInstallationId: MACHINE_INSTALLATION_ID,
                watcherPluginId: PLUGIN_ID,
                watcherMaterializationId: MATERIALIZATION_ID,
                definitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
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
                setupKind: "accountEndpointV1",
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
        let manifestBodyReads = 0;
        const transaction = db.$transaction;
        // Observe the actual persistence boundary; report/currentness logic and SQL stay real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                const findReleases = tx.accountPluginRelease.findMany;
                tx.accountPluginRelease.findMany = new Proxy(findReleases, {
                    apply(read, delegate, values: unknown[]) {
                        const selection = values[0] as { select?: { normalizedManifest?: boolean } } | undefined;
                        if (selection?.select?.normalizedManifest) manifestBodyReads++;
                        return Reflect.apply(read, delegate, values);
                    },
                });
                try { return await callback(tx); }
                finally { tx.accountPluginRelease.findMany = findReleases; }
            }, ...args.slice(1)]);
        } });
        try {
            await expect(reportAutomationEventSourceStatusV1({
                accountId: ACCOUNT_ID,
                caller,
                input: {
                    kind: "source",
                    automationId: AUTOMATION_ID,
                    triggerId: TRIGGER_ID,
                    triggerRevision: TRIGGER_REVISION,
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
        } finally {
            db.$transaction = transaction;
        }
        expect(manifestBodyReads).toBe(1);

        await expect(db.automationEventSourceStatus.findUnique({
            where: { triggerId: TRIGGER_ID },
        })).resolves.toMatchObject({
            reporterMachineId: MACHINE_ID,
            reporterMachineInstallationId: MACHINE_INSTALLATION_ID,
            reporterMaterializationId: MATERIALIZATION_ID,
            reporterSourceCustody: caller.sourceCustody,
            state: "observing",
            code: null,
            observedCount: 2,
            admittedCount: 1,
            skippedCount: 1,
        });
    });

    it('reads declared Event payload schemas for disabled editor triggers without widening summary reads', async () => {
        await seed();
        await db.automation.update({ where: { id: AUTOMATION_ID }, data: { enabled: false } });
        await db.automationTrigger.update({ where: { id: TRIGGER_ID }, data: { enabled: false } });
        const automations = await listAutomations({ accountId: ACCOUNT_ID });
        const summary = await loadAutomationEventStatusProjections({ automations });
        expect(summary.get(TRIGGER_ID)).not.toHaveProperty('payloadSchema');
        const editor = await loadAutomationEventStatusProjections({ automations, includePayloadSchemas: true });
        expect(editor.get(TRIGGER_ID)).toMatchObject({ payloadSchema: { type: 'object', additionalProperties: false } });
        const automation = automations[0]!;
        const original = automation.triggers[0]!;
        const mixed = await loadAutomationEventStatusProjections({ includePayloadSchemas: true, automations: [{ ...automation,
            triggers: [original, { ...original, id: 'old-installation', watcherMachineInstallationId: 'old-installation' }] }] });
        expect(mixed.get(TRIGGER_ID)).toHaveProperty('payloadSchema', { type: 'object', additionalProperties: false });
        expect(mixed.get('old-installation')).toHaveProperty('payloadSchema', null);
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
            data: { enabled: false } });
        const retired = await loadAutomationEventStatusProjections({ automations, includePayloadSchemas: true });
        expect(retired.get(TRIGGER_ID)).toHaveProperty('payloadSchema', null);
    });

    it('reads declared Event payload schemas for intended triggers through the Account query without saving', async () => {
        await seed({ supportedObservationTransports: ['checkpointedPull', 'durablePush'] });
        const route = createRouteTestBuilder({ method: 'POST', path: '/v3/automations/query',
            registerRoutes: app => registerAutomationV3Routes(app as unknown as Fastify) });
        const input = { triggerEventDeclarations: [{ kind: 'pluginEvent',
            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
                machineId: MACHINE_ID, materializationId: MATERIALIZATION_ID, pluginId: PLUGIN_ID,
            } } }] };
        const own = await route.invoke({ userId: ACCOUNT_ID, body: input });
        expect(own.response).toEqual({ triggerEvents: [{ event: input.triggerEventDeclarations[0]!.eventRef,
            payloadSchema: { type: 'object', additionalProperties: false } }] });
        await seedCurrentDurablePushEndpoint();
        const endpointInput = { triggerEventDeclarations: [{ kind: 'pluginEvent',
            eventRef: input.triggerEventDeclarations[0]!.eventRef,
            observationTransport: { kind: 'durablePush', webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                endpointMaterializationRef: { machineId: 'authored-placement', pluginId: PLUGIN_ID, materializationId: 'authored-placement' },
                webhookRoutingSourceInstanceId: 'repository-source-status', setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' } } }] };
        const endpoint = await route.invoke({ userId: ACCOUNT_ID, body: endpointInput });
        expect(endpoint.response).toEqual(own.response);
        await db.pluginWebhookEndpoint.update({ where: { id: DURABLE_PUSH_ENDPOINT_ID }, data: { targetMaterializationId: 'retargeted' } });
        const moved = await route.invoke({ userId: ACCOUNT_ID, body: endpointInput });
        expect(moved.response).toEqual({ triggerEvents: [{ event: input.triggerEventDeclarations[0]!.eventRef, payloadSchema: null }] });
        const other = await route.invoke({ userId: 'another-account', body: input });
        expect(other.response).toEqual({ triggerEvents: [{ event: input.triggerEventDeclarations[0]!.eventRef, payloadSchema: null }] });
    });

    it.each(["admissionUnavailable", "service_unavailable", "historyGap"] as const)("explains %s through the saved source list and detail projection", async (failureCode) => {
        await seed();
        const report = (state: "backingOff" | "observing", code: typeof failureCode | "none", nextRetryAt: number | null = null) => reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "source",
                automationId: AUTOMATION_ID,
                triggerId: TRIGGER_ID,
                triggerRevision: TRIGGER_REVISION,
                eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId: SOURCE_SELECTOR_ID,
                state,
                code,
                lastObservedAt: 1_723_247_200_000,
                lastDispositionAt: null,
                nextRetryAt,
                observedDelta: 1,
                admittedDelta: 0,
                skippedDelta: 0,
            },
        });
        await report("backingOff", failureCode);

        const automations = await listAutomations({ accountId: ACCOUNT_ID });
        const statuses = await loadAutomationEventStatusProjections({ automations });
        const listed = toAutomationDefinitionListItemApiDto(automations[0]!, null, statuses);
        const explanation = failureCode === "historyGap" ? undefined : {
            reason: failureCode,
            requiredFact: "availableSourceObservationOrAdmission",
            remedy: "restoreSourceRegistrationOrAdmission",
            ...(failureCode === "admissionUnavailable" ? { underlyingCause: "notRecorded" } : {}),
        };
        expect(listed.triggers[0]).toMatchObject({ sourceStatus: {
            state: failureCode === "admissionUnavailable" ? "attention" : "backingOff",
            code: failureCode,
            ...(explanation === undefined ? {} : { explanation }),
            observedCount: 1,
            admittedCount: 0,
            lastDispositionAt: null,
        } });
        const listedTrigger = listed.triggers[0];
        if (listedTrigger?.kind !== "pluginEvent") throw new Error("Expected the seeded plugin Event Trigger");
        if (explanation === undefined) expect(listedTrigger.sourceStatus).not.toHaveProperty("explanation");
        const detail = await getAutomation({ accountId: ACCOUNT_ID, automationId: AUTOMATION_ID });
        if (!detail) throw new Error("Expected seeded Automation");
        const detailStatuses = await loadAutomationEventStatusProjections({ automations: [detail] });
        expect(detailStatuses.get(TRIGGER_ID)?.sourceStatus).toEqual(statuses.get(TRIGGER_ID)?.sourceStatus);

        await report("backingOff", failureCode, 1_723_247_200_001);
        const scheduled = await loadAutomationEventStatusProjections({ automations });
        expect(scheduled.get(TRIGGER_ID)?.sourceStatus).toMatchObject({ state: "backingOff", nextRetryAt: 1_723_247_200_001 });

        await report("observing", "none");
        const recovered = await loadAutomationEventStatusProjections({ automations });
        expect(recovered.get(TRIGGER_ID)?.sourceStatus).toMatchObject({ state: "observing", code: null });
        expect(recovered.get(TRIGGER_ID)?.sourceStatus).not.toHaveProperty("explanation");
    });

    it("keeps source status independent for two Event triggers on one Automation", async () => {
        await seed();
        const secondTriggerId = `${TRIGGER_ID}-second`;
        const secondSelectorId = "58d496d6-2105-465a-b363-a0ce80d6594f";
        await db.automationTrigger.create({
            data: {
                id: secondTriggerId,
                automationId: AUTOMATION_ID,
                kind: "pluginEvent",
                enabled: true,
                revision: 3,
                eventPluginId: PLUGIN_ID,
                eventLocalId: EVENT_LOCAL_ID,
                sourceSelectorId: secondSelectorId,
                sourceContractVersion: 1,
                observationTransport: "checkpointedPull",
                watcherMachineId: MACHINE_ID,
                watcherMachineInstallationId: MACHINE_INSTALLATION_ID,
                watcherPluginId: PLUGIN_ID,
                watcherMaterializationId: MATERIALIZATION_ID,
                definitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
            },
        });

        for (const input of [{
            triggerId: TRIGGER_ID,
            triggerRevision: TRIGGER_REVISION,
            sourceSelectorId: SOURCE_SELECTOR_ID,
            observedDelta: 1,
        }, {
            triggerId: secondTriggerId,
            triggerRevision: 3,
            sourceSelectorId: secondSelectorId,
            observedDelta: 2,
        }] as const) {
            await reportAutomationEventSourceStatusV1({
                accountId: ACCOUNT_ID,
                caller,
                input: {
                    kind: "source",
                    automationId: AUTOMATION_ID,
                    triggerId: input.triggerId,
                    triggerRevision: input.triggerRevision,
                    eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                    sourceSelectorId: input.sourceSelectorId,
                    state: "observing",
                    code: "none",
                    lastObservedAt: 1_723_247_200_000,
                    lastDispositionAt: 1_723_247_200_001,
                    nextRetryAt: null,
                    observedDelta: input.observedDelta,
                    admittedDelta: 0,
                    skippedDelta: 0,
                },
            });
        }

        await expect(db.automationEventSourceStatus.findMany({
            orderBy: { triggerId: "asc" },
            select: { triggerId: true, triggerRevision: true, observedCount: true },
        })).resolves.toEqual([
            { triggerId: TRIGGER_ID, triggerRevision: TRIGGER_REVISION, observedCount: 1 },
            { triggerId: secondTriggerId, triggerRevision: 3, observedCount: 2 },
        ]);
    });

    it("resets bounded source counters when the exact trigger revision changes", async () => {
        await seed();
        const report = (triggerRevision: number, observedDelta: number) => ({
            kind: "source" as const,
            automationId: AUTOMATION_ID,
            triggerId: TRIGGER_ID,
            triggerRevision,
            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            sourceSelectorId: SOURCE_SELECTOR_ID,
            state: "observing" as const,
            code: "none" as const,
            lastObservedAt: 1_723_247_200_000,
            lastDispositionAt: 1_723_247_200_001,
            nextRetryAt: null,
            observedDelta,
            admittedDelta: 0,
            skippedDelta: 0,
        });
        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: report(TRIGGER_REVISION, 3),
        });
        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: { revision: TRIGGER_REVISION + 1 },
        });
        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: report(TRIGGER_REVISION + 1, 2),
        });

        await expect(db.automationEventSourceStatus.findUnique({
            where: { triggerId: TRIGGER_ID },
            select: { triggerRevision: true, observedCount: true },
        })).resolves.toEqual({
            triggerRevision: TRIGGER_REVISION + 1,
            observedCount: 2,
        });
    });

    it("does not carry occurrence timestamps into a newly current trigger revision", async () => {
        await seed();
        const identity = {
            kind: "source" as const,
            automationId: AUTOMATION_ID,
            triggerId: TRIGGER_ID,
            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            sourceSelectorId: SOURCE_SELECTOR_ID,
        };
        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...identity,
                triggerRevision: TRIGGER_REVISION,
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
        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: { revision: TRIGGER_REVISION + 1 },
        });

        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...identity,
                triggerRevision: TRIGGER_REVISION + 1,
                state: "backingOff",
                code: "admissionUnavailable",
                nextRetryAt: null,
                observedDelta: 0,
                admittedDelta: 0,
                skippedDelta: 0,
            },
        });

        await expect(db.automationEventSourceStatus.findUnique({
            where: { triggerId: TRIGGER_ID },
            select: {
                triggerRevision: true,
                lastObservedAt: true,
                lastDispositionAt: true,
                observedCount: true,
                admittedCount: true,
                skippedCount: true,
            },
        })).resolves.toEqual({
            triggerRevision: TRIGGER_REVISION + 1,
            lastObservedAt: null,
            lastDispositionAt: null,
            observedCount: 0,
            admittedCount: 0,
            skippedCount: 0,
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
                triggerId: TRIGGER_ID,
                triggerRevision: TRIGGER_REVISION,
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

        const current = await loadAutomationEventStatusProjections({ automations: [automation] });
        expect(current.get(TRIGGER_ID)).toMatchObject({
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

        // Earlier 0.3 development observers persisted the diagnostic-only late
        // variant. Keep that history readable without carrying its deadline.
        await db.automationEventSourceCatalogStatus.updateMany({
            where: { accountId: ACCOUNT_ID },
            data: { state: "reconciliationLate" },
        });
        const retained = await loadAutomationEventStatusProjections({ automations: [automation] });
        expect(retained.get(TRIGGER_ID)?.sourceCatalogStatus).toEqual({
            observedRevision: "7",
            adoptedRevision: "6",
            state: "reconciling",
            scanStartedAt: 1_723_247_200_000,
            nextRetryAt: 1_723_247_260_000,
        });
        expect(await db.automationEventSourceCatalogStatus.findFirst({
            where: { accountId: ACCOUNT_ID }, select: { state: true },
        })).toEqual({ state: "reconciliationLate" });

        await db.automationEventSourceStatus.update({
            where: { triggerId: TRIGGER_ID },
            data: { triggerRevision: TRIGGER_REVISION - 1 },
        });
        const priorRevision = await loadAutomationEventStatusProjections({ automations: [automation] });
        expect(priorRevision.get(TRIGGER_ID)?.sourceStatus).toBeNull();
        await db.automationEventSourceStatus.update({
            where: { triggerId: TRIGGER_ID },
            data: { triggerRevision: TRIGGER_REVISION },
        });

        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: { watcherMaterializationId: "materialization-moved" },
        });
        const staleAutomation = await getAutomation({
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
        });
        if (!staleAutomation) throw new Error("Expected stale Automation");
        const staleMaterialization = await loadAutomationEventStatusProjections({
            automations: [staleAutomation],
        });
        // The retired reporter can no longer write this row (the writer rejects
        // it as `observation_target_changed`), so its last healthy summary is
        // not the current observer's status and must not be presented as one.
        expect(staleMaterialization.get(TRIGGER_ID)).toEqual({
            sourceStatus: null,
            sourceCatalogStatus: null,
            durablePushEndpointMaterializationRef: null,
        });

        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
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
                reporterSourceCustody: caller.sourceCustody,
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
        const staleScope = await loadAutomationEventStatusProjections({
            automations: [scopeAutomation],
        });
        expect(staleScope.get(TRIGGER_ID)?.sourceCatalogStatus).toBeNull();
    });

    it("projects a durable-push catalog status only while its endpoint still has the reporter materialization", async () => {
        await seed({ supportedObservationTransports: ["durablePush"] });
        await seedCurrentDurablePushEndpoint();
        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: {
                observationTransport: "durablePush",
                webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                observationStartsAt: new Date(1_723_247_200_000),
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
        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "source",
                automationId: AUTOMATION_ID,
                triggerId: TRIGGER_ID,
                triggerRevision: TRIGGER_REVISION,
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
        const automation = await getAutomation({
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
        });
        if (!automation) throw new Error("Expected durable-push Automation");

        const current = await loadAutomationEventStatusProjections({ automations: [automation] });
        expect(current.get(TRIGGER_ID)?.durablePushEndpointMaterializationRef).toEqual({
            machineId: MACHINE_ID,
            materializationId: MATERIALIZATION_ID,
            pluginId: PLUGIN_ID,
        });
        expect(current.get(TRIGGER_ID)?.sourceCatalogStatus).toEqual({
            observedRevision: "7",
            adoptedRevision: null,
            state: "reconciling",
            scanStartedAt: 1_723_247_200_000,
            nextRetryAt: 1_723_247_260_000,
        });
        expect(current.get(TRIGGER_ID)?.sourceStatus).toMatchObject({
            state: "observing",
            observedCount: 1,
        });

        await db.pluginWebhookEndpoint.update({
            where: { id: DURABLE_PUSH_ENDPOINT_ID }, data: { enabled: false, revokedAt: new Date() },
        });
        const fallback = await loadAutomationEventStatusProjections({ automations: [automation] });
        expect(fallback.get(TRIGGER_ID)).toEqual(current.get(TRIGGER_ID));

        await db.pluginWebhookEndpoint.update({
            where: { id: DURABLE_PUSH_ENDPOINT_ID },
            data: { targetMaterializationId: "materialization-moved" },
        });
        const stale = await loadAutomationEventStatusProjections({ automations: [automation] });
        // The retargeted endpoint means the row's reporter is no longer the
        // Automation's delivery target, so neither summary is current.
        expect(stale.get(TRIGGER_ID)).toEqual({
            sourceStatus: null,
            sourceCatalogStatus: null,
            durablePushEndpointMaterializationRef: {
                machineId: MACHINE_ID,
                materializationId: "materialization-moved",
                pluginId: PLUGIN_ID,
            },
        });
    });

    it("publishes source status only when current report facts or counters change", async () => {
        await seed();
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        const report = {
            kind: "source" as const,
            automationId: AUTOMATION_ID,
            triggerId: TRIGGER_ID,
            triggerRevision: TRIGGER_REVISION,
            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            sourceSelectorId: SOURCE_SELECTOR_ID,
            state: "observing" as const,
            code: "none" as const,
            nextRetryAt: null,
            observedDelta: 0,
            admittedDelta: 0,
            skippedDelta: 0,
        };
        const send = (input: unknown = report) => reportAutomationEventSourceStatusV1({ accountId: ACCOUNT_ID, caller, input });
        const readStatus = () => db.automationEventSourceStatus.findUniqueOrThrow({ where: { triggerId: TRIGGER_ID } });
        const published = async (revision: number) => {
            const account = await db.account.findUniqueOrThrow({ where: { id: ACCOUNT_ID }, select: { seq: true } });
            const change = await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                accountId: ACCOUNT_ID, kind: "automation", entityId: "automation-source-status",
            } }, select: { cursor: true } });
            expect({ revision: (await readStatus()).revision, accountSeq: account.seq, cursor: change.cursor,
                wakes: emitUpdate.mock.calls.filter(([update]) => update.payload.body.t === "account-change").length,
                sourceUpdates: emitUpdate.mock.calls.filter(([update]) => update.payload.body.t === "automation-source-status-updated").length,
            }).toEqual({ revision, accountSeq: revision, cursor: revision, wakes: revision, sourceUpdates: revision });
        };
        await send();
        const initial = await readStatus();
        for (let index = 0; index < 3; index++) await send();
        // Omitted occurrence times and explicit nulls describe the same initial facts.
        await send({ ...report, lastObservedAt: null, lastDispositionAt: null });
        await published(1);
        expect(await readStatus()).toEqual(initial);

        await send({ ...report, lastObservedAt: 1_723_247_200_000, lastDispositionAt: 1_723_247_200_001 });
        await published(2);
        await send();
        await published(2);
        expect(await readStatus()).toMatchObject({ lastObservedAt: new Date(1_723_247_200_000),
            lastDispositionAt: new Date(1_723_247_200_001) });
        // Explicit null clears a timestamp; omitting it above preserved it.
        await send({ ...report, lastObservedAt: null });
        await published(3);
        await send({ ...report, observedDelta: 1 });
        await published(4);
        await send({ ...report, state: "backingOff", code: "admissionUnavailable", nextRetryAt: 1_723_247_260_000 });
        await published(5);

        // A current reporter must replace retained facts belonging to an old reporter,
        // even when its state, timestamps and counters otherwise match.
        const backingOff = { ...report, state: "backingOff", code: "admissionUnavailable", nextRetryAt: 1_723_247_260_000 };
        const retiredReporterFields = [
            { reporterMachineId: "retired-machine" },
            { reporterMachineInstallationId: "retired-installation" },
            { reporterMaterializationId: "retired-materialization" },
            { reporterSourceCustody: { ...caller.sourceCustody, immutableGenerationId: "retired-generation" } },
        ];
        for (const [index, data] of retiredReporterFields.entries()) {
            await db.automationEventSourceStatus.update({ where: { triggerId: TRIGGER_ID }, data });
            await send(backingOff);
            await published(6 + index);
        }
        await send(backingOff);
        await published(9);

        // Equal facts do not bypass current materialization admission.
        await db.pluginMachineMaterialization.updateMany({ where: { materializationId: MATERIALIZATION_ID }, data: { enabled: false } });
        await expect(send(backingOff)).rejects.toMatchObject({ code: "caller_materialization_not_current" });
        await published(9);
    });

    it("publishes catalog status only for semantic changes, not unchanged receipts", async () => {
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
                triggerId: TRIGGER_ID,
                triggerRevision: TRIGGER_REVISION,
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

        const unchangedCatalogReceipt = {
            kind: "catalogReconciliation" as const,
            scope: { kind: "checkpointedPull" as const },
            observedRevision: "7",
            adoptedRevision: "7",
            state: "current" as const,
            scanStartedAt: 1_723_247_200_000,
            nextRetryAt: null,
        };
        for (let receipt = 0; receipt < 3; receipt += 1) {
            await reportAutomationEventSourceStatusV1({
                accountId: ACCOUNT_ID,
                caller,
                input: unchangedCatalogReceipt,
            });
        }

        await expect(db.automationEventSourceCatalogStatus.findFirstOrThrow({
            where: { accountId: ACCOUNT_ID },
            select: { revision: true },
        })).resolves.toEqual({ revision: 1 });
        await expect(db.accountChange.findUnique({
            where: { accountId_kind_entityId: changeKey },
            select: { cursor: true },
        })).resolves.toEqual({ cursor: 2 });
        expect(emitUpdate.mock.calls.filter(([update]) => (
            update.payload.body.t === "automation-source-status-updated"
        ))).toHaveLength(2);

        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...unchangedCatalogReceipt,
                adoptedRevision: null,
                state: "reconciling",
                nextRetryAt: 1_723_247_260_000,
            },
        });

        await expect(db.automationEventSourceCatalogStatus.findFirstOrThrow({
            where: { accountId: ACCOUNT_ID },
            select: { revision: true, state: true, nextRetryAt: true },
        })).resolves.toEqual({
            revision: 2,
            state: "reconciling",
            nextRetryAt: new Date(1_723_247_260_000),
        });
        await expect(db.accountChange.findUnique({
            where: { accountId_kind_entityId: changeKey },
            select: { cursor: true },
        })).resolves.toEqual({ cursor: 3 });
        expect(emitUpdate.mock.calls.filter(([update]) => (
            update.payload.body.t === "automation-source-status-updated"
        ))).toHaveLength(3);
    });

    it("does not create an Automation change or event for a rejected source report", async () => {
        await seed();
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: { watcherMaterializationId: "materialization-moved" },
        });

        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                kind: "source",
                automationId: AUTOMATION_ID,
                triggerId: TRIGGER_ID,
                triggerRevision: TRIGGER_REVISION,
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
            triggerId: TRIGGER_ID,
            triggerRevision: TRIGGER_REVISION,
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
        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: { watcherMaterializationId: "materialization-moved" },
        });

        await expect(reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { ...report, state: "attention", code: "definitionStale", observedDelta: 0, admittedDelta: 0 },
        })).rejects.toBeInstanceOf(AutomationEventSourceStatusReportError);

        await expect(db.automationEventSourceStatus.findUnique({
            where: { triggerId: TRIGGER_ID },
        })).resolves.toMatchObject({ state: "observing", observedCount: 1, admittedCount: 1 });
    });

    it("preserves occurrence timestamps when connection health alone changes", async () => {
        await seed();
        const lastObservedAt = 1_723_247_200_000;
        const lastDispositionAt = 1_723_247_200_001;
        const identity = {
            kind: "source" as const,
            automationId: AUTOMATION_ID,
            triggerId: TRIGGER_ID,
            triggerRevision: TRIGGER_REVISION,
            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            sourceSelectorId: SOURCE_SELECTOR_ID,
        };
        await reportAutomationEventSourceStatusV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...identity,
                state: "observing",
                code: "none",
                lastObservedAt,
                lastDispositionAt,
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
                ...identity,
                state: "backingOff",
                code: "admissionUnavailable",
                nextRetryAt: null,
                observedDelta: 0,
                admittedDelta: 0,
                skippedDelta: 0,
            },
        });

        const status = await db.automationEventSourceStatus.findUniqueOrThrow({
            where: { triggerId: TRIGGER_ID },
        });
        expect(status).toMatchObject({
            state: "backingOff",
            code: "admissionUnavailable",
            observedCount: 1,
            admittedCount: 1,
        });
        expect(status.lastObservedAt?.getTime()).toBe(lastObservedAt);
        expect(status.lastDispositionAt?.getTime()).toBe(lastDispositionAt);
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
                triggerId: TRIGGER_ID,
                triggerRevision: TRIGGER_REVISION,
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
            reporterSourceCustody: caller.sourceCustody,
            observedRevision: 7n,
            adoptedRevision: 7n,
            state: "current",
            nextRetryAt: null,
        })]);
    });

    it("keeps catalog adoption status independent for the same Machine-local materialization on different Machines", async () => {
        await seed();
        const secondCaller = {
            pluginId: PLUGIN_ID,
            machineId: "machine-automation-source-status-second",
            machineInstallationId: "installation-automation-source-status-second",
            materializationId: MATERIALIZATION_ID,
            sourceCustody: {
                kind: "managed",
                immutableGenerationId: "github-immutable-generation-a",
                installSource: "archive",
            },
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

        const statuses = await db.automationEventSourceCatalogStatus.findMany({
            where: {
                accountId: ACCOUNT_ID,
                eventPluginId: PLUGIN_ID,
                reporterMaterializationId: MATERIALIZATION_ID,
                scopeKey: "checkpointedPull",
            },
            select: {
                reporterMachineId: true,
                reporterMachineInstallationId: true,
                reporterSourceCustody: true,
                revision: true,
            },
        });
        expect(statuses).toHaveLength(2);
        expect(statuses).toEqual(expect.arrayContaining([
            {
                reporterMachineId: caller.machineId,
                reporterMachineInstallationId: caller.machineInstallationId,
                reporterSourceCustody: caller.sourceCustody,
                revision: 1,
            },
            {
                reporterMachineId: secondCaller.machineId,
                reporterMachineInstallationId: secondCaller.machineInstallationId,
                reporterSourceCustody: secondCaller.sourceCustody,
                revision: 1,
            },
        ]));
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

    it.each(["active", "disabled", "revoked", "routeRevoked"] as const)("accepts durable-push source status from its current monitoring target while the route is %s", async availability => {
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
        if (availability === "disabled" || availability === "revoked") {
            await db.pluginWebhookEndpoint.update({
                where: { id: DURABLE_PUSH_ENDPOINT_ID },
                data: availability === "disabled" ? { enabled: false } : { enabled: false, revokedAt: new Date() },
            });
        } else if (availability === "routeRevoked") {
            await db.pluginWebhookRoute.update({
                where: { accountEndpointId: DURABLE_PUSH_ENDPOINT_ID },
                data: { enabled: false, revokedAt: new Date() },
            });
        }
        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: {
                observationTransport: "durablePush",
                webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                observationStartsAt: new Date(1_723_247_200_000),
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
                triggerId: TRIGGER_ID,
                triggerRevision: TRIGGER_REVISION,
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
            sourceCustody: {
                kind: "managed",
                immutableGenerationId: "github-immutable-generation-b",
                installSource: "archive",
            },
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
        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: {
                observationTransport: "durablePush",
                webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                observationStartsAt: new Date(1_723_248_000_000),
                watcherMachineId: null,
                watcherMachineInstallationId: null,
                watcherPluginId: null,
                watcherMaterializationId: null,
            },
        });

        const claimed = await claimPluginWebhookDeliveryV1({
            accountId: ACCOUNT_ID,
            machine: {
                machineId: caller.machineId,
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
            triggerId: TRIGGER_ID,
            triggerRevision: TRIGGER_REVISION,
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

    it.each([false, true])("records durable-push catalog reconciliation only for the current endpoint scope (revoked: %s)", async revoked => {
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
        if (revoked) await db.pluginWebhookEndpoint.update({
            where: { id: DURABLE_PUSH_ENDPOINT_ID }, data: { enabled: false, revokedAt: new Date() },
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
