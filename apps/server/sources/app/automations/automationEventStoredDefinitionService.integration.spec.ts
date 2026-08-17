import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    AutomationSourceSelectorIdV1Schema,
    normalizePluginReleaseFactsV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    sealAccountScopedBlobCiphertext,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    AutomationEventStoredDefinitionsReadError,
    readAutomationEventStoredDefinitionsV1,
} from "./automationEventStoredDefinitionService";

const ACCOUNT_ID = "account-automation-stored-definitions";
const MACHINE_ID = "machine-automation-stored-definitions";
const MACHINE_INSTALLATION_ID = "installation-automation-stored-definitions";
const MATERIALIZATION_ID = "materialization-automation-stored-definitions";
const SERVER_IDENTITY_ID = "srv_automationStoredDefinitionsCurrent1";
const PLUGIN_ID = "com.acme.github";
const PLUGIN_VERSION = "1.0.0";
const EVENT_LOCAL_ID = "repository-event";
const DURABLE_PUSH_ENDPOINT_ID = "wh_ep_AAECAwQFBgcICQoLDA0ODw";

const caller = {
    pluginId: PLUGIN_ID,
    machineId: MACHINE_ID,
    machineInstallationId: MACHINE_INSTALLATION_ID,
    materializationId: MATERIALIZATION_ID,
} as const;

function sourceSelector(index: number) {
    return AutomationSourceSelectorIdV1Schema.parse(
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
}

function releaseFacts(params: Readonly<{
    supportedObservationTransports?: readonly ("checkpointedPull" | "durablePush")[];
}> = {}) {
    const supportedObservationTransports = params.supportedObservationTransports ?? ["checkpointedPull"];
    const supportsDurablePush = supportedObservationTransports.includes("durablePush");
    return normalizePluginReleaseFactsV1({
        ref: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        normalizedManifest: {
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: PLUGIN_VERSION,
            displayName: "Stored definition fixture",
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
                events: [{
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

function automationDefinition(index: number) {
    const id = `automation-${String(index).padStart(4, "0")}`;
    return {
        id,
        accountId: ACCOUNT_ID,
        name: `Observe repository ${index}`,
        enabled: true,
        scheduleKind: null,
        targetType: "new_session" as const,
        templateCiphertext: JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { prompt: "observe" },
        }),
        templateVersion: index,
        triggerKind: "pluginEvent" as const,
        triggerEventPluginId: PLUGIN_ID,
        triggerEventLocalId: EVENT_LOCAL_ID,
        triggerSourceSelectorId: sourceSelector(index),
        triggerSourceContractVersion: 1,
        triggerObservationTransport: "checkpointedPull" as const,
        watcherMachineId: MACHINE_ID,
        watcherMachineInstallationId: MACHINE_INSTALLATION_ID,
        watcherPluginId: PLUGIN_ID,
        watcherMaterializationId: MATERIALIZATION_ID,
        triggerDefinitionEnvelope: JSON.stringify(
            sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: "plain",
                binding: {
                    v: 1,
                    automationId: id,
                    templateVersion: index,
                    triggerKind: "pluginEvent",
                    eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                    sourceSelectorId: sourceSelector(index),
                },
                definition: {
                v: 1,
                sourceInstanceId: `repository-${index}`,
                sourceConfig: { repositoryId: index },
                displayLabel: `Repository ${index}`,
                filter: null,
                maximumObservationAgeMs: null,
                },
            }),
        ),
    };
}

describe("Automation Event stored-definition projection", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-stored-definitions-",
            initAuth: false,
            env: { HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID },
        });
    }, 120_000);

    afterAll(async () => await harness?.close());

    afterEach(async () => {
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

    async function seed(definitionCount: number): Promise<void> {
        const release = releaseFacts();
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
        await db.automation.createMany({
            data: Array.from({ length: definitionCount }, (_, index) => automationDefinition(index + 1)),
        });
        await db.automationEventCatalogState.create({
            data: { accountId: ACCOUNT_ID, eventSourceDefinitionsRevision: 7n },
        });
    }

    async function seedCurrentDurablePushEndpoint(): Promise<void> {
        const route = await db.pluginWebhookRoute.create({
            data: {
                id: "route-automation-stored-definitions",
                opaqueRouteId: "opaque-automation-stored-definitions",
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
                sourceInstanceId: "endpoint-routing-repository",
                ensureIdempotencyKey: "automation-stored-definitions-endpoint-key",
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
    }

    async function seedCurrentDurablePushDelivery() {
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
        await seedCurrentDurablePushEndpoint();
        const endpoint = await db.pluginWebhookEndpoint.findUniqueOrThrow({
            where: { id: DURABLE_PUSH_ENDPOINT_ID },
            select: { id: true, revision: true, routeId: true },
        });
        const leaseId = "wh_lease_AAECAwQFBgcICQoLDA0ODw";
        await db.pluginWebhookDelivery.create({
            data: {
                id: "delivery-automation-stored-definitions",
                endpointId: endpoint.id,
                accountId: ACCOUNT_ID,
                routeId: endpoint.routeId,
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
                endpointSourceInstanceId: "endpoint-routing-repository",
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
        return {
            v: 1,
            deliveryId: "delivery-automation-stored-definitions",
            endpoint: {
                webhookEndpointId: endpoint.id,
                revision: endpoint.revision,
                webhookContribution: { pluginId: PLUGIN_ID, localId: "repository-events" },
                handlerActionLocalId: "receive-repository-events",
                sourceInstanceId: "endpoint-routing-repository",
            },
            target: {
                materialization: {
                    machineId: MACHINE_ID,
                    materializationId: MATERIALIZATION_ID,
                    pluginId: PLUGIN_ID,
                },
                machineInstallationId: MACHINE_INSTALLATION_ID,
            },
            lease: { leaseId, revision: 1 },
        } as const;
    }

    it("uses revision-bound keyset pages to disclose only the exact materialization's opaque stored envelopes", async () => {
        await seed(501);

        const first = await readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "checkpointedPull" }, pageSize: 500 },
        });
        expect(first).toMatchObject({
            kind: "page",
            revision: "7",
            eventDeclarationRelease: {
                release: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION },
                archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            },
            nextCursor: expect.any(String),
        });
        if (first.kind !== "page") throw new Error("expected the first private page");
        expect(first.definitions).toHaveLength(500);
        expect(first.definitions[0]).toMatchObject({
            automationId: "automation-0001",
            templateVersion: 1,
            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            sourceSelectorId: sourceSelector(1),
            storedDefinitionEnvelope: { t: "plain" },
        });
        expect(first.definitions[0]).not.toHaveProperty("sourceInstanceId");
        expect(first.definitions[0]).not.toHaveProperty("sourceConfig");
        expect(first.definitions[0]).not.toHaveProperty("filter");

        const second = await readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                transport: { kind: "checkpointedPull" },
                pageSize: 500,
                cursor: first.nextCursor!,
            },
        });
        expect(second).toMatchObject({
            kind: "page",
            revision: "7",
            nextCursor: null,
            definitions: [{ automationId: "automation-0501", templateVersion: 501 }],
        });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "checkpointedPull" }, knownRevision: "7" },
        })).resolves.toMatchObject({
            kind: "unchanged",
            revision: "7",
            eventDeclarationRelease: {
                release: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION },
                archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            },
            scope: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        });

        await db.automationEventCatalogState.update({
            where: { accountId: ACCOUNT_ID },
            data: { eventSourceDefinitionsRevision: 8n },
        });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                transport: { kind: "checkpointedPull" },
                pageSize: 500,
                cursor: first.nextCursor!,
            },
        })).resolves.toEqual({ kind: "cursorStale", currentRevision: "8" });

        await db.automation.update({
            where: { id: "automation-0001" },
            data: { watcherMaterializationId: "materialization-moved" },
        });
        await db.automationEventCatalogState.update({
            where: { accountId: ACCOUNT_ID },
            data: { eventSourceDefinitionsRevision: 9n },
        });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "checkpointedPull" }, pageSize: 1 },
        })).resolves.toMatchObject({
            kind: "page",
            revision: "9",
            definitions: [{ automationId: "automation-0002" }],
        });
    });

    it("projects durable-push envelopes only through the current generic endpoint target", async () => {
        await seed(1);
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
        const webhookInvocationReference = await seedCurrentDurablePushDelivery();
        await db.automation.update({
            where: { id: "automation-0001" },
            data: {
                triggerObservationTransport: "durablePush",
                triggerWebhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                triggerObservationStartsAt: new Date(1_723_247_200_000),
                watcherMachineId: null,
                watcherMachineInstallationId: null,
                watcherPluginId: null,
                watcherMaterializationId: null,
                triggerDefinitionEnvelope: JSON.stringify(
                    sealAutomationTriggerDefinitionStoredEnvelopeV1({
                        mode: "plain",
                        binding: {
                            v: 1,
                            automationId: "automation-0001",
                            templateVersion: 1,
                            triggerKind: "pluginEvent",
                            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                            sourceSelectorId: sourceSelector(1),
                        },
                        definition: {
                            v: 1,
                            sourceInstanceId: "repository-private-source",
                            webhookRoutingSourceInstanceId: "endpoint-routing-repository",
                            sourceConfig: { repositoryId: 1 },
                            displayLabel: "Repository 1",
                            filter: null,
                            maximumObservationAgeMs: null,
                        },
                    }),
                ),
            },
        });

        const initial = await readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "durablePush" } },
        });
        expect(initial).toMatchObject({
            kind: "page",
            revision: "7",
            scope: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
            definitions: [{
                automationId: "automation-0001",
                observationTransport: {
                    kind: "durablePush",
                    webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                    endpointMaterializationRef: {
                        pluginId: PLUGIN_ID,
                        machineId: MACHINE_ID,
                        materializationId: MATERIALIZATION_ID,
                    },
                    observationStartsAt: 1_723_247_200_000,
                },
                storedDefinitionEnvelope: { t: "plain" },
            }],
        });
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "durablePush" } },
            webhookInvocationReference,
        })).resolves.toMatchObject({
            kind: "page",
            revision: "7",
            definitions: [{ automationId: "automation-0001" }],
        });
        const initialScope = (initial as Readonly<{ scope?: string }>).scope;

        await db.pluginWebhookEndpoint.update({
            where: { id: DURABLE_PUSH_ENDPOINT_ID },
            data: { targetMaterializationId: "materialization-moved" },
        });
        const moved = await readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "durablePush" } },
        });
        expect(moved).toMatchObject({
            kind: "page",
            scope: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
            definitions: [],
        });
        expect((moved as Readonly<{ scope?: string }>).scope).not.toBe(initialScope);
        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "durablePush" } },
            webhookInvocationReference,
        })).rejects.toMatchObject({
            code: "durable_push_endpoint_context_unavailable",
        });
    });

    it("fails closed before disclosure when Account mode and a stored definition envelope disagree", async () => {
        await seed(1);
        const encrypted = sealAccountScopedBlobCiphertext({
            kind: "automation_trigger_evidence",
            material: { type: "dataKey", machineKey: new Uint8Array(32).fill(7) },
            payload: { v: 1 },
            randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
        });
        await db.automation.update({
            where: { id: "automation-0001" },
            data: { triggerDefinitionEnvelope: JSON.stringify({ t: "encrypted", c: encrypted }) },
        });

        await expect(readAutomationEventStoredDefinitionsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { transport: { kind: "checkpointedPull" } },
        })).rejects.toMatchObject(
            new AutomationEventStoredDefinitionsReadError("definition_content_unavailable"),
        );
    });
});
