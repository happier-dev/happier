import { readIndexedBundledDeclarationManifest } from '../../../../../cli/src/plugins/projection/registry/builtIn/declarationAssetFormat.mjs';
import { createHmac, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tweetnacl from "tweetnacl";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    normalizePluginReleaseFactsV1,
    readDeclaredPackageAssetsV1,
    PluginWebhookEndpointEnsureInputV1Schema,
    PluginWebhookEndpointCheckCorrespondenceResultV1Schema,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    type PluginWebhookEndpointCheckCorrespondenceInputV1,
} from "@happier-dev/protocol";

import { createPluginHttpFixture } from "@happier-dev/plugin-sdk/testing";
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from "@happier-dev/protocol/connect/connectedServiceUxDiagnostics";
import { GITHUB_MANAGED_PUSH_EVENT_LOCAL_ID_V1 } from "@happier-dev/protocol/automations/event-setup-result";
import { AutomationTriggerIdSchema } from "@happier-dev/protocol/automations/automationTriggerIdentity";
import { AutomationSourceSelectorIdV1Schema } from "@happier-dev/protocol/automations/automationEventDeclarationV1";
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from "@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent";
import { readGithubManagedRepositoryHookSource, writeGithubManagedRepositoryWebhook } from "../../../../../../packages/plugins/scm-github/src/githubManagedRepositoryWebhook";
import { createGithubRepositorySourceConfig, GITHUB_CONNECTED_ACCOUNT_SERVICE } from "../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts";
import type { ForwardManagedPluginWebhookOperation } from "@/app/api/socket/managedPluginWebhookDispatcher";
import { registerManagedPluginWebhookForEndpoint } from "./registerManagedPluginWebhookForEndpoint";
import { removeUnusedManagedRepositoryWebhook } from "./removeUnusedManagedRepositoryWebhook";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAutomationWorkflowRecipeFixture } from "@/testkit/automationWorkflowRecipe";
import { registerAutomationV3Routes } from "@/app/api/routes/automations/registerAutomationV3Routes";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { createSignedPluginInstallationPublisherHeader } from "@/testkit/pluginInstallationPublisherTestkit";
import { registerPluginWebhookDaemonRoutes } from "@/app/api/routes/plugins/webhooks/registerPluginWebhookDaemonRoutes";
import { registerPluginWebhookIngressRoute } from "@/app/api/routes/plugins/webhooks/registerPluginWebhookIngressRoute";

import {
    createPluginWebhookEndpointActionsV1,
    rotatePluginWebhookEndpointCredentialV1,
} from "./endpointActions";
import { ingestPluginWebhookV1 } from "./ingest";
import { readPluginWebhookAccountStatusV1 } from "./statusStore";

/**
 * The end-to-end reachability proof for the durable-push producer the GitHub
 * plugin actually ships. It deliberately reads the plugin's own published
 * normalized manifest rather than a fixture: the routing declared there is the
 * single fact that decides whether `ensure` can mint an Account endpoint at
 * all, and a fixture copy would pass while the shipped plugin stayed
 * unreachable.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const GITHUB_PLUGIN_MANIFEST_PATH = resolve(
    REPO_ROOT,
    "apps/cli/assets/bundled-plugin-manifests/scm-github.json",
);

const PREVIEW_LIFECYCLE_EVENT = "automation/pull-request-lifecycle-v1";
const SERVER_IDENTITY_ID = "srv_githubAccountEndpoint1";
const PUBLIC_SERVER_URL = "https://happier.example";
const MACHINE_ID = "github-endpoint-machine";
const MACHINE_INSTALLATION_ID = "github-endpoint-installation";
const MATERIALIZATION_ID = "github-endpoint-materialization";
const ROUTING_SOURCE_INSTANCE_ID = "github:repository:849312001";

type GithubPluginManifestFacts = Readonly<{
    pluginId: string;
    version: string;
    normalizedManifest: Record<string, unknown>;
    webhookLocalId: string;
    handlerActionLocalId: string;
}>;

function readGithubPluginManifestFacts(): GithubPluginManifestFacts {
    const normalizedManifest = readIndexedBundledDeclarationManifest(GITHUB_PLUGIN_MANIFEST_PATH);
    const contributes = normalizedManifest.contributes as Record<string, unknown>;
    const webhooks = contributes.webhooks as ReadonlyArray<Record<string, unknown>>;
    const webhook = webhooks[0]!;
    const handlerAction = webhook.handlerAction as Record<string, unknown>;
    return {
        pluginId: String(normalizedManifest.id),
        version: String(normalizedManifest.version),
        normalizedManifest,
        webhookLocalId: String(webhook.id),
        handlerActionLocalId: String(handlerAction.localId),
    };
}

const MANIFEST = readGithubPluginManifestFacts();

const MATERIALIZATION_REF = {
    machineId: MACHINE_ID,
    materializationId: MATERIALIZATION_ID,
    pluginId: MANIFEST.pluginId,
} as const;

/**
 * Rewrites only the webhook routing of the shipped manifest. It reproduces the
 * exact predecessor declaration (`providerInstallation`) so the reason the
 * plugin had to move to `accountEndpoint` stays falsifiable instead of being
 * asserted from the constant it changed.
 */
function manifestWithWebhookRouting(routing: string): Record<string, unknown> {
    const copy = JSON.parse(JSON.stringify(MANIFEST.normalizedManifest)) as Record<string, unknown>;
    const contributes = copy.contributes as Record<string, unknown>;
    const webhooks = contributes.webhooks as Array<Record<string, unknown>>;
    for (const webhook of webhooks) {
        (webhook.verifier as Record<string, unknown>).routing = routing;
    }
    return copy;
}

async function seedAccount(
    normalizedManifest: Record<string, unknown> = MANIFEST.normalizedManifest,
): Promise<string> {
    const release = normalizePluginReleaseFactsV1({
        ref: { pluginId: MANIFEST.pluginId, version: MANIFEST.version },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"b".repeat(64)}`,
            resources: (readDeclaredPackageAssetsV1(normalizedManifest) ?? []).map((asset) => ({
                ...asset,
                byteSize: 1,
                digestSha256: `sha256:${"c".repeat(64)}`,
            })),
        },
        normalizedManifest,
        collectionContracts: [],
        uiSlots: [],
    });
    const account = await db.account.create({
        data: { encryptionMode: "plain" },
        select: { id: true },
    });
    await db.machine.create({
        data: {
            id: MACHINE_ID,
            accountId: account.id,
            metadata: "{}",
            installationId: MACHINE_INSTALLATION_ID,
            pluginMaterializationRevision: 1n,
            operationProtocolCapabilities: { pluginWebhookClaim: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        },
    });
    await db.accountPluginIntent.create({
        data: {
            accountId: account.id,
            pluginId: MANIFEST.pluginId,
            desiredVersion: MANIFEST.version,
            enabled: true,
            writableCollections: [],
        },
    });
    await db.accountPluginRelease.create({
        data: {
            accountId: account.id,
            pluginId: MANIFEST.pluginId,
            version: MANIFEST.version,
            archiveDigestSha256: release.archiveDigestSha256,
            normalizedManifest: release.normalizedManifest,
            collectionContracts: [],
            uiSlots: [],
            packageAssetArchive: release.packageAssetArchive,
        },
    });
    await db.pluginMachineMaterialization.create({
        data: {
            accountId: account.id,
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializationId: MATERIALIZATION_ID,
            pluginId: MANIFEST.pluginId,
            version: MANIFEST.version,
            sourceClass: "registryPackage",
            portableRelease: true,
            archiveDigestSha256: release.archiveDigestSha256,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted",
            observedAt: new Date("2026-08-22T00:00:00.000Z"),
        },
    });
    return account.id;
}

async function ensureGithubEndpoint(accountId: string, idempotencyKey: string) {
    return await createPluginWebhookEndpointActionsV1().ensure({
        accountId,
        input: PluginWebhookEndpointEnsureInputV1Schema.parse({
            webhookContribution: {
                pluginId: MANIFEST.pluginId,
                localId: MANIFEST.webhookLocalId,
            },
            targetMaterialization: MATERIALIZATION_REF,
            sourceInstanceId: ROUTING_SOURCE_INSTANCE_ID,
            setup: { kind: "accountEndpointV1", credential: "serverGenerated" },
            idempotencyKey,
        }),
    });
}

function readOpaqueRouteId(publicUrl: string): string {
    const path = new URL(publicUrl).pathname;
    const prefix = "/v1/plugins/webhooks/";
    expect(path.startsWith(prefix)).toBe(true);
    return path.slice(prefix.length);
}

const PUSH_BODY = Buffer.from(JSON.stringify({
    action: "opened",
    repository: { full_name: "happier-dev/happier" },
}), "utf8");

function githubHeaders(secret: string, deliveryId: string) {
    return {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(PUSH_BODY).digest("hex")}`,
    };
}

describe("Account webhook endpoint with the shipped GitHub producer", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-github-account-endpoint-",
            initEncrypt: true,
            env: {
                HANDY_MASTER_SECRET: "github-account-endpoint-master-secret",
                HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID,
                HAPPIER_PUBLIC_SERVER_URL: PUBLIC_SERVER_URL,
            },
        });
    }, 180_000);

    afterAll(async () => await harness.close());

    afterEach(async () => {
        harness.resetEnv({
            HANDY_MASTER_SECRET: "github-account-endpoint-master-secret",
            HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID,
            HAPPIER_PUBLIC_SERVER_URL: PUBLIC_SERVER_URL,
        });
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationTrigger.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.pluginWebhookEndpointOperation.deleteMany(),
            () => db.pluginWebhookCredential.deleteMany(),
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

    it("saves the GitHub Push observer when GitHub cannot reach the Home", async () => {
        harness.resetEnv({
            HANDY_MASTER_SECRET: "github-account-endpoint-master-secret",
            HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID,
            HAPPIER_PUBLIC_SERVER_URL: "https://127.0.0.1:8443",
        });
        const accountId = await seedAccount();
        const repositoryId = ROUTING_SOURCE_INSTANCE_ID.split(":").at(-1)!;
        const repository = { id: Number(repositoryId), name: "example", full_name: "fixture/example", owner: { login: "fixture" } };
        const automationId = randomUUID();
        const triggerId = randomUUID();
        const app = createAuthenticatedTestApp();
        registerAutomationV3Routes(app);
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v3/automations",
                headers: { "x-test-user-id": accountId },
                payload: {
                    automationId, name: "Deploy on push", enabled: true,
                    assignments: [{ machineId: MACHINE_ID }],
                    executionRecipe: createAutomationWorkflowRecipeFixture({
                        templateVersion: 1, directory: "/workspace/app", prompt: "Deploy",
                    }),
                    triggers: [{
                        triggerId, managedGithubRepositoryId: repositoryId,
                        trigger: {
                            kind: "pluginEvent", enabled: true, sourceInstanceId: ROUTING_SOURCE_INSTANCE_ID,
                            sourceContractVersion: 1, displayLabel: repository.full_name, filter: null,
                            maximumObservationAgeMs: null,
                            eventRef: { pluginId: MANIFEST.pluginId, localId: GITHUB_MANAGED_PUSH_EVENT_LOCAL_ID_V1 },
                            sourceConfig: { v: 1, repository: createGithubRepositorySourceConfig(repository),
                                credentialRef: { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: "fixture-github" } },
                            observationTransport: { kind: "checkpointedPull", watcherMaterializationRef: {
                                machineId: MACHINE_ID, pluginId: MANIFEST.pluginId, materializationId: MATERIALIZATION_ID,
                            } },
                        },
                    }],
                },
            });
            expect(response.json()).toMatchObject({ managedGithubRepositoryHooks: [{
                triggerId, result: { kind: "polling", code: "github_webhook_home_unreachable" },
            }] });
            expect(response.statusCode).toBe(200);
            expect(await db.automationTrigger.findUnique({ where: { id: triggerId } })).toMatchObject({
                automationId, observationTransport: "checkpointedPull", watcherMachineId: MACHINE_ID,
                webhookEndpointId: null,
            });
            expect(await db.pluginWebhookEndpoint.count({ where: { accountId } })).toBe(0);
        } finally {
            await app.close();
        }
    });

    it.each(["full", "light"])("admits a signed GitHub delivery through the %s-server public route without Redis", async (flavor) => {
        const accountId = await seedAccount();

        const ensured = await ensureGithubEndpoint(accountId, "ensure-github-account-endpoint-1");
        expect(ensured.readiness).toBe("providerConfirmationRequired");
        expect(ensured.publicUrl.startsWith(`${PUBLIC_SERVER_URL}/v1/plugins/webhooks/wh_route_`)).toBe(true);
        const secret = ensured.oneTimeGeneratedSecret;
        expect(typeof secret).toBe("string");

        const app = createAuthenticatedTestApp();
        registerPluginWebhookIngressRoute(app, {
            env: {
                HAPPIER_FEATURE_PLUGINS__ENABLED: "1",
                HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1",
                HAPPIER_SERVER_FLAVOR: flavor,
            },
        });
        try {
            const post = (signatureSecret: string) => app.inject({
                method: "POST",
                url: new URL(ensured.publicUrl).pathname,
                payload: PUSH_BODY,
                headers: githubHeaders(signatureSecret, "delivery-github-1"),
            });
            const accepted = await post(secret!);
            expect(accepted.statusCode).toBe(202);
            expect(accepted.body).toBe("");
            expect((await post(`${secret!}-tampered`)).statusCode).toBe(401);
            expect(await db.pluginWebhookDelivery.count()).toBe(1);
            expect((await post(secret!)).statusCode).toBe(202);
        } finally {
            await app.close();
        }

        // The admitted delivery is bound to the endpoint whose handler Action is
        // the GitHub plugin's own webhook handler — the Action the daemon invokes
        // to admit the Automation Event.
        const endpoint = await db.pluginWebhookEndpoint.findFirstOrThrow({
            where: { accountId },
            select: {
                id: true,
                routingKind: true,
                handlerActionId: true,
                pluginId: true,
                sourceInstanceId: true,
                deliveries: { select: { state: true } },
            },
        });
        expect(endpoint).toMatchObject({
            routingKind: "accountEndpoint",
            pluginId: MANIFEST.pluginId,
            handlerActionId: MANIFEST.handlerActionLocalId,
            sourceInstanceId: ROUTING_SOURCE_INSTANCE_ID,
        });
        expect(endpoint.deliveries).toHaveLength(1);
    });

    it("keeps a saved deployment push on polling until GitHub accepts the hook and delivers a signed event", async () => {
        const accountId = await seedAccount();
        const repositoryId = ROUTING_SOURCE_INSTANCE_ID.split(":").at(-1)!;
        const automationId = "managed-push";
        const triggerId = AutomationTriggerIdSchema.parse("managed-push-trigger");
        const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(randomUUID());
        const eventRef = { pluginId: MANIFEST.pluginId, localId: GITHUB_MANAGED_PUSH_EVENT_LOCAL_ID_V1 };
        const credentialRef = { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: "fixture-github" };
        const repository = { id: Number(repositoryId), name: "example", full_name: "fixture/example", owner: { login: "fixture" } };
        const sourceConfig = { v: 1, repository: createGithubRepositorySourceConfig(repository), credentialRef };
        const definitionEnvelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding: { v: 1, automationId, triggerId, triggerRevision: 0, triggerKind: "pluginEvent", eventRef, sourceSelectorId },
            definition: { v: 1, sourceInstanceId: ROUTING_SOURCE_INSTANCE_ID, sourceConfig,
                displayLabel: repository.full_name, filter: null, maximumObservationAgeMs: null },
        });
        await db.automation.create({ data: {
            id: automationId, accountId, name: "Deploy on push", enabled: true, templateCiphertext: "{}",
            triggers: { create: { id: triggerId, kind: "pluginEvent", enabled: true, revision: 0,
                eventPluginId: eventRef.pluginId, eventLocalId: eventRef.localId, sourceSelectorId, sourceContractVersion: 1,
                observationTransport: "checkpointedPull", watcherMachineId: MACHINE_ID, watcherPluginId: MANIFEST.pluginId,
                watcherMachineInstallationId: MACHINE_INSTALLATION_ID, watcherMaterializationId: MATERIALIZATION_ID,
                definitionEnvelope: JSON.stringify(definitionEnvelope) } },
        } });

        const hookId = "123";
        let providerAllowsWrite = false;
        let registration: { url: string; secret: string } | undefined;
        const writes: string[] = [];
        const http = createPluginHttpFixture({ async request(request) {
            const path = new URL(request.url).pathname;
            if (request.method === "POST") {
                expect(path).toBe("/repos/fixture/example/hooks");
                writes.push(request.method);
                if (!providerAllowsWrite) return { status: 403, headers: {}, body: new TextEncoder().encode("{}") };
                const body = JSON.parse(new TextDecoder().decode(request.body));
                expect(body).toMatchObject({ active: true, events: ["push"], config: { content_type: "json", insecure_ssl: "0" } });
                registration = { url: body.config.url, secret: body.config.secret };
                return { status: 201, headers: {}, body: new TextEncoder().encode(JSON.stringify({ id: Number(hookId) })) };
            }
            if (request.method === "PATCH") {
                expect(path).toBe(`/repos/fixture/example/hooks/${hookId}`);
                const body = JSON.parse(new TextDecoder().decode(request.body));
                if ('add_events' in body) {
                    expect(body).toEqual({ add_events: ['pull_request'] });
                    writes.push('PATCH add');
                    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ id: Number(hookId), events: ['push', 'pull_request'] })) };
                }
                expect(body).toEqual({ remove_events: ['pull_request'] });
                writes.push('PATCH remove');
                return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ id: Number(hookId), events: ['push'] })) };
            }
            if (request.method === "DELETE") {
                expect(path).toBe(`/repos/fixture/example/hooks/${hookId}`);
                writes.push(request.method);
                return { status: 204, headers: {}, body: new Uint8Array() };
            }
            expect(path).toBe(`/repositories/${repositoryId}`);
            return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(repository)) };
        } });
        const materialize = async () => ({ kind: "httpHeaders" as const, headers: { Authorization: "Bearer fixture" } });
        const forward: ForwardManagedPluginWebhookOperation = async ({ target, operation }) => {
            expect(target).toEqual({ accountId, machineId: MACHINE_ID, installationId: MACHINE_INSTALLATION_ID });
            const source = readGithubManagedRepositoryHookSource(ROUTING_SOURCE_INSTANCE_ID, sourceConfig);
            if (!source) throw new Error("Expected a bound GitHub repository source");
            return writeGithubManagedRepositoryWebhook({
                plugin: { id: MANIFEST.pluginId, version: MANIFEST.version }, invokedAtMs: Date.now(),
                requestId: operation.operationId, signal: new AbortController().signal,
                services: { http, connectedAccounts: { getBinding: async () => null, materialize, materializeListedAccount: materialize } },
            }, operation.kind === "register"
                ? { kind: "register", ...source, publicUrl: operation.publicUrl, signingSecret: operation.signingSecret }
                : { kind: operation.kind, ...source, hookId: operation.hookId });
        };
        const setup = { accountId, automationId, triggerId, triggerRevision: 0, repositoryId, publicBaseUrl: PUBLIC_SERVER_URL, forward };
        const readTrigger = () => db.automationTrigger.findUniqueOrThrow({ where: { id: triggerId } });
        await expect(registerManagedPluginWebhookForEndpoint({ ...setup, triggerRevision: 1 }))
            .resolves.toEqual({ kind: "polling", code: "endpoint_unavailable" });
        expect(writes).toEqual([]);
        await expect(registerManagedPluginWebhookForEndpoint(setup)).resolves.toEqual({
            kind: "polling", code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialScopeMissing,
        });
        const trigger = await readTrigger();
        expect(trigger).toMatchObject({ observationTransport: "checkpointedPull", webhookEndpointId: expect.any(String) });

        providerAllowsWrite = true;
        await expect(registerManagedPluginWebhookForEndpoint(setup)).resolves.toEqual({ kind: "pendingVerification" });
        expect(await readTrigger()).toMatchObject({ observationTransport: "checkpointedPull" });
        if (!registration) throw new Error("GitHub did not receive hook registration");
        const rawBody = Buffer.from(JSON.stringify({ ref: "refs/heads/main", repository }));
        await expect(ingestPluginWebhookV1({
            opaqueRouteId: readOpaqueRouteId(registration.url), rawBody,
            headers: { "x-github-event": "push", "x-github-delivery": "managed-push-proof", "x-github-hook-id": hookId,
                "x-hub-signature-256": `sha256=${createHmac("sha256", registration.secret).update(rawBody).digest("hex")}` },
        })).resolves.toMatchObject({ kind: "accepted" });
        const promoted = await readTrigger();
        expect(promoted).toMatchObject({ observationTransport: "durablePush", webhookEndpointId: trigger.webhookEndpointId });
        // The same retained hook serves push and the admitted Preview. Other
        // Account ids and ordinary PR-event Automations cannot change it.
        const previewId = 'preview-workflow';
        const previewTrigger = AutomationTriggerIdSchema.parse('preview-trigger');
        const previewSelector = AutomationSourceSelectorIdV1Schema.parse(randomUUID());
        const previewEventRef = { ...eventRef, localId: PREVIEW_LIFECYCLE_EVENT };
        const previewEnvelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: 'plain',
            binding: { v: 1, automationId: previewId, triggerId: previewTrigger, triggerRevision: 0, triggerKind: 'pluginEvent',
                eventRef: previewEventRef, sourceSelectorId: previewSelector },
            definition: { v: 1, sourceInstanceId: ROUTING_SOURCE_INSTANCE_ID, sourceConfig, displayLabel: repository.full_name,
                filter: null, maximumObservationAgeMs: null },
        });
        await db.automation.create({ data: {
            id: previewId, accountId, name: 'Preview PR', enabled: true, templateCiphertext: '{}',
            triggers: { create: { id: previewTrigger, kind: 'pluginEvent', enabled: true, revision: 0,
                sourceSelectorId: previewSelector, sourceContractVersion: 1, eventPluginId: previewEventRef.pluginId,
                eventLocalId: previewEventRef.localId, observationTransport: 'checkpointedPull',
                watcherMachineId: MACHINE_ID, watcherMachineInstallationId: MACHINE_INSTALLATION_ID,
                watcherMaterializationId: MATERIALIZATION_ID, watcherPluginId: MANIFEST.pluginId,
                webhookEndpointId: null, observationStartsAt: null, definitionEnvelope: JSON.stringify(previewEnvelope) } },
        } });
        const previewSetup = { ...setup, automationId: previewId, triggerId: previewTrigger };
        await expect(registerManagedPluginWebhookForEndpoint(previewSetup)).resolves.toMatchObject({ kind: 'polling' });
        await db.automation.update({ where: { id: previewId }, data: { deploymentPreviewRole: 'preview_admission' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        await expect(registerManagedPluginWebhookForEndpoint({ ...previewSetup, accountId: stranger.id }))
            .resolves.toMatchObject({ kind: 'polling' });
        await expect(registerManagedPluginWebhookForEndpoint(setup)).resolves.toEqual({ kind: 'webhook' });
        expect(writes).toEqual(['POST', 'POST']);
        await expect(registerManagedPluginWebhookForEndpoint(previewSetup)).resolves.toEqual({ kind: 'webhook' });
        expect(await db.automationTrigger.findUniqueOrThrow({ where: { id: previewTrigger } }))
            .toMatchObject({ observationTransport: 'durablePush', webhookEndpointId: trigger.webhookEndpointId });
        const previewConsumer = await db.automationTrigger.delete({ where: { id: previewTrigger } });
        await expect(removeUnusedManagedRepositoryWebhook({ accountId, consumer: previewConsumer, forward }))
            .resolves.toEqual({ kind: 'retained' });
        expect(writes).toEqual(['POST', 'POST', 'PATCH add', 'PATCH remove']);
        await db.automationTrigger.delete({ where: { id: triggerId } });
        await expect(removeUnusedManagedRepositoryWebhook({ accountId, consumer: promoted, forward })).resolves.toEqual({ kind: "removed" });
        expect(writes).toEqual(["POST", "POST", "PATCH add", "PATCH remove", "DELETE"]);
    });

    it("keeps every readiness projection unconfirmed until a verified delivery proves the provider was configured", async () => {
        const accountId = await seedAccount();
        const keyPair = tweetnacl.sign.keyPair();
        await db.machine.update({ where: { id: MACHINE_ID }, data: { installationPublicKey: new Uint8Array(keyPair.publicKey) } });
        const app = createAuthenticatedTestApp();
        registerPluginWebhookDaemonRoutes(app, undefined, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        try {
        const ensured = await ensureGithubEndpoint(accountId, "ensure-github-account-endpoint-readiness");
        const opaqueRouteId = readOpaqueRouteId(ensured.publicUrl);
        const readReadiness = async () => (await createPluginWebhookEndpointActionsV1().read({
            accountId,
            input: { webhookEndpointId: ensured.webhookEndpointId },
        })).readiness;
        const statusReadiness = async () => (await readPluginWebhookAccountStatusV1({
            accountId,
            input: { pageSize: 50, deadLetterPageSize: 0 },
        })).endpoints.map((endpoint) => endpoint.readiness);
        const correspondenceInput = {
            webhookEndpointId: ensured.webhookEndpointId,
            webhookContribution: { pluginId: MANIFEST.pluginId, localId: MANIFEST.webhookLocalId },
            targetMaterialization: MATERIALIZATION_REF,
            sourceInstanceId: ROUTING_SOURCE_INSTANCE_ID,
            setup: { kind: "accountEndpointV1", credential: "serverGenerated" },
        } as const;
        const readCorrespondence = async (input: PluginWebhookEndpointCheckCorrespondenceInputV1 = correspondenceInput) => {
            const path = "/v1/plugins/webhooks/endpoints/check-correspondence";
            const body = { caller: MATERIALIZATION_REF, input };
            const response = await app.inject({ method: "POST", url: path, payload: body, headers: {
                "x-test-user-id": accountId,
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair, machineId: MACHINE_ID, installationId: MACHINE_INSTALLATION_ID, path, body,
                }),
            } });
            expect(response.statusCode).toBe(200);
            return PluginWebhookEndpointCheckCorrespondenceResultV1Schema.parse(response.json());
        };

        // An enabled endpoint with a live route is NOT a working delivery path.
        expect(ensured.readiness).toBe("providerConfirmationRequired");
        await expect(readReadiness()).resolves.toBe("providerConfirmationRequired");
        await expect(statusReadiness()).resolves.toEqual(["providerConfirmationRequired"]);
        await expect(readCorrespondence()).resolves.toMatchObject({ kind: "ready", readiness: "providerConfirmationRequired" });

        // A request the verifier rejected is not provider confirmation.
        await expect(ingestPluginWebhookV1({
            opaqueRouteId,
            rawBody: PUSH_BODY,
            headers: githubHeaders(`${ensured.oneTimeGeneratedSecret!}-tampered`, "delivery-readiness-rejected"),
        })).resolves.toMatchObject({ kind: "rejected", statusCode: 401 });
        await expect(readReadiness()).resolves.toBe("providerConfirmationRequired");
        await expect(statusReadiness()).resolves.toEqual(["providerConfirmationRequired"]);

        await expect(ingestPluginWebhookV1({
            opaqueRouteId,
            rawBody: PUSH_BODY,
            headers: githubHeaders(ensured.oneTimeGeneratedSecret!, "delivery-readiness-verified"),
        })).resolves.toMatchObject({ kind: "accepted" });

        await expect(readReadiness()).resolves.toBe("ready");
        await expect(statusReadiness()).resolves.toEqual(["ready"]);
        await expect(readCorrespondence()).resolves.toMatchObject({ kind: "ready", readiness: "ready" });
        await expect(readCorrespondence({ ...correspondenceInput, sourceInstanceId: "different-source" }))
            .resolves.toEqual({ kind: "unavailable", code: "endpoint_unavailable" });
        await expect(readCorrespondence({ ...correspondenceInput,
            targetMaterialization: { ...MATERIALIZATION_REF, materializationId: "different-materialization" },
        })).resolves.toEqual({ kind: "unavailable", code: "endpoint_unavailable" });
        await expect(readCorrespondence({ ...correspondenceInput,
            webhookContribution: { pluginId: MANIFEST.pluginId, localId: "different-contribution" },
        })).resolves.toEqual({ kind: "unavailable", code: "endpoint_unavailable" });

        // The same idempotency key rejoins a confirmed endpoint, so the lost
        // one-time disclosure no longer blocks provider setup.
        await expect(ensureGithubEndpoint(accountId, "ensure-github-account-endpoint-readiness"))
            .resolves.toMatchObject({ readiness: "ready" });
        await db.pluginWebhookEndpoint.update({ where: { id: ensured.webhookEndpointId }, data: { enabled: false } });
        await expect(readCorrespondence()).resolves.toEqual({ kind: "unavailable", code: "endpoint_unavailable" });
        } finally { await app.close(); }
    });

    it("returns readiness to provider confirmation across a credential rotation until the new secret delivers", async () => {
        const accountId = await seedAccount();
        const ensured = await ensureGithubEndpoint(accountId, "ensure-github-account-endpoint-rotation");
        const opaqueRouteId = readOpaqueRouteId(ensured.publicUrl);
        const readEndpoint = async () => await createPluginWebhookEndpointActionsV1().read({
            accountId,
            input: { webhookEndpointId: ensured.webhookEndpointId },
        });

        await expect(ingestPluginWebhookV1({
            opaqueRouteId,
            rawBody: PUSH_BODY,
            headers: githubHeaders(ensured.oneTimeGeneratedSecret!, "delivery-rotation-1"),
        })).resolves.toMatchObject({ kind: "accepted" });
        const confirmed = await readEndpoint();
        expect(confirmed.readiness).toBe("ready");

        const rotated = await rotatePluginWebhookEndpointCredentialV1({
            accountId,
            input: { webhookEndpointId: ensured.webhookEndpointId, expectedRevision: confirmed.revision },
        });
        expect(rotated).toMatchObject({ kind: "rotated", oneTimeGeneratedSecret: expect.any(String) });
        const rotatedSecret = rotated.oneTimeGeneratedSecret;
        if (rotatedSecret === undefined) throw new Error("Expected the rotation to disclose its new secret");

        // The provider still holds the superseded secret. Reporting `ready`
        // here would call a configuration that breaks when the overlap ends a
        // working delivery path.
        await expect(readEndpoint()).resolves.toMatchObject({ readiness: "providerConfirmationRequired" });

        // A delivery still signed with the superseded secret verifies inside
        // the overlap window and is admitted, but it proves nothing about the
        // credential the provider now has to be reconfigured with.
        await expect(ingestPluginWebhookV1({
            opaqueRouteId,
            rawBody: PUSH_BODY,
            headers: githubHeaders(ensured.oneTimeGeneratedSecret!, "delivery-rotation-2"),
        })).resolves.toMatchObject({ kind: "accepted" });
        await expect(readEndpoint()).resolves.toMatchObject({ readiness: "providerConfirmationRequired" });

        // Positive twin: the reconfigured provider's first delivery confirms
        // the current credential, so the states above are the rotation and not
        // a permanently unconfirmable endpoint.
        await expect(ingestPluginWebhookV1({
            opaqueRouteId,
            rawBody: PUSH_BODY,
            headers: githubHeaders(rotatedSecret, "delivery-rotation-3"),
        })).resolves.toMatchObject({ kind: "accepted" });
        await expect(readEndpoint()).resolves.toMatchObject({ readiness: "ready" });
    });

    it("rejects a delivery signed with any secret other than the one disclosed by ensure", async () => {
        const accountId = await seedAccount();
        const ensured = await ensureGithubEndpoint(accountId, "ensure-github-account-endpoint-2");

        const ingested = await ingestPluginWebhookV1({
            opaqueRouteId: readOpaqueRouteId(ensured.publicUrl),
            rawBody: PUSH_BODY,
            headers: githubHeaders(`${ensured.oneTimeGeneratedSecret!}-tampered`, "delivery-github-2"),
        });

        expect(ingested).toMatchObject({ kind: "rejected", statusCode: 401 });
        expect(await db.pluginWebhookDelivery.count()).toBe(0);
    });

    it("cannot mint an Account endpoint while the same plugin declares shared-installation routing", async () => {
        const accountId = await seedAccount(manifestWithWebhookRouting("providerInstallation"));

        await expect(ensureGithubEndpoint(accountId, "ensure-github-account-endpoint-3"))
            .rejects.toThrow("endpoint_unavailable");
        expect(await db.pluginWebhookEndpoint.count()).toBe(0);
        expect(await db.pluginWebhookRoute.count()).toBe(0);
    });
});
