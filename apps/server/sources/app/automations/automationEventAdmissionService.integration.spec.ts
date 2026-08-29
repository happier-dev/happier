import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";

import {
    AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
    AutomationEventActionHttpPathsV1,
    AutomationEventActionHttpRequestSchemasV1,
    AutomationEventAdmitHttpResultV1Schema,
    AutomationEventAdmitInputV1Schema,
    AutomationEventAdmitEncryptedHostEvidenceV1Schema,
    AutomationEventAdmitHostEvidenceV1Schema,
    AutomationEventAdmitResultV1Schema,
    AutomationEventStoredDefinitionsReadHttpRequestV1Schema,
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    buildAutomationPluginEventOccurrenceEvidenceV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    createPluginInstallationManifestPublisherSigningInputV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1,
    deriveAutomationOccurrenceKeyV1,
    freezeAutomationRunPluginEventExecutionRecipeV1,
    normalizePluginReleaseFactsV1,
    parseAutomationRunExecutionRecipeV1,
    serializeAutomationRunExecutionRecipeV1,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
    sealAccountScopedBlobCiphertext,
    sealAutomationOccurrenceTriggerEvidenceEnvelopeV1,
    sealAutomationRunTriggerEvidenceEnvelopeV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    stringifyPluginInstallationManifestCanonicalJsonV1,
    type AccountEncryptionCurrentnessResponse,
    type AutomationEventDeclarationReleaseV1,
    type AutomationSourceSelectorIdV1,
    type PluginJsonSchemaV2,
    type PluginJsonValueV2,
} from "@happier-dev/protocol";
import { createPluginEventAutomationSetupResultV1JsonSchema } from "@happier-dev/protocol/automations/event-setup-result";

import { eventRouter } from "@/app/events/eventRouter";
import { registerAutomationEventRoutes } from "@/app/api/routes/automations/registerAutomationEventRoutes";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { validateCurrentPluginWebhookInvocationReferenceTxV1 } from "@/app/plugins/webhooks/claimStore";
import { retargetPluginWebhookEndpointV1 } from "@/app/plugins/webhooks/endpointStore";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

import {
    AutomationEventAdmissionError,
    admitAutomationEventV1 as admitAutomationEventV1Impl,
} from "./automationEventAdmissionService";
import { claimAutomationRun } from "./automationClaimService";
import { setAutomationEnabled } from "./automationCrudService";
import { startAutomationRun } from "./automationRunService";

const ACCOUNT_ID = "account-automation-event-admission";
const MACHINE_ID = "machine-automation-event-admission";
const MACHINE_INSTALLATION_ID = "installation-automation-event-admission";
const MATERIALIZATION_ID = "materialization-automation-event-admission";
const SERVER_IDENTITY_ID = "srv_automationEventAdmissionCurrent1";
const PLUGIN_ID = "com.acme.github";
const PLUGIN_VERSION = "1.0.0";
const EVENT_LOCAL_ID = "repository-event";
const SETUP_ACTION_LOCAL_ID = "setup-repository-source";
const AUTOMATION_ID = "automation-event-admission";
const TRIGGER_ID = AutomationTriggerIdSchema.parse("automation-event-admission-trigger");
const SOURCE_SELECTOR_ID = AutomationSourceSelectorIdV1Schema.parse(
    "8123c1f4-5566-4f77-8a88-1234567890ab",
);
const SECOND_AUTOMATION_ID = "automation-event-admission-second";
const SECOND_TRIGGER_ID = AutomationTriggerIdSchema.parse("automation-event-admission-trigger-second");
const SECOND_SOURCE_SELECTOR_ID = AutomationSourceSelectorIdV1Schema.parse(
    "7123c1f4-5566-4f77-8a88-1234567890ab",
);
const DURABLE_PUSH_ENDPOINT_ID = "wh_ep_AAECAwQFBgcICQoLDA0ODw";
const GITHUB_AUTOMATION_SOURCE_SELECTOR_ID = AutomationSourceSelectorIdV1Schema.parse(
    "95e0d5ef-0d4f-40b5-b539-1b4a4e996313",
);
const GITHUB_IMMUTABLE_GENERATION_ID = "github-composed-admission-generation";
const GITHUB_SOURCE_INSTANCE_ID = "github:repository:77";

const EVENT_PAYLOAD_SCHEMA = {
    type: "object",
    properties: { action: { type: "string" } },
    required: ["action"],
    additionalProperties: false,
} satisfies PluginJsonSchemaV2;

const GITHUB_EVENT_PAYLOAD_SCHEMA = {
    type: "object",
    additionalProperties: true,
} satisfies PluginJsonSchemaV2;

const GITHUB_SOURCE_CONFIG_SCHEMA = {
    type: "object",
    additionalProperties: true,
} satisfies PluginJsonSchemaV2;

const caller = {
    pluginId: PLUGIN_ID,
    machineId: MACHINE_ID,
    machineInstallationId: MACHINE_INSTALLATION_ID,
    materializationId: MATERIALIZATION_ID,
    immutableGenerationId: "generation-automation-event-admission",
} as const;

type DynamicRecord = Readonly<Record<string, unknown>>;
type GithubCheckpointRow = DynamicRecord;
type StoredGithubCheckpointRow = Readonly<{
    rowId: string;
    revision: number;
    value: GithubCheckpointRow;
}>;
type DynamicEventActionExecutor = (args: DynamicRecord) => Promise<unknown>;
type DynamicAdoptedDefinitionSet = DynamicRecord & Readonly<{
    refresh(signal?: AbortSignal): Promise<unknown>;
}>;
type DynamicGithubObserver = Readonly<{
    runCycle(context: unknown): Promise<void>;
    runSourceAttempt(input: unknown, context: unknown): Promise<unknown>;
}>;
type CurrentAutomationAdmissionSources = Readonly<{
    createEventActionExecutor(params: DynamicRecord): DynamicEventActionExecutor;
    createAdoptedDefinitionSet(params: DynamicRecord): DynamicAdoptedDefinitionSet;
    createGithubObserver(params: DynamicRecord): DynamicGithubObserver;
    createGithubCheckpointRowId(params: DynamicRecord): string;
    createGithubCheckpointRow(params: DynamicRecord): GithubCheckpointRow;
    checkpointFields: Readonly<{ id: string; payload: string }>;
    github: Readonly<{
        pluginId: string;
        connectedAccountId: string;
        eventId: string;
        backgroundServiceId: string;
        sourceAttemptActionId: string;
        sourceContractVersion: number;
    }>;
}>;

function isRecord(value: unknown): value is DynamicRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(record: DynamicRecord, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || !value) throw new Error(`missing current-source export: ${key}`);
    return value;
}

function readRequiredPositiveInteger(record: DynamicRecord, key: string): number {
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`missing current-source export: ${key}`);
    }
    return value;
}

function readRequiredFunction<T>(record: DynamicRecord, key: string): T {
    const value = record[key];
    if (typeof value !== "function") throw new Error(`missing current-source export: ${key}`);
    // Dynamic current-source imports are a test boundary; validate each required export before narrowing it.
    return value as T;
}

async function loadCurrentAutomationAdmissionSources(): Promise<CurrentAutomationAdmissionSources> {
    const cliAutomationSourceRoot = "../../../../cli/src/plugins/runtime/automations/";
    const githubPluginSourceRoot = "../../../../../packages/plugins/scm-github/src/";
    const githubObservationSourceRoot = `${githubPluginSourceRoot}observations/`;
    const [
        executorModule,
        adoptedSetModule,
        observerModule,
        checkpointModule,
        contractsModule,
        eventsModule,
    ] = await Promise.all([
        import(/* @vite-ignore */ new URL(
            `${cliAutomationSourceRoot}automationEventActionExecutor.ts`,
            import.meta.url,
        ).href),
        import(/* @vite-ignore */ new URL(
            `${cliAutomationSourceRoot}automationEventAdoptedDefinitionSetHost.ts`,
            import.meta.url,
        ).href),
        import(/* @vite-ignore */ new URL(
            `${githubObservationSourceRoot}githubAutomationEventObserver.ts`,
            import.meta.url,
        ).href),
        import(/* @vite-ignore */ new URL(
            `${githubObservationSourceRoot}githubAutomationEventCheckpoint.ts`,
            import.meta.url,
        ).href),
        import(/* @vite-ignore */ new URL(
            `${githubObservationSourceRoot}githubProviderContracts.ts`,
            import.meta.url,
        ).href),
        import(/* @vite-ignore */ new URL(
            `${githubPluginSourceRoot}githubAutomationEvents.ts`,
            import.meta.url,
        ).href),
    ]);
    if (
        !isRecord(executorModule)
        || !isRecord(adoptedSetModule)
        || !isRecord(observerModule)
        || !isRecord(checkpointModule)
        || !isRecord(contractsModule)
        || !isRecord(eventsModule)
        || !isRecord(checkpointModule.GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD)
        || !isRecord(eventsModule.GITHUB_AUTOMATION_EVENT_LOCAL_IDS)
    ) {
        throw new Error("current Automation Event sources are unavailable");
    }
    const checkpointFields = checkpointModule.GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD;
    const eventLocalIds = eventsModule.GITHUB_AUTOMATION_EVENT_LOCAL_IDS;
    return {
        createEventActionExecutor: readRequiredFunction<
            CurrentAutomationAdmissionSources["createEventActionExecutor"]
        >(executorModule, "createAutomationEventActionExecutor"),
        createAdoptedDefinitionSet: readRequiredFunction<
            CurrentAutomationAdmissionSources["createAdoptedDefinitionSet"]
        >(adoptedSetModule, "createAutomationEventAdoptedDefinitionSetHostV1"),
        createGithubObserver: readRequiredFunction<
            CurrentAutomationAdmissionSources["createGithubObserver"]
        >(observerModule, "createGithubAutomationEventCheckpointedPullObserver"),
        createGithubCheckpointRowId: readRequiredFunction<
            CurrentAutomationAdmissionSources["createGithubCheckpointRowId"]
        >(checkpointModule, "createGithubAutomationEventCheckpointRowId"),
        createGithubCheckpointRow: readRequiredFunction<
            CurrentAutomationAdmissionSources["createGithubCheckpointRow"]
        >(checkpointModule, "createGithubAutomationEventCheckpointRowV1"),
        checkpointFields: {
            id: readRequiredString(checkpointFields, "id"),
            payload: readRequiredString(checkpointFields, "payload"),
        },
        github: {
            pluginId: readRequiredString(contractsModule, "GITHUB_PLUGIN_ID"),
            connectedAccountId: readRequiredString(contractsModule, "GITHUB_CONNECTED_ACCOUNT_ID"),
            eventId: readRequiredString(eventLocalIds, "push"),
            backgroundServiceId: readRequiredString(
                contractsModule,
                "GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID",
            ),
            sourceAttemptActionId: readRequiredString(
                contractsModule,
                "GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID",
            ),
            sourceContractVersion: readRequiredPositiveInteger(
                contractsModule,
                "GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION",
            ),
        },
    };
}

function createGithubCheckpointCollection(
    initialRows: readonly GithubCheckpointRow[],
    idField: string,
): Readonly<{
    collection: Readonly<{
        get(rowId: string): Promise<StoredGithubCheckpointRow | null>;
        query(request: Readonly<{ cursor?: string; limit?: number }>): Promise<Readonly<{
            rows: readonly StoredGithubCheckpointRow[];
            nextCursor?: string;
            changeCursor: number;
        }>>;
        put(
            value: GithubCheckpointRow,
            options: Readonly<{ expectedRevision: number | "absent" }>,
        ): Promise<StoredGithubCheckpointRow>;
        delete(
            rowId: string,
            options: Readonly<{ expectedRevision: number }>,
        ): Promise<Readonly<{ rowId: string; revision: number; deleted: true }>>;
    }>;
    read(rowId: string): StoredGithubCheckpointRow | null;
}> {
    const rows = new Map<string, StoredGithubCheckpointRow>();
    for (const value of initialRows) {
        const rowId = value[idField];
        if (typeof rowId !== "string") throw new Error("GitHub checkpoint fixture row has no id");
        rows.set(rowId, { rowId, revision: 1, value: structuredClone(value) });
    }

    const collection = {
        async get(rowId: string) {
            const row = rows.get(rowId);
            return row === undefined ? null : structuredClone(row);
        },
        async query(request: Readonly<{ cursor?: string; limit?: number }>) {
            const ordered = [...rows.values()].sort((left, right) => left.rowId.localeCompare(right.rowId));
            const available = request.cursor === undefined
                ? ordered
                : ordered.filter((row) => row.rowId > request.cursor!);
            const pageRows = available.slice(0, request.limit ?? 50);
            const lastRowId = pageRows.at(-1)?.rowId;
            return {
                rows: pageRows.map((row) => structuredClone(row)),
                ...(lastRowId !== undefined && available.length > pageRows.length
                    ? { nextCursor: lastRowId }
                    : {}),
                changeCursor: 0,
            };
        },
        async put(
            value: GithubCheckpointRow,
            options: Readonly<{ expectedRevision: number | "absent" }>,
        ) {
            const rowId = value[idField];
            if (typeof rowId !== "string") throw new Error("GitHub checkpoint fixture row has no id");
            const current = rows.get(rowId);
            const expectedMatches = options.expectedRevision === "absent"
                ? current === undefined
                : current?.revision === options.expectedRevision;
            if (!expectedMatches) throw new Error("github checkpoint CAS conflict");
            const row = {
                rowId,
                revision: (current?.revision ?? 0) + 1,
                value: structuredClone(value),
            } satisfies StoredGithubCheckpointRow;
            rows.set(rowId, row);
            return structuredClone(row);
        },
        async delete(rowId: string, options: Readonly<{ expectedRevision: number }>) {
            const current = rows.get(rowId);
            if (current === undefined || current.revision !== options.expectedRevision) {
                throw new Error("github checkpoint delete CAS conflict");
            }
            rows.delete(rowId);
            return { rowId, revision: current.revision + 1, deleted: true as const };
        },
    };

    return {
        collection,
        read(rowId) {
            const row = rows.get(rowId);
            return row === undefined ? null : structuredClone(row);
        },
    };
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
        signatureBase64Url: "",
    };
    const signature = tweetnacl.sign.detached(
        createPluginInstallationManifestPublisherSigningInputV1({
            proof: {
                v: proof.v,
                alg: proof.alg,
                machineId: proof.machineId,
                installationId: proof.installationId,
                issuedAt: proof.issuedAt,
                nonce: proof.nonce,
                method: proof.method,
                path: proof.path,
                bodySha256Base64Url: proof.bodySha256Base64Url,
            },
        }),
        params.keyPair.secretKey,
    );
    return Buffer.from(JSON.stringify({
        proof: {
            ...proof,
            signatureBase64Url: Buffer.from(signature).toString("base64url"),
        },
    }), "utf8").toString("base64url");
}

function releaseFacts(params: Readonly<{
    archiveDigestSha256?: string;
    payloadSchema?: PluginJsonSchemaV2;
    sourceContractVersion?: number;
    supportedObservationTransports?: readonly ("checkpointedPull" | "durablePush")[];
    version?: string;
}> = {}) {
    const version = params.version ?? PLUGIN_VERSION;
    const sourceContractVersion = params.sourceContractVersion ?? 1;
    const supportedObservationTransports = params.supportedObservationTransports
        ?? ["checkpointedPull"];
    const supportsDurablePush = supportedObservationTransports.includes("durablePush");
    const sourceConfigSchema = { type: "object", additionalProperties: false } as const;
    return normalizePluginReleaseFactsV1({
        ref: { pluginId: PLUGIN_ID, version },
        archiveDigestSha256: params.archiveDigestSha256 ?? `sha256:${"a".repeat(64)}`,
        normalizedManifest: {
            schemaVersion: 2,
            id: PLUGIN_ID,
            version,
            displayName: "Automation Event admission fixture",
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
                    inputSchema: sourceConfigSchema,
                    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(
                        sourceContractVersion,
                        sourceConfigSchema,
                    ),
                }, ...(supportsDurablePush ? [{
                    id: "receive-repository-events",
                    title: "Receive repository events",
                    scopes: ["global"],
                    surfaces: ["plugin"],
                    dangerLevel: "safe",
                    execution: { target: "daemon" },
                }] : [])],
                events: [{
                    id: EVENT_LOCAL_ID,
                    kind: "event",
                    title: "Repository event",
                    payloadSchema: params.payloadSchema ?? EVENT_PAYLOAD_SCHEMA,
                    automation: {
                        v: 1,
                        eligible: true,
                        source: {
                            sourceContractVersion,
                            supportedObservationTransports,
                            ...(supportsDurablePush ? {
                                webhookContributionRef: {
                                    pluginId: PLUGIN_ID,
                                    localId: "repository-events",
                                },
                            } : {}),
                            sourceConfigSchema,
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

function githubReleaseFacts(params: Readonly<{
    eventId: string;
    pluginId: string;
    sourceContractVersion: number;
}>) {
    return normalizePluginReleaseFactsV1({
        ref: { pluginId: params.pluginId, version: PLUGIN_VERSION },
        archiveDigestSha256: `sha256:${"c".repeat(64)}`,
        normalizedManifest: {
            schemaVersion: 2,
            id: params.pluginId,
            version: PLUGIN_VERSION,
            displayName: "GitHub checkpointed-pull admission fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: "./dist/index.js" },
            contributes: {
                actions: [{
                    id: SETUP_ACTION_LOCAL_ID,
                    title: "Set up GitHub repository source",
                    scopes: ["global"],
                    surfaces: ["plugin"],
                    dangerLevel: "safe",
                    execution: { target: "daemon" },
                    inputSchema: GITHUB_SOURCE_CONFIG_SCHEMA,
                    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(
                        params.sourceContractVersion,
                        GITHUB_SOURCE_CONFIG_SCHEMA,
                    ),
                }],
                events: [{
                    id: params.eventId,
                    kind: "event",
                    title: "GitHub repository Event",
                    payloadSchema: GITHUB_EVENT_PAYLOAD_SCHEMA,
                    automation: {
                        v: 1,
                        eligible: true,
                        source: {
                            sourceContractVersion: params.sourceContractVersion,
                            supportedObservationTransports: ["checkpointedPull"],
                            sourceConfigSchema: GITHUB_SOURCE_CONFIG_SCHEMA,
                            setupActionRef: { pluginId: params.pluginId, localId: SETUP_ACTION_LOCAL_ID },
                        },
                    },
                }],
                webhooks: [],
            },
        },
        collectionContracts: [],
        uiSlots: [],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"e".repeat(64)}`,
            resources: [],
        },
    });
}

function strictEventDefinitionRecipe(params: Readonly<{
    prompt: string;
    templateVersion?: number;
}>): string {
    const serialized = serializeAutomationStoredDefinitionExecutionRecipeV1({
        v: 1,
        templateVersion: params.templateVersion ?? 1,
        template: { t: "plain", v: { v: 1, prompt: params.prompt } },
        // A Definition carries no occurrence evidence. Admission freezes the
        // authoritative Event occurrence into the Run-owned recipe.
        triggerEvidence: null,
        target: eventAdmissionSpawnTarget(),
    });
    if (serialized.kind !== "available") {
        throw new Error("Event admission fixture must use a valid strict recipe");
    }
    return serialized.serialized;
}

function strictExecutionRunEventDefinitionRecipe(params: Readonly<{
    prompt: string;
    templateVersion?: number;
}>): string {
    const serialized = serializeAutomationStoredDefinitionExecutionRecipeV1({
        v: 1,
        templateVersion: params.templateVersion ?? 1,
        template: { t: "plain", v: { v: 1, prompt: params.prompt } },
        triggerEvidence: null,
        target: {
            kind: "executionRun",
            request: {
                intent: "task",
                backendTarget: { kind: "builtInAgent", agentId: "codex" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
            },
        },
    });
    if (serialized.kind !== "available") {
        throw new Error("Event admission fixture must use a valid execution Run recipe");
    }
    return serialized.serialized;
}

function encryptedStrictEventDefinitionRecipe(params: Readonly<{
    snapshot: ReturnType<typeof createAccountScopedCryptoMaterialSnapshotV1>;
    prompt: string;
    templateVersion?: number;
}>): string {
    const serialized = serializeAutomationStoredDefinitionExecutionRecipeV1({
        v: 1,
        templateVersion: params.templateVersion ?? 1,
        template: {
            t: "encrypted",
            c: sealAccountScopedBlobCiphertext({
                kind: "automation_template_payload",
                material: params.snapshot.material,
                payload: { v: 1, prompt: params.prompt },
                randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 31),
            }),
        },
        triggerEvidence: null,
        target: eventAdmissionSpawnTarget(),
    });
    if (serialized.kind !== "available") {
        throw new Error("Encrypted Event admission fixture must use a valid strict recipe");
    }
    return serialized.serialized;
}

function eventAdmissionSpawnTarget() {
    return {
        kind: "newSession" as const,
        spawn: {
            executionTarget: { serverId: "server-event-admission", machineId: MACHINE_ID },
            directory: "/tmp/event-admission",
            agentTarget: {
                kind: "agent" as const,
                identity: { pluginId: "happier.agent.codex", localId: "codex" },
            },
        },
    };
}

const EVENT_ADMISSION_SOURCE_INSTANCE_ID = "repository-happier-example";
const CAPACITY_SEED_PROMPT = "frozen capacity seed";

function capacityPluginEventOccurrenceEvidence(params: Readonly<{
    occurrenceId: string;
    sourceSelectorId?: AutomationSourceSelectorIdV1;
}>) {
    return buildAutomationPluginEventOccurrenceEvidenceV1({
        eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
        sourceSelectorId: params.sourceSelectorId ?? SOURCE_SELECTOR_ID,
        occurrenceId: params.occurrenceId,
        occurredAt: 1_723_247_200_000,
        payload: { action: "opened" },
    });
}

/** Freezes the current strict definition recipe into a truthful queued Run input. */
function frozenPluginEventRunExecutionInput(params: Readonly<{
    evidence: ReturnType<typeof capacityPluginEventOccurrenceEvidence>;
    prompt?: string;
}>): string {
    const frozen = freezeAutomationRunPluginEventExecutionRecipeV1({
        definitionRecipe: strictEventDefinitionRecipe({
            prompt: params.prompt ?? CAPACITY_SEED_PROMPT,
        }),
        templateVersion: 1,
        triggerEvidence: {
            t: "plain" as const,
            v: {
                ...params.evidence,
                sourceInstanceId: EVENT_ADMISSION_SOURCE_INSTANCE_ID,
                sourceContractVersion: 1,
                observationReceivedAt: 1_723_247_201_000,
                filter: { version: null, result: "matched" as const },
            },
        },
        assignmentMachineIds: [],
    });
    if (frozen.kind !== "available") {
        throw new Error("capacity seed must freeze a valid strict recipe");
    }
    return frozen.serialized;
}

/** One truthful claimable/capacity pluginEvent Run row that satisfies the physical CHECK arms. */
function pluginEventCapacityRunSeed(params: Readonly<{
    id: string;
    automationId: string;
    triggerId: string;
    sourceSelectorId: AutomationSourceSelectorIdV1;
    occurrenceId: string;
    scheduledAt: Date;
    dueAt: Date;
    prompt?: string;
}>) {
    const evidence = capacityPluginEventOccurrenceEvidence({
        occurrenceId: params.occurrenceId,
        sourceSelectorId: params.sourceSelectorId,
    });
    return {
        id: params.id,
        automationId: params.automationId,
        accountId: ACCOUNT_ID,
        state: "queued" as const,
        triggerId: params.triggerId,
        causeKind: "trigger" as const,
        causeTriggerKind: "pluginEvent" as const,
        causeTriggerRevision: 1,
        causeEventPluginId: PLUGIN_ID,
        causeEventLocalId: EVENT_LOCAL_ID,
        causeOccurredAt: new Date(evidence.occurredAt),
        occurrenceKey: deriveAutomationOccurrenceKeyV1({
            triggerId: AutomationTriggerIdSchema.parse(params.triggerId),
            evidence,
        }),
        causeSourceSelectorId: params.sourceSelectorId,
        triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: evidence }),
        executionInputEnvelope: frozenPluginEventRunExecutionInput({
            evidence,
            prompt: params.prompt,
        }),
        scheduledAt: params.scheduledAt,
        dueAt: params.dueAt,
    };
}

function frozenConversationRunExecutionInput(params: Readonly<{
    evidence: Readonly<{
        v: 1;
        kind: "conversation";
        bindingId: string;
        occurrenceId: string;
        occurredAt: number;
        caller: Readonly<{ pluginId: string; contributionLocalId: string; machineId: string }>;
        input: PluginJsonValueV2;
        replyContextIdentity: string;
    }>;
    prompt?: string;
}>): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: { t: "plain", v: { v: 1, prompt: params.prompt ?? CAPACITY_SEED_PROMPT } },
        triggerEvidence: {
            t: "plain" as const,
            v: { ...params.evidence, observationReceivedAt: params.evidence.occurredAt },
        },
        target: eventAdmissionSpawnTarget(),
        assignmentMachineIds: [],
    });
    if (serialized.kind !== "available") {
        throw new Error("conversation capacity seed must freeze a valid strict recipe");
    }
    return serialized.serialized;
}

function frozenE2eeRunExecutionInput(params: Readonly<{
    definitionRecipe: string;
    triggerEvidenceEnvelope: unknown;
}>): string {
    const frozen = freezeAutomationRunPluginEventExecutionRecipeV1({
        definitionRecipe: params.definitionRecipe,
        templateVersion: 1,
        triggerEvidence: params.triggerEvidenceEnvelope,
        assignmentMachineIds: [],
    });
    if (frozen.kind !== "available") {
        throw new Error("E2EE rejoin seed must freeze a valid strict recipe");
    }
    return frozen.serialized;
}

function triggerDefinitionEnvelope(params: Readonly<{
    automationId?: string;
    triggerId?: string;
    triggerRevision?: number;
    filter?: PluginJsonValueV2;
    maximumObservationAgeMs?: number | null;
    sourceSelectorId?: AutomationSourceSelectorIdV1;
    sourceInstanceId?: string;
    webhookRoutingSourceInstanceId?: string;
}> = {}): string {
    return JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: "plain",
        binding: {
            v: 1,
            automationId: params.automationId ?? AUTOMATION_ID,
            triggerId: AutomationTriggerIdSchema.parse(params.triggerId ?? TRIGGER_ID),
            triggerRevision: params.triggerRevision ?? 1,
            triggerKind: "pluginEvent",
            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            sourceSelectorId: params.sourceSelectorId ?? SOURCE_SELECTOR_ID,
        },
        definition: {
            v: 1,
            sourceInstanceId: params.sourceInstanceId ?? "repository-happier-example",
            ...(params.webhookRoutingSourceInstanceId === undefined
                ? {}
                : { webhookRoutingSourceInstanceId: params.webhookRoutingSourceInstanceId }),
            sourceConfig: {},
            displayLabel: "Repository happier/example",
            filter: params.filter ?? null,
            maximumObservationAgeMs: params.maximumObservationAgeMs ?? null,
        },
    }));
}

function githubTriggerDefinitionEnvelope(
    github: CurrentAutomationAdmissionSources["github"],
    params: Readonly<{
        automationId?: string;
        triggerId?: string;
        triggerRevision?: number;
        sourceSelectorId?: AutomationSourceSelectorIdV1;
    }> = {},
): string {
    return JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: "plain",
        binding: {
            v: 1,
            automationId: params.automationId ?? AUTOMATION_ID,
            triggerId: AutomationTriggerIdSchema.parse(params.triggerId ?? TRIGGER_ID),
            triggerRevision: params.triggerRevision ?? 1,
            triggerKind: "pluginEvent",
            eventRef: {
                pluginId: github.pluginId,
                localId: github.eventId,
            },
            sourceSelectorId: params.sourceSelectorId ?? GITHUB_AUTOMATION_SOURCE_SELECTOR_ID,
        },
        definition: {
            v: 1,
            sourceInstanceId: GITHUB_SOURCE_INSTANCE_ID,
            sourceConfig: {
                v: 1,
                credentialRef: {
                    service: { pluginId: github.pluginId, localId: github.connectedAccountId },
                    accountId: "github-composed-admission-account",
                },
                repository: {
                    v: 1,
                    repositoryId: "77",
                    owner: "acme",
                    name: "widgets",
                    nameWithOwner: "acme/widgets",
                },
            },
            displayLabel: "GitHub acme/widgets",
            filter: null,
            maximumObservationAgeMs: null,
        },
    }));
}

function input(params: Readonly<{
    occurrenceId?: string;
    occurredAt?: number;
    triggerRevision?: number;
    payload?: PluginJsonValueV2;
}> = {}) {
    return {
        eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
        occurrenceId: params.occurrenceId ?? "delivery-1",
        occurredAt: params.occurredAt ?? 1_723_247_200_000,
        observationReceivedAt: 1_723_247_201_000,
        payload: params.payload ?? { action: "opened" },
        definitions: [{
            automationId: AUTOMATION_ID,
            triggerId: TRIGGER_ID,
            triggerRevision: params.triggerRevision ?? 1,
            sourceSelectorId: SOURCE_SELECTOR_ID,
        }],
    };
}

async function plainHostEvidence() {
    const account = await db.account.findUniqueOrThrow({
        where: { id: ACCOUNT_ID },
        select: { seq: true },
    });
    return {
        v: 1,
        t: "plain" as const,
        accountCurrentness: {
            mode: "plain" as const,
            version: account.seq,
            contentKeyFingerprint: null,
        },
    };
}

async function admitAutomationEventV1Raw(params: Readonly<{
    accountId: string;
    caller: Parameters<typeof admitAutomationEventV1Impl>[0]["caller"];
    input: unknown;
    hostEvidence?: unknown;
}>) {
    const hostEvidence = AutomationEventAdmitHostEvidenceV1Schema.parse(
        params.hostEvidence ?? await plainHostEvidence(),
    );
    const response = await admitAutomationEventV1Impl({
        accountId: params.accountId,
        caller: params.caller,
        request: hostEvidence.t === "encrypted"
            ? {
                v: 1,
                caller: {
                    pluginId: params.caller.pluginId,
                    immutableGenerationId: params.caller.immutableGenerationId,
                    materialization: {
                        pluginId: params.caller.pluginId,
                        machineId: params.caller.machineId,
                        materializationId: params.caller.materializationId,
                    },
                },
                hostEvidence,
            }
            : {
                v: 1,
                caller: {
                    pluginId: params.caller.pluginId,
                    immutableGenerationId: params.caller.immutableGenerationId,
                    materialization: {
                        pluginId: params.caller.pluginId,
                        machineId: params.caller.machineId,
                        materializationId: params.caller.materializationId,
                    },
                },
                input: params.input,
                hostEvidence,
            },
    });
    return response;
}

async function admitAutomationEventV1(params: Parameters<typeof admitAutomationEventV1Raw>[0]) {
    const response = await admitAutomationEventV1Raw(params);
    return { results: response.results };
}

async function configureE2eeAccount() {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    const contentKeyBinding = Buffer.concat([
        Buffer.from("Happy content key v1\u0000", "utf8"),
        Buffer.from(content.publicKey),
    ]);
    await db.account.update({
        where: { id: ACCOUNT_ID },
        data: {
            encryptionMode: "e2ee",
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
            contentPublicKey: new Uint8Array(content.publicKey),
            contentPublicKeySig: new Uint8Array(
                tweetnacl.sign.detached(contentKeyBinding, signing.secretKey),
            ),
        },
    });
    const account = await db.account.findUniqueOrThrow({
        where: { id: ACCOUNT_ID },
        select: { seq: true },
    });
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
        accountEncryptionMode: "e2ee",
        material: { type: "dataKey", machineKey: content.secretKey },
        dataKeyPublicKey: content.publicKey,
    });
    return {
        snapshot,
        accountCurrentness: {
            mode: "e2ee" as const,
            version: account.seq,
            contentKeyFingerprint:
                convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                    snapshot.contentPublicKeyFingerprint,
                ),
        },
    };
}

function encryptedHostEvidence(params: Readonly<{
    adoptedRevision?: string;
    eventDeclarationRelease?: AutomationEventDeclarationReleaseV1;
    event: unknown;
    snapshot: ReturnType<typeof createAccountScopedCryptoMaterialSnapshotV1>;
    accountCurrentness: Readonly<{
        mode: "e2ee";
        version: number;
        contentKeyFingerprint: string;
    }>;
}>) {
    const event = AutomationEventAdmitInputV1Schema.parse(params.event);
    const hostEvidence = {
        v: 1,
        t: "encrypted" as const,
        accountCurrentness: params.accountCurrentness,
        adoptedRevision: params.adoptedRevision ?? "0",
        eventRef: event.eventRef,
        eventDeclarationRelease: params.eventDeclarationRelease ?? {
            release: { pluginId: event.eventRef.pluginId, version: PLUGIN_VERSION },
            archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        },
        definitions: event.definitions.map((definition) => {
            const evidence = buildAutomationPluginEventOccurrenceEvidenceV1({
                eventRef: event.eventRef,
                sourceSelectorId: definition.sourceSelectorId,
                occurrenceId: event.occurrenceId,
                occurredAt: event.occurredAt,
                payload: event.payload,
            });
            const base = {
                automationId: definition.automationId,
                triggerId: definition.triggerId,
                triggerRevision: definition.triggerRevision,
                sourceSelectorId: definition.sourceSelectorId,
                sourceContractVersion: 1,
                observationTransport: "checkpointedPull" as const,
                occurrenceKey: deriveAutomationOccurrenceKeyV1({
                    triggerId: definition.triggerId,
                    evidence,
                }),
                occurredAt: event.occurredAt,
                triggerEvidenceEnvelope: sealAutomationOccurrenceTriggerEvidenceEnvelopeV1({
                    material: params.snapshot.material,
                    evidence,
                    randomBytes: (length) => Uint8Array.from(
                        { length },
                        (_, index) => index + 1,
                    ),
                }),
                occurrenceEvidenceEqualityTag:
                    deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1({
                        material: params.snapshot.material,
                        accountId: ACCOUNT_ID,
                        automationId: definition.automationId,
                        triggerId: definition.triggerId,
                        evidence,
                    }),
            };
            const triggerEvidence = sealAutomationRunTriggerEvidenceEnvelopeV1({
                material: params.snapshot.material,
                evidence: {
                    ...evidence,
                    sourceInstanceId: "repository-happier-example",
                    sourceContractVersion: 1,
                    observationReceivedAt: event.observationReceivedAt,
                    filter: { version: null, result: "matched" as const },
                },
                randomBytes: (length) => Uint8Array.from(
                    { length },
                    (_, index) => index + 17,
                ),
            });
            return {
                ...base,
                triggerEvidenceEnvelope: triggerEvidence,
                outcome: { kind: "matched" as const },
            };
        }),
    };
    return AutomationEventAdmitEncryptedHostEvidenceV1Schema.parse(hostEvidence);
}

describe("Automation Event admission", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-event-admission-",
            initAuth: false,
            env: { HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID },
        });
    }, 120_000);

    afterAll(async () => await harness?.close());

    afterEach(async () => {
        vi.restoreAllMocks();
        harness?.resetEnv();
        await harness?.resetDbTables([
            () => db.accountChange.deleteMany(),
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

    async function seed(params: Readonly<{
        filter?: PluginJsonValueV2;
        maximumObservationAgeMs?: number | null;
        supportedObservationTransports?: readonly ("checkpointedPull" | "durablePush")[];
    }> = {}): Promise<void> {
        const release = releaseFacts({
            supportedObservationTransports: params.supportedObservationTransports,
        });
        await db.account.create({
            data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" },
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
                name: "Handle repository events",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: strictEventDefinitionRecipe({ prompt: "frozen v1" }),
                templateVersion: 1,
                triggers: {
                    create: {
                        id: TRIGGER_ID,
                        kind: "pluginEvent",
                        enabled: true,
                        revision: 1,
                        eventPluginId: PLUGIN_ID,
                        eventLocalId: EVENT_LOCAL_ID,
                        sourceSelectorId: SOURCE_SELECTOR_ID,
                        sourceContractVersion: 1,
                        observationTransport: "checkpointedPull",
                        watcherMachineId: MACHINE_ID,
                        watcherMachineInstallationId: MACHINE_INSTALLATION_ID,
                        watcherPluginId: PLUGIN_ID,
                        watcherMaterializationId: MATERIALIZATION_ID,
                        definitionEnvelope: triggerDefinitionEnvelope(params),
                    },
                },
            },
        });
        // Assignment-liveness: an enabled Automation must keep one enabled
        // execution assignment or canonical admission refuses every occurrence.
        await db.automationAssignment.create({
            data: { automationId: AUTOMATION_ID, machineId: MACHINE_ID, enabled: true },
        });
    }

    async function seedGithubCheckpointedPull(params: Readonly<{
        github: CurrentAutomationAdmissionSources["github"];
        keyPair: tweetnacl.SignKeyPair;
    }>): Promise<void> {
        await seed();
        const release = githubReleaseFacts({
            pluginId: params.github.pluginId,
            eventId: params.github.eventId,
            sourceContractVersion: params.github.sourceContractVersion,
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: params.github.pluginId,
                desiredVersion: PLUGIN_VERSION,
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: params.github.pluginId,
                version: PLUGIN_VERSION,
                archiveDigestSha256: release.archiveDigestSha256,
                normalizedManifest: release.normalizedManifest,
                collectionContracts: [],
                uiSlots: [],
                packageAssetArchive: release.packageAssetArchive,
            },
        });
        await db.machine.update({
            where: { accountId_id: { accountId: ACCOUNT_ID, id: MACHINE_ID } },
            data: { installationPublicKey: new Uint8Array(params.keyPair.publicKey) },
        });
        await db.pluginMachineMaterialization.update({
            where: {
                machineId_materializationId: {
                    machineId: MACHINE_ID,
                    materializationId: MATERIALIZATION_ID,
                },
            },
            data: {
                pluginId: params.github.pluginId,
                version: PLUGIN_VERSION,
                archiveDigestSha256: release.archiveDigestSha256,
            },
        });
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: {
                name: "Handle GitHub repository Events",
            },
        });
        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: {
                eventPluginId: params.github.pluginId,
                eventLocalId: params.github.eventId,
                sourceSelectorId: GITHUB_AUTOMATION_SOURCE_SELECTOR_ID,
                sourceContractVersion: params.github.sourceContractVersion,
                watcherPluginId: params.github.pluginId,
                definitionEnvelope: githubTriggerDefinitionEnvelope(params.github),
            },
        });
    }

    async function seedGithubBoundedAdmissionDefinitions(params: Readonly<{
        github: CurrentAutomationAdmissionSources["github"];
        keyPair: tweetnacl.SignKeyPair;
    }>): Promise<ReadonlyArray<Readonly<{
        automationId: string;
        triggerId: string;
        triggerRevision: number;
        sourceSelectorId: AutomationSourceSelectorIdV1;
    }>>> {
        await seedGithubCheckpointedPull(params);
        for (let index = 1; index < 31; index += 1) {
            const automationId = `${AUTOMATION_ID}-bounded-${String(index).padStart(2, "0")}`;
            const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
                `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            );
            await db.automation.create({
                data: {
                    id: automationId,
                    accountId: ACCOUNT_ID,
                    name: `Handle GitHub repository Event ${index}`,
                    enabled: true,
                    targetType: "new_session",
                    templateCiphertext: strictEventDefinitionRecipe({ prompt: `bounded ${index}` }),
                    templateVersion: 1,
                    triggers: { create: {
                        id: `${automationId}-trigger`,
                        kind: "pluginEvent",
                        enabled: true,
                        revision: 1,
                        eventPluginId: params.github.pluginId,
                        eventLocalId: params.github.eventId,
                        sourceSelectorId,
                        sourceContractVersion: params.github.sourceContractVersion,
                        observationTransport: "checkpointedPull",
                        watcherMachineId: MACHINE_ID,
                        watcherMachineInstallationId: MACHINE_INSTALLATION_ID,
                        watcherPluginId: params.github.pluginId,
                        watcherMaterializationId: MATERIALIZATION_ID,
                        definitionEnvelope: githubTriggerDefinitionEnvelope(params.github, {
                            automationId,
                            triggerId: `${automationId}-trigger`,
                            sourceSelectorId,
                        }),
                    } },
                },
            });
            await db.automationAssignment.create({
                data: { automationId, machineId: MACHINE_ID, enabled: true },
            });
        }
        const triggers = await db.automationTrigger.findMany({
            where: {
                automation: { accountId: ACCOUNT_ID },
                eventPluginId: params.github.pluginId,
                eventLocalId: params.github.eventId,
            },
            select: {
                id: true,
                automationId: true,
                revision: true,
                sourceSelectorId: true,
            },
            orderBy: { id: "asc" },
        });
        return triggers.map((trigger) => {
            if (trigger.sourceSelectorId === null) {
                throw new Error("bounded Event admission fixture lost its source selector");
            }
            return {
                automationId: trigger.automationId,
                triggerId: trigger.id,
                triggerRevision: trigger.revision,
                sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(
                    trigger.sourceSelectorId,
                ),
            };
        });
    }

    async function executeGithubBoundedAdmission(params: Readonly<{
        sources: CurrentAutomationAdmissionSources;
        keyPair: tweetnacl.SignKeyPair;
        definitions: ReadonlyArray<Readonly<{
            automationId: string;
            triggerId: string;
            triggerRevision: number;
            sourceSelectorId: AutomationSourceSelectorIdV1;
        }>>;
        beforeFirstAdmit?: () => Promise<void>;
        afterFirstAdmit?: () => Promise<void>;
    }>) {
        const { github } = params.sources;
        const githubMaterialization = {
            pluginId: github.pluginId,
            machineId: MACHINE_ID,
            materializationId: MATERIALIZATION_ID,
        } as const;
        const githubActionCaller = {
            kind: "plugin" as const,
            pluginId: github.pluginId,
            contributionLocalId: github.backgroundServiceId,
            immutableGenerationId: GITHUB_IMMUTABLE_GENERATION_ID,
            materialization: githubMaterialization,
        };
        const credentials = {
            token: "bounded-automation-event-token",
            encryption: { type: "legacy" as const, secret: new Uint8Array(32).fill(8) },
        };
        const revalidateCallerMaterialization = async (candidate: Readonly<{
            pluginId: string;
            machineId: string;
            materializationId: string;
        }>) => (
            candidate.pluginId === githubMaterialization.pluginId
            && candidate.machineId === githubMaterialization.machineId
            && candidate.materializationId === githubMaterialization.materializationId
        );
        const readAccountCurrentness = async (): Promise<AccountEncryptionCurrentnessResponse> => {
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
                        keyPair: params.keyPair,
                        path,
                    }),
                },
                payload: body,
            });
            const adoptedSet = params.sources.createAdoptedDefinitionSet({
                credentials,
                caller: githubMaterialization,
                immutableGenerationId: GITHUB_IMMUTABLE_GENERATION_ID,
                transport: { kind: "checkpointedPull" },
                generationSignal: new AbortController().signal,
                isGenerationCurrent: () => true,
                revalidateCallerMaterialization,
                revalidateCallerImmutableGeneration: async () => true,
                readStoredDefinitions: async (request: DynamicRecord) => {
                    if (
                        !isRecord(request.caller)
                        || typeof request.caller.immutableGenerationId !== "string"
                        || !isRecord(request.caller.materialization)
                        || !isRecord(request.input)
                    ) {
                        throw new Error("stored Event definition request is incompatible");
                    }
                    const body = AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse({
                        v: 1,
                        caller: {
                            pluginId: request.caller.pluginId,
                            immutableGenerationId: request.caller.immutableGenerationId,
                            materialization: request.caller.materialization,
                        },
                        input: request.input,
                    });
                    const response = await injectSigned(
                        AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
                        body,
                    );
                    if (response.statusCode !== 200) {
                        throw new Error(`stored Event definition route failed: ${response.statusCode}`);
                    }
                    return response.json();
                },
                resolveAccountEncryptionCurrentness: readAccountCurrentness,
                resolveAccountEncryptionMaterial: async () => null,
            });
            await expect(adoptedSet.refresh()).resolves.toEqual({ kind: "adopted", revision: "0" });

            const witnessVersions: number[] = [];
            const continuations: unknown[] = [];
            let admitRouteCalls = 0;
            let beforeFirstAdmitPending = true;
            const transport = {
                async execute(actionId: unknown, request: unknown): Promise<unknown> {
                    if (actionId !== "automation.event.admit") {
                        throw new Error(`unexpected bounded Event transport action: ${String(actionId)}`);
                    }
                    const body = AutomationEventActionHttpRequestSchemasV1[actionId].parse(request);
                    if (!("input" in body)) {
                        throw new Error("bounded GitHub fixture expected a plain admission request");
                    }
                    witnessVersions.push(body.hostEvidence.accountCurrentness.version);
                    if (beforeFirstAdmitPending) {
                        beforeFirstAdmitPending = false;
                        await params.beforeFirstAdmit?.();
                    }
                    const response = await injectSigned(AutomationEventActionHttpPathsV1[actionId], body);
                    if (response.statusCode !== 200) {
                        throw new Error(`Automation Event route failed: ${response.statusCode}`);
                    }
                    admitRouteCalls += 1;
                    const result = AutomationEventAdmitHttpResultV1Schema.parse(response.json());
                    continuations.push(result.continuation);
                    if (admitRouteCalls === 1) await params.afterFirstAdmit?.();
                    return result;
                },
            };
            const executor = params.sources.createEventActionExecutor({
                credentials,
                transport,
                revalidateCallerMaterialization,
                revalidateCallerImmutableGeneration: async () => true,
                resolveAccountId: async () => ACCOUNT_ID,
                resolveAdoptedDefinitionSet: (
                    candidate: DynamicRecord,
                    immutableGenerationId: string,
                    transportKind: DynamicRecord,
                ) => (
                    transportKind.kind === "checkpointedPull"
                    && immutableGenerationId === GITHUB_IMMUTABLE_GENERATION_ID
                    && candidate.pluginId === githubMaterialization.pluginId
                    && candidate.machineId === githubMaterialization.machineId
                    && candidate.materializationId === githubMaterialization.materializationId
                        ? adoptedSet
                        : null
                ),
            });
            const result = AutomationEventAdmitResultV1Schema.parse(await executor({
                actionId: "automation.event.admit",
                input: {
                    eventRef: { pluginId: github.pluginId, localId: github.eventId },
                    occurrenceId: "github:repository:77:event:bounded",
                    occurredAt: 1_723_247_200_000,
                    observationReceivedAt: 1_723_247_201_000,
                    payload: { action: "opened" },
                    definitions: params.definitions,
                },
                caller: githubActionCaller,
            }));
            return { admitRouteCalls, continuations, result, witnessVersions };
        } finally {
            await app.close();
        }
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
        const route = await db.pluginWebhookRoute.create({
            data: {
                id: "route-automation-event-admission",
                opaqueRouteId: "opaque-automation-event-admission",
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
                sourceInstanceId: "repository-happier-example",
                ensureIdempotencyKey: "automation-event-admission-endpoint-key",
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
                id: "delivery-automation-event-admission",
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
                endpointSourceInstanceId: "repository-happier-example",
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
            deliveryId: "delivery-automation-event-admission",
            endpoint: {
                webhookEndpointId: endpoint.id,
                revision: endpoint.revision,
                webhookContribution: { pluginId: PLUGIN_ID, localId: "repository-events" },
                handlerActionLocalId: "receive-repository-events",
                sourceInstanceId: "repository-happier-example",
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

    it("rejoins committed durable-push evidence before mutable target checks while rejecting net-new retargeted work", async () => {
        await seed({ supportedObservationTransports: ["durablePush"] });
        const webhookInvocationReference = await seedCurrentDurablePushDelivery();
        await expect(inTx(async (tx) => await validateCurrentPluginWebhookInvocationReferenceTxV1({
            tx,
            accountId: ACCOUNT_ID,
            reference: webhookInvocationReference,
            serverIdentityId: SERVER_IDENTITY_ID,
        }))).resolves.toMatchObject({ kind: "ready" });
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
                definitionEnvelope: triggerDefinitionEnvelope({
                    sourceInstanceId: "repository-private-source",
                    webhookRoutingSourceInstanceId: "repository-happier-example",
                }),
            },
        });

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
        })).resolves.toEqual({
            results: [{ kind: "blocked", reason: "temporarilyUnavailable", checkpointSafe: false }],
        });
        await expect(db.automationRun.count()).resolves.toBe(0);

        const admitted = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
            hostEvidence: {
                ...await plainHostEvidence(),
                webhookInvocationReference,
            },
        });
        expect(admitted.results).toEqual([
            expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
        ]);
        const runId = (admitted.results[0] as { runId: string }).runId;

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
            hostEvidence: {
                ...await plainHostEvidence(),
                webhookInvocationReference,
            },
        })).resolves.toEqual({
            results: [{ kind: "rejoined", runId, checkpointSafe: true }],
        });

        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: {
                definitionEnvelope: triggerDefinitionEnvelope({
                    sourceInstanceId: "repository-other-source",
                    webhookRoutingSourceInstanceId: "routing-other-source",
                }),
            },
        });
        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
            hostEvidence: {
                ...await plainHostEvidence(),
                webhookInvocationReference,
            },
        })).resolves.toEqual({
            results: [{ kind: "rejoined", runId, checkpointSafe: true }],
        });
        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ occurrenceId: "retargeted-definition-net-new" }),
            hostEvidence: {
                ...await plainHostEvidence(),
                webhookInvocationReference,
            },
        })).resolves.toEqual({
            results: [{ kind: "refreshDefinition", reason: "observationTargetChanged", checkpointSafe: false }],
        });
        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: {
                definitionEnvelope: triggerDefinitionEnvelope({
                    sourceInstanceId: "repository-private-source",
                    webhookRoutingSourceInstanceId: "repository-happier-example",
                }),
            },
        });

        const nextCaller = {
            pluginId: PLUGIN_ID,
            machineId: "machine-automation-event-admission-retargeted",
            machineInstallationId: "installation-automation-event-admission-retargeted",
            materializationId: "materialization-automation-event-admission-retargeted",
        } as const;
        const durableRelease = releaseFacts({ supportedObservationTransports: ["durablePush"] });
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
            idempotencyKey: "retarget-automation-event-admission-0001",
            target: {
                materialization: {
                    machineId: nextCaller.machineId,
                    materializationId: nextCaller.materializationId,
                    pluginId: nextCaller.pluginId,
                },
                machineInstallationId: nextCaller.machineInstallationId,
                pluginVersion: PLUGIN_VERSION,
            },
        })).resolves.toMatchObject({ kind: "retargeted" });
        await expect(db.pluginWebhookDelivery.findUniqueOrThrow({
            where: { id: webhookInvocationReference.deliveryId },
            select: {
                endpointRevision: true,
                targetMachineId: true,
                targetMachineInstallationId: true,
                targetMaterializationId: true,
            },
        })).resolves.toEqual({
            endpointRevision: 1,
            targetMachineId: caller.machineId,
            targetMachineInstallationId: caller.machineInstallationId,
            targetMaterializationId: caller.materializationId,
        });

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
            hostEvidence: {
                ...await plainHostEvidence(),
                webhookInvocationReference,
            },
        })).resolves.toEqual({
            results: [{ kind: "rejoined", runId, checkpointSafe: true }],
        });
        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ occurrenceId: "retargeted-endpoint-net-new" }),
            hostEvidence: {
                ...await plainHostEvidence(),
                webhookInvocationReference,
            },
        })).resolves.toEqual({
            results: [{ kind: "refreshDefinition", reason: "observationTargetChanged", checkpointSafe: false }],
        });
        await expect(db.automationRun.count()).resolves.toBe(1);
    });

    it("skips a durable-push delivery received at the observation boundary before creating a Run", async () => {
        await seed({ supportedObservationTransports: ["durablePush"] });
        const webhookInvocationReference = await seedCurrentDurablePushDelivery();
        const boundary = 1_723_247_201_000;
        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: {
                observationTransport: "durablePush",
                webhookEndpointId: DURABLE_PUSH_ENDPOINT_ID,
                observationStartsAt: new Date(boundary),
                watcherMachineId: null,
                watcherMachineInstallationId: null,
                watcherPluginId: null,
                watcherMaterializationId: null,
                definitionEnvelope: triggerDefinitionEnvelope({
                    sourceInstanceId: "repository-private-source",
                    webhookRoutingSourceInstanceId: "repository-happier-example",
                }),
            },
        });

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
            hostEvidence: {
                ...await plainHostEvidence(),
                webhookInvocationReference,
            },
        })).resolves.toEqual({
            results: [{ kind: "skipped", reason: "beforeObservationStart", checkpointSafe: true }],
        });
        await expect(db.automationRun.count()).resolves.toBe(0);
    });

    it("freezes the recipe and assignments at admission while later edits affect only new occurrences", async () => {
        await seed();

        const admitted = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
        });
        expect(admitted.results).toEqual([
            expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
        ]);
        const runId = (admitted.results[0] as { runId: string }).runId;

        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: {
                templateVersion: 2,
                templateCiphertext: strictEventDefinitionRecipe({
                    prompt: "new mutable definition",
                    templateVersion: 2,
                }),
            },
        });
        await db.automationAssignment.create({
            data: { automationId: AUTOMATION_ID, machineId: MACHINE_ID, enabled: true },
        });

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
        })).resolves.toEqual({
            results: [{ kind: "rejoined", runId, checkpointSafe: true }],
        });

        const editedAdmission = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ occurrenceId: "delivery-after-recipe-edit" }),
        });
        expect(editedAdmission.results).toEqual([
            expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
        ]);
        const editedRunId = (editedAdmission.results[0] as { runId: string }).runId;

        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: {
                revision: 2,
                definitionEnvelope: triggerDefinitionEnvelope({ triggerRevision: 2 }),
            },
        });
        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ triggerRevision: 2 }),
        })).resolves.toEqual({
            results: [{ kind: "rejoined", runId, checkpointSafe: true }],
        });

        const runs = await db.automationRun.findMany({
            where: { accountId: ACCOUNT_ID },
            select: {
                id: true,
                triggerId: true,
                causeKind: true,
                causeTriggerKind: true,
                causeTriggerRevision: true,
                causeEventPluginId: true,
                causeEventLocalId: true,
                causeOccurredAt: true,
                occurrenceKey: true,
                executionInputEnvelope: true,
                triggerEvidenceEnvelope: true,
            },
        });
        const occurrenceEvidence = {
            v: 1,
            kind: "pluginEvent" as const,
            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            sourceSelectorId: SOURCE_SELECTOR_ID,
            occurrenceId: "delivery-1",
            occurredAt: 1_723_247_200_000,
            payload: { action: "opened" },
        };
        const frozenTriggerEvidence = {
            ...occurrenceEvidence,
            sourceInstanceId: "repository-happier-example",
            sourceContractVersion: 1,
            observationReceivedAt: 1_723_247_201_000,
            filter: { version: null, result: "matched" as const },
        };
        const expectedRecipe = serializeAutomationRunExecutionRecipeV1({
            v: 1,
            templateVersion: 1,
            template: { t: "plain", v: { v: 1, prompt: "frozen v1" } },
            triggerEvidence: { t: "plain", v: frozenTriggerEvidence },
            target: eventAdmissionSpawnTarget(),
            assignmentMachineIds: [],
        });
        expect(expectedRecipe.kind).toBe("available");
        if (expectedRecipe.kind !== "available") return;

        const editedOccurrenceEvidence = {
            ...occurrenceEvidence,
            occurrenceId: "delivery-after-recipe-edit",
        };
        const editedFrozenTriggerEvidence = {
            ...editedOccurrenceEvidence,
            sourceInstanceId: "repository-happier-example",
            sourceContractVersion: 1,
            observationReceivedAt: 1_723_247_201_000,
            filter: { version: null, result: "matched" as const },
        };
        const editedRecipe = serializeAutomationRunExecutionRecipeV1({
            v: 1,
            templateVersion: 2,
            template: { t: "plain", v: { v: 1, prompt: "new mutable definition" } },
            triggerEvidence: { t: "plain", v: editedFrozenTriggerEvidence },
            target: eventAdmissionSpawnTarget(),
            assignmentMachineIds: [MACHINE_ID],
        });
        if (editedRecipe.kind !== "available") {
            throw new Error("edited Event recipe fixture must be valid");
        }

        expect(runs).toHaveLength(2);
        expect(runs).toEqual(expect.arrayContaining([{
            id: runId,
            triggerId: TRIGGER_ID,
            causeKind: "trigger",
            causeTriggerKind: "pluginEvent",
            causeTriggerRevision: 1,
            causeEventPluginId: PLUGIN_ID,
            causeEventLocalId: EVENT_LOCAL_ID,
            causeOccurredAt: new Date(1_723_247_200_000),
            occurrenceKey: expect.any(String),
            executionInputEnvelope: expectedRecipe.serialized,
            triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: occurrenceEvidence }),
        }, {
            id: editedRunId,
            triggerId: TRIGGER_ID,
            causeKind: "trigger",
            causeTriggerKind: "pluginEvent",
            causeTriggerRevision: 1,
            causeEventPluginId: PLUGIN_ID,
            causeEventLocalId: EVENT_LOCAL_ID,
            causeOccurredAt: new Date(1_723_247_200_000),
            occurrenceKey: expect.any(String),
            executionInputEnvelope: editedRecipe.serialized,
            triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: editedOccurrenceEvidence }),
        }]));
        expect(await db.session.count({ where: { accountId: ACCOUNT_ID } })).toBe(0);
        expect(await db.automationRunEvent.count()).toBe(0);
    });

    it("keeps a corrupted zero-assignment Event occurrence retryable with its exact reason", async () => {
        await seed();
        await db.automationAssignment.deleteMany({ where: { automationId: AUTOMATION_ID } });

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ occurrenceId: "zero-assignment-retryable" }),
        })).resolves.toEqual({
            results: [{ kind: "blocked", reason: "noEnabledAssignment", checkpointSafe: false }],
        });
        await expect(db.automationRun.count({ where: { automationId: AUTOMATION_ID } })).resolves.toBe(0);
    });

    it("rejoins committed plain evidence before current definition retirement while rejecting net-new work", async () => {
        await seed();
        const originalInput = input({ occurrenceId: "plain-rejoin-before-retirement" });

        const admitted = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: originalInput,
        });
        expect(admitted.results).toEqual([
            expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
        ]);
        const runId = (admitted.results[0] as { runId: string }).runId;

        await setAutomationEnabled({
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
            enabled: false,
        });

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: originalInput,
        })).resolves.toEqual({
            results: [{ kind: "rejoined", runId, checkpointSafe: true }],
        });
        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ occurrenceId: "plain-net-new-after-retirement" }),
        })).resolves.toEqual({
            results: [{ kind: "skipped", reason: "definitionRetired", checkpointSafe: true }],
        });
        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
    });

    it("rejoins one concurrent matching Event occurrence after the unique race and conflicts on changed evidence", async () => {
        await seed();

        const concurrentInput = input();
        const hostEvidence = await plainHostEvidence();
        const [first, second] = await Promise.all([
            admitAutomationEventV1({
                accountId: ACCOUNT_ID,
                caller,
                input: concurrentInput,
                hostEvidence,
            }),
            admitAutomationEventV1({
                accountId: ACCOUNT_ID,
                caller,
                input: concurrentInput,
                hostEvidence,
            }),
        ]);

        const concurrentResults = [first.results[0]!, second.results[0]!];
        expect(concurrentResults.map((result) => result.kind).sort()).toEqual([
            "admitted",
            "rejoined",
        ]);
        expect(concurrentResults.every((result) => result.checkpointSafe)).toBe(true);
        const runIds = concurrentResults.flatMap((result) => (
            result.kind === "admitted" || result.kind === "rejoined" ? [result.runId] : []
        ));
        expect(new Set(runIds).size).toBe(1);
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ payload: { action: "closed" } }),
        })).resolves.toEqual({
            results: [{
                kind: "blocked",
                reason: "occurrenceConflict",
                checkpointSafe: false,
            }],
        });
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);
    });

    it("keeps two same-source triggers independent through replay, currentness, pause, and deletion", async () => {
        await seed();
        await db.automationTrigger.create({
            data: {
                id: SECOND_TRIGGER_ID,
                automationId: AUTOMATION_ID,
                kind: "pluginEvent",
                enabled: true,
                revision: 1,
                eventPluginId: PLUGIN_ID,
                eventLocalId: EVENT_LOCAL_ID,
                sourceSelectorId: SOURCE_SELECTOR_ID,
                sourceContractVersion: 1,
                observationTransport: "checkpointedPull",
                watcherMachineId: MACHINE_ID,
                watcherMachineInstallationId: MACHINE_INSTALLATION_ID,
                watcherPluginId: PLUGIN_ID,
                watcherMaterializationId: MATERIALIZATION_ID,
                definitionEnvelope: triggerDefinitionEnvelope({
                    triggerId: SECOND_TRIGGER_ID,
                    sourceSelectorId: SOURCE_SELECTOR_ID,
                }),
            },
        });

        const secondDefinition = {
            automationId: AUTOMATION_ID,
            triggerId: SECOND_TRIGGER_ID,
            triggerRevision: 1,
            sourceSelectorId: SOURCE_SELECTOR_ID,
        };
        const firstAdmission = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...input({ occurrenceId: "same-source-occurrence" }),
                definitions: [input().definitions[0]!, secondDefinition],
            },
        });
        expect(firstAdmission.results).toEqual([
            expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
            expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
        ]);
        const runIds = firstAdmission.results.flatMap((result) => (
            result.kind === "admitted" ? [result.runId] : []
        ));
        expect(new Set(runIds).size).toBe(2);
        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...input({ occurrenceId: "same-source-occurrence" }),
                definitions: [input().definitions[0]!, secondDefinition],
            },
        })).resolves.toEqual({
            results: [
                { kind: "rejoined", runId: runIds[0], checkpointSafe: true },
                { kind: "rejoined", runId: runIds[1], checkpointSafe: true },
            ],
        });
        const firstRunRows = await db.automationRun.findMany({
            where: { id: { in: runIds } },
            select: { automationId: true, triggerId: true, occurrenceKey: true, causeSourceSelectorId: true },
            orderBy: { triggerId: "asc" },
        });
        expect(firstRunRows).toEqual([
            {
                automationId: AUTOMATION_ID,
                triggerId: TRIGGER_ID,
                occurrenceKey: expect.any(String),
                causeSourceSelectorId: SOURCE_SELECTOR_ID,
            },
            {
                automationId: AUTOMATION_ID,
                triggerId: SECOND_TRIGGER_ID,
                occurrenceKey: expect.any(String),
                causeSourceSelectorId: SOURCE_SELECTOR_ID,
            },
        ]);
        expect(new Set(firstRunRows.map((run) => run.occurrenceKey)).size).toBe(2);

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...input({ occurrenceId: "stale-second-definition" }),
                definitions: [input().definitions[0]!, { ...secondDefinition, triggerRevision: 0 }],
            },
        })).resolves.toEqual({
            results: [
                expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
                { kind: "refreshDefinition", reason: "definitionStale", checkpointSafe: false },
            ],
        });
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(3);

        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: { enabled: false },
        });
        const afterPause = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...input({ occurrenceId: "after-first-pause" }),
                definitions: [input().definitions[0]!, secondDefinition],
            },
        });
        expect(afterPause.results).toEqual([
            { kind: "skipped", reason: "definitionRetired", checkpointSafe: true },
            expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
        ]);

        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: {
                enabled: false,
                deletedAt: new Date(),
                scheduleKind: null,
                scheduleExpr: null,
                everyMs: null,
                timezone: null,
                nextRunAt: null,
                observationTransport: null,
                webhookEndpointId: null,
                observationStartsAt: null,
                watcherMachineId: null,
                watcherMachineInstallationId: null,
                watcherPluginId: null,
                watcherMaterializationId: null,
                definitionEnvelope: null,
                sessionLifecycleEvent: null,
                sourceSessionId: null,
                sourceTurnId: null,
            },
        });
        const afterDelete = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...input({ occurrenceId: "after-first-delete" }),
                definitions: [input().definitions[0]!, secondDefinition],
            },
        });
        expect(afterDelete.results).toEqual([
            { kind: "skipped", reason: "definitionRetired", checkpointSafe: true },
            expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
        ]);
        expect(await db.automationRun.count({
            where: { accountId: ACCOUNT_ID, automationId: AUTOMATION_ID },
        })).toBe(5);
    });

    it("fails closed before durable effects when private Account currentness is stale", async () => {
        await seed();

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
            hostEvidence: {
                v: 1,
                t: "plain",
                accountCurrentness: {
                    mode: "plain",
                    version: 999,
                    contentKeyFingerprint: null,
                },
            },
        })).resolves.toEqual({
            results: [{
                kind: "blocked",
                reason: "temporarilyUnavailable",
                checkpointSafe: false,
            }],
        });
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(0);
    });

    async function configureE2eeEventAutomation() {
        const e2ee = await configureE2eeAccount();
        const e2eeRecipe = encryptedStrictEventDefinitionRecipe({
            snapshot: e2ee.snapshot,
            prompt: "frozen v1",
        });
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: { templateCiphertext: e2eeRecipe },
        });
        await db.automationTrigger.update({
            where: { id: TRIGGER_ID },
            data: {
                definitionEnvelope: JSON.stringify(
                    sealAutomationTriggerDefinitionStoredEnvelopeV1({
                        mode: "e2ee",
                        material: e2ee.snapshot.material,
                        randomBytes: (length) => new Uint8Array(length).fill(3),
                        binding: {
                            v: 1,
                            automationId: AUTOMATION_ID,
                            triggerId: TRIGGER_ID,
                            triggerRevision: 1,
                            triggerKind: "pluginEvent",
                            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                            sourceSelectorId: SOURCE_SELECTOR_ID,
                        },
                        definition: {
                            v: 1,
                            sourceInstanceId: "repository-happier-example",
                            sourceConfig: {},
                            displayLabel: "Repository happier/example",
                            filter: null,
                            maximumObservationAgeMs: null,
                        },
                    }),
                ),
            },
        });
        return { e2ee, e2eeRecipe };
    }

    it("evaluates a repeated encrypted definition once and expands the outcome to every supplied position", async () => {
        await seed();
        const { e2ee } = await configureE2eeEventAutomation();
        const originalInput = input();
        const hostEvidence = encryptedHostEvidence({
            event: originalInput,
            snapshot: e2ee.snapshot,
            accountCurrentness: e2ee.accountCurrentness,
        });
        const definition = hostEvidence.definitions[0]!;

        const admitted = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: originalInput,
            hostEvidence: { ...hostEvidence, definitions: [definition, definition] },
        });

        expect(admitted.results).toEqual([
            expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
            expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
        ]);
        expect((admitted.results[0] as { runId: string }).runId)
            .toBe((admitted.results[1] as { runId: string }).runId);
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);
    });

    it("refuses one encrypted occurrence claimed twice with disagreeing evidence before writing any Run", async () => {
        await seed();
        const { e2ee } = await configureE2eeEventAutomation();
        const originalInput = input();
        const hostEvidence = encryptedHostEvidence({
            event: originalInput,
            snapshot: e2ee.snapshot,
            accountCurrentness: e2ee.accountCurrentness,
        });
        const definition = hostEvidence.definitions[0]!;

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: originalInput,
            hostEvidence: {
                ...hostEvidence,
                definitions: [
                    definition,
                    { ...definition, occurredAt: definition.occurredAt + 1_000 },
                ],
            },
        })).resolves.toEqual({
            results: [
                { kind: "blocked", reason: "occurrenceConflict", checkpointSafe: false },
                { kind: "blocked", reason: "occurrenceConflict", checkpointSafe: false },
            ],
        });
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(0);
    });

    it("rejoins E2EE Event evidence immutably while rejecting net-new outcomes prepared under a retired Event payload schema", async () => {
        await seed();
        const { e2ee, e2eeRecipe } = await configureE2eeEventAutomation();
        const originalInput = input();
        const hostEvidence = encryptedHostEvidence({
            event: originalInput,
            snapshot: e2ee.snapshot,
            accountCurrentness: e2ee.accountCurrentness,
        });
        const originalEvidence = buildAutomationPluginEventOccurrenceEvidenceV1({
            eventRef: originalInput.eventRef,
            sourceSelectorId: SOURCE_SELECTOR_ID,
            occurrenceId: originalInput.occurrenceId,
            occurredAt: originalInput.occurredAt,
            payload: originalInput.payload,
        });
        const existingRunId = "automation-event-e2ee-rejoin";
        await db.automationRun.create({
            data: {
                id: existingRunId,
                automationId: AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                state: "queued",
                triggerId: TRIGGER_ID,
                causeKind: "trigger",
                causeTriggerKind: "pluginEvent",
                causeTriggerRevision: 1,
                causeEventPluginId: PLUGIN_ID,
                causeEventLocalId: EVENT_LOCAL_ID,
                causeOccurredAt: new Date(originalInput.occurredAt),
                occurrenceKey: deriveAutomationOccurrenceKeyV1({
                    triggerId: TRIGGER_ID,
                    evidence: originalEvidence,
                }),
                occurrenceEvidenceEqualityTag:
                    hostEvidence.definitions[0]!.occurrenceEvidenceEqualityTag,
                causeSourceSelectorId: SOURCE_SELECTOR_ID,
                triggerEvidenceEnvelope: JSON.stringify(
                    hostEvidence.definitions[0]!.triggerEvidenceEnvelope,
                ),
                executionInputEnvelope: frozenE2eeRunExecutionInput({
                    definitionRecipe: e2eeRecipe,
                    triggerEvidenceEnvelope: hostEvidence.definitions[0]!.triggerEvidenceEnvelope,
                }),
                scheduledAt: new Date(),
                dueAt: new Date(),
            },
        });

        await expect(admitAutomationEventV1Raw({
            accountId: ACCOUNT_ID,
            caller,
            input: originalInput,
            hostEvidence,
        })).resolves.toEqual({
            results: [{ kind: "rejoined", runId: existingRunId, checkpointSafe: true }],
            continuation: { kind: "ready", accountCurrentness: e2ee.accountCurrentness },
        });

        const conflictingInput = input({ payload: { action: "closed" } });
        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: conflictingInput,
            hostEvidence: encryptedHostEvidence({
                event: conflictingInput,
                snapshot: e2ee.snapshot,
                accountCurrentness: e2ee.accountCurrentness,
            }),
        })).resolves.toEqual({
            results: [{
                kind: "blocked",
                reason: "occurrenceConflict",
                checkpointSafe: false,
            }],
        });

        const netNewInput = input({ occurrenceId: "delivery-e2ee-net-new" });
        const netNewHostEvidence = encryptedHostEvidence({
            event: netNewInput,
            snapshot: e2ee.snapshot,
            accountCurrentness: e2ee.accountCurrentness,
        });
        const netNewOutcome = netNewHostEvidence.definitions[0]!.outcome;
        if (netNewOutcome.kind !== "matched") throw new Error("fixture must produce a matched E2EE outcome");
        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: netNewInput,
            hostEvidence: netNewHostEvidence,
        })).resolves.toEqual({
            results: [{
                kind: "admitted",
                runId: expect.any(String),
                checkpointSafe: true,
            }],
        });
        const netNewRun = await db.automationRun.findFirstOrThrow({
            where: {
                accountId: ACCOUNT_ID,
                triggerId: TRIGGER_ID,
                occurrenceKey: netNewHostEvidence.definitions[0]!.occurrenceKey,
            },
            select: {
                occurrenceEvidenceEqualityTag: true,
                executionInputEnvelope: true,
            },
        });
        expect(netNewRun.occurrenceEvidenceEqualityTag).toBe(
            netNewHostEvidence.definitions[0]!.occurrenceEvidenceEqualityTag,
        );
        const frozenRecipe = parseAutomationRunExecutionRecipeV1(netNewRun.executionInputEnvelope);
        expect(frozenRecipe.kind).toBe("available");
        if (frozenRecipe.kind !== "available") throw new Error("admitted E2EE recipe must be readable");
        expect(frozenRecipe.recipe.triggerEvidence).toEqual(
            netNewHostEvidence.definitions[0]!.triggerEvidenceEnvelope,
        );
        const skippedInput = input({ occurrenceId: "delivery-e2ee-skipped" });
        const skippedAccount = await db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { seq: true },
        });
        const skippedBaseEvidence = encryptedHostEvidence({
            event: skippedInput,
            snapshot: e2ee.snapshot,
            accountCurrentness: {
                ...e2ee.accountCurrentness,
                version: skippedAccount.seq,
            },
        });
        const skippedHostEvidence = AutomationEventAdmitHostEvidenceV1Schema.parse({
            ...skippedBaseEvidence,
            definitions: skippedBaseEvidence.definitions.map((definition) => ({
                ...definition,
                triggerEvidenceEnvelope: sealAutomationOccurrenceTriggerEvidenceEnvelopeV1({
                    material: e2ee.snapshot.material,
                    evidence: buildAutomationPluginEventOccurrenceEvidenceV1({
                        eventRef: skippedInput.eventRef,
                        sourceSelectorId: definition.sourceSelectorId,
                        occurrenceId: skippedInput.occurrenceId,
                        occurredAt: skippedInput.occurredAt,
                        payload: skippedInput.payload,
                    }),
                    randomBytes: (length) => Uint8Array.from(
                        { length },
                        (_, index) => index + 1,
                    ),
                }),
                outcome: { kind: "skipped", reason: "filtered" },
            })),
        });
        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: skippedInput,
            hostEvidence: skippedHostEvidence,
        })).resolves.toEqual({
            results: [{ kind: "skipped", reason: "filtered", checkpointSafe: true }],
        });
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(2);
        const changedRecipe = encryptedStrictEventDefinitionRecipe({
            snapshot: e2ee.snapshot,
            prompt: "frozen v2",
            templateVersion: 2,
        });
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: { templateVersion: 2, templateCiphertext: changedRecipe },
        });
        // Fixture the next adopted-definition generation without changing the
        // Account encryption witness: this isolates the catalog/Definition
        // currentness result from an unrelated Account-version refusal.
        await db.automationEventCatalogState.update({
            where: { accountId: ACCOUNT_ID },
            data: { eventSourceDefinitionsRevision: 1n },
        });
        await expect(db.automationEventCatalogState.findUniqueOrThrow({
            where: { accountId: ACCOUNT_ID },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 1n });
        // The E3-prepared skipped result did not create an immutable
        // occurrence. Once its adopted catalog revision is stale, the server
        // must withhold the checkpoint-safe skip rather than acknowledge an
        // observation under the retired Definition.
        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: skippedInput,
            hostEvidence: skippedHostEvidence,
        })).resolves.toEqual({
            results: [{
                kind: "refreshDefinition",
                reason: "definitionStale",
                checkpointSafe: false,
            }],
        });
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(2);
        // Re-adopt a current Definition snapshot at a later catalog revision.
        // The successor transition below changes only the Event payload schema:
        // catalog, Definition facts, and source-contract facts stay current.
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: { templateVersion: 1, templateCiphertext: e2eeRecipe },
        });
        await db.automationEventCatalogState.update({
            where: { accountId: ACCOUNT_ID },
            data: { eventSourceDefinitionsRevision: 2n },
        });
        const schemaCurrentAccount = await db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { seq: true },
        });
        const schemaStaleMatchedInput = input({ occurrenceId: "delivery-e2ee-schema-stale-matched" });
        const schemaStaleMatchedHostEvidence = encryptedHostEvidence({
            event: schemaStaleMatchedInput,
            snapshot: e2ee.snapshot,
            accountCurrentness: {
                ...e2ee.accountCurrentness,
                version: schemaCurrentAccount.seq,
            },
            adoptedRevision: "2",
        });
        const schemaStaleSkippedInput = input({ occurrenceId: "delivery-e2ee-schema-stale-skipped" });
        const schemaStaleSkippedBaseEvidence = encryptedHostEvidence({
            event: schemaStaleSkippedInput,
            snapshot: e2ee.snapshot,
            accountCurrentness: {
                ...e2ee.accountCurrentness,
                version: schemaCurrentAccount.seq,
            },
            adoptedRevision: "2",
        });
        const schemaStaleSkippedHostEvidence = AutomationEventAdmitHostEvidenceV1Schema.parse({
            ...schemaStaleSkippedBaseEvidence,
            definitions: schemaStaleSkippedBaseEvidence.definitions.map((definition) => ({
                ...definition,
                triggerEvidenceEnvelope: sealAutomationOccurrenceTriggerEvidenceEnvelopeV1({
                    material: e2ee.snapshot.material,
                    evidence: buildAutomationPluginEventOccurrenceEvidenceV1({
                        eventRef: schemaStaleSkippedInput.eventRef,
                        sourceSelectorId: definition.sourceSelectorId,
                        occurrenceId: schemaStaleSkippedInput.occurrenceId,
                        occurredAt: schemaStaleSkippedInput.occurredAt,
                        payload: schemaStaleSkippedInput.payload,
                    }),
                    randomBytes: (length) => Uint8Array.from(
                        { length },
                        (_, index) => index + 1,
                    ),
                }),
                outcome: { kind: "skipped", reason: "filtered" },
            })),
        });

        const successorVersion = "1.0.1";
        const successorRelease = releaseFacts({
            version: successorVersion,
            archiveDigestSha256: `sha256:${"b".repeat(64)}`,
            payloadSchema: {
                type: "object",
                properties: { action: { type: "number" } },
                required: ["action"],
                additionalProperties: false,
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                version: successorVersion,
                archiveDigestSha256: successorRelease.archiveDigestSha256,
                normalizedManifest: successorRelease.normalizedManifest,
                collectionContracts: [],
                uiSlots: [],
                packageAssetArchive: successorRelease.packageAssetArchive,
            },
        });
        await db.accountPluginIntent.update({
            where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
            data: { desiredVersion: successorVersion },
        });
        await db.pluginMachineMaterialization.update({
            where: {
                machineId_materializationId: {
                    machineId: MACHINE_ID,
                    materializationId: MATERIALIZATION_ID,
                },
            },
            data: {
                version: successorVersion,
                archiveDigestSha256: successorRelease.archiveDigestSha256,
            },
        });
        await expect(db.automationEventCatalogState.findUniqueOrThrow({
            where: { accountId: ACCOUNT_ID },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 2n });

        // Immutable equality rejoin remains deliberately ahead of release and
        // schema currentness for a previously admitted occurrence, while the
        // stale frozen Account witness terminates any later bounded suffix.
        await expect(admitAutomationEventV1Raw({
            accountId: ACCOUNT_ID,
            caller,
            input: originalInput,
            hostEvidence,
        })).resolves.toEqual({
            results: [{ kind: "rejoined", runId: existingRunId, checkpointSafe: true }],
            continuation: { kind: "stopped", reason: "accountCurrentnessMoved" },
        });

        // Both outcomes were prepared by E3 with schema A at revision 2. The
        // exact same materialization now resolves schema B while every catalog,
        // Definition, selector, and source-contract fact remains unchanged.
        // Net-new work must refresh instead of consuming either stale outcome.
        expect([
            await admitAutomationEventV1({
                accountId: ACCOUNT_ID,
                caller,
                input: schemaStaleMatchedInput,
                hostEvidence: schemaStaleMatchedHostEvidence,
            }),
            await admitAutomationEventV1({
                accountId: ACCOUNT_ID,
                caller,
                input: schemaStaleSkippedInput,
                hostEvidence: schemaStaleSkippedHostEvidence,
            }),
        ]).toEqual([
            {
                results: [{
                    kind: "refreshDefinition",
                    reason: "definitionStale",
                    checkpointSafe: false,
                }],
            },
            {
                results: [{
                    kind: "refreshDefinition",
                    reason: "definitionStale",
                    checkpointSafe: false,
                }],
            },
        ]);
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(2);
    });

    it("commits an Event Run wake and hands its initial revision to the incumbent claim owner", async () => {
        await seed();
        await db.automationAssignment.create({
            data: {
                automationId: AUTOMATION_ID,
                machineId: MACHINE_ID,
                enabled: true,
            },
        });
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});

        const admitted = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
        });
        const runId = (admitted.results[0] as { runId: string }).runId;

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: { id: true, state: true, revision: true, executionDispatchState: true },
        })).resolves.toEqual({
            id: runId,
            state: "queued",
            revision: 0,
            executionDispatchState: null,
        });

        const change = await db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: ACCOUNT_ID,
                    kind: "automation",
                    entityId: AUTOMATION_ID,
                },
            },
            select: { cursor: true },
        });
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: ACCOUNT_ID,
            payload: expect.objectContaining({
                seq: change.cursor,
                body: expect.objectContaining({
                    t: "automation-run-updated",
                    runId,
                    automationId: AUTOMATION_ID,
                    state: "queued",
                }),
            }),
            recipientFilter: { type: "user-scoped-only" },
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: ACCOUNT_ID,
            payload: expect.objectContaining({
                seq: change.cursor,
                body: expect.objectContaining({
                    t: "automation-run-updated",
                    runId,
                    automationId: AUTOMATION_ID,
                    state: "queued",
                    targetMachineId: MACHINE_ID,
                }),
            }),
            recipientFilter: { type: "machine-only", machineId: MACHINE_ID },
        }));

        await expect(claimAutomationRun({
            accountId: ACCOUNT_ID,
            machineId: MACHINE_ID,
            leaseDurationMs: 30_000,
            expectedTriggerKind: "pluginEvent",
        })).resolves.toEqual({
            run: expect.objectContaining({
                id: runId,
                state: "claimed",
                attempt: 1,
                revision: 1,
            }),
            accountCurrentness: {
                mode: "plain",
                version: 2,
                contentKeyFingerprint: null,
            },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: { revision: true },
        })).resolves.toEqual({ revision: 1 });
    });

    it("initializes an admitted execution Run before the canonical start transition", async () => {
        await seed();
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: {
                targetType: "execution_run",
                templateCiphertext: strictExecutionRunEventDefinitionRecipe({
                    prompt: "Run the admitted detached task.",
                }),
            },
        });
        await db.automationAssignment.create({
            data: {
                automationId: AUTOMATION_ID,
                machineId: MACHINE_ID,
                enabled: true,
            },
        });

        const admitted = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ occurrenceId: "execution-run-startable-admission" }),
        });
        const admittedItem = admitted.results[0];
        if (admittedItem?.kind !== "admitted") {
            throw new Error("Expected Event admission to create an execution Run");
        }

        const claimed = await claimAutomationRun({
            accountId: ACCOUNT_ID,
            machineId: MACHINE_ID,
            leaseDurationMs: 30_000,
            expectedTriggerKind: "pluginEvent",
        });
        if (!claimed.run || !claimed.accountCurrentness) {
            throw new Error("Expected the newly admitted execution Run to be claimed");
        }

        await expect(startAutomationRun({
            accountId: ACCOUNT_ID,
            runId: admittedItem.runId,
            machineId: MACHINE_ID,
            attempt: claimed.run.attempt,
            accountCurrentness: claimed.accountCurrentness,
        })).resolves.toEqual(expect.objectContaining({
            run: expect.objectContaining({
                id: admittedItem.runId,
                state: "running",
                executionDispatchState: "dispatchPermitted",
                executionAttempt: 1,
            }),
        }));

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admittedItem.runId },
            select: { executionDispatchState: true },
        })).resolves.toEqual({ executionDispatchState: "dispatchPermitted" });
    });

    it("turns same-key immutable evidence mismatch into a non-checkpoint-safe conflict without another Run", async () => {
        await seed();
        await admitAutomationEventV1({ accountId: ACCOUNT_ID, caller, input: input() });

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ payload: { action: "closed" } }),
        })).resolves.toEqual({
            results: [{
                kind: "blocked",
                reason: "occurrenceConflict",
                checkpointSafe: false,
            }],
        });
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);
    });

    it("does not rejoin a matching occurrence key when its retained source occurrence time differs", async () => {
        await seed();
        const admitted = await admitAutomationEventV1({ accountId: ACCOUNT_ID, caller, input: input() });
        const runId = (admitted.results[0] as { runId: string }).runId;

        await db.automationRun.update({
            where: { id: runId },
            data: { causeOccurredAt: new Date(1_723_247_200_001) },
        });

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
        })).resolves.toEqual({
            results: [{
                kind: "blocked",
                reason: "occurrenceConflict",
                checkpointSafe: false,
            }],
        });
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);
    });

    it("does not rejoin a matching occurrence key retained for a different occurrence kind", async () => {
        await seed();
        const admitted = await admitAutomationEventV1({ accountId: ACCOUNT_ID, caller, input: input() });
        const runId = (admitted.results[0] as { runId: string }).runId;

        await db.automationRun.update({
            where: { id: runId },
            data: {
                // Preserve the incoming trigger-scoped occurrence discriminator
                // while making the retained immutable cause a different valid
                // trigger arm. Clearing triggerId would move this row into the
                // Conversation uniqueness domain, so the retry would correctly
                // be a new Event occurrence rather than an identity conflict.
                causeTriggerKind: "schedule",
                causeEventPluginId: null,
                causeEventLocalId: null,
                causeSourceSelectorId: null,
                causeScheduledFor: new Date(1_723_247_200_000),
                triggerEvidenceEnvelope: null,
                occurrenceEvidenceEqualityTag: null,
            },
        });

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
        })).resolves.toEqual({
            results: [{
                kind: "blocked",
                reason: "occurrenceConflict",
                checkpointSafe: false,
            }],
        });
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);
    });

    it("deduplicates repeated definition input while preserving one result per supplied definition", async () => {
        await seed();
        const firstDefinition = input().definitions[0];

        const admitted = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...input(),
                definitions: [firstDefinition, firstDefinition],
            },
        });

        expect(admitted.results).toHaveLength(2);
        expect(admitted.results).toEqual([
            expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
            expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
        ]);
        expect((admitted.results[0] as { runId: string }).runId)
            .toBe((admitted.results[1] as { runId: string }).runId);
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);
    });

    it("keeps Event capacity with an admitted Run after its Definition is disabled", async () => {
        await seed();
        await db.automationAssignment.create({
            data: {
                automationId: AUTOMATION_ID,
                machineId: MACHINE_ID,
                enabled: true,
            },
        });
        await db.automation.create({
            data: {
                id: SECOND_AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                name: "Capacity successor definition",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: strictEventDefinitionRecipe({ prompt: "frozen capacity successor" }),
                templateVersion: 1,
                triggers: { create: {
                    id: `${SECOND_AUTOMATION_ID}-trigger`, kind: "pluginEvent", enabled: true, revision: 1,
                    eventPluginId: PLUGIN_ID, eventLocalId: EVENT_LOCAL_ID,
                    sourceSelectorId: SECOND_SOURCE_SELECTOR_ID, sourceContractVersion: 1,
                    observationTransport: "checkpointedPull", watcherMachineId: MACHINE_ID,
                    watcherMachineInstallationId: MACHINE_INSTALLATION_ID, watcherPluginId: PLUGIN_ID,
                    watcherMaterializationId: MATERIALIZATION_ID,
                    definitionEnvelope: triggerDefinitionEnvelope({
                        automationId: SECOND_AUTOMATION_ID,
                        triggerId: `${SECOND_AUTOMATION_ID}-trigger`,
                        sourceSelectorId: SECOND_SOURCE_SELECTOR_ID,
                    }),
                } },
            },
        });
        const successorDefinition = {
            automationId: SECOND_AUTOMATION_ID,
            triggerId: `${SECOND_AUTOMATION_ID}-trigger`,
            triggerRevision: 1,
            sourceSelectorId: SECOND_SOURCE_SELECTOR_ID,
        };
        // Assignment-liveness: the successor must keep an enabled execution
        // assignment or canonical admission refuses its occurrences.
        await db.automationAssignment.create({
            data: { automationId: SECOND_AUTOMATION_ID, machineId: MACHINE_ID, enabled: true },
        });
        const leasedAdmission = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ occurrenceId: "retired-capacity-lease" }),
        });
        const leasedRunId = (leasedAdmission.results[0] as { runId: string }).runId;
        await expect(claimAutomationRun({
            accountId: ACCOUNT_ID,
            machineId: MACHINE_ID,
            leaseDurationMs: 30_000,
            expectedTriggerKind: "pluginEvent",
        })).resolves.toMatchObject({
            run: { id: leasedRunId, state: "claimed" },
        });
        await db.automationRun.update({
            where: { id: leasedRunId },
            data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
        });
        await setAutomationEnabled({
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
            enabled: false,
        });

        const now = new Date();
        const futureDueAt = new Date(now.getTime() + 60 * 60 * 1_000);
        await db.automationRun.createMany({
            data: Array.from({ length: MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT - 1 }, (_, index) => (
                pluginEventCapacityRunSeed({
                    id: `retired-capacity-run-${index}`,
                    automationId: SECOND_AUTOMATION_ID,
                    triggerId: `${SECOND_AUTOMATION_ID}-trigger`,
                    sourceSelectorId: SECOND_SOURCE_SELECTOR_ID,
                    occurrenceId: `retired-capacity-occurrence-${index}`,
                    scheduledAt: now,
                    dueAt: futureDueAt,
                })
            )),
        });

        const capacityAdmission = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...input({ occurrenceId: "retired-capacity-blocked" }),
                definitions: [successorDefinition],
            },
        });
        expect(capacityAdmission.results).toEqual([{
            kind: "blocked",
            reason: "capacity",
            checkpointSafe: false,
        }]);

        await expect(claimAutomationRun({
            accountId: ACCOUNT_ID,
            machineId: MACHINE_ID,
            leaseDurationMs: 30_000,
            expectedTriggerKind: "pluginEvent",
        })).resolves.toMatchObject({
            run: { id: leasedRunId, state: "claimed", claimedByMachineId: MACHINE_ID, attempt: 2 },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: leasedRunId },
            select: { state: true, errorCode: true, claimedByMachineId: true, leaseExpiresAt: true },
        })).resolves.toEqual({
            state: "claimed",
            errorCode: null,
            claimedByMachineId: MACHINE_ID,
            leaseExpiresAt: expect.any(Date),
        });

        const stillAtCapacity = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...input({ occurrenceId: "retired-capacity-released" }),
                definitions: [successorDefinition],
            },
        });
        expect(stillAtCapacity.results).toEqual([{
            kind: "blocked",
            reason: "capacity",
            checkpointSafe: false,
        }]);
        await expect(db.automationRun.count({
            where: {
                accountId: ACCOUNT_ID,
                OR: [
                    { causeKind: "conversation" },
                    { causeKind: "trigger", causeTriggerKind: "pluginEvent" },
                ],
                state: { in: ["queued", "claimed", "running"] },
            },
        })).resolves.toBe(MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT);
    });

    it("retains admitted Event capacity when disabling their Automation", async () => {
        await seed();
        await db.automation.create({
            data: {
                id: SECOND_AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                name: "Capacity successor definition",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: strictEventDefinitionRecipe({ prompt: "frozen capacity successor" }),
                templateVersion: 1,
                triggers: { create: {
                    id: `${SECOND_AUTOMATION_ID}-trigger`, kind: "pluginEvent", enabled: true, revision: 1,
                    eventPluginId: PLUGIN_ID, eventLocalId: EVENT_LOCAL_ID,
                    sourceSelectorId: SECOND_SOURCE_SELECTOR_ID, sourceContractVersion: 1,
                    observationTransport: "checkpointedPull", watcherMachineId: MACHINE_ID,
                    watcherMachineInstallationId: MACHINE_INSTALLATION_ID, watcherPluginId: PLUGIN_ID,
                    watcherMaterializationId: MATERIALIZATION_ID,
                    definitionEnvelope: triggerDefinitionEnvelope({
                        automationId: SECOND_AUTOMATION_ID,
                        triggerId: `${SECOND_AUTOMATION_ID}-trigger`,
                        sourceSelectorId: SECOND_SOURCE_SELECTOR_ID,
                    }),
                } },
            },
        });
        const successorDefinition = {
            automationId: SECOND_AUTOMATION_ID,
            triggerId: `${SECOND_AUTOMATION_ID}-trigger`,
            triggerRevision: 1,
            sourceSelectorId: SECOND_SOURCE_SELECTOR_ID,
        };
        await db.automationAssignment.create({
            data: { automationId: SECOND_AUTOMATION_ID, machineId: MACHINE_ID, enabled: true },
        });
        const now = new Date();
        const dueAt = new Date(now.getTime() + 60 * 60 * 1_000);
        const disabledPluginEventRunId = "disabled-capacity-plugin-event";
        const disabledConversationRunId = "disabled-capacity-conversation";
        const disabledConversationEvidence = {
            v: 1 as const,
            kind: "conversation" as const,
            bindingId: "binding-disabled-capacity-conversation",
            occurrenceId: "disabled-capacity-conversation-occurrence",
            occurredAt: now.getTime(),
            caller: {
                pluginId: PLUGIN_ID,
                contributionLocalId: "github/observation-ingest-v1",
                machineId: MACHINE_ID,
            },
            input: { text: "capacity seed" },
            replyContextIdentity: "disabled-capacity-conversation-reply-context",
        };
        await db.automationRun.createMany({
            data: [
                pluginEventCapacityRunSeed({
                    id: disabledPluginEventRunId,
                    automationId: AUTOMATION_ID,
                    triggerId: TRIGGER_ID,
                    sourceSelectorId: SOURCE_SELECTOR_ID,
                    occurrenceId: "disabled-capacity-plugin-event-occurrence",
                    scheduledAt: now,
                    dueAt,
                    prompt: "frozen disabled capacity seed",
                }),
                {
                    id: disabledConversationRunId,
                    automationId: AUTOMATION_ID,
                    accountId: ACCOUNT_ID,
                    state: "queued" as const,
                    causeKind: "conversation" as const,
                    causeOccurredAt: now,
                    occurrenceKey: "disabled-capacity-conversation-occurrence",
                    causeSourceSelectorId: null,
                    triggerEvidenceEnvelope: JSON.stringify({
                        t: "plain",
                        v: disabledConversationEvidence,
                    }),
                    executionInputEnvelope: frozenConversationRunExecutionInput({
                        evidence: disabledConversationEvidence,
                    }),
                    scheduledAt: now,
                    dueAt,
                },
                ...Array.from(
                    { length: MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT - 2 },
                    (_, index) => pluginEventCapacityRunSeed({
                        id: `disabled-capacity-retained-${index}`,
                        automationId: SECOND_AUTOMATION_ID,
                        triggerId: `${SECOND_AUTOMATION_ID}-trigger`,
                        sourceSelectorId: SECOND_SOURCE_SELECTOR_ID,
                        occurrenceId: `disabled-capacity-retained-occurrence-${index}`,
                        scheduledAt: now,
                        dueAt,
                        prompt: "frozen retained capacity seed",
                    }),
                ),
            ],
        });

        const capacityAdmission = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...input({ occurrenceId: "disabled-capacity-blocked" }),
                definitions: [successorDefinition],
            },
        });
        expect(capacityAdmission.results).toEqual([{
            kind: "blocked",
            reason: "capacity",
            checkpointSafe: false,
        }]);

        await expect(setAutomationEnabled({
            accountId: ACCOUNT_ID,
            automationId: AUTOMATION_ID,
            enabled: false,
        })).resolves.toEqual(expect.objectContaining({ enabled: false }));
        await expect(db.automationRun.findMany({
            where: { id: { in: [disabledPluginEventRunId, disabledConversationRunId] } },
            select: { id: true, state: true, finishedAt: true },
        })).resolves.toEqual(expect.arrayContaining([
            {
                id: disabledPluginEventRunId,
                state: "queued",
                finishedAt: null,
            },
            {
                id: disabledConversationRunId,
                state: "queued",
                finishedAt: null,
            },
        ]));

        const retainedCapacityAdmission = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...input({ occurrenceId: "disabled-capacity-released" }),
                definitions: [successorDefinition],
            },
        });
        expect(retainedCapacityAdmission.results).toEqual([{
            kind: "blocked",
            reason: "capacity",
            checkpointSafe: false,
        }]);
        await expect(db.automationRun.count({
            where: {
                accountId: ACCOUNT_ID,
                OR: [
                    { causeKind: "conversation" },
                    { causeKind: "trigger", causeTriggerKind: "pluginEvent" },
                ],
                state: { in: ["queued", "claimed", "running"] },
            },
        })).resolves.toBe(MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT);
    });

    it("blocks checkpoint advancement without creating a Run when Event capacity is exhausted", async () => {
        await seed();
        const now = new Date();
        await db.automationRun.createMany({
            data: Array.from({ length: MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT }, (_, index) => (
                pluginEventCapacityRunSeed({
                    id: `capacity-run-${index}`,
                    automationId: AUTOMATION_ID,
                    triggerId: TRIGGER_ID,
                    sourceSelectorId: SOURCE_SELECTOR_ID,
                    occurrenceId: `capacity-occurrence-${index}`,
                    scheduledAt: now,
                    dueAt: now,
                })
            )),
        });

        const capacityAdmission = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ occurrenceId: "capacity-next" }),
        });
        expect(capacityAdmission.results).toEqual([{
            kind: "blocked",
            reason: "capacity",
            checkpointSafe: false,
        }]);
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } }))
            .toBe(MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT);

        await db.automationRun.update({
            where: { id: "capacity-run-9999" },
            data: {
                state: "failed",
                executionDispatchState: "settled",
                executionAttempt: 3,
                executionDispatchDueAt: null,
                executionNativeRunId: null,
                executionNativeCallId: null,
                executionNativeSidechainId: null,
                claimedByMachineId: null,
                leaseExpiresAt: null,
                finishedAt: now,
                errorCode: "execution_run_retry_exhausted",
            },
        });

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ occurrenceId: "capacity-after-exhaustion" }),
        })).resolves.toEqual({
            results: [{
                kind: "admitted",
                runId: expect.any(String),
                checkpointSafe: true,
            }],
        });
        await expect(db.automationRun.count({
            where: {
                accountId: ACCOUNT_ID,
                OR: [
                    { causeKind: "conversation" },
                    { causeKind: "trigger", causeTriggerKind: "pluginEvent" },
                ],
                state: { in: ["queued", "claimed", "running"] },
            },
        })).resolves.toBe(MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT);
        await expect(db.automationRun.findUnique({
            where: { id: "capacity-run-9999" },
            select: {
                state: true,
                executionDispatchState: true,
                executionAttempt: true,
                errorCode: true,
            },
        })).resolves.toEqual({
            state: "failed",
            executionDispatchState: "settled",
            executionAttempt: 3,
            errorCode: "execution_run_retry_exhausted",
        });
    });

    it("blocks every net-new Event candidate when the complete request would exceed capacity", async () => {
        await seed();
        await db.automationTrigger.create({
            data: {
                id: SECOND_TRIGGER_ID,
                automationId: AUTOMATION_ID,
                kind: "pluginEvent",
                enabled: true,
                revision: 1,
                eventPluginId: PLUGIN_ID,
                eventLocalId: EVENT_LOCAL_ID,
                sourceSelectorId: SOURCE_SELECTOR_ID,
                sourceContractVersion: 1,
                observationTransport: "checkpointedPull",
                watcherMachineId: MACHINE_ID,
                watcherMachineInstallationId: MACHINE_INSTALLATION_ID,
                watcherPluginId: PLUGIN_ID,
                watcherMaterializationId: MATERIALIZATION_ID,
                definitionEnvelope: triggerDefinitionEnvelope({
                    triggerId: SECOND_TRIGGER_ID,
                    sourceSelectorId: SOURCE_SELECTOR_ID,
                }),
            },
        });
        const now = new Date();
        await db.automationRun.createMany({
            data: Array.from({ length: MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT - 1 }, (_, index) => (
                pluginEventCapacityRunSeed({
                    id: `batch-capacity-run-${index}`,
                    automationId: AUTOMATION_ID,
                    triggerId: TRIGGER_ID,
                    sourceSelectorId: SOURCE_SELECTOR_ID,
                    occurrenceId: `batch-capacity-occurrence-${index}`,
                    scheduledAt: now,
                    dueAt: now,
                })
            )),
        });

        const result = await admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...input({ occurrenceId: "batch-capacity-next" }),
                definitions: [
                    input().definitions[0]!,
                    {
                        automationId: AUTOMATION_ID,
                        triggerId: SECOND_TRIGGER_ID,
                        triggerRevision: 1,
                        sourceSelectorId: SOURCE_SELECTOR_ID,
                    },
                ],
            },
        });

        expect(result.results).toEqual([
            { kind: "blocked", reason: "capacity", checkpointSafe: false },
            { kind: "blocked", reason: "capacity", checkpointSafe: false },
        ]);
        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } }))
            .resolves.toBe(MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT - 1);
    });

    it("rejects a payload outside the current Event schema before creating a Run", async () => {
        await seed();

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: input({ occurrenceId: "delivery-invalid", payload: { action: 42 } }),
        })).resolves.toEqual({
            results: [{
                kind: "skipped",
                reason: "occurrenceRejected",
                checkpointSafe: true,
            }],
        });
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(0);
    });

    it("fails closed before durable effects when the caller materialization is not the authenticated Event owner", async () => {
        await seed();

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller: { ...caller, pluginId: "com.acme.other" },
            input: input(),
        })).rejects.toEqual(expect.objectContaining({
            code: "caller_materialization_not_current",
        } satisfies Partial<AutomationEventAdmissionError>));
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(0);
    });

    it("rejects an Event ref from another plugin instead of treating it as a stale local definition", async () => {
        await seed();

        await expect(admitAutomationEventV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...input(),
                eventRef: { pluginId: "com.acme.other", localId: EVENT_LOCAL_ID },
            },
        })).rejects.toEqual(expect.objectContaining({
            code: "event_contribution_not_current",
        } satisfies Partial<AutomationEventAdmissionError>));
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(0);
    });

    it("rejects a plain private witness after the Account changes to E2EE", async () => {
        await seed();
        await configureE2eeAccount();

        await expect(admitAutomationEventV1Raw({
            accountId: ACCOUNT_ID,
            caller,
            input: input(),
        })).resolves.toEqual({
            results: [{
                kind: "blocked",
                reason: "temporarilyUnavailable",
                checkpointSafe: false,
            }],
            continuation: { kind: "stopped", reason: "accountUnavailable" },
        });
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(0);
    });

    it("carries each server-derived successor witness across all 15/15/1 composed admission requests", async () => {
        const sources = await loadCurrentAutomationAdmissionSources();
        const publisherKeyPair = tweetnacl.sign.keyPair();
        const definitions = await seedGithubBoundedAdmissionDefinitions({
            github: sources.github,
            keyPair: publisherKeyPair,
        });
        const initial = await db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { seq: true },
        });

        const execution = await executeGithubBoundedAdmission({
            sources,
            keyPair: publisherKeyPair,
            definitions,
        });

        expect(execution.admitRouteCalls).toBe(3);
        expect(execution.witnessVersions).toEqual([
            Number(initial.seq),
            Number(initial.seq) + 15,
            Number(initial.seq) + 30,
        ]);
        expect(execution.continuations).toEqual([
            {
                kind: "ready",
                accountCurrentness: {
                    mode: "plain",
                    version: Number(initial.seq) + 15,
                    contentKeyFingerprint: null,
                },
            },
            {
                kind: "ready",
                accountCurrentness: {
                    mode: "plain",
                    version: Number(initial.seq) + 30,
                    contentKeyFingerprint: null,
                },
            },
            {
                kind: "ready",
                accountCurrentness: {
                    mode: "plain",
                    version: Number(initial.seq) + 31,
                    contentKeyFingerprint: null,
                },
            },
        ]);
        expect(execution.result.results).toHaveLength(31);
        expect(execution.result.results).toEqual(expect.arrayContaining(
            Array.from({ length: 31 }, () => expect.objectContaining({
                kind: "admitted",
                checkpointSafe: true,
            })),
        ));
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(31);
    });

    it("stops after an external Account marker moves between bounded admission requests", async () => {
        const sources = await loadCurrentAutomationAdmissionSources();
        const publisherKeyPair = tweetnacl.sign.keyPair();
        const definitions = await seedGithubBoundedAdmissionDefinitions({
            github: sources.github,
            keyPair: publisherKeyPair,
        });
        const initial = await db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { seq: true },
        });

        const execution = await executeGithubBoundedAdmission({
            sources,
            keyPair: publisherKeyPair,
            definitions,
            afterFirstAdmit: async () => {
                await inTx(async (tx) => {
                    await markAccountChanged(tx, {
                        accountId: ACCOUNT_ID,
                        kind: "machine",
                        entityId: MACHINE_ID,
                    });
                });
            },
        });

        expect(execution.admitRouteCalls).toBe(2);
        expect(execution.witnessVersions).toEqual([
            Number(initial.seq),
            Number(initial.seq) + 15,
        ]);
        expect(execution.continuations).toEqual([
            {
                kind: "ready",
                accountCurrentness: {
                    mode: "plain",
                    version: Number(initial.seq) + 15,
                    contentKeyFingerprint: null,
                },
            },
            { kind: "stopped", reason: "accountCurrentnessMoved" },
        ]);
        expect(execution.result.results).toHaveLength(31);
        expect(execution.result.results.slice(0, 15)).toEqual(expect.arrayContaining(
            Array.from({ length: 15 }, () => expect.objectContaining({
                kind: "admitted",
                checkpointSafe: true,
            })),
        ));
        expect(execution.result.results.slice(15)).toEqual(Array.from({ length: 16 }, () => ({
            kind: "blocked",
            reason: "temporarilyUnavailable",
            checkpointSafe: false,
        })));
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(15);
    });

    it("preserves all-rejoin results but stops the remaining suffix when the frozen initial witness moved", async () => {
        const sources = await loadCurrentAutomationAdmissionSources();
        const publisherKeyPair = tweetnacl.sign.keyPair();
        const definitions = await seedGithubBoundedAdmissionDefinitions({
            github: sources.github,
            keyPair: publisherKeyPair,
        });
        await executeGithubBoundedAdmission({
            sources,
            keyPair: publisherKeyPair,
            definitions,
        });

        const execution = await executeGithubBoundedAdmission({
            sources,
            keyPair: publisherKeyPair,
            definitions,
            beforeFirstAdmit: async () => {
                await inTx(async (tx) => {
                    await markAccountChanged(tx, {
                        accountId: ACCOUNT_ID,
                        kind: "machine",
                        entityId: MACHINE_ID,
                    });
                });
            },
        });

        expect(execution.admitRouteCalls).toBe(1);
        expect(execution.continuations).toEqual([
            { kind: "stopped", reason: "accountCurrentnessMoved" },
        ]);
        expect(execution.result.results).toHaveLength(31);
        expect(execution.result.results.slice(0, 15)).toEqual(expect.arrayContaining(
            Array.from({ length: 15 }, () => expect.objectContaining({
                kind: "rejoined",
                checkpointSafe: true,
            })),
        ));
        expect(execution.result.results.slice(15)).toEqual(Array.from({ length: 16 }, () => ({
            kind: "blocked",
            reason: "temporarilyUnavailable",
            checkpointSafe: false,
        })));
        expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(31);
    });

    it("keeps a GitHub checkpoint behind a response-lost commit, then replays the same adopted Event through E2 and rejoins before advancing", async () => {
        const sources = await loadCurrentAutomationAdmissionSources();
        const { github } = sources;
        const publisherKeyPair = tweetnacl.sign.keyPair();
        await seedGithubCheckpointedPull({ github, keyPair: publisherKeyPair });
        await db.automationAssignment.create({
            data: {
                automationId: AUTOMATION_ID,
                machineId: MACHINE_ID,
                enabled: true,
            },
        });
        const githubMaterialization = {
            pluginId: github.pluginId,
            machineId: MACHINE_ID,
            materializationId: MATERIALIZATION_ID,
        } as const;
        const githubActionCaller = {
            kind: "plugin" as const,
            pluginId: github.pluginId,
            contributionLocalId: github.backgroundServiceId,
            immutableGenerationId: GITHUB_IMMUTABLE_GENERATION_ID,
            materialization: githubMaterialization,
        };
        const githubEventRef = { pluginId: github.pluginId, localId: github.eventId } as const;
        const checkpointRowId = sources.createGithubCheckpointRowId({
            automationId: AUTOMATION_ID,
            triggerId: TRIGGER_ID,
            eventRef: githubEventRef,
            sourceSelectorId: GITHUB_AUTOMATION_SOURCE_SELECTOR_ID,
        });
        const checkpoints = createGithubCheckpointCollection([sources.createGithubCheckpointRow({
            checkpointRowId,
            automationId: AUTOMATION_ID,
            triggerId: TRIGGER_ID,
            eventRef: githubEventRef,
            sourceSelectorId: GITHUB_AUTOMATION_SOURCE_SELECTOR_ID,
            sourceInstanceId: GITHUB_SOURCE_INSTANCE_ID,
            sourceContractVersion: github.sourceContractVersion,
            cursor: {
                v: 1,
                observationStartsAtMs: 1_000,
                observedAtMs: 1_000,
                seenEventIds: ["old"],
                etag: "prior-etag",
            },
            lastContiguousOccurrenceId: "github:repository:77:event:old",
            baseline: { kind: "currentHead", establishedAt: 1_000 },
            lastEvaluatedTriggerRevision: 1,
            continuity: {
                v: 1,
                endpointKind: "repositoryEvents",
                repositoryId: "77",
            },
        })], sources.checkpointFields.id);
        let now = 2_000;
        let storedDefinitionRouteCalls = 0;
        let admitRouteCalls = 0;
        let dropFirstAdmitResponse = true;

        const credentials = {
            token: "composed-automation-event-token",
            encryption: { type: "legacy" as const, secret: new Uint8Array(32).fill(7) },
        };
        const revalidateCallerMaterialization = async (candidate: Readonly<{
            pluginId: string;
            machineId: string;
            materializationId: string;
        }>) => (
            candidate.pluginId === githubMaterialization.pluginId
            && candidate.machineId === githubMaterialization.machineId
            && candidate.materializationId === githubMaterialization.materializationId
        );
        const readAccountCurrentness = async (): Promise<AccountEncryptionCurrentnessResponse> => {
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
                        keyPair: publisherKeyPair,
                        path,
                    }),
                },
                payload: body,
            });
            const adoptedSet = sources.createAdoptedDefinitionSet({
                credentials,
                caller: githubMaterialization,
                immutableGenerationId: GITHUB_IMMUTABLE_GENERATION_ID,
                transport: { kind: "checkpointedPull" },
                generationSignal: new AbortController().signal,
                isGenerationCurrent: () => true,
                revalidateCallerMaterialization,
                revalidateCallerImmutableGeneration: async () => true,
                readStoredDefinitions: async (params: DynamicRecord) => {
                    if (
                        !isRecord(params.caller)
                        || typeof params.caller.immutableGenerationId !== "string"
                        || !isRecord(params.caller.materialization)
                        || !isRecord(params.input)
                    ) {
                        throw new Error("stored Event definition request is incompatible");
                    }
                    const body = AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse({
                        v: 1,
                        caller: {
                            pluginId: params.caller.pluginId,
                            immutableGenerationId: params.caller.immutableGenerationId,
                            materialization: params.caller.materialization,
                        },
                        input: params.input,
                    });
                    storedDefinitionRouteCalls += 1;
                    const response = await injectSigned(
                        AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
                        body,
                    );
                    if (response.statusCode !== 200) {
                        throw new Error(`stored Event definition route failed: ${response.statusCode}`);
                    }
                    return response.json();
                },
                resolveAccountEncryptionCurrentness: readAccountCurrentness,
                resolveAccountEncryptionMaterial: async () => null,
            });
            await expect(adoptedSet.refresh()).resolves.toEqual({ kind: "adopted", revision: "0" });

            const transport = {
                async execute(actionId: unknown, request: unknown): Promise<unknown> {
                    if (
                        actionId !== "automation.event.admit"
                        && actionId !== "automation.event.source.status.report"
                    ) {
                        throw new Error(`unexpected Event transport action: ${String(actionId)}`);
                    }
                    const body = AutomationEventActionHttpRequestSchemasV1[actionId].parse(request);
                    const response = await injectSigned(AutomationEventActionHttpPathsV1[actionId], body);
                    if (response.statusCode !== 200) {
                        throw new Error(`Automation Event route failed: ${response.statusCode}`);
                    }
                    if (actionId === "automation.event.admit") {
                        admitRouteCalls += 1;
                        if (dropFirstAdmitResponse) {
                            dropFirstAdmitResponse = false;
                            throw new Error("simulated response loss after committed Event admission");
                        }
                    }
                    return response.json();
                },
            };
            const executor = sources.createEventActionExecutor({
                credentials,
                transport,
                revalidateCallerMaterialization,
                revalidateCallerImmutableGeneration: async () => true,
                resolveAccountId: async () => ACCOUNT_ID,
                resolveAdoptedDefinitionSet: (
                    candidate: DynamicRecord,
                    immutableGenerationId: string,
                    transportKind: DynamicRecord,
                ) => (
                    transportKind.kind === "checkpointedPull"
                    && immutableGenerationId === GITHUB_IMMUTABLE_GENERATION_ID
                    && candidate.pluginId === githubMaterialization.pluginId
                    && candidate.machineId === githubMaterialization.machineId
                    && candidate.materializationId === githubMaterialization.materializationId
                        ? adoptedSet
                        : null
                ),
            });
            const observer = sources.createGithubObserver({ now: () => now });
            const observerSignal = new AbortController().signal;
            let observerServices: DynamicRecord | null = null;
            const dispatchAction = async (
                actionId: unknown,
                actionInput: unknown,
                options?: Readonly<{ signal?: AbortSignal }>,
            ): Promise<unknown> => {
                if (
                    typeof actionId === "object"
                    && isRecord(actionId)
                    && actionId.pluginId === github.pluginId
                    && actionId.localId === github.sourceAttemptActionId
                ) {
                    if (observerServices === null) throw new Error("observer action context unavailable");
                    const sourceAttemptContext = {
                        plugin: { id: github.pluginId, version: PLUGIN_VERSION },
                        contribution: {
                            id: github.sourceAttemptActionId,
                            qualifiedId: `${github.pluginId}/actions/${github.sourceAttemptActionId}`,
                        },
                        surface: "plugin" as const,
                        caller: {
                            kind: "plugin" as const,
                            pluginId: github.pluginId,
                            contribution: {
                                id: github.backgroundServiceId,
                                qualifiedId: `${github.pluginId}/backgroundServices/${github.backgroundServiceId}`,
                            },
                            materialization: githubMaterialization,
                            originSurface: "background" as const,
                        },
                        signal: options?.signal ?? observerSignal,
                        services: observerServices,
                    };
                    return await observer.runSourceAttempt(actionInput, sourceAttemptContext);
                }
                if (
                    actionId !== "automation.event.sources.list"
                    && actionId !== "automation.event.admit"
                    && actionId !== "automation.event.source.status.report"
                ) {
                    throw new Error(`unexpected Automation action: ${String(actionId)}`);
                }
                return await executor({
                    actionId,
                    input: actionInput,
                    caller: githubActionCaller,
                    ...(options?.signal === undefined ? {} : { signal: options.signal }),
                });
            };
            observerServices = {
                actions: { execute: dispatchAction },
                connectedAccounts: {
                    materialize: async () => ({
                        kind: "httpHeaders" as const,
                        headers: { Authorization: "Bearer GitHub checkpoint fixture" },
                    }),
                },
                http: {
                    request: async () => ({
                        status: 200,
                        headers: { etag: "composed-github-etag" },
                        body: new TextEncoder().encode(JSON.stringify([
                            {
                                id: "old",
                                type: "PushEvent",
                                created_at: "1970-01-01T00:00:00.900Z",
                                repo: { id: 77, name: "acme/widgets" },
                                payload: {
                                    ref: "refs/heads/main",
                                    before: "a".repeat(40),
                                    head: "b".repeat(40),
                                },
                            },
                            {
                                id: "new-composed-event",
                                type: "PushEvent",
                                created_at: "1970-01-01T00:00:01.100Z",
                                repo: { id: 77, name: "acme/widgets" },
                                payload: {
                                    ref: "refs/heads/main",
                                    before: "b".repeat(40),
                                    head: "c".repeat(40),
                                },
                            },
                        ])),
                    }),
                },
                storage: {
                    account: {
                        collection: () => checkpoints.collection,
                    },
                },
            };
            const observerContext = {
                plugin: { id: github.pluginId, version: PLUGIN_VERSION },
                contribution: {
                    id: github.backgroundServiceId,
                    qualifiedId: `${github.pluginId}/backgroundServices/${github.backgroundServiceId}`,
                },
                surface: "background" as const,
                signal: observerSignal,
                services: observerServices,
            };

            await observer.runCycle(observerContext);
            expect(checkpoints.read(checkpointRowId)).toMatchObject({
                revision: 1,
                value: {
                    [sources.checkpointFields.payload]: {
                        lastContiguousOccurrenceId: "github:repository:77:event:old",
                    },
                },
            });
            expect(admitRouteCalls).toBe(1);
            expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);

            now = 64_000;
            await observer.runCycle(observerContext);

            expect(storedDefinitionRouteCalls).toBeGreaterThan(0);
            expect(admitRouteCalls).toBe(2);
            expect(await db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);
            expect(checkpoints.read(checkpointRowId)).toMatchObject({
                revision: 2,
                value: {
                    [sources.checkpointFields.payload]: {
                        lastContiguousOccurrenceId: "github:repository:77:event:new-composed-event",
                        cursor: {
                            etag: "composed-github-etag",
                            seenEventIds: expect.arrayContaining(["old", "new-composed-event"]),
                        },
                    },
                },
            });
        } finally {
            await app.close();
        }
    });
});
