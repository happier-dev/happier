import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";

import {
    MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT,
    AutomationConversationAdmitInputV1Schema,
    buildAutomationConversationOccurrenceEvidenceV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    deriveAutomationOccurrenceKeyV1,
    deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1,
    normalizePluginReleaseFactsV1,
    openAutomationConversationReplyContextStoredEnvelopeV1,
    parseAutomationRunExecutionRecipeV1,
    parseAutomationStoredDefinitionExecutionRecipeV1,
    sealAccountScopedBlobCiphertext,
    sealAutomationConversationReplyContextStoredEnvelopeV1,
    sealAutomationOccurrenceTriggerEvidenceEnvelopeV1,
    sealAutomationRunTriggerEvidenceEnvelopeV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    serializeAutomationRunExecutionRecipeV1,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
    type AutomationConversationResultDeliveryV1,
    type PluginJsonValueV2,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { encodePlainAutomationOccurrenceEvidence } from "./automationOccurrencePersistence";
import {
    claimNextAutomationReplyHandoff,
    findNextAutomationReplyHandoffDueAt,
} from "./automationReplyHandoffService";
import {
    admitAutomationConversationV1 as admitPlainAutomationConversationV1,
    admitEncryptedAutomationConversationV1,
} from "./automationConversationAdmissionService";
import {
    listAutomationConversationTargetsV1,
    verifyAutomationConversationTargetV1,
} from "./automationConversationTargetVerificationService";

const ACCOUNT_ID = "account-conversation-admission";
const MACHINE_ID = "machine-conversation-admission";
const MACHINE_INSTALLATION_ID = "installation-conversation-admission";
const MATERIALIZATION_ID = "materialization-conversation-admission";
const SERVER_IDENTITY_ID = "srv_conversationAdmission";
const PLUGIN_ID = "happier.channels";
const PLUGIN_VERSION = "1.0.0";
const OTHER_PLUGIN_ID = "com.example.other";
const AUTOMATION_ID = "automation-conversation-admission";
const ARCHIVE_DIGEST = `sha256:${"a".repeat(64)}`;
const CONTRIBUTION_LOCAL_ID = "provider/observation-ingest-v1";
const BINDING_ID = "binding-conversation-admission";

const caller = {
    pluginId: PLUGIN_ID,
    contributionLocalId: CONTRIBUTION_LOCAL_ID,
    machineId: MACHINE_ID,
    machineInstallationId: MACHINE_INSTALLATION_ID,
    materializationId: MATERIALIZATION_ID,
    immutableGenerationId: "generation-channels-1",
} as const;

const releaseFacts = normalizePluginReleaseFactsV1({
    ref: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION },
    archiveDigestSha256: ARCHIVE_DIGEST,
    normalizedManifest: {
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: PLUGIN_VERSION,
        displayName: "Channels conversation admission fixture",
        engines: { happier: "^1.0.0" },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: "./dist/index.js" },
        contributes: { actions: [], events: [], webhooks: [] },
    },
    collectionContracts: [],
    uiSlots: [],
    packageAssetArchive: {
        archiveDigestSha256: `sha256:${"d".repeat(64)}`,
        resources: [],
    },
});

function strictConversationRunRecipe(
    target: Readonly<
        | { kind: "executionRun" }
        | { kind: "existingSession"; sessionId: string }
    > = { kind: "executionRun" },
    templateVersion = 3,
): string {
    const serialized = serializeAutomationStoredDefinitionExecutionRecipeV1({
        v: 1,
        templateVersion,
        template: {
            t: "plain",
            v: { v: 1, prompt: "Respond to the Conversation message." },
        },
        triggerEvidence: null,
        target: target.kind === "existingSession"
            ? target
            : {
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
        throw new Error("Failed to construct a strict Conversation Run execution recipe");
    }
    return serialized.serialized;
}

const FINAL_RESULT_DELIVERY = {
    kind: "finalResult",
    actionRef: {
        pluginId: "happier.channels",
        localId: "automation/result-deliver-v1",
    },
    opaqueContext: {
        connectionId: "connection-1",
        bindingId: BINDING_ID,
    },
} satisfies AutomationConversationResultDeliveryV1;

function conversationInput(params: Readonly<{
    resultDelivery?: AutomationConversationResultDeliveryV1;
}> = {}) {
    return {
        automationId: AUTOMATION_ID,
        bindingId: BINDING_ID,
        occurrenceId: "conversation-occurrence-admission",
        occurredAt: 1_723_247_200_000,
        sender: { id: "sender-1" },
        text: "Please summarize the latest change.",
        resultDelivery: params.resultDelivery ?? FINAL_RESULT_DELIVERY,
    };
}

/**
 * Direct service tests exercise the same host-owned precommit seal as the
 * public Action. Individual negative cases call the implementation alias when
 * they need to prove the server refuses a missing or mismatched envelope.
 */
async function admitAutomationConversationV1(
    params: Parameters<typeof admitPlainAutomationConversationV1>[0],
) {
    const input = AutomationConversationAdmitInputV1Schema.parse(params.input);
    const replyHandoff = params.replyHandoff ?? (input.resultDelivery.kind === "none"
        ? undefined
        : (() => {
            const occurrenceKey = deriveAutomationOccurrenceKeyV1(
                buildAutomationConversationOccurrenceEvidenceV1({
                    accountMode: "plain",
                    bindingId: input.bindingId,
                    occurrenceId: input.occurrenceId,
                    occurredAt: input.occurredAt,
                    caller: {
                        pluginId: params.caller.pluginId,
                        contributionLocalId: params.caller.contributionLocalId,
                        machineId: params.caller.machineId,
                    },
                    sender: input.sender,
                    text: input.text,
                    resultDelivery: input.resultDelivery,
                }),
            );
            return {
                actionRef: input.resultDelivery.actionRef,
                replyContextEnvelope: sealAutomationConversationReplyContextStoredEnvelopeV1({
                    mode: "plain",
                    correspondence: { automationId: input.automationId, occurrenceKey },
                    opaqueContext: input.resultDelivery.opaqueContext,
                }),
            };
        })());
    return await admitPlainAutomationConversationV1({
        ...params,
        ...(replyHandoff === undefined ? {} : { replyHandoff }),
    });
}

type E2eeAccountFixture = Readonly<{
    snapshot: ReturnType<typeof createAccountScopedCryptoMaterialSnapshotV1>;
    accountCurrentness: Readonly<{
        mode: "e2ee";
        version: number;
        contentKeyFingerprint: string;
    }>;
}>;

/**
 * `resealAutomationTemplate: false` leaves the Automation template in its plain
 * envelope so the persisted Account mode becomes the only fact that can refuse a
 * plaintext admission. Without it the downstream recipe-mode assertion returns
 * the same blocked result, and the refusal could be deleted unnoticed.
 */
async function configureE2eeAccount(params: Readonly<{
    resealAutomationTemplate?: boolean;
    target?: "executionRun" | "existingSession";
}> = {}): Promise<E2eeAccountFixture> {
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
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
        accountEncryptionMode: "e2ee",
        material: { type: "dataKey", machineKey: content.secretKey },
        dataKeyPublicKey: content.publicKey,
    });
    const account = await db.account.findUniqueOrThrow({
        where: { id: ACCOUNT_ID },
        select: { seq: true },
    });
    if (params.resealAutomationTemplate !== false) {
        const target = params.target ?? "executionRun";
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: {
                targetType: target === "existingSession" ? "existing_session" : "execution_run",
                templateCiphertext: encryptedConversationDefinitionRecipe(snapshot, target),
            },
        });
    }
    return {
        snapshot,
        accountCurrentness: {
            mode: "e2ee",
            version: account.seq,
            contentKeyFingerprint:
                convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                    snapshot.contentPublicKeyFingerprint,
                ),
        },
    };
}

function encryptedConversationDefinitionRecipe(
    snapshot: ReturnType<typeof createAccountScopedCryptoMaterialSnapshotV1>,
    target: "executionRun" | "existingSession" = "executionRun",
): string {
    const serialized = serializeAutomationStoredDefinitionExecutionRecipeV1({
        v: 1,
        templateVersion: 3,
        template: {
            t: "encrypted",
            c: sealAccountScopedBlobCiphertext({
                kind: "automation_template_payload",
                material: snapshot.material,
                payload: { v: 1, prompt: "Respond to the Conversation message." },
                randomBytes: (length: number) => Uint8Array.from({ length }, (_, index) => index + 31),
            }),
        },
        triggerEvidence: null,
        target: target === "existingSession"
            ? { kind: "existingSession", sessionId: "session-conversation-target" }
            : {
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
        throw new Error("Encrypted Conversation admission fixture must use a valid strict recipe");
    }
    return serialized.serialized;
}

/**
 * Builds exactly what the authenticated admission host produces for an E2EE
 * Account: sealed occurrence evidence, sealed Run trigger evidence, and the
 * opaque equality tag. `nonceSeed` varies the randomized ciphertext so a replay
 * can only rejoin through the tag, never through matching bytes.
 */
function encryptedConversationHostEvidence(params: Readonly<{
    account: E2eeAccountFixture;
    nonceSeed: number;
    text?: string;
    occurredAt?: number;
    resultDelivery?: AutomationConversationResultDeliveryV1;
}>) {
    const resultDelivery = params.resultDelivery ?? { kind: "none" };
    const input = conversationInput({ resultDelivery });
    const evidence = buildAutomationConversationOccurrenceEvidenceV1({
        accountMode: "e2ee",
        bindingId: input.bindingId,
        occurrenceId: input.occurrenceId,
        occurredAt: params.occurredAt ?? input.occurredAt,
        caller: {
            pluginId: caller.pluginId,
            contributionLocalId: caller.contributionLocalId,
            machineId: caller.machineId,
        },
        sender: input.sender,
        text: params.text ?? input.text,
        resultDelivery,
    });
    const occurrenceKey = deriveAutomationOccurrenceKeyV1(evidence);
    const replyHandoff = resultDelivery.kind === "none"
        ? undefined
        : {
            actionRef: resultDelivery.actionRef,
            replyContextEnvelope: sealAutomationConversationReplyContextStoredEnvelopeV1({
                mode: "e2ee",
                material: params.account.snapshot.material,
                randomBytes: (length: number) => Uint8Array.from(
                    { length },
                    (_, index) => (index + params.nonceSeed + 193) % 251,
                ),
                correspondence: { automationId: input.automationId, occurrenceKey },
                opaqueContext: resultDelivery.opaqueContext,
            }),
        };
    return {
        v: 1 as const,
        t: "encrypted" as const,
        accountCurrentness: params.account.accountCurrentness,
        automationId: input.automationId,
        occurrenceKey,
        occurredAt: params.occurredAt ?? input.occurredAt,
        triggerEvidenceEnvelope: sealAutomationOccurrenceTriggerEvidenceEnvelopeV1({
            material: params.account.snapshot.material,
            evidence,
            randomBytes: (length: number) => Uint8Array.from(
                { length },
                (_, index) => (index + params.nonceSeed) % 251,
            ),
        }),
        executionTriggerEvidenceEnvelope: sealAutomationRunTriggerEvidenceEnvelopeV1({
            material: params.account.snapshot.material,
            evidence: { ...evidence, observationReceivedAt: 1_723_247_200_500 },
            randomBytes: (length: number) => Uint8Array.from(
                { length },
                (_, index) => (index + params.nonceSeed + 97) % 251,
            ),
        }),
        occurrenceEvidenceEqualityTag: deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1({
            material: params.account.snapshot.material,
            accountId: ACCOUNT_ID,
            automationId: input.automationId,
            evidence,
        }),
        ...(replyHandoff === undefined ? {} : { replyHandoff }),
    };
}

/**
 * The current Conversation definition recipe the capacity seeds freeze. It is
 * read through the canonical stored-definition owner so a queued capacity row
 * carries exactly the frozen input the plain admission writer would produce
 * for this Automation.
 */
const CONVERSATION_CAPACITY_DEFINITION_RECIPE = (() => {
    const definition = parseAutomationStoredDefinitionExecutionRecipeV1(
        strictConversationRunRecipe(),
    );
    if (definition.kind !== "available") {
        throw new Error("Capacity seed must read the current Conversation definition recipe");
    }
    return definition.recipe;
})();

/**
 * One truthful queued Conversation capacity row. Capacity occupancy satisfies
 * the same physical nonterminal frozen-input invariant as admitted Runs: the
 * seed freezes the current definition recipe together with the row's own
 * immutable occurrence evidence, its derived occurrence key, and the plain
 * stored evidence envelope, so no capacity row evades the database CHECK with
 * missing or placeholder bytes.
 */
function conversationCapacityRunSeed(params: Readonly<{
    id: string;
    index: number;
    now: Date;
}>) {
    const evidence = buildAutomationConversationOccurrenceEvidenceV1({
        accountMode: "plain",
        bindingId: BINDING_ID,
        occurrenceId: `conversation-capacity-occurrence-${params.index}`,
        occurredAt: params.now.getTime(),
        caller: {
            pluginId: caller.pluginId,
            contributionLocalId: caller.contributionLocalId,
            machineId: caller.machineId,
        },
        sender: { id: "sender-1" },
        text: "Please summarize the latest change.",
        resultDelivery: { kind: "none" },
    });
    const frozen = serializeAutomationRunExecutionRecipeV1({
        ...CONVERSATION_CAPACITY_DEFINITION_RECIPE,
        triggerEvidence: {
            t: "plain" as const,
            v: { ...evidence, observationReceivedAt: params.now.getTime() },
        },
        assignmentMachineIds: [],
    });
    if (frozen.kind !== "available") {
        throw new Error("Capacity seed must freeze a valid strict Conversation recipe");
    }
    return {
        id: params.id,
        automationId: AUTOMATION_ID,
        accountId: ACCOUNT_ID,
        state: "queued" as const,
        causeKind: "conversation" as const,
        causeOccurredAt: params.now,
        occurrenceKey: deriveAutomationOccurrenceKeyV1(evidence),
        legacyManualIdempotencyKey: null,
        triggerEvidenceEnvelope: encodePlainAutomationOccurrenceEvidence(evidence),
        executionInputEnvelope: frozen.serialized,
        executionDispatchState: "notStarted" as const,
        scheduledAt: params.now,
        dueAt: params.now,
    };
}

describe("Automation Conversation admission database boundary", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-conversation-admission-",
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
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
            () => db.simpleCache.deleteMany(),
        ]);
    });

    beforeEach(async () => {
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
                archiveDigestSha256: releaseFacts.archiveDigestSha256,
                normalizedManifest: releaseFacts.normalizedManifest,
                collectionContracts: releaseFacts.collectionContracts,
                uiSlots: releaseFacts.uiSlots,
                packageAssetArchive: releaseFacts.packageAssetArchive,
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
                archiveDigestSha256: ARCHIVE_DIGEST,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-12T00:00:00.000Z"),
            },
        });
        await db.automation.create({
            data: {
                id: AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                name: "Conversation admission",
                enabled: true,
                targetType: "execution_run",
                templateCiphertext: strictConversationRunRecipe(),
                templateVersion: 3,
            },
        });
        // Assignment-liveness: an enabled Automation must keep one enabled
        // execution assignment or canonical admission refuses every occurrence.
        await db.automationAssignment.create({
            data: { automationId: AUTOMATION_ID, machineId: MACHINE_ID, enabled: true },
        });
    });

    async function configurePlainExistingSessionTarget(): Promise<void> {
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: {
                targetType: "existing_session",
                templateCiphertext: strictConversationRunRecipe({
                    kind: "existingSession",
                    sessionId: "session-conversation-target",
                }),
            },
        });
    }

    it("persists resultDelivery:none without handoff facts, a wake, or a claim", async () => {
        const input = conversationInput({ resultDelivery: { kind: "none" } });
        const admitted = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        });

        expect(admitted).toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        if (admitted.kind !== "admitted") throw new Error("Expected Conversation admission");
        const run = await db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: {
                causeKind: true,
                causeOccurredAt: true,
                triggerId: true,
                occurrenceKey: true,
                triggerEvidenceEnvelope: true,
                executionDispatchState: true,
                replyContextEnvelope: true,
                replyHandoffActionPluginId: true,
                replyHandoffActionLocalId: true,
                replyHandoffTargetMachineId: true,
                replyHandoffTargetMachineInstallationId: true,
                replyHandoffTargetMaterializationId: true,
                replyHandoffId: true,
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
                replyHandoffReceiptEnvelope: true,
            },
        });

        expect(run).toEqual({
            causeKind: "conversation",
            causeOccurredAt: new Date(input.occurredAt),
            triggerId: null,
            occurrenceKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            triggerEvidenceEnvelope: expect.any(String),
            executionDispatchState: "notStarted",
            replyContextEnvelope: null,
            replyHandoffActionPluginId: null,
            replyHandoffActionLocalId: null,
            replyHandoffTargetMachineId: null,
            replyHandoffTargetMachineInstallationId: null,
            replyHandoffTargetMaterializationId: null,
            replyHandoffId: null,
            replyHandoffState: "none",
            replyHandoffAttempt: 0,
            replyHandoffDueAt: null,
            replyHandoffReceiptEnvelope: null,
        });
        await expect(findNextAutomationReplyHandoffDueAt({ now: new Date() })).resolves.toBeNull();
        await expect(claimNextAutomationReplyHandoff({ now: new Date() })).resolves.toBeNull();
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input: conversationInput(),
        })).resolves.toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });
    });

    it("keeps a corrupted zero-assignment Conversation occurrence retryable with its exact reason", async () => {
        await db.automationAssignment.deleteMany({ where: { automationId: AUTOMATION_ID } });

        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input: conversationInput({ resultDelivery: { kind: "none" } }),
        })).resolves.toEqual({
            kind: "blocked",
            reason: "noEnabledAssignment",
            checkpointSafe: false,
        });
        await expect(db.automationRun.count({ where: { automationId: AUTOMATION_ID } })).resolves.toBe(0);
    });

    it("rejects final-result delivery for executionRun before persistence and admits the same request for a Session target", async () => {
        const unsupportedInput = conversationInput();

        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                automationId: AUTOMATION_ID,
                resultDelivery: "finalResult",
            },
        })).resolves.toEqual({
            kind: "notVerified",
            reason: "resultDeliveryUnsupported",
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input: unsupportedInput,
        })).resolves.toEqual({
            kind: "blocked",
            reason: "resultDeliveryUnsupported",
            checkpointSafe: false,
        });
        await expect(db.automationRun.count({
            where: { automationId: AUTOMATION_ID },
        })).resolves.toBe(0);

        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: {
                targetType: "existing_session",
                templateCiphertext: strictConversationRunRecipe({
                    kind: "existingSession",
                    sessionId: "session-conversation-target",
                }),
            },
        });

        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                automationId: AUTOMATION_ID,
                resultDelivery: "finalResult",
            },
        })).resolves.toEqual({ kind: "verified" });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...unsupportedInput,
                occurrenceId: "conversation-occurrence-session-target",
            },
        })).resolves.toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        await expect(db.automationRun.count({
            where: { automationId: AUTOMATION_ID },
        })).resolves.toBe(1);
    });

    it("feeds one zero-trigger Automation from several conversation bindings without inventing a trigger", async () => {
        // A Discord thread and a Telegram chat can both drive the same daily
        // Automation. Each binding keeps its own occurrence identity, so both
        // admit distinct Runs against one durable target.
        const first = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...conversationInput({ resultDelivery: { kind: "none" } }),
                bindingId: "binding-discord-thread-a",
            },
        });
        const second = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...conversationInput({ resultDelivery: { kind: "none" } }),
                bindingId: "binding-telegram-chat-b",
            },
        });

        expect(first).toEqual({ kind: "admitted", runId: expect.any(String), checkpointSafe: true });
        expect(second).toEqual({ kind: "admitted", runId: expect.any(String), checkpointSafe: true });
        if (first.kind !== "admitted" || second.kind !== "admitted") {
            throw new Error("Expected both bindings to admit into the same Automation");
        }
        expect(first.runId).not.toBe(second.runId);
        await expect(db.automationRun.count({
            where: { accountId: ACCOUNT_ID, automationId: AUTOMATION_ID },
        })).resolves.toBe(2);
        // Direct conversation invocation is a cause, never a synthetic trigger.
        await expect(db.automation.findUniqueOrThrow({
            where: { id: AUTOMATION_ID },
            select: { triggers: { select: { id: true } } },
        })).resolves.toEqual({ triggers: [] });
    });

    it("rejoins only the same logical Channels caller across a materialization rollover", async () => {
        const input = conversationInput({ resultDelivery: { kind: "none" } });
        const admitted = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        });
        expect(admitted).toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        if (admitted.kind !== "admitted") throw new Error("Expected Conversation admission");

        await db.pluginMachineMaterialization.update({
            where: {
                machineId_materializationId: {
                    machineId: MACHINE_ID,
                    materializationId: MATERIALIZATION_ID,
                },
            },
            data: { enabled: false },
        });
        const replacementMaterializationId = "materialization-conversation-admission-v2";
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: replacementMaterializationId,
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: ARCHIVE_DIGEST,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-12T00:01:00.000Z"),
            },
        });
        const replacementCaller = {
            ...caller,
            materializationId: replacementMaterializationId,
        };
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: replacementCaller,
            input,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });

        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: {
                ...replacementCaller,
                contributionLocalId: "provider/other-observation-ingest-v1",
            },
            input,
        })).resolves.toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });

        const otherMachineId = "machine-conversation-admission-other";
        const otherMachineInstallationId = "installation-conversation-admission-other";
        const otherMachineMaterializationId = "materialization-conversation-admission-other";
        await db.machine.create({
            data: {
                id: otherMachineId,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: otherMachineInstallationId,
                pluginMaterializationRevision: 1n,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: otherMachineId,
                materializationId: otherMachineMaterializationId,
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: ARCHIVE_DIGEST,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-12T00:02:00.000Z"),
            },
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: {
                ...caller,
                machineId: otherMachineId,
                machineInstallationId: otherMachineInstallationId,
                materializationId: otherMachineMaterializationId,
            },
            input,
        })).resolves.toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });
        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
    });

    it("creates one Run and equality-rejoins an exact concurrent Conversation admission", async () => {
        const input = conversationInput({ resultDelivery: { kind: "none" } });
        const [first, second] = await Promise.all([
            admitAutomationConversationV1({ accountId: ACCOUNT_ID, caller, input }),
            admitAutomationConversationV1({ accountId: ACCOUNT_ID, caller, input }),
        ]);
        const results = [first, second];
        expect(results.map((result) => result.kind).sort()).toEqual(["admitted", "rejoined"]);
        expect(results.every((result) => result.checkpointSafe)).toBe(true);
        const runIds = results.flatMap((result) => (
            result.kind === "admitted" || result.kind === "rejoined" ? [result.runId] : []
        ));
        expect(new Set(runIds).size).toBe(1);
        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
    });

    it("releases Conversation Run capacity after an exhausted execution Run is terminally failed", async () => {
        const now = new Date();
        await db.automationRun.createMany({
            data: Array.from(
                { length: MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT },
                (_, index) => conversationCapacityRunSeed({
                    id: `conversation-capacity-run-${index}`,
                    index,
                    now,
                }),
            ),
        });

        const input = conversationInput({ resultDelivery: { kind: "none" } });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        })).resolves.toEqual({
            kind: "blocked",
            reason: "capacity",
            checkpointSafe: false,
        });

        await db.automationRun.update({
            where: { id: "conversation-capacity-run-9999" },
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

        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        })).resolves.toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: "conversation-capacity-run-9999" },
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

    it("admits the same observed occurrence independently for each matching Automation", async () => {
        const secondAutomationId = "automation-conversation-admission-second";
        await db.automation.create({
            data: {
                id: secondAutomationId,
                accountId: ACCOUNT_ID,
                name: "Second Conversation admission",
                enabled: true,
                targetType: "execution_run",
                templateCiphertext: strictConversationRunRecipe(),
                templateVersion: 3,
            },
        });
        await db.automationAssignment.create({
            data: { automationId: secondAutomationId, machineId: MACHINE_ID, enabled: true },
        });
        await db.automationTrigger.create({
            data: {
                automationId: secondAutomationId,
                kind: "schedule",
                enabled: true,
                revision: 1,
                scheduleKind: "interval",
                everyMs: 60_000,
            },
        });

        const input = conversationInput({ resultDelivery: { kind: "none" } });
        const [first, second] = await Promise.all([
            admitAutomationConversationV1({ accountId: ACCOUNT_ID, caller, input }),
            admitAutomationConversationV1({
                accountId: ACCOUNT_ID,
                caller,
                input: { ...input, automationId: secondAutomationId },
            }),
        ]);

        expect(first).toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        expect(second).toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        if (first.kind !== "admitted" || second.kind !== "admitted") {
            throw new Error("Expected both matching Automations to admit the occurrence");
        }
        expect(first.runId).not.toBe(second.runId);

        const runs = await db.automationRun.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { automationId: "asc" },
            select: { automationId: true, occurrenceKey: true },
        });
        expect(runs).toEqual([
            { automationId: AUTOMATION_ID, occurrenceKey: expect.any(String) },
            { automationId: secondAutomationId, occurrenceKey: expect.any(String) },
        ]);
        expect(new Set(runs.map((run) => run.occurrenceKey)).size).toBe(1);
    });

    it("creates one Run and conflicts a concurrent same occurrence from a different logical caller", async () => {
        const input = conversationInput({ resultDelivery: { kind: "none" } });
        const [first, second] = await Promise.all([
            admitAutomationConversationV1({ accountId: ACCOUNT_ID, caller, input }),
            admitAutomationConversationV1({
                accountId: ACCOUNT_ID,
                caller: {
                    ...caller,
                    contributionLocalId: "provider/other-observation-ingest-v1",
                },
                input,
            }),
        ]);
        const results = [first, second];
        expect(results.map((result) => result.kind).sort()).toEqual(["admitted", "blocked"]);
        expect(results.find((result) => result.kind === "blocked")).toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });
        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
    });

    it("lists, verifies, and admits an existing Account Automation for an out-of-tree plugin", async () => {
        const externalPluginId = "acme.slack-bridge";
        const externalMaterializationId = "materialization-acme-slack-bridge";
        const externalReleaseFacts = normalizePluginReleaseFactsV1({
            ref: { pluginId: externalPluginId, version: PLUGIN_VERSION },
            archiveDigestSha256: ARCHIVE_DIGEST,
            normalizedManifest: {
                schemaVersion: 2,
                id: externalPluginId,
                version: PLUGIN_VERSION,
                displayName: "Out-of-tree bridge fixture",
                engines: { happier: "^1.0.0" },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: "./dist/index.js" },
                contributes: { actions: [], events: [], webhooks: [] },
            },
            collectionContracts: [],
            uiSlots: [],
            packageAssetArchive: releaseFacts.packageAssetArchive,
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: externalPluginId,
                desiredVersion: PLUGIN_VERSION,
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: externalPluginId,
                version: PLUGIN_VERSION,
                archiveDigestSha256: externalReleaseFacts.archiveDigestSha256,
                normalizedManifest: externalReleaseFacts.normalizedManifest,
                collectionContracts: externalReleaseFacts.collectionContracts,
                uiSlots: externalReleaseFacts.uiSlots,
                packageAssetArchive: externalReleaseFacts.packageAssetArchive,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: externalMaterializationId,
                pluginId: externalPluginId,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: ARCHIVE_DIGEST,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-12T00:00:00.000Z"),
            },
        });

        const externalCaller = {
            pluginId: externalPluginId,
            contributionLocalId: "slack/observation-ingest-v1",
            machineId: MACHINE_ID,
            machineInstallationId: MACHINE_INSTALLATION_ID,
            materializationId: externalMaterializationId,
            immutableGenerationId: "generation-slack-bridge-1",
        } as const;
        const externalBindingId = "binding-acme-slack-bridge";

        // The target is an ordinary Account Automation with its own schedule.
        // The out-of-tree plugin never authors it; it binds the one the user
        // already has, exactly as the bundled plugin would.
        const scheduledAutomationId = "automation-conversation-admission-scheduled";
        await db.automation.create({
            data: {
                id: scheduledAutomationId,
                accountId: ACCOUNT_ID,
                name: "Slack bridge conversation",
                enabled: true,
                targetType: "existing_session",
                templateCiphertext: strictConversationRunRecipe({
                    kind: "existingSession",
                    sessionId: "session-slack-bridge-target",
                }),
                templateVersion: 3,
            },
        });
        await db.automationTrigger.create({
            data: {
                automationId: scheduledAutomationId,
                kind: "schedule",
                enabled: true,
                revision: 1,
                scheduleKind: "interval",
                everyMs: 60_000,
            },
        });
        await db.automationAssignment.create({
            data: {
                automationId: scheduledAutomationId,
                machineId: MACHINE_ID,
                enabled: true,
            },
        });
        const created = { kind: "created" as const, automationId: scheduledAutomationId };

        const externalTargets = await listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller: externalCaller,
            input: {},
        });
        const channelsTargets = await listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {},
        });
        // Identical capability: the out-of-tree plugin sees exactly the same
        // Account targets the bundled plugin does.
        expect(externalTargets).toEqual(channelsTargets);
        expect(externalTargets.items.map((item) => item.automationId).sort())
            .toEqual([AUTOMATION_ID, scheduledAutomationId].sort());

        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller: externalCaller,
            input: {
                automationId: created.automationId,
                resultDelivery: "finalResult",
            },
        })).resolves.toEqual({ kind: "verified" });
        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                automationId: created.automationId,
                resultDelivery: "finalResult",
            },
        })).resolves.toEqual({ kind: "verified" });

        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: externalCaller,
            input: {
                automationId: created.automationId,
                bindingId: externalBindingId,
                occurrenceId: "slack:event:1",
                occurredAt: 1_724_000_000_000,
                sender: { id: "U-123" },
                text: "Please summarize the latest change.",
                resultDelivery: {
                    kind: "finalResult",
                    actionRef: {
                        pluginId: externalPluginId,
                        localId: "automation/reply-deliver-v1",
                    },
                    opaqueContext: { channelId: "C-123" },
                },
            },
        })).resolves.toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });

        // The reply handoff is frozen onto the authoring plugin's own Action.
        await expect(db.automationRun.findFirst({
            where: { automationId: created.automationId },
            select: {
                replyHandoffActionPluginId: true,
                replyHandoffActionLocalId: true,
                replyHandoffTargetMachineId: true,
                replyHandoffState: true,
            },
        })).resolves.toEqual({
            replyHandoffActionPluginId: externalPluginId,
            replyHandoffActionLocalId: "automation/reply-deliver-v1",
            replyHandoffTargetMachineId: MACHINE_ID,
            replyHandoffState: "awaitingResult",
        });
    });

    it("admits a current external plugin materialization through the generic conversation policy", async () => {
        const otherReleaseFacts = normalizePluginReleaseFactsV1({
            ref: { pluginId: OTHER_PLUGIN_ID, version: PLUGIN_VERSION },
            archiveDigestSha256: ARCHIVE_DIGEST,
            normalizedManifest: {
                schemaVersion: 2,
                id: OTHER_PLUGIN_ID,
                version: PLUGIN_VERSION,
                displayName: "Other plugin fixture",
                engines: { happier: "^1.0.0" },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: "./dist/index.js" },
                contributes: { actions: [], events: [], webhooks: [] },
            },
            collectionContracts: [],
            uiSlots: [],
            packageAssetArchive: releaseFacts.packageAssetArchive,
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: OTHER_PLUGIN_ID,
                desiredVersion: PLUGIN_VERSION,
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: OTHER_PLUGIN_ID,
                version: PLUGIN_VERSION,
                archiveDigestSha256: otherReleaseFacts.archiveDigestSha256,
                normalizedManifest: otherReleaseFacts.normalizedManifest,
                collectionContracts: otherReleaseFacts.collectionContracts,
                uiSlots: otherReleaseFacts.uiSlots,
                packageAssetArchive: otherReleaseFacts.packageAssetArchive,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: "materialization-other-plugin",
                pluginId: OTHER_PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: ARCHIVE_DIGEST,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-12T00:00:00.000Z"),
            },
        });

        const externalCaller = {
            ...caller,
            pluginId: OTHER_PLUGIN_ID,
            materializationId: "materialization-other-plugin",
        };
        // The Account's Automations belong to the user, not to a plugin: an
        // out-of-tree plugin binds the very same target the bundled plugin can,
        // with byte-identical capability and no policy row naming either id.
        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller: externalCaller,
            input: { automationId: AUTOMATION_ID },
        })).resolves.toEqual({ kind: "verified" });
        await expect(listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller: externalCaller,
            input: {},
        })).resolves.toEqual({
            items: [{
                automationId: AUTOMATION_ID,
                label: "Conversation admission",
                execution: { targetType: "execution_run", enabled: true },
            }],
            nextCursor: null,
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: externalCaller,
            input: {
                ...conversationInput({ resultDelivery: { kind: "none" } }),
                bindingId: "binding-out-of-tree",
            },
        })).resolves.toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        await expect(db.automationRun.count()).resolves.toBe(1);
    });

    it("freezes finalResult custody and rejects a rejoin with a changed opaque context", async () => {
        await configurePlainExistingSessionTarget();
        const input = conversationInput();
        const finalResultDelivery = input.resultDelivery;
        if (finalResultDelivery.kind !== "finalResult") {
            throw new Error("Expected final-result test fixture");
        }
        const admitted = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        });

        expect(admitted).toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        if (admitted.kind !== "admitted") throw new Error("Expected Conversation admission");
        const run = await db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: {
                replyContextEnvelope: true,
                replyHandoffActionPluginId: true,
                replyHandoffActionLocalId: true,
                replyHandoffTargetMachineId: true,
                replyHandoffTargetMachineInstallationId: true,
                replyHandoffTargetMaterializationId: true,
                replyHandoffId: true,
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
                replyHandoffReceiptEnvelope: true,
            },
        });

        expect(run).toEqual({
            replyContextEnvelope: expect.any(String),
            replyHandoffActionPluginId: "happier.channels",
            replyHandoffActionLocalId: "automation/result-deliver-v1",
            replyHandoffTargetMachineId: MACHINE_ID,
            replyHandoffTargetMachineInstallationId: MACHINE_INSTALLATION_ID,
            replyHandoffTargetMaterializationId: MATERIALIZATION_ID,
            replyHandoffId: expect.any(String),
            replyHandoffState: "awaitingResult",
            replyHandoffAttempt: 0,
            replyHandoffDueAt: null,
            replyHandoffReceiptEnvelope: null,
        });
        expect(JSON.parse(run.replyContextEnvelope!)).toEqual({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    automationId: AUTOMATION_ID,
                    occurrenceKey: expect.any(String),
                },
                opaqueContext: finalResultDelivery.opaqueContext,
            },
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });
        await db.pluginMachineMaterialization.update({
            where: {
                machineId_materializationId: {
                    machineId: MACHINE_ID,
                    materializationId: MATERIALIZATION_ID,
                },
            },
            data: { enabled: false },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: "materialization-conversation-admission-v2",
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: ARCHIVE_DIGEST,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-12T00:01:00.000Z"),
            },
        });
        const replacementCaller = {
            ...caller,
            materializationId: "materialization-conversation-admission-v2",
        };
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: replacementCaller,
            input,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: { replyHandoffTargetMaterializationId: true },
        })).resolves.toEqual({
            replyHandoffTargetMaterializationId: MATERIALIZATION_ID,
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: replacementCaller,
            input: conversationInput({
                resultDelivery: {
                    kind: "finalResult",
                    actionRef: {
                        pluginId: "happier.channels",
                        localId: "automation/result-deliver-v1",
                    },
                    opaqueContext: {
                        connectionId: "connection-1",
                        bindingId: "binding-conversation-admission",
                        replacement: true,
                    },
                },
            }),
        })).resolves.toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: { templateVersion: 4 },
        });
        const frozenReplyContext = await db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: { replyContextEnvelope: true },
        });
        expect(JSON.parse(frozenReplyContext.replyContextEnvelope!)).toEqual({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    automationId: AUTOMATION_ID,
                    occurrenceKey: expect.any(String),
                },
                opaqueContext: finalResultDelivery.opaqueContext,
            },
        });
    });

    it.each([
        ["a template edit", async () => {
            await db.automation.update({
                where: { id: AUTOMATION_ID },
                data: { templateVersion: 4 },
            });
        }],
        ["disabling the Automation", async () => {
            await db.automation.update({
                where: { id: AUTOMATION_ID },
                data: { enabled: false },
            });
        }],
    ] as const)("rejoins an exact frozen final-result handoff after %s", async (_description, mutate) => {
        await configurePlainExistingSessionTarget();
        const input = conversationInput();
        const finalResultDelivery = input.resultDelivery;
        if (finalResultDelivery.kind !== "finalResult") {
            throw new Error("Expected final-result test fixture");
        }
        const admitted = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        });
        if (admitted.kind !== "admitted") throw new Error("Expected Conversation admission");

        const frozenHandoff = await db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: {
                replyHandoffId: true,
                replyHandoffState: true,
                replyContextEnvelope: true,
            },
        });
        expect(JSON.parse(frozenHandoff.replyContextEnvelope!)).toMatchObject({
            v: {
                correspondence: {
                    automationId: AUTOMATION_ID,
                    occurrenceKey: expect.any(String),
                },
            },
        });
        const accountChangesBeforeReplay = await db.accountChange.count({
            where: { accountId: ACCOUNT_ID },
        });

        await mutate();

        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input: conversationInput({
                resultDelivery: {
                    ...finalResultDelivery,
                    opaqueContext: {
                        connectionId: "connection-1",
                        bindingId: BINDING_ID,
                        changedAfterAdmission: true,
                    },
                },
            }),
        })).resolves.toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });
        await expect(db.automationRun.count({
            where: { accountId: ACCOUNT_ID },
        })).resolves.toBe(1);
        await expect(db.accountChange.count({
            where: { accountId: ACCOUNT_ID },
        })).resolves.toBe(accountChangesBeforeReplay);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: {
                replyHandoffId: true,
                replyHandoffState: true,
                replyContextEnvelope: true,
            },
        })).resolves.toEqual(frozenHandoff);
    });

    it("uses the current recipe at first admission and preserves that Run and handoff on replay", async () => {
        const target = {
            kind: "existingSession" as const,
            sessionId: "session-conversation-target",
        };
        const currentRecipe = strictConversationRunRecipe(target, 4);
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: {
                targetType: "existing_session",
                templateCiphertext: currentRecipe,
                templateVersion: 4,
            },
        });

        const input = conversationInput();
        const admitted = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        });
        if (admitted.kind !== "admitted") throw new Error("Expected Conversation admission");

        const frozen = await db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: {
                executionInputEnvelope: true,
                replyContextEnvelope: true,
                replyHandoffId: true,
            },
        });
        if (frozen.executionInputEnvelope === null) throw new Error("Expected frozen Conversation recipe");
        const frozenRecipe = parseAutomationRunExecutionRecipeV1(frozen.executionInputEnvelope);
        expect(frozenRecipe).toMatchObject({
            kind: "available",
            recipe: {
                templateVersion: 4,
                target,
            },
        });
        if (frozenRecipe.kind !== "available") throw new Error("Expected frozen Conversation recipe");
        expect(frozenRecipe.recipe.triggerEvidence).not.toBeNull();
        expect(JSON.parse(frozen.replyContextEnvelope!)).toMatchObject({
            t: "plain",
            v: {
                correspondence: {
                    automationId: AUTOMATION_ID,
                    occurrenceKey: expect.any(String),
                },
                opaqueContext: FINAL_RESULT_DELIVERY.opaqueContext,
            },
        });
        expect(JSON.parse(frozen.replyContextEnvelope!).v).not.toHaveProperty("templateVersion");

        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: {
                templateCiphertext: strictConversationRunRecipe(target, 5),
                templateVersion: 5,
            },
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: {
                executionInputEnvelope: true,
                replyContextEnvelope: true,
                replyHandoffId: true,
            },
        })).resolves.toEqual(frozen);
    });

    it("admits an E2EE Conversation occurrence from sealed host evidence and rejoins its replay by tag", async () => {
        const account = await configureE2eeAccount();
        const hostEvidence = encryptedConversationHostEvidence({ account, nonceSeed: 1 });

        const admitted = await admitEncryptedAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            hostEvidence,
        });
        expect(admitted).toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        if (admitted.kind !== "admitted") throw new Error("Expected an E2EE Conversation admission");

        const run = await db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: {
                triggerId: true,
                causeKind: true,
                causeOccurredAt: true,
                occurrenceKey: true,
                occurrenceEvidenceEqualityTag: true,
                causeSourceSelectorId: true,
                triggerEvidenceEnvelope: true,
                executionInputEnvelope: true,
                replyContextEnvelope: true,
                replyHandoffState: true,
            },
        });
        expect(run.triggerId).toBeNull();
        expect(run.causeKind).toBe("conversation");
        expect(run.causeOccurredAt).toEqual(new Date(hostEvidence.occurredAt));
        expect(run.occurrenceKey).toBe(hostEvidence.occurrenceKey);
        expect(run.occurrenceEvidenceEqualityTag)
            .toBe(hostEvidence.occurrenceEvidenceEqualityTag);
        expect(run.causeSourceSelectorId).toBeNull();
        expect(run.replyContextEnvelope).toBeNull();
        expect(run.replyHandoffState).toBe("none");
        expect(JSON.parse(run.triggerEvidenceEnvelope ?? "null"))
            .toEqual(hostEvidence.triggerEvidenceEnvelope);
        // The sealed Run evidence must reach the frozen recipe: without it the
        // exact-machine materializer renders an empty Automation input.
        expect(JSON.parse(run.executionInputEnvelope ?? "null")).toMatchObject({
            triggerEvidence: hostEvidence.executionTriggerEvidenceEnvelope,
            template: { t: "encrypted" },
        });
        // Nothing the Account sealed may appear in any server-readable column.
        const storedBytes = JSON.stringify(run);
        expect(storedBytes).not.toContain("Please summarize the latest change.");
        expect(storedBytes).not.toContain("sender-1");
        expect(storedBytes).not.toContain(BINDING_ID);

        // A replay reseals the same occurrence under a different nonce, so only
        // the opaque equality tag can rejoin it.
        const replay = encryptedConversationHostEvidence({ account, nonceSeed: 140 });
        expect(replay.triggerEvidenceEnvelope.c)
            .not.toBe(hostEvidence.triggerEvidenceEnvelope.c);
        expect(replay.occurrenceEvidenceEqualityTag)
            .toBe(hostEvidence.occurrenceEvidenceEqualityTag);
        await expect(admitEncryptedAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            hostEvidence: replay,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });

        // Same occurrence identity, different sealed content: the tag differs
        // and the conflict is reported instead of silently rejoining.
        await expect(admitEncryptedAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            hostEvidence: encryptedConversationHostEvidence({
                account,
                nonceSeed: 200,
                text: "A different message under the same occurrence id.",
            }),
        })).resolves.toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });
        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
    });

    it("freezes an E2EE final-result handoff before the Run exists and retains it for the actual Run", async () => {
        const account = await configureE2eeAccount({ target: "existingSession" });
        const hostEvidence = encryptedConversationHostEvidence({
            account,
            nonceSeed: 31,
            resultDelivery: FINAL_RESULT_DELIVERY,
        });

        const admitted = await admitEncryptedAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            hostEvidence,
        });
        expect(admitted).toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        if (admitted.kind !== "admitted") throw new Error("Expected an E2EE Conversation admission");

        const run = await db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: {
                occurrenceKey: true,
                replyContextEnvelope: true,
                replyHandoffActionPluginId: true,
                replyHandoffActionLocalId: true,
                replyHandoffId: true,
                replyHandoffState: true,
            },
        });
        expect(run.occurrenceKey).toBe(hostEvidence.occurrenceKey);
        expect(run.replyHandoffActionPluginId).toBe(FINAL_RESULT_DELIVERY.actionRef.pluginId);
        expect(run.replyHandoffActionLocalId).toBe(FINAL_RESULT_DELIVERY.actionRef.localId);
        expect(run.replyHandoffId).toBe(`automation-reply-handoff:${admitted.runId}`);
        expect(run.replyHandoffState).toBe("awaitingResult");
        expect(JSON.parse(run.replyContextEnvelope ?? "null")).toMatchObject({ t: "encrypted" });
        expect(JSON.stringify(run)).not.toContain(FINAL_RESULT_DELIVERY.opaqueContext.connectionId);

        const opened = openAutomationConversationReplyContextStoredEnvelopeV1({
            mode: "e2ee",
            material: account.snapshot.material,
            envelope: JSON.parse(run.replyContextEnvelope ?? "null"),
        });
        expect(opened).toEqual({
            kind: "available",
            correspondence: {
                automationId: AUTOMATION_ID,
                occurrenceKey: hostEvidence.occurrenceKey,
            },
            opaqueContext: FINAL_RESULT_DELIVERY.opaqueContext,
        });

        const replay = encryptedConversationHostEvidence({
            account,
            nonceSeed: 131,
            resultDelivery: FINAL_RESULT_DELIVERY,
        });
        await expect(admitEncryptedAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            hostEvidence: replay,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });
    });

    it("rejects an E2EE executionRun final result before persistence", async () => {
        const account = await configureE2eeAccount();
        const hostEvidence = encryptedConversationHostEvidence({
            account,
            nonceSeed: 41,
            resultDelivery: FINAL_RESULT_DELIVERY,
        });

        await expect(admitEncryptedAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            hostEvidence,
        })).resolves.toEqual({
            kind: "blocked",
            reason: "resultDeliveryUnsupported",
            checkpointSafe: false,
        });
        await expect(db.automationRun.count({
            where: { automationId: AUTOMATION_ID },
        })).resolves.toBe(0);
    });

    it("keeps each Account mode on its own admission arm", async () => {
        // A plain Account has no sealed carrier to admit.
        const strangerKeyPair = tweetnacl.box.keyPair();
        await expect(admitEncryptedAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            hostEvidence: encryptedConversationHostEvidence({
                account: {
                    snapshot: createAccountScopedCryptoMaterialSnapshotV1({
                        accountEncryptionMode: "e2ee",
                        material: { type: "dataKey", machineKey: strangerKeyPair.secretKey },
                        dataKeyPublicKey: strangerKeyPair.publicKey,
                    }),
                    accountCurrentness: {
                        mode: "e2ee",
                        version: 0,
                        contentKeyFingerprint: "not-the-current-account-key",
                    },
                },
                nonceSeed: 3,
            }),
        })).resolves.toEqual({
            kind: "blocked",
            reason: "temporarilyUnavailable",
            checkpointSafe: false,
        });

        // An E2EE Account may not admit plaintext sender/text/context. The
        // Automation template stays plain so nothing downstream of the Account
        // mode can refuse this: delete the refusal and the plain writer freezes
        // a recipe and persists a plaintext Run for an encrypted Account.
        await configureE2eeAccount({ resealAutomationTemplate: false });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input: conversationInput({ resultDelivery: { kind: "none" } }),
        })).resolves.toEqual({
            kind: "blocked",
            reason: "temporarilyUnavailable",
            checkpointSafe: false,
        });
        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);
    });

    it("refuses sealed evidence that is not current for this Account key and version", async () => {
        const account = await configureE2eeAccount();

        // Current Account version, superseded content key. Only the content-key
        // match can refuse this, and admitting it would persist a Run sealed
        // under a retired key that no current-key reader could ever open.
        const supersededKey = encryptedConversationHostEvidence({ account, nonceSeed: 11 });
        await expect(admitEncryptedAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            hostEvidence: {
                ...supersededKey,
                accountCurrentness: {
                    ...supersededKey.accountCurrentness,
                    contentKeyFingerprint: "aemk1_superseded_content",
                },
            },
        })).resolves.toEqual({
            kind: "blocked",
            reason: "temporarilyUnavailable",
            checkpointSafe: false,
        });

        // Current content key, but the Account version advanced between sealing
        // and admission. Only the exact version match on a new insert can
        // refuse this; the fingerprint still agrees.
        const supersededVersion = encryptedConversationHostEvidence({ account, nonceSeed: 12 });
        const advanced = await db.account.update({
            where: { id: ACCOUNT_ID },
            data: { seq: { increment: 1 } },
            select: { seq: true },
        });
        expect(advanced.seq).not.toBe(supersededVersion.accountCurrentness.version);
        await expect(admitEncryptedAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            hostEvidence: supersededVersion,
        })).resolves.toEqual({
            kind: "blocked",
            reason: "temporarilyUnavailable",
            checkpointSafe: false,
        });

        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);

        // Positive twin: the same producer witnessing the now-current Account
        // version is admitted, so neither refusal above is the arm simply
        // being broken.
        await expect(admitEncryptedAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            hostEvidence: {
                ...encryptedConversationHostEvidence({ account, nonceSeed: 13 }),
                accountCurrentness: {
                    ...account.accountCurrentness,
                    version: advanced.seq,
                },
            },
        })).resolves.toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
    });
});
