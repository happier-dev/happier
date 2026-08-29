import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";

import {
    AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
    AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
    AutomationStoredDefinitionExecutionRecipeV1Schema,
    AutomationConversationActionHttpPathsV1,
    AutomationConversationActionHttpRequestSchemasV1,
    AutomationConversationAdmitResultV1Schema,
    AutomationEventActionHttpPathsV1,
    AutomationEventActionHttpRequestSchemasV1,
    AutomationEventStoredDefinitionsReadHttpRequestV1Schema,
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    buildAutomationConversationOccurrenceEvidenceV1,
    createPluginInstallationManifestPublisherSigningInputV1,
    deriveAutomationOccurrenceKeyV1,
    normalizePluginReleaseFactsV1,
    parseAutomationRunExecutionRecipeV1,
    PluginJsonValueV2Schema,
    readDeclaredPackageAssetsV1,
    sealAutomationConversationReplyContextStoredEnvelopeV1,
    sealAutomationRunResultStoredEnvelopeV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
    stringifyPluginInstallationManifestCanonicalJsonV1,
    type AccountEncryptionCurrentnessResponse,
    type AutomationReplyHandoffDispatchResultV1,
    type PluginJsonValueV2,
} from "@happier-dev/protocol";

import { registerAutomationConversationRoutes } from "@/app/api/routes/automations/registerAutomationConversationRoutes";
import { registerAutomationEventRoutes } from "@/app/api/routes/automations/registerAutomationEventRoutes";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { claimAutomationRun } from "@/app/automations/automationClaimService";
import {
    createAutomation,
    runAutomationNow,
    updateAutomation,
} from "@/app/automations/automationCrudService";
import {
    startAutomationRun,
    succeedAutomationRun,
} from "@/app/automations/automationRunService";
import { runAutomationReplyHandoffWorkerPass } from "@/app/automations/automationReplyHandoffWorker";
import { runAutomationScheduleWorkerPass } from "@/app/automations/automationScheduleWorker";
import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

const ACCOUNT_ID = "account-channels-provider-composed";
const MACHINE_ID = "machine-channels-provider-composed";
const MACHINE_INSTALLATION_ID = "installation-channels-provider-composed";
const MATERIALIZATION_ID = "materialization-channels-provider-composed";
const SERVER_IDENTITY_ID = "srv_channelsProviderComposed01";
const AUTOMATION_ID = "automation-channels-provider-composed";
const TRIGGER_ID = AutomationTriggerIdSchema.parse("trigger-channels-provider-composed");
const COMPOSED_SCHEDULE_TRIGGER_A_ID = "trigger-composed-schedule-a";
const COMPOSED_SCHEDULE_TRIGGER_B_ID = "trigger-composed-schedule-b";
const COMPOSED_ZERO_TRIGGER_AUTOMATION_ID = "automation-composed-zero-trigger";
const COMPOSED_CONNECTION_ID = "connection-telegram";
const COMPOSED_BINDING_ID = "binding-composed-1";
const COMPOSED_CONVERSATION_OCCURRENCE_ID = "conversation:composed:custody:1";
const COMPOSED_SESSION_ID = "session-channels-provider-composed";
const CHANNELS_MATERIALIZATION_ID = "channels-materialization";
const CHANNELS_RESULT_DELIVERY_ACTION_LOCAL_ID = "automation/result-deliver-v1";
const CHANNELS_INGRESS_CONTRIBUTION_LOCAL_ID = "provider/observation-ingest-v1";
const SOURCE_SELECTOR_ID = AutomationSourceSelectorIdV1Schema.parse(
    "bd37e041-8d5c-4f9b-985d-101f43d32a41",
);
const VERSION = "0.0.0";
const CHANNELS_PLUGIN_ID = "happier.channels";
const CHANNELS_GENERATION = "channels-provider-composed-generation";
const PROVIDER_GENERATION = "provider-channels-composed-generation";

type JsonRecord = Readonly<Record<string, unknown>>;
type StoredRow = Readonly<{
    rowId: string;
    revision: number;
    value: JsonRecord;
    deleted?: boolean;
}>;
type DynamicExecutor = (args: JsonRecord) => Promise<unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${name}`);
    return value;
}

function createSignedPublisherHeader(params: Readonly<{
    body: unknown;
    keyPair: tweetnacl.SignKeyPair;
    path: string;
}>): string {
    const proof = {
        v: 1 as const,
        alg: "ed25519-machine-installation-v1" as const,
        machineId: MACHINE_ID,
        installationId: MACHINE_INSTALLATION_ID,
        issuedAt: Date.now(),
        nonce: randomUUID(),
        method: "POST" as const,
        path: params.path,
        bodySha256Base64Url: createHash("sha256")
            .update(stringifyPluginInstallationManifestCanonicalJsonV1(params.body))
            .digest("base64url"),
    };
    const signature = tweetnacl.sign.detached(
        createPluginInstallationManifestPublisherSigningInputV1({ proof }),
        params.keyPair.secretKey,
    );
    return Buffer.from(JSON.stringify({
        proof: {
            ...proof,
            signatureBase64Url: Buffer.from(signature).toString("base64url"),
        },
    }), "utf8").toString("base64url");
}

function stateRow(value: JsonRecord, revision = 1, deleted = false): StoredRow {
    const rowId = requiredString(value.id, "Channels row id");
    return { rowId, revision, value, ...(deleted ? { deleted: true } : {}) };
}

function createChannelsCollection(...initialRows: JsonRecord[]) {
    const rows = new Map<string, StoredRow>();
    for (const initialRow of initialRows) {
        const initialRowId = requiredString(initialRow.id, "Channels row id");
        rows.set(initialRowId, stateRow(initialRow));
    }
    const collection = {
        async get(rowId: string) {
            const row = rows.get(rowId);
            return row?.deleted === true ? null : row ?? null;
        },
        async put(value: JsonRecord, options: Readonly<{ expectedRevision: number | "absent" }>) {
            const rowId = requiredString(value.id, "Channels row id");
            const current = rows.get(rowId);
            const matches = options.expectedRevision === "absent"
                ? current === undefined
                : current?.revision === options.expectedRevision;
            if (!matches) throw new Error(`Channels Collection CAS conflict for ${rowId}`);
            const next = stateRow(value, (current?.revision ?? 0) + 1);
            rows.set(rowId, next);
            return next;
        },
        async query(request: Readonly<{
            index: string;
            prefix?: readonly unknown[];
            range?: Readonly<{ upper?: number }>;
            order?: "asc" | "desc";
            cursor?: string;
            limit: number;
        }>) {
            const prefix = request.prefix ?? [];
            const ordered = [...rows.values()].filter((row) => {
                if (row.deleted === true) return false;
                if (request.index === "by-kind") return row.value["record-kind"] === prefix[0];
                if (request.index === "by-connection") return row.value["connection-id"] === prefix[0];
                if (request.index === "by-binding") return row.value["binding-id"] === prefix[0];
                if (request.index === "by-connection-binding-v2") {
                    return row.value["connection-id"] === prefix[0]
                        && (row.value["binding-id"] ?? null) === prefix[1]
                        && row.value["record-kind"] === prefix[2]
                        && row.value.attention === prefix[3];
                }
                if (request.index === "by-ingress-due") {
                    const dueAt = row.value["due-at"];
                    return row.value["record-kind"] === prefix[0]
                        && typeof dueAt === "number"
                        && (request.range?.upper === undefined || dueAt <= request.range.upper);
                }
                return false;
            }).sort((left, right) => left.rowId.localeCompare(right.rowId));
            const afterCursor = request.cursor === undefined
                ? ordered
                : ordered.filter((row) => row.rowId > request.cursor!);
            const page = afterCursor.slice(0, request.limit);
            return {
                rows: page,
                changeCursor: 1,
                ...(afterCursor.length > page.length && page.length > 0
                    ? { nextCursor: page.at(-1)!.rowId }
                    : {}),
            };
        },
        async limits() {
            return {
                maxRowEncodedBytes: 512 * 1024,
                maxBatchBytes: 16 * 1024 * 1024,
                maxBatchRows: 100,
                maxAccountRows: 10_000,
                maxAccountBytes: 256 * 1024 * 1024,
                basis: "deployment" as const,
            };
        },
        async measureBatch(operations: readonly unknown[]) {
            return {
                overheadEncodedBytes: 512,
                operationEncodedBytes: operations.map((operation) => (
                    new TextEncoder().encode(JSON.stringify(operation)).byteLength + 1
                )),
            };
        },
        async batch(operations: readonly JsonRecord[]) {
            const snapshot = new Map(rows);
            const results: Array<Readonly<{ rowId: string; revision: number; deleted: boolean }>> = [];
            for (const operation of operations) {
                if (operation.kind === "assert") {
                    const rowId = requiredString(operation.rowId, "assert row id");
                    const current = snapshot.get(rowId);
                    if (
                        current === undefined
                        || current.revision !== operation.expectedRevision
                        || current.deleted === true
                    ) {
                        return { status: "conflict" as const, conflicts: [{ rowId }] };
                    }
                    continue;
                }
                if (operation.kind === "put") {
                    if (!isRecord(operation.value)) throw new Error("invalid Collection put");
                    const rowId = requiredString(operation.value.id, "put row id");
                    const current = snapshot.get(rowId);
                    const expected = operation.expectedRevision;
                    const matches = expected === "absent"
                        ? current === undefined
                        : current?.revision === expected;
                    if (!matches) return { status: "conflict" as const, conflicts: [{ rowId }] };
                    const next = stateRow(operation.value, (current?.revision ?? 0) + 1);
                    snapshot.set(rowId, next);
                    results.push({ rowId, revision: next.revision, deleted: false });
                    continue;
                }
                if (operation.kind === "delete") {
                    const rowId = requiredString(operation.rowId, "delete row id");
                    const current = snapshot.get(rowId);
                    if (
                        current === undefined
                        || current.revision !== operation.expectedRevision
                        || current.deleted === true
                    ) {
                        return { status: "conflict" as const, conflicts: [{ rowId }] };
                    }
                    snapshot.set(rowId, stateRow(current.value, current.revision + 1, true));
                    results.push({ rowId, revision: current.revision + 1, deleted: true });
                    continue;
                }
                throw new Error("unsupported Collection operation");
            }
            rows.clear();
            for (const [rowId, row] of snapshot) rows.set(rowId, row);
            return { status: "updated" as const, results, changeCursor: 1 };
        },
    };
    return { collection, rows };
}

function strictRecipe(): string {
    const result = serializeAutomationStoredDefinitionExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: { t: "plain", v: { v: 1, prompt: "Handle the observed provider message" } },
        triggerEvidence: null,
        // This boundary exercises Event/Conversation admission and result
        // custody, not Session-spawn acknowledgement. An existing-Session
        // target lets the canonical Run owner settle without fabricating the
        // Session-owned creation tag required by a strict new-Session recipe.
        target: { kind: "existingSession", sessionId: COMPOSED_SESSION_ID },
    });
    if (result.kind !== "available") throw new Error("composed Event recipe must be valid");
    return result.serialized;
}

type ProviderScenario = Readonly<{
    pluginId: string;
    manifest: JsonRecord;
    eventLocalId: string;
    admitActionLocalId: string;
    contributionId: string;
    sourceInstanceId: string;
    sourceConfig: PluginJsonValueV2;
    eventPayload: PluginJsonValueV2;
    occurrenceId: string;
    occurredAt: number;
    observation: JsonRecord;
    connectionTransport: Readonly<{ kind: "checkpointedPull" }> | Readonly<{ kind: "socket" }>;
    replayContinuity: "checkpointed" | "sessionBound";
    providerConfig: PluginJsonValueV2;
    credentialRef: JsonRecord;
    providerConnectionKey: string;
    integrationPrincipal: JsonRecord;
    endpoint: JsonRecord;
    activate: (api: unknown) => unknown;
    admit(input: unknown, context: unknown): Promise<unknown>;
}>;

async function loadScenario(
    kind: "telegram" | "discord",
    opts: Readonly<{ discordSelfEcho?: boolean }> = {},
): Promise<ProviderScenario> {
    if (kind === "telegram") {
        const [plugin, actions, events, constants] = await Promise.all([
            import(/* @vite-ignore */ new URL(
                "../../../../../packages/plugins/channel-telegram/src/plugin.ts",
                import.meta.url,
            ).href),
            import(/* @vite-ignore */ new URL(
                "../../../../../packages/plugins/channel-telegram/src/channelActions.ts",
                import.meta.url,
            ).href),
            import(/* @vite-ignore */ new URL(
                "../../../../../packages/plugins/channel-telegram/src/automationEvents.ts",
                import.meta.url,
            ).href),
            import(/* @vite-ignore */ new URL(
                "../../../../../packages/plugins/channel-telegram/src/constants.ts",
                import.meta.url,
            ).href),
        ]);
        const occurredAt = Date.now() - 1_000;
        const pollContext = {
            plugin: { id: "happier.channel.telegram", version: VERSION },
            contribution: { id: "channels/poll", qualifiedId: "happier.channel.telegram/actions/channels/poll" },
            surface: "plugin",
            caller: {
                kind: "plugin",
                pluginId: CHANNELS_PLUGIN_ID,
                contribution: { id: "ingress-supervisor", qualifiedId: "happier.channels/backgroundServices/ingress-supervisor" },
                materialization: {
                    pluginId: CHANNELS_PLUGIN_ID,
                    machineId: MACHINE_ID,
                    materializationId: "channels-materialization",
                },
            },
            signal: new AbortController().signal,
            services: {
                connectedAccounts: {
                    materialize: async () => ({
                        kind: "environment" as const,
                        env: { TELEGRAM_BOT_TOKEN: "123:token" },
                    }),
                },
                http: {
                    request: async (request: Readonly<{ url: string }>) => ({
                        status: 200,
                        finalUrl: request.url,
                        headers: { "content-type": "application/json" },
                        body: new TextEncoder().encode(JSON.stringify(
                            request.url.endsWith("/getMe")
                                ? {
                                    ok: true,
                                    result: {
                                        id: 123,
                                        is_bot: true,
                                        first_name: "Happier",
                                        username: "HappierBot",
                                    },
                                }
                                : {
                                    ok: true,
                                    result: [{
                                        update_id: 51,
                                        message: {
                                            message_id: 9,
                                            date: Math.floor(occurredAt / 1_000),
                                            chat: { id: -100456, type: "supergroup", title: "Deploys" },
                                            from: { id: 789, is_bot: false, first_name: "Ada" },
                                            text: "deploy the site",
                                        },
                                    }],
                                },
                        )),
                    }),
                },
            },
        };
        const poll = await actions.pollTelegramObservations({
            v: 1,
            connectionId: "connection-telegram",
            providerConnectionKey: "telegram-bot:123",
            providerConfigVersion: 1,
            providerConfig: { botUsername: "HappierBot", canReadAllGroupMessages: true },
            credentialRef: {
                service: { pluginId: "happier.channel.telegram", localId: "telegram-bot" },
                accountId: "telegram-bot-account",
            },
            checkpoint: { v: 1, offset: "51", caughtUpAtMs: occurredAt - 1_000 },
            waitMs: 0,
            limit: 10,
        }, pollContext);
        if (poll.kind !== "batch" || poll.observations.length !== 1) {
            throw new Error("Telegram composed fixture did not produce one observation");
        }
        const entry = poll.observations[0]!;
        if (entry.eventCandidate === null || entry.observation.kind !== "fullText") {
            throw new Error("Telegram composed fixture did not produce an Event candidate");
        }
        return {
            pluginId: "happier.channel.telegram",
            manifest: plugin.PLUGIN_MANIFEST,
            eventLocalId: constants.TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID,
            admitActionLocalId: constants.TELEGRAM_AUTOMATION_MESSAGE_ADMIT_ACTION_ID,
            contributionId: "telegram-provider",
            sourceInstanceId: requiredString(entry.eventCandidate.sourceInstanceId, "Telegram source instance"),
            sourceConfig: { v: 1, botId: "123", chatId: "-100456" },
            eventPayload: entry.eventCandidate.payload,
            occurrenceId: entry.observation.observation.occurrenceId,
            occurredAt: entry.observation.observation.occurredAt,
            observation: entry,
            connectionTransport: { kind: "checkpointedPull" },
            replayContinuity: "checkpointed",
            providerConfig: { botUsername: "HappierBot", canReadAllGroupMessages: true },
            credentialRef: {
                service: { pluginId: "happier.channel.telegram", localId: "telegram-bot" },
                accountId: "telegram-bot-account",
            },
            providerConnectionKey: "telegram-bot:123",
            integrationPrincipal: { id: "telegram:bot:123", label: "HappierBot" },
            endpoint: entry.observation.observation.endpoint,
            activate: plugin.activate,
            admit: events.admitTelegramAutomationEvent,
        };
    }

    const [plugin, admission, event, message, observation] = await Promise.all([
        import(/* @vite-ignore */ new URL(
            "../../../../../packages/plugins/channel-discord/src/plugin.ts",
            import.meta.url,
        ).href),
        import(/* @vite-ignore */ new URL(
            "../../../../../packages/plugins/channel-discord/src/discordAutomationEventAdmission.ts",
            import.meta.url,
        ).href),
        import(/* @vite-ignore */ new URL(
            "../../../../../packages/plugins/channel-discord/src/discordAutomationEvent.ts",
            import.meta.url,
        ).href),
        import(/* @vite-ignore */ new URL(
            "../../../../../packages/plugins/channel-discord/src/discordMessage.ts",
            import.meta.url,
        ).href),
        import(/* @vite-ignore */ new URL(
            "../../../../../packages/plugins/channel-discord/src/discordObservation.ts",
            import.meta.url,
        ).href),
    ]);
    const selfEcho = opts.discordSelfEcho === true;
    const parsed = message.parseDiscordMessageDispatch({
        event: "MESSAGE_CREATE",
        payload: {
            id: selfEcho ? "9002" : "9001",
            channel_id: "4242",
            guild_id: "7777",
            timestamp: new Date(Date.now() - 1_000).toISOString(),
            type: 0,
            // The real Gateway delivers the integration's own result deliveries
            // with the bot itself as author; the projection must classify that
            // actor as integration-self so the census can drop the Event arm.
            content: selfEcho ? "Automation result delivered into the watched channel" : "ship it",
            author: selfEcho
                ? { id: "bot-1", bot: true, username: "Happier" }
                : { id: "77", bot: false, username: "Ada" },
            mentions: selfEcho ? [] : [{ id: "bot-1" }],
            attachments: [],
            embeds: [],
        },
        channel: { channelId: "4242", kind: "shared" },
        context: {
            botUserId: "bot-1",
            applicationId: "123",
            botRoleIds: [],
            messageContentIntentEnabled: true,
        },
    });
    const normalized = observation.mapDiscordMessageToSocketIngress({ parsed });
    if (normalized === null || normalized.kind !== "fullText") {
        throw new Error("Discord composed fixture did not produce one full-text observation");
    }
    const candidate = event.createDiscordAutomationEventCandidate({
        applicationId: "123",
        observation: normalized,
    });
    if (selfEcho) {
        if (candidate !== null) {
            throw new Error("Discord integration-self echo must not produce an Event candidate");
        }
    } else if (candidate === null) {
        throw new Error("Discord composed fixture did not produce an Event candidate");
    }
    const fallbackSourceConfig = { v: 1, applicationId: "123", channelId: "4242" } as const;
    const projectedEventPayload = candidate === null
        ? event.createDiscordAutomationMessagePayload({ observation: normalized.observation })
        : candidate.payload;
    if (projectedEventPayload === null) {
        throw new Error("Discord self-echo payload projection failed");
    }
    return {
        pluginId: "happier.channel.discord",
        manifest: plugin.PLUGIN_MANIFEST,
        eventLocalId: event.DISCORD_AUTOMATION_MESSAGE_EVENT_ID,
        admitActionLocalId: event.DISCORD_AUTOMATION_MESSAGE_ADMIT_ACTION_ID,
        contributionId: "discord-provider",
        sourceInstanceId: candidate === null
            ? event.createDiscordAutomationMessageSourceInstanceId(fallbackSourceConfig)
            : candidate.sourceInstanceId,
        sourceConfig: fallbackSourceConfig,
        eventPayload: projectedEventPayload,
        occurrenceId: normalized.observation.occurrenceId,
        occurredAt: normalized.observation.occurredAt,
        observation: { observation: normalized, eventCandidate: candidate },
        connectionTransport: { kind: "socket" },
        replayContinuity: "sessionBound",
        providerConfig: { applicationId: "123", botUserId: "bot-1" },
        credentialRef: {
            service: { pluginId: "happier.channel.discord", localId: "discord-bot" },
            accountId: "discord-bot-account",
        },
        providerConnectionKey: "discord-application:123",
        integrationPrincipal: { id: "discord:bot:bot-1", label: "Happier" },
        endpoint: normalized.observation.endpoint,
        activate: plugin.activate,
        admit: admission.admitDiscordAutomationEvent,
    };
}

function providerContributionProjection(scenario: ProviderScenario) {
    const declarations = isRecord(scenario.manifest.contributes)
        ? scenario.manifest.contributes.targetedPluginContributions
        : null;
    if (!Array.isArray(declarations)) throw new Error("provider manifest has no targeted contribution");
    const declaration = declarations.find((value) => (
        isRecord(value) && value.id === scenario.contributionId
    ));
    if (!isRecord(declaration) || !isRecord(declaration.protocol) || !isRecord(declaration.operations)) {
        throw new Error("provider manifest contribution is incomplete");
    }
    const operations = Object.fromEntries(Object.entries(declaration.operations).map(([role, localId]) => [
        role,
        {
            identity: {
                target: { pluginId: CHANNELS_PLUGIN_ID },
                point: {
                    pointId: "providers",
                    protocol: declaration.protocol,
                },
                contributor: {
                    pluginId: scenario.pluginId,
                    contributionId: scenario.contributionId,
                    immutableGenerationId: PROVIDER_GENERATION,
                },
                role,
            },
            localId,
        },
    ]));
    return {
        contributor: {
            pluginId: scenario.pluginId,
            contributionId: scenario.contributionId,
            immutableGenerationId: PROVIDER_GENERATION,
        },
        protocol: declaration.protocol,
        operations,
    };
}

function pluginReleaseFacts(scenario: ProviderScenario) {
    const declaredAssets = readDeclaredPackageAssetsV1(scenario.manifest);
    if (declaredAssets === null) throw new Error("provider manifest package assets are invalid");
    return normalizePluginReleaseFactsV1({
        ref: { pluginId: scenario.pluginId, version: VERSION },
        archiveDigestSha256: `sha256:${"c".repeat(64)}`,
        normalizedManifest: scenario.manifest as never,
        collectionContracts: [],
        uiSlots: [],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"d".repeat(64)}`,
            resources: declaredAssets.map((asset) => ({
                ...asset,
                byteSize: 0,
                digestSha256: `sha256:${"0".repeat(64)}`,
            })),
        },
    });
}

async function requireAdoptedDefinitionSet(
    adoptedSet: Readonly<{ refresh(): Promise<unknown> }>,
): Promise<void> {
    const result = await adoptedSet.refresh();
    if (!isRecord(result) || result.kind !== "adopted") {
        throw new Error(`Automation Event definition adoption failed: ${JSON.stringify(result)}`);
    }
}

function triggerEnvelope(scenario: ProviderScenario): string {
    return JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: "plain",
        binding: {
            v: 1,
            automationId: AUTOMATION_ID,
            triggerId: TRIGGER_ID,
            triggerRevision: 1,
            triggerKind: "pluginEvent",
            eventRef: { pluginId: scenario.pluginId, localId: scenario.eventLocalId },
            sourceSelectorId: SOURCE_SELECTOR_ID,
        },
        definition: {
            v: 1,
            sourceInstanceId: scenario.sourceInstanceId,
            sourceConfig: scenario.sourceConfig,
            displayLabel: `${scenario.pluginId} source`,
            filter: null,
            maximumObservationAgeMs: null,
        },
    }));
}

describe("Channels first-party provider Automation Event composition", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-channels-provider-composed-",
            initAuth: false,
            env: { HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID },
        });
    }, 120_000);

    afterAll(async () => await harness?.close());

    afterEach(async () => {
        harness?.resetEnv();
        await harness?.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.sessionTurn.deleteMany(),
            () => db.session.deleteMany(),
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    for (const provider of ["telegram", "discord"] as const) {
        it(`persists one ${provider} observation through Channels custody and rejoins a lost signed response`, async () => {
            const scenario = await loadScenario(provider);
            const release = pluginReleaseFacts(scenario);
            const keyPair = tweetnacl.sign.keyPair();
            await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
            await db.session.create({
                data: { id: COMPOSED_SESSION_ID, accountId: ACCOUNT_ID, tag: "channels-provider-composed", metadata: "{}" },
            });
            await db.automationEventCatalogState.create({
                data: { accountId: ACCOUNT_ID, eventSourceDefinitionsRevision: 0n },
            });
            await db.machine.create({
                data: {
                    id: MACHINE_ID,
                    accountId: ACCOUNT_ID,
                    metadata: "{}",
                    installationId: MACHINE_INSTALLATION_ID,
                    installationPublicKey: new Uint8Array(keyPair.publicKey),
                    pluginMaterializationRevision: 1n,
                },
            });
            await db.accountPluginIntent.create({
                data: {
                    accountId: ACCOUNT_ID,
                    pluginId: scenario.pluginId,
                    desiredVersion: VERSION,
                    enabled: true,
                    writableCollections: [],
                },
            });
            await db.accountPluginRelease.create({
                data: {
                    accountId: ACCOUNT_ID,
                    pluginId: scenario.pluginId,
                    version: VERSION,
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
                    pluginId: scenario.pluginId,
                    version: VERSION,
                    sourceClass: "registryPackage",
                    portableRelease: true,
                    archiveDigestSha256: release.archiveDigestSha256,
                    uiArtifacts: [],
                    enabled: true,
                    trustState: "trusted",
                    observedAt: new Date(),
                },
            });
            await db.automation.create({
                data: {
                    id: AUTOMATION_ID,
                    accountId: ACCOUNT_ID,
                    name: `${provider} composed Event`,
                    enabled: true,
                    targetType: "existing_session",
                    templateCiphertext: strictRecipe(),
                    templateVersion: 1,
                    assignments: { create: { machineId: MACHINE_ID, enabled: true } },
                    triggers: { create: {
                        id: TRIGGER_ID,
                        kind: "pluginEvent",
                        enabled: true,
                        revision: 1,
                        eventPluginId: scenario.pluginId,
                        eventLocalId: scenario.eventLocalId,
                        sourceSelectorId: SOURCE_SELECTOR_ID,
                        sourceContractVersion: 1,
                        observationTransport: "checkpointedPull",
                        watcherMachineId: MACHINE_ID,
                        watcherMachineInstallationId: MACHINE_INSTALLATION_ID,
                        watcherPluginId: scenario.pluginId,
                        watcherMaterializationId: MATERIALIZATION_ID,
                        definitionEnvelope: triggerEnvelope(scenario),
                    } },
                },
            });

            const cliModules = await Promise.all([
                import(/* @vite-ignore */ new URL(
                    "../../../../cli/src/plugins/runtime/automations/automationEventActionExecutor.ts",
                    import.meta.url,
                ).href),
                import(/* @vite-ignore */ new URL(
                    "../../../../cli/src/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost.ts",
                    import.meta.url,
                ).href),
            ]);
            const createExecutor = cliModules[0].createAutomationEventActionExecutor as (
                input: JsonRecord,
            ) => DynamicExecutor;
            const createAdoptedSet = cliModules[1].createAutomationEventAdoptedDefinitionSetHostV1 as (
                input: JsonRecord,
            ) => JsonRecord & Readonly<{ refresh(): Promise<unknown> }>;
            const materialization = {
                pluginId: scenario.pluginId,
                machineId: MACHINE_ID,
                materializationId: MATERIALIZATION_ID,
            };
            const credentials = {
                token: "channels-provider-composed-token",
                encryption: { type: "legacy" as const, secret: new Uint8Array(32).fill(9) },
            };
            const readCurrentness = async (): Promise<AccountEncryptionCurrentnessResponse> => {
                const account = await db.account.findUniqueOrThrow({
                    where: { id: ACCOUNT_ID },
                    select: { seq: true, updatedAt: true },
                });
                return {
                    mode: "plain",
                    version: Number(account.seq),
                    signingKeyFingerprint: null,
                    contentKeyFingerprint: null,
                    updatedAt: account.updatedAt.getTime(),
                };
            };
            const app = createAuthenticatedTestApp();
            registerAutomationEventRoutes(app as never);
            await app.ready();
            try {
                const injectSigned = async (path: string, body: unknown) => await app.inject({
                    method: "POST",
                    url: path,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": ACCOUNT_ID,
                        [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                            body,
                            keyPair,
                            path,
                        }),
                    },
                    payload: body,
                });
                const adoptedSet = createAdoptedSet({
                    credentials,
                    caller: materialization,
                    immutableGenerationId: PROVIDER_GENERATION,
                    transport: { kind: "checkpointedPull" },
                    generationSignal: new AbortController().signal,
                    isGenerationCurrent: () => true,
                    revalidateCallerMaterialization: async () => true,
                    revalidateCallerImmutableGeneration: async () => true,
                    readStoredDefinitions: async (params: JsonRecord) => {
                        if (!isRecord(params.caller) || !isRecord(params.input)) {
                            throw new Error("stored definition request is invalid");
                        }
                        const body = AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse({
                            v: 1,
                            caller: params.caller,
                            input: params.input,
                        });
                        const response = await injectSigned(
                            AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
                            body,
                        );
                        expect(response.statusCode).toBe(200);
                        return response.json();
                    },
                    resolveAccountEncryptionCurrentness: readCurrentness,
                    resolveAccountEncryptionMaterial: async () => null,
                });
                await requireAdoptedDefinitionSet(adoptedSet);

                let loseFirstAdmissionResponse = true;
                let admissionRouteCalls = 0;
                const executor = createExecutor({
                    credentials,
                    revalidateCallerMaterialization: async () => true,
                    revalidateCallerImmutableGeneration: async () => true,
                    resolveAccountId: async () => ACCOUNT_ID,
                    resolveAdoptedDefinitionSet: () => adoptedSet,
                    transport: {
                        execute: async (actionId: string, request: unknown) => {
                            if (!(actionId in AutomationEventActionHttpRequestSchemasV1)) {
                                throw new Error(`unexpected Automation action ${actionId}`);
                            }
                            const body = AutomationEventActionHttpRequestSchemasV1[
                                actionId as keyof typeof AutomationEventActionHttpRequestSchemasV1
                            ].parse(request);
                            const path = AutomationEventActionHttpPathsV1[
                                actionId as keyof typeof AutomationEventActionHttpPathsV1
                            ];
                            const response = await injectSigned(path, body);
                            expect(response.statusCode).toBe(200);
                            if (actionId === "automation.event.admit") {
                                admissionRouteCalls += 1;
                                if (loseFirstAdmissionResponse) {
                                    loseFirstAdmissionResponse = false;
                                    throw new Error("simulated response loss after persisted admission");
                                }
                            }
                            return response.json();
                        },
                    },
                });

                const contribution = providerContributionProjection(scenario);
                const currentConnectionFixture = await import(/* @vite-ignore */ new URL(
                    "../../../../../packages/plugins/channels/src/testkit/currentConnectionFixture.ts",
                    import.meta.url,
                ).href);
                const connection = currentConnectionFixture.createCurrentConversationConnectionFixture({
                    connectionId: `connection-${provider}`,
                    authority: {
                        providerPluginId: scenario.pluginId,
                        providerContributionSelection: {
                            contributionId: scenario.contributionId,
                            immutableGenerationId: PROVIDER_GENERATION,
                        },
                        providerSetupInput: { source: "composed-test" },
                        credentialRef: scenario.credentialRef,
                        transportOrigin: {
                            serverIdentityId: SERVER_IDENTITY_ID,
                            materializationRef: materialization,
                        },
                        providerConnectionKey: scenario.providerConnectionKey,
                        providerConfig: scenario.providerConfig,
                        routingIdentityKey: "r".repeat(43),
                        integrationPrincipal: scenario.integrationPrincipal,
                        authorityEpoch: 4,
                    },
                    transport: scenario.connectionTransport,
                    overlapSafety: provider === "telegram" ? "providerExclusive" : "safe",
                    replayContinuity: scenario.replayContinuity,
                    outboundTextLimit: { maximum: 4_096, unit: "utf8Bytes" },
                });
                const channels = createChannelsCollection(connection);
                const providerActionContext = {
                    plugin: { id: scenario.pluginId, version: VERSION },
                    contribution: {
                        id: scenario.admitActionLocalId,
                        qualifiedId: `${scenario.pluginId}/actions/${scenario.admitActionLocalId}`,
                    },
                    surface: "plugin",
                    caller: {
                        kind: "plugin",
                        pluginId: CHANNELS_PLUGIN_ID,
                        contribution: {
                            id: "provider/observation-ingest-v1",
                            qualifiedId: `${CHANNELS_PLUGIN_ID}/actions/provider/observation-ingest-v1`,
                        },
                        materialization: {
                            pluginId: CHANNELS_PLUGIN_ID,
                            machineId: MACHINE_ID,
                            materializationId: "channels-materialization",
                        },
                    },
                    signal: new AbortController().signal,
                    services: {
                        actions: {
                            execute: async (actionId: string, actionInput: unknown) => await executor({
                                actionId,
                                input: actionInput,
                                caller: {
                                    kind: "plugin",
                                    pluginId: scenario.pluginId,
                                    contributionLocalId: scenario.admitActionLocalId,
                                    immutableGenerationId: PROVIDER_GENERATION,
                                    materialization,
                                },
                            }),
                        },
                        logger: { debug() {}, info() {}, warn() {}, error() {} },
                    },
                };
                let pollCalls = 0;
                const channelsContext = {
                    invokedAtMs: Date.now(),
                    plugin: { id: CHANNELS_PLUGIN_ID, version: VERSION },
                    contribution: {
                        id: "provider/observation-ingest-v1",
                        qualifiedId: `${CHANNELS_PLUGIN_ID}/actions/provider/observation-ingest-v1`,
                    },
                    surface: "plugin",
                    caller: {
                        kind: "plugin",
                        pluginId: scenario.pluginId,
                        contribution: {
                            id: provider === "telegram" ? "poll" : "gateway",
                            qualifiedId: `${scenario.pluginId}/backgroundServices/provider-observer`,
                        },
                        materialization,
                    },
                    signal: new AbortController().signal,
                    services: {
                        storage: { account: { collection: () => channels.collection } },
                        sessions: { get: async () => null },
                        targetedContributions: {
                            observeForSelf: () => ({
                                dispose() {},
                                readCurrent: async () => ({
                                    generation: CHANNELS_GENERATION,
                                    contributions: [contribution],
                                }),
                            }),
                        },
                        actions: {
                            execute: async () => {
                                throw new Error("unexpected generic Channels action");
                            },
                            executeAdmittedTargetedOperationWithExecutionOrigin: async (
                                operation: JsonRecord,
                                actionInput: unknown,
                            ) => {
                                if (!isRecord(operation.identity)) {
                                    throw new Error("unexpected provider operation");
                                }
                                if (operation.identity.role === "observationsPoll") {
                                    pollCalls += 1;
                                    return {
                                        result: pollCalls === 1
                                            ? {
                                                kind: "checkpointOnly",
                                                checkpointAfterBatch: { cursor: "baseline" },
                                            }
                                            : {
                                                kind: "batch",
                                                observations: [scenario.observation],
                                                checkpointAfterBatch: { cursor: "after-observation" },
                                            },
                                        executionOrigin: {
                                            serverIdentityId: SERVER_IDENTITY_ID,
                                            materializationRef: materialization,
                                        },
                                    };
                                }
                                if (operation.identity.role !== "automationEventAdmit") {
                                    throw new Error("unexpected provider operation");
                                }
                                return {
                                    result: await scenario.admit(actionInput, providerActionContext),
                                    executionOrigin: {
                                        serverIdentityId: SERVER_IDENTITY_ID,
                                        materializationRef: materialization,
                                    },
                                };
                            },
                        },
                    },
                };
                const ingressModule = await import(/* @vite-ignore */ new URL(
                    "../../../../../packages/plugins/channels/src/ingress.ts",
                    import.meta.url,
                ).href);
                const input = {
                    connectionId: `connection-${provider}`,
                    entry: scenario.observation,
                };

                if (provider === "telegram") {
                    await expect(ingressModule.runConversationCheckpointedPollForInvocation(
                        { connectionId: input.connectionId, waitMs: 0 },
                        channelsContext,
                    )).resolves.toMatchObject({ kind: "committed" });
                    await expect(ingressModule.runConversationCheckpointedPollForInvocation(
                        { connectionId: input.connectionId, waitMs: 0 },
                        channelsContext,
                    )).resolves.toMatchObject({ kind: "retry" });
                } else {
                    await expect(ingressModule.ingestConversationProviderObservationForInvocation(
                        input,
                        channelsContext,
                    )).rejects.toMatchObject({ code: "channels_ingress_admission_unsettled" });
                }
                expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);
                expect([...channels.rows.values()].some((row) => (
                    row.deleted !== true
                    && row.value["record-kind"] === "ingress-obligation"
                    && isRecord(row.value.payload)
                    && isRecord(row.value.payload.lifecycle)
                    && row.value.payload.lifecycle.phase === "retryDue"
                ))).toBe(true);

                const retryNow = Date.now() + 60_000;
                const nowSpy = vi.spyOn(Date, "now").mockReturnValue(retryNow);
                let dueWork: number;
                try {
                    dueWork = await ingressModule.runConversationIngressDueWorkForInvocation(
                        { now: retryNow, limit: 10 },
                        channelsContext,
                    );
                } finally {
                    nowSpy.mockRestore();
                }
                expect(dueWork).toBe(1);
                expect(admissionRouteCalls).toBe(2);
                expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);
                expect([...channels.rows.values()].some((row) => (
                    row.deleted !== true
                    && row.value["record-kind"] === "ingress-obligation"
                    && row.value.terminal === true
                ))).toBe(true);
                if (provider === "telegram") {
                    await expect(ingressModule.runConversationCheckpointedPollForInvocation(
                        { connectionId: input.connectionId, waitMs: 0 },
                        channelsContext,
                    )).resolves.toMatchObject({ kind: "committed" });
                    expect(pollCalls).toBe(3);
                    expect(admissionRouteCalls).toBe(2);
                }
            } finally {
                await app.close();
            }
        }, 120_000);
    }

    // ---------------------------------------------------------------------
    // Composed trigger-set and custody lanes (AUTOMATION-TRIGGERS r1.0 §10.1
    // and Channels c0.58/c0.59 custody seam). These lanes reuse the exact
    // first-party provider modules, signed HTTP admission routes, canonical
    // CRUD/schedule/claim/settlement owners, reply-handoff worker, daemon RPC
    // receiver, and Channels ingress/custody owners above; only the plugin
    // runtime process lease and the generic Data Collection storage host are
    // boundary fixtures, matching the existing lanes in this file.
    // ---------------------------------------------------------------------

    function definitionRecipeVersioned(templateVersion: number) {
        return AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
            v: 1,
            templateVersion,
            template: {
                t: "plain",
                v: { v: 1, prompt: `Handle the observed provider message (v${templateVersion})` },
            },
            triggerEvidence: null,
            target: {
                kind: "newSession",
                spawn: {
                    executionTarget: { serverId: "server-channels-provider-composed", machineId: MACHINE_ID },
                    directory: "/tmp/channels-provider-composed",
                    agentTarget: {
                        kind: "agent",
                        identity: { pluginId: "happier.agent.codex", localId: "codex" },
                    },
                },
            },
        });
    }

    function strictRecipeVersioned(templateVersion: number): string {
        const result = serializeAutomationStoredDefinitionExecutionRecipeV1(
            definitionRecipeVersioned(templateVersion),
        );
        if (result.kind !== "available") throw new Error("composed Event recipe must be valid");
        return result.serialized;
    }

    function frozenRecipeTemplateVersion(executionInputEnvelope: string): number {
        const parsed = parseAutomationRunExecutionRecipeV1(executionInputEnvelope);
        if (parsed.kind !== "available") throw new Error("frozen Run recipe must parse");
        return parsed.recipe.templateVersion;
    }

    function pluginEventTriggerRow(scenario: ProviderScenario) {
        return {
            id: TRIGGER_ID,
            kind: "pluginEvent" as const,
            enabled: true,
            revision: 1,
            eventPluginId: scenario.pluginId,
            eventLocalId: scenario.eventLocalId,
            sourceSelectorId: SOURCE_SELECTOR_ID,
            sourceContractVersion: 1,
            observationTransport: "checkpointedPull" as const,
            watcherMachineId: MACHINE_ID,
            watcherMachineInstallationId: MACHINE_INSTALLATION_ID,
            watcherPluginId: scenario.pluginId,
            watcherMaterializationId: MATERIALIZATION_ID,
            definitionEnvelope: triggerEnvelope(scenario),
        };
    }

    async function readComposedAccountCurrentness(): Promise<AccountEncryptionCurrentnessResponse> {
        const account = await db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { seq: true, updatedAt: true },
        });
        return {
            mode: "plain",
            version: Number(account.seq),
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: account.updatedAt.getTime(),
        };
    }

    async function seedComposedProviderFixture(
        scenario: ProviderScenario,
    ): Promise<tweetnacl.SignKeyPair> {
        const release = pluginReleaseFacts(scenario);
        const keyPair = tweetnacl.sign.keyPair();
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        await db.session.create({
            data: { id: COMPOSED_SESSION_ID, accountId: ACCOUNT_ID, tag: "channels-provider-composed", metadata: "{}" },
        });
        await db.automationEventCatalogState.create({
            data: { accountId: ACCOUNT_ID, eventSourceDefinitionsRevision: 0n },
        });
        await db.machine.create({
            data: {
                id: MACHINE_ID,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: MACHINE_INSTALLATION_ID,
                installationPublicKey: new Uint8Array(keyPair.publicKey),
                pluginMaterializationRevision: 1n,
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: scenario.pluginId,
                desiredVersion: VERSION,
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: scenario.pluginId,
                version: VERSION,
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
                pluginId: scenario.pluginId,
                version: VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: release.archiveDigestSha256,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date(),
            },
        });
        return keyPair;
    }

    async function seedChannelsCoreReleaseFixture(): Promise<void> {
        const manifestModule = await import(/* @vite-ignore */ new URL(
            "../../../../../packages/plugins/channels/src/manifest.ts",
            import.meta.url,
        ).href) as { PLUGIN_MANIFEST: JsonRecord };
        const release = normalizePluginReleaseFactsV1({
            ref: { pluginId: CHANNELS_PLUGIN_ID, version: VERSION },
            archiveDigestSha256: `sha256:${"e".repeat(64)}`,
            normalizedManifest: manifestModule.PLUGIN_MANIFEST as never,
            collectionContracts: [],
            uiSlots: [],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${"f".repeat(64)}`,
                resources: [],
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: CHANNELS_PLUGIN_ID,
                desiredVersion: VERSION,
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: CHANNELS_PLUGIN_ID,
                version: VERSION,
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
                materializationId: CHANNELS_MATERIALIZATION_ID,
                pluginId: CHANNELS_PLUGIN_ID,
                version: VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: release.archiveDigestSha256,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date(),
            },
        });
    }

    type ComposedInjectResponse = Readonly<{ statusCode: number; json(): unknown }>;
    type ComposedSignedTransport = Readonly<{
        injectSigned(path: string, body: unknown): Promise<ComposedInjectResponse>;
    }>;

    /**
     * Drives one real Telegram provider occurrence through the composed lane:
     * provider poll runtime -> Channels ingress census/custody -> signed
     * `automation.event.admit` HTTP admission -> trigger-scoped Run. The app
     * stays open for the optional continuation so callers can compose further
     * real-route seams (conversation target verify/admit) onto the same wire.
     */
    async function admitOneTelegramEventOccurrence(params: Readonly<{
        scenario: ProviderScenario;
        keyPair: tweetnacl.SignKeyPair;
        initialChannelsRows?: readonly JsonRecord[];
        whileAppOpen?: (transport: ComposedSignedTransport) => Promise<void>;
    }>): Promise<Readonly<{
        channels: ReturnType<typeof createChannelsCollection>;
        pollCalls: number;
        admissionRouteCalls: number;
    }>> {
        const scenario = params.scenario;
        const materialization = {
            pluginId: scenario.pluginId,
            machineId: MACHINE_ID,
            materializationId: MATERIALIZATION_ID,
        };
        const credentials = {
            token: "channels-provider-composed-token",
            encryption: { type: "legacy" as const, secret: new Uint8Array(32).fill(9) },
        };
        let pollCalls = 0;
        let admissionRouteCalls = 0;
        const app = createAuthenticatedTestApp();
        registerAutomationEventRoutes(app as never);
        registerAutomationConversationRoutes(app as never);
        await app.ready();
        try {
            const injectSigned = async (path: string, body: unknown): Promise<ComposedInjectResponse> => await app.inject({
                method: "POST",
                url: path,
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": ACCOUNT_ID,
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                        body,
                        keyPair: params.keyPair,
                        path,
                    }),
                },
                payload: body,
            });
            const cliModules = await Promise.all([
                import(/* @vite-ignore */ new URL(
                    "../../../../cli/src/plugins/runtime/automations/automationEventActionExecutor.ts",
                    import.meta.url,
                ).href),
                import(/* @vite-ignore */ new URL(
                    "../../../../cli/src/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost.ts",
                    import.meta.url,
                ).href),
            ]);
            const createExecutor = cliModules[0].createAutomationEventActionExecutor as (
                input: JsonRecord,
            ) => DynamicExecutor;
            const createAdoptedSet = cliModules[1].createAutomationEventAdoptedDefinitionSetHostV1 as (
                input: JsonRecord,
            ) => JsonRecord & Readonly<{ refresh(): Promise<unknown> }>;
            const adoptedSet = createAdoptedSet({
                credentials,
                caller: materialization,
                immutableGenerationId: PROVIDER_GENERATION,
                transport: { kind: "checkpointedPull" },
                generationSignal: new AbortController().signal,
                isGenerationCurrent: () => true,
                revalidateCallerMaterialization: async () => true,
                revalidateCallerImmutableGeneration: async () => true,
                readStoredDefinitions: async (storedParams: JsonRecord) => {
                    if (!isRecord(storedParams.caller) || !isRecord(storedParams.input)) {
                        throw new Error("stored definition request is invalid");
                    }
                    const body = AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse({
                        v: 1,
                        caller: storedParams.caller,
                        input: storedParams.input,
                    });
                    const response = await injectSigned(
                        AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
                        body,
                    );
                    expect(response.statusCode).toBe(200);
                    return response.json();
                },
                resolveAccountEncryptionCurrentness: readComposedAccountCurrentness,
                resolveAccountEncryptionMaterial: async () => null,
            });
            await requireAdoptedDefinitionSet(adoptedSet);

            const executor = createExecutor({
                credentials,
                revalidateCallerMaterialization: async () => true,
                revalidateCallerImmutableGeneration: async () => true,
                resolveAccountId: async () => ACCOUNT_ID,
                resolveAdoptedDefinitionSet: () => adoptedSet,
                transport: {
                    execute: async (actionId: string, request: unknown) => {
                        if (!(actionId in AutomationEventActionHttpRequestSchemasV1)) {
                            throw new Error(`unexpected Automation action ${actionId}`);
                        }
                        const body = AutomationEventActionHttpRequestSchemasV1[
                            actionId as keyof typeof AutomationEventActionHttpRequestSchemasV1
                        ].parse(request);
                        const path = AutomationEventActionHttpPathsV1[
                            actionId as keyof typeof AutomationEventActionHttpPathsV1
                        ];
                        const response = await injectSigned(path, body);
                        expect(response.statusCode).toBe(200);
                        if (actionId === "automation.event.admit") {
                            admissionRouteCalls += 1;
                        }
                        return response.json();
                    },
                },
            });

            const contribution = providerContributionProjection(scenario);
            const fixtureModule = await import(/* @vite-ignore */ new URL(
                "../../../../../packages/plugins/channels/src/testkit/currentConnectionFixture.ts",
                import.meta.url,
            ).href) as {
                createCurrentConversationConnectionFixture: (input: JsonRecord) => JsonRecord;
            };
            const connection = fixtureModule.createCurrentConversationConnectionFixture({
                connectionId: COMPOSED_CONNECTION_ID,
                authority: {
                    providerPluginId: scenario.pluginId,
                    providerContributionSelection: {
                        contributionId: scenario.contributionId,
                        immutableGenerationId: PROVIDER_GENERATION,
                    },
                    providerSetupInput: { source: "composed-test" },
                    credentialRef: scenario.credentialRef,
                    transportOrigin: {
                        serverIdentityId: SERVER_IDENTITY_ID,
                        materializationRef: materialization,
                    },
                    providerConnectionKey: scenario.providerConnectionKey,
                    providerConfig: scenario.providerConfig,
                    routingIdentityKey: "r".repeat(43),
                    integrationPrincipal: scenario.integrationPrincipal,
                    authorityEpoch: 4,
                },
                transport: { kind: "checkpointedPull" },
                overlapSafety: "providerExclusive",
                replayContinuity: "checkpointed",
                outboundTextLimit: { maximum: 4_096, unit: "utf8Bytes" },
            });
            const channels = createChannelsCollection(connection, ...(params.initialChannelsRows ?? []));
            const channelsContext = {
                invokedAtMs: Date.now(),
                plugin: { id: CHANNELS_PLUGIN_ID, version: VERSION },
                contribution: {
                    id: "provider/observation-ingest-v1",
                    qualifiedId: `${CHANNELS_PLUGIN_ID}/actions/provider/observation-ingest-v1`,
                },
                surface: "plugin",
                caller: {
                    kind: "plugin",
                    pluginId: scenario.pluginId,
                    contribution: {
                        id: "poll",
                        qualifiedId: `${scenario.pluginId}/backgroundServices/provider-observer`,
                    },
                    materialization,
                },
                signal: new AbortController().signal,
                services: {
                    storage: { account: { collection: () => channels.collection } },
                    sessions: { get: async () => null },
                    targetedContributions: {
                        observeForSelf: () => ({
                            dispose() {},
                            readCurrent: async () => ({
                                generation: CHANNELS_GENERATION,
                                contributions: [contribution],
                            }),
                        }),
                    },
                    actions: {
                        execute: async () => {
                            throw new Error("unexpected generic Channels action");
                        },
                        executeAdmittedTargetedOperationWithExecutionOrigin: async (
                            operation: JsonRecord,
                            actionInput: unknown,
                        ) => {
                            if (!isRecord(operation.identity)) {
                                throw new Error("unexpected provider operation");
                            }
                            if (operation.identity.role === "observationsPoll") {
                                pollCalls += 1;
                                return {
                                    result: pollCalls === 1
                                        ? {
                                            kind: "checkpointOnly",
                                            checkpointAfterBatch: { cursor: "baseline" },
                                        }
                                        : {
                                            kind: "batch",
                                            observations: [scenario.observation],
                                            checkpointAfterBatch: { cursor: "after-observation" },
                                        },
                                    executionOrigin: {
                                        serverIdentityId: SERVER_IDENTITY_ID,
                                        materializationRef: materialization,
                                    },
                                };
                            }
                            if (operation.identity.role !== "automationEventAdmit") {
                                throw new Error("unexpected provider operation");
                            }
                            return {
                                result: await scenario.admit(actionInput, {
                                    plugin: { id: scenario.pluginId, version: VERSION },
                                    contribution: {
                                        id: scenario.admitActionLocalId,
                                        qualifiedId: `${scenario.pluginId}/actions/${scenario.admitActionLocalId}`,
                                    },
                                    surface: "plugin",
                                    caller: {
                                        kind: "plugin",
                                        pluginId: CHANNELS_PLUGIN_ID,
                                        contribution: {
                                            id: "provider/observation-ingest-v1",
                                            qualifiedId: `${CHANNELS_PLUGIN_ID}/actions/provider/observation-ingest-v1`,
                                        },
                                        materialization: {
                                            pluginId: CHANNELS_PLUGIN_ID,
                                            machineId: MACHINE_ID,
                                            materializationId: CHANNELS_MATERIALIZATION_ID,
                                        },
                                    },
                                    signal: new AbortController().signal,
                                    services: {
                                        actions: {
                                            execute: async (actionId: string, actionInput: unknown) => await executor({
                                                actionId,
                                                input: actionInput,
                                                caller: {
                                                    kind: "plugin",
                                                    pluginId: scenario.pluginId,
                                                    contributionLocalId: scenario.admitActionLocalId,
                                                    immutableGenerationId: PROVIDER_GENERATION,
                                                    materialization,
                                                },
                                            }),
                                        },
                                        logger: { debug() {}, info() {}, warn() {}, error() {} },
                                    },
                                }),
                                executionOrigin: {
                                    serverIdentityId: SERVER_IDENTITY_ID,
                                    materializationRef: materialization,
                                },
                            };
                        },
                    },
                },
            };
            const ingressModule = await import(/* @vite-ignore */ new URL(
                "../../../../../packages/plugins/channels/src/ingress.ts",
                import.meta.url,
            ).href);
            await expect(ingressModule.runConversationCheckpointedPollForInvocation(
                { connectionId: COMPOSED_CONNECTION_ID, waitMs: 0 },
                channelsContext,
            )).resolves.toMatchObject({ kind: "committed" });
            await expect(ingressModule.runConversationCheckpointedPollForInvocation(
                { connectionId: COMPOSED_CONNECTION_ID, waitMs: 0 },
                channelsContext,
            )).resolves.toMatchObject({ kind: "committed" });
            expect(pollCalls).toBe(2);
            expect(admissionRouteCalls).toBe(1);
            await expect(db.automationRun.count({
                where: { accountId: ACCOUNT_ID, causeKind: "trigger", causeTriggerKind: "pluginEvent" },
            })).resolves.toBe(1);

            if (params.whileAppOpen) {
                await params.whileAppOpen({ injectSigned });
            }
            return { channels, pollCalls, admissionRouteCalls };
        } finally {
            await app.close();
        }
    }

    it("composes schedule and plugin Event triggers, manual Run Now, and per-admission recipe freezing on one Automation", async () => {
        const scenario = await loadScenario("telegram");
        const keyPair = await seedComposedProviderFixture(scenario);
        const dueAt = new Date(Date.now() - 60_000);
        await db.automation.create({
            data: {
                id: AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                name: "Composed trigger set",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: strictRecipeVersioned(1),
                templateVersion: 1,
                assignments: { create: { machineId: MACHINE_ID, enabled: true } },
                triggers: { create: [
                    {
                        id: COMPOSED_SCHEDULE_TRIGGER_A_ID,
                        kind: "schedule",
                        enabled: true,
                        revision: 1,
                        scheduleKind: "interval",
                        everyMs: 60_000,
                        nextRunAt: dueAt,
                    },
                    {
                        id: COMPOSED_SCHEDULE_TRIGGER_B_ID,
                        kind: "schedule",
                        enabled: true,
                        revision: 1,
                        scheduleKind: "interval",
                        everyMs: 120_000,
                        nextRunAt: dueAt,
                    },
                    pluginEventTriggerRow(scenario),
                ] },
            },
        });

        // Each enabled schedule trigger admits its own independent occurrence.
        await runAutomationScheduleWorkerPass({ now: dueAt });
        const scheduleRuns = await db.automationRun.findMany({
            where: { accountId: ACCOUNT_ID, causeTriggerKind: "schedule" },
            orderBy: { triggerId: "asc" },
        });
        expect(scheduleRuns.map((run) => [run.triggerId, run.causeKind, run.causeTriggerRevision, run.state]))
            .toEqual([
                [COMPOSED_SCHEDULE_TRIGGER_A_ID, "trigger", 1, "queued"],
                [COMPOSED_SCHEDULE_TRIGGER_B_ID, "trigger", 1, "queued"],
            ]);
        for (const run of scheduleRuns) {
            expect(run.occurrenceKey).not.toBeNull();
            expect(frozenRecipeTemplateVersion(run.executionInputEnvelope!)).toBe(1);
        }
        expect(new Set(scheduleRuns.map((run) => run.occurrenceKey)).size).toBe(scheduleRuns.length);

        // A definition edit before the next occurrence affects only future Runs:
        // trigger identity, revisions, schedule cursors, and admitted bytes stay.
        const readTriggers = () => db.automationTrigger.findMany({
            where: { automationId: AUTOMATION_ID },
            orderBy: { id: "asc" },
            select: { id: true, kind: true, enabled: true, revision: true, everyMs: true, nextRunAt: true },
        });
        const triggersBeforeEdit = await readTriggers();
        await expect(updateAutomation({
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
            expectedTemplateVersion: 1,
            input: { executionRecipe: definitionRecipeVersioned(2) },
        })).resolves.toMatchObject({ templateVersion: 2 });
        expect(await readTriggers()).toEqual(triggersBeforeEdit);
        for (const run of scheduleRuns) {
            const refetched = await db.automationRun.findUniqueOrThrow({
                where: { id: run.id },
                select: { executionInputEnvelope: true },
            });
            expect(refetched.executionInputEnvelope).toBe(run.executionInputEnvelope);
        }

        // The real provider occurrence admits through the signed Event route and
        // freezes the CURRENT (v2) recipe at admission; trigger-scoped cause and
        // source selector remain exact.
        const composed = await admitOneTelegramEventOccurrence({ scenario, keyPair });
        const eventRun = await db.automationRun.findFirstOrThrow({
            where: { accountId: ACCOUNT_ID, causeTriggerKind: "pluginEvent" },
        });
        expect(eventRun).toMatchObject({
            triggerId: TRIGGER_ID,
            causeKind: "trigger",
            causeTriggerRevision: 1,
            causeSourceSelectorId: SOURCE_SELECTOR_ID,
            state: "queued",
        });
        expect(frozenRecipeTemplateVersion(eventRun.executionInputEnvelope!)).toBe(2);
        const occurrenceKeys = [
            ...scheduleRuns.map((run) => run.occurrenceKey),
            eventRun.occurrenceKey,
        ];
        expect(new Set(occurrenceKeys).size).toBe(occurrenceKeys.length);
        expect([...composed.channels.rows.values()].some((row) => (
            row.deleted !== true
            && row.value["record-kind"] === "ingress-obligation"
            && row.value.terminal === true
        ))).toBe(true);

        // Run Now is an invocation cause, not a trigger: no trigger row is
        // invented or disturbed and the current recipe is frozen.
        await expect(runAutomationNow({
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
        })).resolves.toMatchObject({ triggerId: null, causeKind: "manual", causeTriggerKind: null });
        const manualRun = await db.automationRun.findFirstOrThrow({
            where: { accountId: ACCOUNT_ID, causeKind: "manual", automationId: AUTOMATION_ID },
        });
        expect(manualRun.triggerId).toBeNull();
        expect(frozenRecipeTemplateVersion(manualRun.executionInputEnvelope!)).toBe(2);
        expect(await readTriggers()).toEqual(triggersBeforeEdit);

        // A zero-trigger Automation runs directly through the same manual cause.
        const zeroTrigger = await createAutomation({
            accountId: ACCOUNT_ID,
            input: {
                automationId: COMPOSED_ZERO_TRIGGER_AUTOMATION_ID,
                name: "Composed zero trigger",
                enabled: true,
                executionRecipe: definitionRecipeVersioned(1),
                assignments: [{ machineId: MACHINE_ID, enabled: true, priority: 0 }],
                triggers: [],
            },
        });
        expect(zeroTrigger.triggers).toEqual([]);
        await expect(runAutomationNow({
            accountId: ACCOUNT_ID,
            automationId: zeroTrigger.id,
        })).resolves.toMatchObject({ triggerId: null, causeKind: "manual", causeTriggerKind: null });
        await expect(db.automationRun.count({
            where: { accountId: ACCOUNT_ID, automationId: zeroTrigger.id, causeKind: "manual", triggerId: null },
        })).resolves.toBe(1);

        expect(composed.admissionRouteCalls).toBe(1);
        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(5);
    }, 120_000);

    it("composes provider Event custody with a directly admitted Conversation result handoff", async () => {
        const scenario = await loadScenario("telegram");
        const keyPair = await seedComposedProviderFixture(scenario);
        await seedChannelsCoreReleaseFixture();
        await db.automation.create({
            data: {
                id: AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                name: "Composed custody loop",
                enabled: true,
                targetType: "existing_session",
                templateCiphertext: strictRecipe(),
                templateVersion: 1,
                assignments: { create: { machineId: MACHINE_ID, enabled: true } },
                triggers: { create: [pluginEventTriggerRow(scenario)] },
            },
        });

        // One canonical persisted Channels binding routes the connection to this
        // Automation with verified final-result delivery.
        const routeOpaqueContext = PluginJsonValueV2Schema.parse({
            v: 1,
            kind: "conversationAutomationResultDelivery",
            connectionId: COMPOSED_CONNECTION_ID,
            bindingId: COMPOSED_BINDING_ID,
            bindingRevision: 1,
            connectionAuthorityEpoch: 4,
            bindingAuthorityEpoch: 1,
            endpoint: scenario.endpoint,
            reply: { providerMessageId: "9" },
            linkPreviewPolicy: "suppress",
        });
        const bindingRowValue = {
            id: COMPOSED_BINDING_ID,
            "record-kind": "binding",
            v: 1,
            "connection-id": COMPOSED_CONNECTION_ID,
            "binding-id": COMPOSED_BINDING_ID,
            "created-at": 1_000,
            "updated-at": 1_000,
            payload: {
                endpoint: scenario.endpoint,
                target: {
                    kind: "automation",
                    automationId: AUTOMATION_ID,
                    policy: { resultDelivery: "finalResult" },
                },
                allowedPrincipalIds: ["person-1"],
                allowBotSenders: false,
                inputMode: "allAllowedMessages",
                inboundDebounceMs: 750,
                linkPreviewPolicy: "suppress",
                senderFeedback: "off",
                authorityEpoch: 1,
                enabled: true,
                deletionState: "none",
            },
        };

        // 1. A real provider occurrence reaches Channels ingress custody and
        //    signed Event admission. While that composed transport is live, a
        //    distinct direct Conversation invocation uses the canonical signed
        //    admission route. The test deliberately does not claim the Event
        //    Run itself owns a reply handoff.
        let conversationRunId: string | null = null;
        const composed = await admitOneTelegramEventOccurrence({
            scenario,
            keyPair,
            initialChannelsRows: [bindingRowValue],
            whileAppOpen: async ({ injectSigned }) => {
                const conversationCaller = {
                    pluginId: CHANNELS_PLUGIN_ID,
                    contributionLocalId: CHANNELS_INGRESS_CONTRIBUTION_LOCAL_ID,
                    materialization: {
                        pluginId: CHANNELS_PLUGIN_ID,
                        machineId: MACHINE_ID,
                        materializationId: CHANNELS_MATERIALIZATION_ID,
                    },
                    immutableGenerationId: CHANNELS_GENERATION,
                };
                // CHAN-16: the direct Conversation binding target verifies
                // through the real plugin-only verifier before final-result
                // delivery is admitted.
                const verified = await injectSigned(
                    AutomationConversationActionHttpPathsV1["automation.conversation.target.verify"],
                    AutomationConversationActionHttpRequestSchemasV1["automation.conversation.target.verify"].parse({
                        v: 1,
                        caller: conversationCaller,
                        input: { automationId: AUTOMATION_ID, resultDelivery: "finalResult" },
                    }),
                );
                expect(verified.statusCode).toBe(200);
                expect(verified.json()).toEqual({ kind: "verified" });

                const occurredAt = Date.now() - 500;
                const resultDelivery = {
                    kind: "finalResult",
                    actionRef: {
                        pluginId: CHANNELS_PLUGIN_ID,
                        localId: CHANNELS_RESULT_DELIVERY_ACTION_LOCAL_ID,
                    },
                    opaqueContext: routeOpaqueContext,
                } as const;
                const occurrenceKey = deriveAutomationOccurrenceKeyV1(
                    buildAutomationConversationOccurrenceEvidenceV1({
                        accountMode: "plain",
                        bindingId: COMPOSED_BINDING_ID,
                        occurrenceId: COMPOSED_CONVERSATION_OCCURRENCE_ID,
                        occurredAt,
                        caller: {
                            pluginId: CHANNELS_PLUGIN_ID,
                            contributionLocalId: CHANNELS_INGRESS_CONTRIBUTION_LOCAL_ID,
                            machineId: MACHINE_ID,
                        },
                        sender: { id: "person-1" },
                        text: "Run the composed custody loop",
                        resultDelivery,
                    }),
                );
                const admitBody = AutomationConversationActionHttpRequestSchemasV1["automation.conversation.admit"].parse({
                    v: 1,
                    caller: conversationCaller,
                    input: {
                        automationId: AUTOMATION_ID,
                        bindingId: COMPOSED_BINDING_ID,
                        occurrenceId: COMPOSED_CONVERSATION_OCCURRENCE_ID,
                        occurredAt,
                        sender: { id: "person-1" },
                        text: "Run the composed custody loop",
                        resultDelivery,
                    },
                    replyHandoff: {
                        actionRef: {
                            pluginId: CHANNELS_PLUGIN_ID,
                            localId: CHANNELS_RESULT_DELIVERY_ACTION_LOCAL_ID,
                        },
                        replyContextEnvelope: sealAutomationConversationReplyContextStoredEnvelopeV1({
                            mode: "plain",
                            correspondence: { automationId: AUTOMATION_ID, occurrenceKey },
                            opaqueContext: routeOpaqueContext,
                        }),
                    },
                });
                const admitted = await injectSigned(
                    AutomationConversationActionHttpPathsV1["automation.conversation.admit"],
                    admitBody,
                );
                expect(admitted.statusCode).toBe(200);
                const admission = AutomationConversationAdmitResultV1Schema.parse(admitted.json());
                expect(admission).toMatchObject({ kind: "admitted", checkpointSafe: true });
                if (admission.kind !== "admitted") throw new Error("composed conversation admission failed");
                conversationRunId = admission.runId;

                // Conversation replay equality rejoins the same durable Run.
                const replay = await injectSigned(
                    AutomationConversationActionHttpPathsV1["automation.conversation.admit"],
                    admitBody,
                );
                expect(replay.statusCode).toBe(200);
                expect(AutomationConversationAdmitResultV1Schema.parse(replay.json())).toMatchObject({
                    kind: "rejoined",
                    runId: conversationRunId,
                });
            },
        });
        if (conversationRunId === null) throw new Error("composed conversation Run was not admitted");
        const conversationRunIdResolved: string = conversationRunId;
        const handoffId = `automation-reply-handoff:${conversationRunIdResolved}`;
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: conversationRunIdResolved },
            select: {
                causeKind: true,
                triggerId: true,
                replyHandoffState: true,
                replyHandoffId: true,
                replyHandoffActionPluginId: true,
                replyHandoffActionLocalId: true,
                replyHandoffTargetMachineId: true,
                replyHandoffTargetMachineInstallationId: true,
                replyHandoffTargetMaterializationId: true,
            },
        })).resolves.toMatchObject({
            causeKind: "conversation",
            triggerId: null,
            replyHandoffState: "awaitingResult",
            replyHandoffId: handoffId,
            replyHandoffActionPluginId: CHANNELS_PLUGIN_ID,
            replyHandoffActionLocalId: CHANNELS_RESULT_DELIVERY_ACTION_LOCAL_ID,
            replyHandoffTargetMachineId: MACHINE_ID,
            replyHandoffTargetMachineInstallationId: MACHINE_INSTALLATION_ID,
            replyHandoffTargetMaterializationId: CHANNELS_MATERIALIZATION_ID,
        });

        // 2. Daemon execution seam: canonical V3 claim -> start -> settle for
        //    every admitted Run (the Event Run and the Conversation Run).
        const settledRunIds: string[] = [];
        for (let claimIndex = 0; claimIndex < 3; claimIndex += 1) {
            const claim = await claimAutomationRun({
                accountId: ACCOUNT_ID,
                machineId: MACHINE_ID,
                leaseDurationMs: 30_000,
                claimRequest: {
                    machineInstallationId: MACHINE_INSTALLATION_ID,
                    nonce: `composed-custody-claim-${claimIndex}`,
                    expiresAt: new Date(Date.now() + 300_000),
                },
            });
            if (!claim.run || !claim.accountCurrentness) break;
            const started = await startAutomationRun({
                accountId: ACCOUNT_ID,
                runId: claim.run.id,
                machineId: MACHINE_ID,
                attempt: claim.run.attempt,
                accountCurrentness: claim.accountCurrentness,
            });
            if (started === null) throw new Error("claimed composed Run did not start");
            const resultEnvelope = claim.run.causeKind === "conversation"
                ? JSON.stringify(sealAutomationRunResultStoredEnvelopeV1({
                    mode: "plain",
                    correspondence: {
                        accountId: ACCOUNT_ID,
                        automationId: AUTOMATION_ID,
                        runId: claim.run.id,
                        handoffId: `automation-reply-handoff:${claim.run.id}`,
                    },
                    result: { v: 1, kind: "text", text: "Composed Channels custody reply" },
                }))
                : null;
            await expect(succeedAutomationRun({
                accountId: ACCOUNT_ID,
                runId: claim.run.id,
                machineId: MACHINE_ID,
                attempt: claim.run.attempt,
                accountCurrentness: started.accountCurrentness,
                resultEnvelope,
            })).resolves.toMatchObject({ id: claim.run.id, state: "succeeded" });
            settledRunIds.push(claim.run.id);
        }
        expect(settledRunIds.sort()).toEqual([conversationRunIdResolved, (await db.automationRun.findFirstOrThrow({
            where: { accountId: ACCOUNT_ID, causeTriggerKind: "pluginEvent" },
            select: { id: true },
        })).id].sort());
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: conversationRunIdResolved },
            select: { replyHandoffState: true, replyHandoffAttempt: true },
        })).resolves.toMatchObject({ replyHandoffState: "ready", replyHandoffAttempt: 0 });

        // 3. Reply handoff: the real server worker dispatches to the real daemon
        //    RPC receiver, whose Action seam invokes the real Channels result
        //    custody writer against the same Account Collections host.
        const custodyModules = await Promise.all([
            import(/* @vite-ignore */ new URL(
                "../../../../cli/src/rpc/handlers/automationReplyHandoff.ts",
                import.meta.url,
            ).href),
            import(/* @vite-ignore */ new URL(
                "../../../../../packages/plugins/channels/src/automationResultDelivery.ts",
                import.meta.url,
            ).href),
            import(/* @vite-ignore */ new URL(
                "../../../../../packages/plugins/channels/src/collections.ts",
                import.meta.url,
            ).href),
        ]);
        const handlerModule = custodyModules[0] as {
            registerAutomationReplyHandoffRpcHandler: (registrar: unknown, options: Record<string, unknown>) => void;
        };
        const deliverCustody = custodyModules[1]
            .deliverConversationAutomationResultForInvocation as (
                input: unknown,
                context: Record<string, unknown>,
            ) => Promise<unknown>;
        const collectionsModule = custodyModules[2] as {
            CHANNEL_STATE_COLLECTION: unknown;
            CHANNEL_DELIVERIES_COLLECTION: unknown;
        };
        const deliveries = createChannelsCollection();
        const stateCollection = composed.channels.collection;
        const handlers = new Map<string, (
            raw: unknown,
            context?: Readonly<{ signal?: AbortSignal }>,
        ) => Promise<unknown>>();
        handlerModule.registerAutomationReplyHandoffRpcHandler(
            {
                registerHandler: (method: string, handler: (raw: unknown, context?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>) => {
                    handlers.set(method, handler);
                },
            },
            {
                machineId: MACHINE_ID,
                resolveAccountId: async () => ACCOUNT_ID,
                resolveInstallationId: async () => MACHINE_INSTALLATION_ID,
                resolveAccountEncryptionCurrentness: readComposedAccountCurrentness,
                resolveAccountEncryptionMaterial: async () => null,
                resolveCurrentTargetMaterializationId: async () => CHANNELS_MATERIALIZATION_ID,
                acquireRuntimeLease: async () => ({
                    registry: null,
                    release: async () => {},
                }) as never,
                executeContributedAction: async (invocation: Readonly<{
                    input: unknown;
                    context: Record<string, unknown>;
                }>) => ({
                    matched: true,
                    result: {
                        ok: true,
                        result: await deliverCustody(invocation.input, {
                            ...invocation.context,
                            services: {
                                storage: {
                                    account: {
                                        collection: (requested: unknown) => requested === collectionsModule.CHANNEL_DELIVERIES_COLLECTION
                                            ? deliveries.collection
                                            : stateCollection,
                                    },
                                },
                            },
                        }),
                    },
                }),
            },
        );
        const dispatchHandler = handlers.get(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1);
        if (dispatchHandler === undefined) throw new Error("composed handoff receiver was not registered");
        const worker = await runAutomationReplyHandoffWorkerPass({
            now: new Date(),
            dispatch: async (request: unknown) => await dispatchHandler(request, {
                signal: new AbortController().signal,
            }) as AutomationReplyHandoffDispatchResultV1,
        });
        expect(worker).toMatchObject({ claimed: true, settled: true });

        // 4. Custody truth: the Run carries an accepted receipt and Channels owns
        //    exactly one ready outward custody obligation for this handoff.
        const custodySettled = await db.automationRun.findUniqueOrThrow({
            where: { id: conversationRunIdResolved },
            select: { replyHandoffState: true, replyHandoffReceiptEnvelope: true },
        });
        expect(custodySettled.replyHandoffState).toBe("accepted");
        expect(JSON.parse(custodySettled.replyHandoffReceiptEnvelope ?? "null")).toEqual({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    accountId: ACCOUNT_ID,
                    automationId: AUTOMATION_ID,
                    runId: conversationRunIdResolved,
                    handoffId,
                },
                result: { kind: "accepted", custodyId: expect.any(String) },
            },
        });
        const deliveryRows = [...deliveries.rows.values()].filter((row) => row.deleted !== true);
        expect(deliveryRows).toHaveLength(1);
        const deliveryPayload = deliveryRows[0]!.value.payload as JsonRecord;
        expect(deliveryPayload).toMatchObject({
            state: "ready",
            attemptCount: 0,
            deliveryKey: `automation:${handoffId}`,
            source: {
                kind: "automationResult",
                automationRunId: conversationRunIdResolved,
                resultId: handoffId,
                automationId: AUTOMATION_ID,
                resultDelivery: "finalResult",
            },
        });
        expect([...composed.channels.rows.values()].every((row) => (
            row.value["record-kind"] !== "ingress-obligation"
            || row.value.terminal === true
        ))).toBe(true);
    }, 120_000);

    it("excludes the Discord integration's own echo at the census while the adjacent human occurrence admits one Run", async () => {
        const humanScenario = await loadScenario("discord");
        const selfScenario = await loadScenario("discord", { discordSelfEcho: true });
        const keyPair = await seedComposedProviderFixture(humanScenario);
        await db.automation.create({
            data: {
                id: AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                name: "Discord self-echo composed Event",
                enabled: true,
                targetType: "existing_session",
                templateCiphertext: strictRecipe(),
                templateVersion: 1,
                assignments: { create: { machineId: MACHINE_ID, enabled: true } },
                triggers: { create: [pluginEventTriggerRow(humanScenario)] },
            },
        });

        const cliModules = await Promise.all([
            import(/* @vite-ignore */ new URL(
                "../../../../cli/src/plugins/runtime/automations/automationEventActionExecutor.ts",
                import.meta.url,
            ).href),
            import(/* @vite-ignore */ new URL(
                "../../../../cli/src/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost.ts",
                import.meta.url,
            ).href),
        ]);
        const createExecutor = cliModules[0].createAutomationEventActionExecutor as (
            input: JsonRecord,
        ) => DynamicExecutor;
        const createAdoptedSet = cliModules[1].createAutomationEventAdoptedDefinitionSetHostV1 as (
            input: JsonRecord,
        ) => JsonRecord & Readonly<{ refresh(): Promise<unknown> }>;
        const materialization = {
            pluginId: humanScenario.pluginId,
            machineId: MACHINE_ID,
            materializationId: MATERIALIZATION_ID,
        };
        const credentials = {
            token: "channels-provider-composed-token",
            encryption: { type: "legacy" as const, secret: new Uint8Array(32).fill(9) },
        };
        const app = createAuthenticatedTestApp();
        registerAutomationEventRoutes(app as never);
        await app.ready();
        try {
            const injectSigned = async (path: string, body: unknown) => await app.inject({
                method: "POST",
                url: path,
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": ACCOUNT_ID,
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                        body,
                        keyPair,
                        path,
                    }),
                },
                payload: body,
            });
            const adoptedSet = createAdoptedSet({
                credentials,
                caller: materialization,
                immutableGenerationId: PROVIDER_GENERATION,
                transport: { kind: "checkpointedPull" },
                generationSignal: new AbortController().signal,
                isGenerationCurrent: () => true,
                revalidateCallerMaterialization: async () => true,
                revalidateCallerImmutableGeneration: async () => true,
                readStoredDefinitions: async (params: JsonRecord) => {
                    if (!isRecord(params.caller) || !isRecord(params.input)) {
                        throw new Error("stored definition request is invalid");
                    }
                    const body = AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse({
                        v: 1,
                        caller: params.caller,
                        input: params.input,
                    });
                    const response = await injectSigned(
                        AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
                        body,
                    );
                    expect(response.statusCode).toBe(200);
                    return response.json();
                },
                resolveAccountEncryptionCurrentness: readComposedAccountCurrentness,
                resolveAccountEncryptionMaterial: async () => null,
            });
            await requireAdoptedDefinitionSet(adoptedSet);
            const executor = createExecutor({
                credentials,
                revalidateCallerMaterialization: async () => true,
                revalidateCallerImmutableGeneration: async () => true,
                resolveAccountId: async () => ACCOUNT_ID,
                resolveAdoptedDefinitionSet: () => adoptedSet,
                transport: {
                    execute: async (actionId: string, request: unknown) => {
                        if (!(actionId in AutomationEventActionHttpRequestSchemasV1)) {
                            throw new Error(`unexpected Automation action ${actionId}`);
                        }
                        const body = AutomationEventActionHttpRequestSchemasV1[
                            actionId as keyof typeof AutomationEventActionHttpRequestSchemasV1
                        ].parse(request);
                        const path = AutomationEventActionHttpPathsV1[
                            actionId as keyof typeof AutomationEventActionHttpPathsV1
                        ];
                        const response = await injectSigned(path, body);
                        expect(response.statusCode).toBe(200);
                        return response.json();
                    },
                },
            });

            const connectionId = "connection-discord";
            const connection = await (async () => {
                const fixtureModule = await import(/* @vite-ignore */ new URL(
                    "../../../../../packages/plugins/channels/src/testkit/currentConnectionFixture.ts",
                    import.meta.url,
                ).href) as {
                    createCurrentConversationConnectionFixture: (input: JsonRecord) => JsonRecord;
                };
                return fixtureModule.createCurrentConversationConnectionFixture({
                    connectionId,
                    authority: {
                        providerPluginId: humanScenario.pluginId,
                        providerContributionSelection: {
                            contributionId: humanScenario.contributionId,
                            immutableGenerationId: PROVIDER_GENERATION,
                        },
                        providerSetupInput: { source: "composed-test" },
                        credentialRef: humanScenario.credentialRef,
                        transportOrigin: {
                            serverIdentityId: SERVER_IDENTITY_ID,
                            materializationRef: materialization,
                        },
                        providerConnectionKey: humanScenario.providerConnectionKey,
                        providerConfig: humanScenario.providerConfig,
                        routingIdentityKey: "r".repeat(43),
                        integrationPrincipal: humanScenario.integrationPrincipal,
                        authorityEpoch: 4,
                    },
                    transport: humanScenario.connectionTransport,
                    overlapSafety: "safe",
                    replayContinuity: humanScenario.replayContinuity,
                    outboundTextLimit: { maximum: 4_096, unit: "utf8Bytes" },
                });
            })();
            const channels = createChannelsCollection(connection);
            let currentScenario = selfScenario;
            const channelsContext = {
                invokedAtMs: Date.now(),
                plugin: { id: CHANNELS_PLUGIN_ID, version: VERSION },
                contribution: {
                    id: "provider/observation-ingest-v1",
                    qualifiedId: `${CHANNELS_PLUGIN_ID}/actions/provider/observation-ingest-v1`,
                },
                surface: "plugin",
                caller: {
                    kind: "plugin",
                    pluginId: humanScenario.pluginId,
                    contribution: {
                        id: "gateway",
                        qualifiedId: `${humanScenario.pluginId}/backgroundServices/provider-observer`,
                    },
                    materialization,
                },
                signal: new AbortController().signal,
                services: {
                    storage: { account: { collection: () => channels.collection } },
                    sessions: { get: async () => null },
                    targetedContributions: {
                        observeForSelf: () => ({
                            dispose() {},
                            readCurrent: async () => ({
                                generation: CHANNELS_GENERATION,
                                contributions: [providerContributionProjection(humanScenario)],
                            }),
                        }),
                    },
                    actions: {
                        execute: async () => {
                            throw new Error("unexpected generic Channels action");
                        },
                        executeAdmittedTargetedOperationWithExecutionOrigin: async (
                            operation: JsonRecord,
                            actionInput: unknown,
                        ) => {
                            if (!isRecord(operation.identity)) {
                                throw new Error("unexpected provider operation");
                            }
                            if (operation.identity.role !== "automationEventAdmit") {
                                throw new Error("unexpected provider operation");
                            }
                            const scenario = currentScenario;
                            return {
                                result: await scenario.admit(actionInput, {
                                    plugin: { id: scenario.pluginId, version: VERSION },
                                    contribution: {
                                        id: scenario.admitActionLocalId,
                                        qualifiedId: `${scenario.pluginId}/actions/${scenario.admitActionLocalId}`,
                                    },
                                    surface: "plugin",
                                    caller: {
                                        kind: "plugin",
                                        pluginId: CHANNELS_PLUGIN_ID,
                                        contribution: {
                                            id: "provider/observation-ingest-v1",
                                            qualifiedId: `${CHANNELS_PLUGIN_ID}/actions/provider/observation-ingest-v1`,
                                        },
                                        materialization: {
                                            pluginId: CHANNELS_PLUGIN_ID,
                                            machineId: MACHINE_ID,
                                            materializationId: CHANNELS_MATERIALIZATION_ID,
                                        },
                                    },
                                    signal: new AbortController().signal,
                                    services: {
                                        actions: {
                                            execute: async (actionId: string, actionInputInner: unknown) => await executor({
                                                actionId,
                                                input: actionInputInner,
                                                caller: {
                                                    kind: "plugin",
                                                    pluginId: scenario.pluginId,
                                                    contributionLocalId: scenario.admitActionLocalId,
                                                    immutableGenerationId: PROVIDER_GENERATION,
                                                    materialization,
                                                },
                                            }),
                                        },
                                        logger: { debug() {}, info() {}, warn() {}, error() {} },
                                    },
                                }),
                                executionOrigin: {
                                    serverIdentityId: SERVER_IDENTITY_ID,
                                    materializationRef: materialization,
                                },
                            };
                        },
                    },
                },
            };
            const ingressModule = await import(/* @vite-ignore */ new URL(
                "../../../../../packages/plugins/channels/src/ingress.ts",
                import.meta.url,
            ).href) as {
                ingestConversationProviderObservationForInvocation: (
                    input: JsonRecord,
                    context: unknown,
                ) => Promise<void>;
            };

            // The integration's own Gateway echo — the same entry the real
            // worker builds with a null Event candidate — traverses the one
            // census/checkpoint owner and settles checkpoint-safe with zero
            // Event custody and zero Runs.
            await expect(ingressModule.ingestConversationProviderObservationForInvocation(
                { connectionId, entry: selfScenario.observation },
                channelsContext,
            )).resolves.toBeUndefined();
            expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(0);
            expect([...channels.rows.values()].filter((row) => (
                row.deleted !== true && row.value["record-kind"] === "ingress-obligation"
            ))).toHaveLength(0);

            // The adjacent human occurrence in the same channel admits exactly
            // one Run through the same census and the provider's admit Action.
            currentScenario = humanScenario;
            await expect(ingressModule.ingestConversationProviderObservationForInvocation(
                { connectionId, entry: humanScenario.observation },
                channelsContext,
            )).resolves.toBeUndefined();
            expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);
            const admittedRun = await db.automationRun.findFirstOrThrow({
                where: { accountId: ACCOUNT_ID },
                select: { triggerId: true, causeKind: true, causeTriggerKind: true, state: true },
            });
            expect(admittedRun).toMatchObject({
                triggerId: TRIGGER_ID,
                causeKind: "trigger",
                causeTriggerKind: "pluginEvent",
                state: "queued",
            });
            expect([...channels.rows.values()].some((row) => (
                row.deleted !== true
                && row.value["record-kind"] === "ingress-obligation"
                && row.value.terminal === true
            ))).toBe(true);
        } finally {
            await app.close();
        }
    }, 120_000);

    it("rejoins the same Conversation handoff deterministically when the daemon custody response is lost", async () => {
        const scenario = await loadScenario("telegram");
        const keyPair = await seedComposedProviderFixture(scenario);
        await seedChannelsCoreReleaseFixture();
        await db.automation.create({
            data: {
                id: AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                name: "Composed custody response-loss loop",
                enabled: true,
                targetType: "existing_session",
                templateCiphertext: strictRecipe(),
                templateVersion: 1,
                assignments: { create: { machineId: MACHINE_ID, enabled: true } },
                triggers: { create: [pluginEventTriggerRow(scenario)] },
            },
        });

        const routeOpaqueContext = PluginJsonValueV2Schema.parse({
            v: 1,
            kind: "conversationAutomationResultDelivery",
            connectionId: COMPOSED_CONNECTION_ID,
            bindingId: COMPOSED_BINDING_ID,
            bindingRevision: 1,
            connectionAuthorityEpoch: 4,
            bindingAuthorityEpoch: 1,
            endpoint: scenario.endpoint,
            reply: { providerMessageId: "9" },
            linkPreviewPolicy: "suppress",
        });
        const bindingRowValue = {
            id: COMPOSED_BINDING_ID,
            "record-kind": "binding",
            v: 1,
            "connection-id": COMPOSED_CONNECTION_ID,
            "binding-id": COMPOSED_BINDING_ID,
            "created-at": 1_000,
            "updated-at": 1_000,
            payload: {
                endpoint: scenario.endpoint,
                target: {
                    kind: "automation",
                    automationId: AUTOMATION_ID,
                    policy: { resultDelivery: "finalResult" },
                },
                allowedPrincipalIds: ["person-1"],
                allowBotSenders: false,
                inputMode: "allAllowedMessages",
                inboundDebounceMs: 750,
                linkPreviewPolicy: "suppress",
                senderFeedback: "off",
                authorityEpoch: 1,
                enabled: true,
                deletionState: "none",
            },
        };

        let conversationRunId: string | null = null;
        const composed = await admitOneTelegramEventOccurrence({
            scenario,
            keyPair,
            initialChannelsRows: [bindingRowValue],
            whileAppOpen: async ({ injectSigned }) => {
                const conversationCaller = {
                    pluginId: CHANNELS_PLUGIN_ID,
                    contributionLocalId: CHANNELS_INGRESS_CONTRIBUTION_LOCAL_ID,
                    materialization: {
                        pluginId: CHANNELS_PLUGIN_ID,
                        machineId: MACHINE_ID,
                        materializationId: CHANNELS_MATERIALIZATION_ID,
                    },
                    immutableGenerationId: CHANNELS_GENERATION,
                };
                const occurredAt = Date.now() - 500;
                const resultDelivery = {
                    kind: "finalResult",
                    actionRef: {
                        pluginId: CHANNELS_PLUGIN_ID,
                        localId: CHANNELS_RESULT_DELIVERY_ACTION_LOCAL_ID,
                    },
                    opaqueContext: routeOpaqueContext,
                } as const;
                const occurrenceKey = deriveAutomationOccurrenceKeyV1(
                    buildAutomationConversationOccurrenceEvidenceV1({
                        accountMode: "plain",
                        bindingId: COMPOSED_BINDING_ID,
                        occurrenceId: COMPOSED_CONVERSATION_OCCURRENCE_ID,
                        occurredAt,
                        caller: {
                            pluginId: CHANNELS_PLUGIN_ID,
                            contributionLocalId: CHANNELS_INGRESS_CONTRIBUTION_LOCAL_ID,
                            machineId: MACHINE_ID,
                        },
                        sender: { id: "person-1" },
                        text: "Run the response-loss custody loop",
                        resultDelivery,
                    }),
                );
                const admitBody = AutomationConversationActionHttpRequestSchemasV1["automation.conversation.admit"].parse({
                    v: 1,
                    caller: conversationCaller,
                    input: {
                        automationId: AUTOMATION_ID,
                        bindingId: COMPOSED_BINDING_ID,
                        occurrenceId: COMPOSED_CONVERSATION_OCCURRENCE_ID,
                        occurredAt,
                        sender: { id: "person-1" },
                        text: "Run the response-loss custody loop",
                        resultDelivery,
                    },
                    replyHandoff: {
                        actionRef: {
                            pluginId: CHANNELS_PLUGIN_ID,
                            localId: CHANNELS_RESULT_DELIVERY_ACTION_LOCAL_ID,
                        },
                        replyContextEnvelope: sealAutomationConversationReplyContextStoredEnvelopeV1({
                            mode: "plain",
                            correspondence: { automationId: AUTOMATION_ID, occurrenceKey },
                            opaqueContext: routeOpaqueContext,
                        }),
                    },
                });
                const admitted = await injectSigned(
                    AutomationConversationActionHttpPathsV1["automation.conversation.admit"],
                    admitBody,
                );
                expect(admitted.statusCode).toBe(200);
                const admission = AutomationConversationAdmitResultV1Schema.parse(admitted.json());
                expect(admission).toMatchObject({ kind: "admitted", checkpointSafe: true });
                if (admission.kind === "admitted") conversationRunId = admission.runId;
            },
        });
        if (conversationRunId === null) throw new Error("composed conversation Run was not admitted");
        const conversationRunIdResolved: string = conversationRunId;
        const handoffId = `automation-reply-handoff:${conversationRunIdResolved}`;

        for (let claimIndex = 0; claimIndex < 2; claimIndex += 1) {
            const claim = await claimAutomationRun({
                accountId: ACCOUNT_ID,
                machineId: MACHINE_ID,
                leaseDurationMs: 30_000,
                claimRequest: {
                    machineInstallationId: MACHINE_INSTALLATION_ID,
                    nonce: `response-loss-claim-${claimIndex}`,
                    expiresAt: new Date(Date.now() + 300_000),
                },
            });
            if (!claim.run || !claim.accountCurrentness) break;
            if (claim.run.causeKind !== "conversation") continue;
            const started = await startAutomationRun({
                accountId: ACCOUNT_ID,
                runId: claim.run.id,
                machineId: MACHINE_ID,
                attempt: claim.run.attempt,
                accountCurrentness: claim.accountCurrentness,
            });
            if (started === null) throw new Error("claimed response-loss Run did not start");
            await expect(succeedAutomationRun({
                accountId: ACCOUNT_ID,
                runId: claim.run.id,
                machineId: MACHINE_ID,
                attempt: claim.run.attempt,
                accountCurrentness: started.accountCurrentness,
                resultEnvelope: JSON.stringify(sealAutomationRunResultStoredEnvelopeV1({
                    mode: "plain",
                    correspondence: {
                        accountId: ACCOUNT_ID,
                        automationId: AUTOMATION_ID,
                        runId: claim.run.id,
                        handoffId: `automation-reply-handoff:${claim.run.id}`,
                    },
                    result: { v: 1, kind: "text", text: "Response-loss custody reply" },
                })),
            })).resolves.toMatchObject({ id: claim.run.id, state: "succeeded" });
        }
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: conversationRunIdResolved },
            select: { replyHandoffState: true },
        })).resolves.toMatchObject({ replyHandoffState: "ready" });

        const custodyModules = await Promise.all([
            import(/* @vite-ignore */ new URL(
                "../../../../cli/src/rpc/handlers/automationReplyHandoff.ts",
                import.meta.url,
            ).href),
            import(/* @vite-ignore */ new URL(
                "../../../../../packages/plugins/channels/src/automationResultDelivery.ts",
                import.meta.url,
            ).href),
            import(/* @vite-ignore */ new URL(
                "../../../../../packages/plugins/channels/src/collections.ts",
                import.meta.url,
            ).href),
        ]);
        const handlerModule = custodyModules[0] as {
            registerAutomationReplyHandoffRpcHandler: (registrar: unknown, options: Record<string, unknown>) => void;
        };
        const deliverCustody = custodyModules[1]
            .deliverConversationAutomationResultForInvocation as (
                input: unknown,
                context: Record<string, unknown>,
            ) => Promise<unknown>;
        const collectionsModule = custodyModules[2] as {
            CHANNEL_STATE_COLLECTION: unknown;
            CHANNEL_DELIVERIES_COLLECTION: unknown;
        };
        const deliveries = createChannelsCollection();
        const stateCollection = composed.channels.collection;
        const handlers = new Map<string, (
            raw: unknown,
            context?: Readonly<{ signal?: AbortSignal }>,
        ) => Promise<unknown>>();
        handlerModule.registerAutomationReplyHandoffRpcHandler(
            {
                registerHandler: (method: string, handler: (raw: unknown, context?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>) => {
                    handlers.set(method, handler);
                },
            },
            {
                machineId: MACHINE_ID,
                resolveAccountId: async () => ACCOUNT_ID,
                resolveInstallationId: async () => MACHINE_INSTALLATION_ID,
                resolveAccountEncryptionCurrentness: readComposedAccountCurrentness,
                resolveAccountEncryptionMaterial: async () => null,
                resolveCurrentTargetMaterializationId: async () => CHANNELS_MATERIALIZATION_ID,
                acquireRuntimeLease: async () => ({
                    registry: null,
                    release: async () => {},
                }) as never,
                executeContributedAction: async (invocation: Readonly<{
                    input: unknown;
                    context: Record<string, unknown>;
                }>) => ({
                    matched: true,
                    result: {
                        ok: true,
                        result: await deliverCustody(invocation.input, {
                            ...invocation.context,
                            services: {
                                storage: {
                                    account: {
                                        collection: (requested: unknown) => requested === collectionsModule.CHANNEL_DELIVERIES_COLLECTION
                                            ? deliveries.collection
                                            : stateCollection,
                                    },
                                },
                            },
                        }),
                    },
                }),
            },
        );
        const dispatchHandler = handlers.get(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1);
        if (dispatchHandler === undefined) throw new Error("composed handoff receiver was not registered");

        // First dispatch: the real daemon handler commits custody, then the
        // RPC response is lost before it reaches the server worker.
        let dispatchCalls = 0;
        const dispatch = async (request: unknown) => {
            dispatchCalls += 1;
            const result = await dispatchHandler(request, {
                signal: new AbortController().signal,
            }) as AutomationReplyHandoffDispatchResultV1;
            if (dispatchCalls === 1) {
                throw new Error("simulated RPC response loss after custody committed");
            }
            return result;
        };
        const firstPass = await runAutomationReplyHandoffWorkerPass({
            now: new Date(),
            dispatch,
        });
        expect(firstPass).toMatchObject({ claimed: true, settled: true });
        expect(dispatchCalls).toBe(1);
        // The custody row is durable even though its settlement never arrived.
        const custodyAfterLoss = [...deliveries.rows.values()].filter((row) => row.deleted !== true);
        expect(custodyAfterLoss).toHaveLength(1);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: conversationRunIdResolved },
            select: { replyHandoffState: true, replyHandoffAttempt: true },
        })).resolves.toMatchObject({ replyHandoffState: "ready", replyHandoffAttempt: 1 });

        // The retry re-leases the SAME handoff id; the deterministic custody
        // writer rejoins the existing row instead of creating a second one.
        const retryPass = await runAutomationReplyHandoffWorkerPass({
            now: new Date(Date.now() + 60_000),
            dispatch,
        });
        expect(retryPass).toMatchObject({ claimed: true, settled: true });
        expect(dispatchCalls).toBe(2);
        expect([...deliveries.rows.values()].filter((row) => row.deleted !== true)).toHaveLength(1);
        const settledRun = await db.automationRun.findUniqueOrThrow({
            where: { id: conversationRunIdResolved },
            select: { replyHandoffState: true, replyHandoffAttempt: true, replyHandoffReceiptEnvelope: true },
        });
        expect(settledRun.replyHandoffState).toBe("accepted");
        expect(settledRun.replyHandoffAttempt).toBe(2);
        const receipt = JSON.parse(settledRun.replyHandoffReceiptEnvelope ?? "null") as JsonRecord;
        expect(receipt).toMatchObject({ t: "plain" });
        const receiptValue = receipt.v as JsonRecord;
        expect(receiptValue).toMatchObject({
            correspondence: { runId: conversationRunIdResolved, handoffId },
            result: {
                kind: "accepted",
                custodyId: custodyAfterLoss[0]!.rowId,
            },
        });
    }, 120_000);
});
