import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { isPrismaErrorCode } from "@/storage/prisma";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { invalidateSessionReviewProjectionsForAutomationInTx } from './sessionReviewProjectionInvalidation';
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import type {
    AccountEncryptionMigrateAutomationInventoryItem,
    AccountEncryptionMigrateAutomationStageItem,
    AccountEncryptionMigrateAutomationsDirective,
    AccountEncryptionMigrateAutomationsDirectiveInput,
    AccountEncryptionMigrateAutomationsInventoryResponse,
} from "@happier-dev/protocol";
import {
    assertWorkflowStoredEnvelopeOuterForMode,
    WorkflowStoredContentError,
} from "@/app/workflows/runs/storedContent";
import { invocationSelect, projectInvocation, type InvocationRow } from "@/app/workflows/workflowRunService";
import {
    readWorkflowRunKeyProjectionInTx,
    replaceWorkflowRunKeyEnvelopesInTx,
    WorkflowRunAccessError,
} from "@/app/workflows/workflowRunAccess";
import {
    ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS,
    AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
    ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
    AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS,
    AUTOMATION_V3_RUN_LIST_MAX_ITEMS,
    AccountEncryptionMigrateAutomationsDirectiveSchema,
    AccountEncryptionMigrateAutomationsInventoryResponseSchema,
    parseWorkflowStoredContentEnvelopeV1,
    isAccountScopedBlobCiphertextForKind,
    AutomationEventTriggerDefinitionStoredPayloadV1Schema,
    AutomationPullRequestTriggerSchema,
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    AutomationOccurrenceEvidenceEqualityTagV1Schema,
    AutomationOccurrenceEvidenceV1ReadSchema,
    AutomationOccurrenceEvidenceV1Schema,
    deriveAutomationOccurrenceKeyV1,
    parseAutomationStoredDefinitionExecutionRecipeV1,
    AutomationTemplatePayloadV1Schema,
    normalizeAutomationTemplateEnvelopeStoredRead,
    parseAutomationStoredWorkflowDefinitionRecipeV2,
    pluginJsonValuesEqual,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
    serializeAutomationStoredWorkflowDefinitionRecipeV2,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    parseAutomationRunFailureDetailStoredEnvelopeV1,
    parseAutomationRunResultStoredEnvelopeV1,
    parseAutomationRunExecutionRecipeV1,
    compilePluginJsonSchema,
    createCanonicalJsonSigningInput,
    isValidPluginJsonSchemaValue,
    validateAutomationEventFilterAgainstPayloadSchemaV1,
    validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1,
    type AutomationRunCause,
    type AutomationSessionLifecycleTrigger,
    type AutomationDefinitionReconcileRequest,
    type AutomationStoredDefinitionExecutionRecipeV1,
    type AutomationStoredWorkflowDefinitionRecipeV2,
    type AutomationTriggerCreateRequest,
    type AutomationTriggerPatchRequest,
    type AutomationTriggerDefinition,
    type AutomationTriggerDefinitionInput,
    type AutomationPluginEventDefinitionTriggerInput,
    type AutomationPluginEventEncryptedDefinitionTrigger,
} from "@happier-dev/protocol";

import {
    emitAutomationAssignmentUpdated,
    emitAutomationDelete,
    emitAutomationRunUpdated,
    emitAutomationUpsert,
} from "./automationChangePublisher";
import { assertAutomationAssignmentLiveness, replaceAutomationAssignmentsTx } from "./automationAssignmentService";
import { ensureAutomationScheduleCursorsTx } from "./automationRunQueueService";
import { decodeAutomationRunLifecycleConfiguration } from "./automationRunLifecycleConfigurationCodec";
import { validateAutomationRunLifecycleSourceTx } from "./automationRunLifecycleAdmission";
import { admitAutomationRunTx } from "./automationRunAdmissionService";
import type { AutomationRecipeFeaturePolicy } from "./automationRecipeFeaturePolicy";
import { validateExistingSessionAutomationTargetTx } from "./automationExistingSessionValidation";
import { fetchAutomationAccountCurrentnessWitnessTx } from "./automationAccountCurrentness";
import {
    automationDefinitionListItemSelect,
    automationListItemSelect,
    automationRunCauseSelect,
    automationRunDetailSelect,
    automationRunV3ListItemSelect,
    automationRunItemSelect,
    automationTriggerSelect,
} from "./automationPersistenceSelect";
import {
    AutomationEventCurrentnessError,
    readCurrentAutomationEventDurablePushWebhookContributionV1,
    resolveCurrentAutomationEventContributionTx,
} from "./automationEventCurrentness";
import { rejoinAutomationOccurrenceInsertRace } from "./automationOccurrencePersistence";
import { readAutomationRunCauseChainTx } from "./automationTriggerCauseChain";
import { automationPortableQueryChunks } from "./automationPortableQueryChunks";
import { parseStoredSessionTurnFacts } from "@/app/session/turns/parseSessionTurnState";
import { checkCurrentPluginWebhookEndpointCorrespondenceTxV1 } from "@/app/plugins/webhooks/endpointCorrespondence";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { resolveCurrentClaimablePluginMachineMaterializationTx } from "@/app/plugins/availability/operations";
import {
    assertAutomationTemplateEnvelopeForAccountMode,
    AutomationEventFilterValidationError,
    AutomationValidationError,
    parseAutomationScheduleInput,
    readLegacyExistingSessionTemplateAdmission,
} from "./automationValidation";
import {
    assertAutomationExecutionInputEnvelopeOuterForMode,
    AutomationStoredContentReadError,
    readAutomationTriggerDefinitionBinding,
    validateAutomationStoredContentEnvelopeOuterForMode,
    validateAutomationTriggerDefinitionEnvelopeOuterForMode,
    validateAutomationRunFailureDetailEnvelopeOuterForMode,
} from "./automationStoredContentRead";
import {
    decodeAutomationRunCause,
    encodeAutomationRunCause,
    isAutomationCauseRow,
    projectAutomationOriginRun,
} from "./automationRunCauseCodec";
import {
    validateSessionLifecycleExecutionTargetInequality,
    validateSessionLifecycleTriggerRegistrationTx,
    type AutomationSessionBirthContext,
} from "./automationSessionLifecycleRegistration";
import {
    automationSessionLifecycleConfigurationsEqual,
    decodeAutomationSessionLifecycleConfiguration,
    encodeAutomationSessionLifecycleConfiguration,
} from "./automationSessionLifecycleConfigurationCodec";
import {
    AUTOMATION_RUN_REPLY_HANDOFF_TERMINAL_STATES,
    AUTOMATION_RUN_TERMINAL_STATES,
    isAutomationCurrentPatchInput,
    isAutomationCurrentUpsertInput,
    isAutomationLegacyTargetType,
    isAutomationRunState,
} from "./automationTypes";
import type {
    AutomationAssignmentInput,
    AutomationTargetType,
    AutomationLegacyTemplateEnvelopeAdmission,
    AutomationLegacyTargetType,
    AutomationListItem,
    AutomationPatchInput,
    AutomationCurrentUpsertInput,
    AutomationRunDetailItem,
    AutomationRunItem,
    AutomationRunV3ListItem,
    AutomationScheduleInput,
    AutomationTriggerItem,
    AutomationTriggerKind,
    AutomationUpsertInput,
} from "./automationTypes";

async function assertAutomationTemplateMatchesCurrentAccountModeTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        targetType: AutomationLegacyTargetType;
        templateCiphertext: string;
        legacyTemplateEnvelopeAdmission?: AutomationLegacyTemplateEnvelopeAdmission;
    }>,
): Promise<"e2ee" | "plain"> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
    if (fence.status === "account_not_found") {
        throw new Error("Account not found");
    }
    if (fence.status === "account_inconsistent") {
        throw new Error("Account encryption state is inconsistent");
    }
    const accountMode = fence.account.currentness.encryptionMode;
    assertAutomationTemplateEnvelopeForAccountMode(
        params.templateCiphertext,
        accountMode,
        params.targetType,
        params.legacyTemplateEnvelopeAdmission,
    );
    return accountMode;
}

type CurrentAutomationDefinitionWrite = Readonly<{
    targetType: AutomationListItem["targetType"];
    templateCiphertext: string;
    accountMode: "plain" | "e2ee";
    strictExistingSessionId?: string;
}>;

function toCurrentAutomationDefinitionTargetType(
    recipe: AutomationStoredDefinitionExecutionRecipeV1,
): AutomationListItem["targetType"] {
    switch (recipe.target.kind) {
        case "newSession":
            return "new_session";
        case "existingSession":
            return "existing_session";
        case "executionRun":
            return "execution_run";
    }
}

/**
 * The single current Definition writer. It keeps the Protocol-owned strict
 * Workflow recipe intact, clears the retired physical target arm, and
 * fences the Account and validates the opaque private envelopes against its
 * current mode. The server never opens current-definition content here.
 */
async function normalizeCurrentAutomationDefinitionWriteTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2;
    expectedTemplateVersion: number;
}>): Promise<CurrentAutomationDefinitionWrite> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(params.tx, params.accountId);
    if (fence.status === "account_not_found") {
        throw new Error("Account not found");
    }
    if (fence.status === "account_inconsistent") {
        throw new Error("Account encryption state is inconsistent");
    }

    const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(
        params.tx,
        params.accountId,
    );
    if (!accountCurrentness) {
        throw new Error("Account encryption state is inconsistent");
    }
    const serialized = serializeAutomationStoredWorkflowDefinitionRecipeV2(params.executionRecipe);
    if (serialized.kind !== "available") {
        throw new AutomationValidationError("Automation workflow recipe is invalid");
    }
    if (serialized.recipe.templateVersion !== params.expectedTemplateVersion) {
        throw new AutomationValidationError(
            "Automation execution recipe version must match the next template version",
        );
    }
    const workflowOuter = validateAutomationStoredContentEnvelopeOuterForMode({
        raw: createCanonicalJsonSigningInput(serialized.recipe.workflow),
        mode: accountCurrentness.mode,
    });
    if (workflowOuter.kind !== "available") {
        throw new AutomationValidationError("Automation workflow recipe does not match the Account");
    }
    return {
        targetType: null,
        templateCiphertext: serialized.serialized,
        accountMode: accountCurrentness.mode,
    };
}

/** Trigger-set currentness shares the Definition revision, even without a recipe edit. */
function advanceAutomationDefinitionRevision(existing: Pick<AutomationListItem, "templateVersion" | "templateCiphertext">) {
    const templateVersion = existing.templateVersion + 1;
    const workflow = parseAutomationStoredWorkflowDefinitionRecipeV2(existing.templateCiphertext);
    const execution = parseAutomationStoredDefinitionExecutionRecipeV1(existing.templateCiphertext);
    const serialized = workflow.kind === "available"
        ? serializeAutomationStoredWorkflowDefinitionRecipeV2({ ...workflow.recipe, templateVersion })
        : execution.kind === "available"
            ? serializeAutomationStoredDefinitionExecutionRecipeV1({ ...execution.recipe, templateVersion })
            : null;
    if (serialized?.kind === "contentInvalid") {
        throw new AutomationValidationError("Automation execution recipe revision is invalid");
    }
    return {
        templateVersion,
        // Retained legacy/invalid content stays opaque: removal never requires source recovery.
        templateCiphertext: serialized?.serialized ?? existing.templateCiphertext,
    };
}

async function advanceAutomationTriggerSetRevisionTx(tx: Tx, automation: AutomationListItem, now: Date) {
    const updated = await tx.automation.updateMany({
        where: { id: automation.id, accountId: automation.accountId, deletedAt: null, templateVersion: automation.templateVersion },
        data: { ...advanceAutomationDefinitionRevision(automation), updatedAt: now },
    });
    if (updated.count !== 1) throw new AutomationTemplateMutationConflictError();
}

type AutomationScheduleDbFields = Readonly<{
    scheduleKind: "cron" | "interval";
    scheduleExpr: string | null;
    everyMs: number | null;
    timezone: string | null;
}>;

function resolveScheduleDbFields(schedule: AutomationScheduleInput): AutomationScheduleDbFields {
    const validated = parseAutomationScheduleInput(schedule);
    if (validated.kind === "interval") {
        return {
            scheduleKind: "interval",
            scheduleExpr: null,
            everyMs: validated.everyMs,
            timezone: validated.timezone ?? null,
        };
    }
    return {
        scheduleKind: "cron",
        scheduleExpr: validated.scheduleExpr,
        everyMs: null,
        timezone: validated.timezone ?? null,
    };
}

/**
 * Public trigger definitions carry explicit nulls for the inactive schedule
 * arm. Strip that representation detail before the canonical schedule parser
 * so create rejoin and edit equality use the same persistence semantics as a
 * direct schedule write.
 */
function resolveTriggerDefinitionScheduleDbFields(
    schedule: Extract<AutomationTriggerDefinition, { kind: "schedule" }>["schedule"],
): AutomationScheduleDbFields {
    return resolveScheduleDbFields(schedule.kind === "interval"
        ? {
            kind: "interval",
            everyMs: schedule.everyMs,
            timezone: schedule.timezone,
        }
        : {
            kind: "cron",
            scheduleExpr: schedule.scheduleExpr,
            timezone: schedule.timezone,
        });
}

function hasSameAutomationScheduleFields(
    current: Readonly<{
        scheduleKind: "cron" | "interval" | null;
        scheduleExpr: string | null;
        everyMs: number | null;
        timezone: string | null;
    }>,
    next: AutomationScheduleDbFields,
): boolean {
    return current.scheduleKind === next.scheduleKind
        && current.scheduleExpr === next.scheduleExpr
        && current.everyMs === next.everyMs
        && current.timezone === next.timezone;
}

type AutomationPluginEventWriteInput = AutomationPluginEventDefinitionTriggerInput;
type AutomationPlainPluginEventWriteInput = Exclude<
    AutomationPluginEventWriteInput,
    AutomationPluginEventEncryptedDefinitionTrigger & { enabled: boolean }
>;

type NormalizedAutomationPluginEventWriteBase = Readonly<{
    eventRef: AutomationPlainPluginEventWriteInput["eventRef"];
    sourceInstanceId: string;
    sourceContractVersion: number;
    sourceConfig: AutomationPlainPluginEventWriteInput["sourceConfig"];
    displayLabel: string;
    filter: AutomationPlainPluginEventWriteInput["filter"];
    maximumObservationAgeMs: number | null;
}>;

/**
 * AUTO-19: exactly one selected observation transport per enabled Event
 * trigger. The checkpointed-pull and session-socket arms own the four watcher
 * columns; the durable-push arm owns the canonical endpoint scalar and leaves
 * every watcher column null.
 */
type NormalizedAutomationPluginEventWrite =
    | (NormalizedAutomationPluginEventWriteBase & Readonly<{
        observationTransport: "checkpointedPull";
        watcherMachineId: string;
        watcherMachineInstallationId: string;
        watcherPluginId: string;
        watcherMaterializationId: string;
    }>)
    | (NormalizedAutomationPluginEventWriteBase & Readonly<{
        observationTransport: "socket";
        watcherMachineId: string;
        watcherMachineInstallationId: string;
        watcherPluginId: string;
        watcherMaterializationId: string;
    }>)
    | (NormalizedAutomationPluginEventWriteBase & Readonly<{
        observationTransport: "durablePush";
        webhookEndpointId: string;
        webhookRoutingSourceInstanceId: string;
    }>);

/**
 * The exact facts that decide which deliveries a durable-push trigger may
 * observe. AUTO-19 resets the delivery-time observation boundary when any of
 * them changes or when push is re-enabled, and deliberately preserves it for
 * prompt/target/execution-recipe edits and cosmetic label changes.
 */
function durablePushObservationEligibilityFingerprint(
    event: Extract<NormalizedAutomationPluginEventWrite, { observationTransport: "durablePush" }>,
): string {
    return createCanonicalJsonSigningInput({
        eventRef: event.eventRef,
        sourceInstanceId: event.sourceInstanceId,
        sourceContractVersion: event.sourceContractVersion,
        sourceConfig: event.sourceConfig,
        filter: event.filter,
        maximumObservationAgeMs: event.maximumObservationAgeMs,
        webhookEndpointId: event.webhookEndpointId,
        webhookRoutingSourceInstanceId: event.webhookRoutingSourceInstanceId,
    });
}

async function normalizeAutomationPluginEventWriteTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    serverIdentityId: string | null;
    input: AutomationPlainPluginEventWriteInput;
}>): Promise<NormalizedAutomationPluginEventWrite> {
    const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(
        params.tx,
        params.accountId,
    );
    if (!accountCurrentness || accountCurrentness.mode !== "plain") {
        throw new AutomationStoredContentReadError("modeMismatch");
    }
    const transport = params.input.observationTransport;
    const observationTarget = transport.kind === "durablePush"
        ? transport.endpointMaterializationRef
        : transport.watcherMaterializationRef;
    if (observationTarget.pluginId !== params.input.eventRef.pluginId) {
        throw new AutomationValidationError(
            "Automation Event watcher must use the Event's declaring plugin",
        );
    }
    const watcher = observationTarget;
    const [materialization, machine] = await Promise.all([
        params.tx.pluginMachineMaterialization.findUnique({
            where: {
                machineId_materializationId: {
                    machineId: watcher.machineId,
                    materializationId: watcher.materializationId,
                },
            },
            select: {
                accountId: true,
                pluginId: true,
                version: true,
                serverIdentityId: true,
            },
        }),
        params.tx.machine.findFirst({
            where: { accountId: params.accountId, id: watcher.machineId },
            select: { installationId: true },
        }),
    ]);
    if (
        !materialization
        || materialization.accountId !== params.accountId
        || materialization.pluginId !== watcher.pluginId
        || !machine
        || machine.installationId === null
    ) {
        throw new AutomationValidationError("Automation Event watcher is not current");
    }
    const current = await resolveCurrentClaimablePluginMachineMaterializationTx({
        tx: params.tx,
        accountId: params.accountId,
        serverIdentityId: materialization.serverIdentityId,
        machineId: watcher.machineId,
        machineInstallationId: machine.installationId,
        materializationId: watcher.materializationId,
        pluginId: watcher.pluginId,
        version: materialization.version,
    });
    if (current.kind !== "current") {
        throw new AutomationValidationError("Automation Event watcher is not current");
    }

    let contribution;
    try {
        contribution = await resolveCurrentAutomationEventContributionTx({
            tx: params.tx,
            accountId: params.accountId,
            pluginId: params.input.eventRef.pluginId,
            version: materialization.version,
            eventLocalId: params.input.eventRef.localId,
            sourceContractVersion: params.input.sourceContractVersion,
        });
    } catch (error) {
        if (error instanceof AutomationEventCurrentnessError) {
            throw new AutomationValidationError(
                "Automation Event declaration is not current",
            );
        }
        throw error;
    }
    if (!contribution.automation.source.supportedObservationTransports.includes(transport.kind)) {
        throw new AutomationValidationError(
            `Automation Event declaration does not support ${transport.kind} observation`,
        );
    }
    let validatesSourceConfig: ReturnType<typeof compilePluginJsonSchema>;
    try {
        validatesSourceConfig = compilePluginJsonSchema(
            contribution.automation.source.sourceConfigSchema,
        );
    } catch {
        throw new AutomationValidationError(
            "Automation Event source configuration schema is invalid",
        );
    }
    if (!isValidPluginJsonSchemaValue(validatesSourceConfig, params.input.sourceConfig)) {
        throw new AutomationValidationError(
            "Automation Event source configuration does not match its declaration",
        );
    }
    const filterValidation = validateAutomationEventFilterAgainstPayloadSchemaV1({
        filter: params.input.filter,
        payloadSchema: contribution.payloadSchema,
    });
    if (filterValidation.kind !== "valid") {
        throw new AutomationEventFilterValidationError(filterValidation.issue);
    }
    const base = {
        eventRef: params.input.eventRef,
        sourceInstanceId: params.input.sourceInstanceId,
        sourceContractVersion: params.input.sourceContractVersion,
        sourceConfig: params.input.sourceConfig,
        displayLabel: params.input.displayLabel,
        filter: params.input.filter,
        maximumObservationAgeMs: params.input.maximumObservationAgeMs,
    } as const;
    if (transport.kind === "checkpointedPull" || transport.kind === "socket") {
        return {
            ...base,
            observationTransport: transport.kind,
            watcherMachineId: watcher.machineId,
            watcherMachineInstallationId: machine.installationId,
            watcherPluginId: watcher.pluginId,
            watcherMaterializationId: watcher.materializationId,
        };
    }
    const webhookContribution = readCurrentAutomationEventDurablePushWebhookContributionV1(
        contribution,
    );
    if (!webhookContribution || params.serverIdentityId === null) {
        throw new AutomationValidationError(
            "Automation Event declaration does not support durable push",
        );
    }
    // AUTO-19: the endpoint is persisted only after the single canonical
    // webhook correspondence owner returns `ready` inside this transaction.
    // The declared webhook contribution comes from the current Event
    // declaration, never from authoring input.
    const correspondence = await checkCurrentPluginWebhookEndpointCorrespondenceTxV1({
        tx: params.tx,
        serverIdentityId: params.serverIdentityId,
        accountId: params.accountId,
        input: {
            webhookEndpointId: transport.webhookEndpointId,
            webhookContribution,
            targetMaterialization: transport.endpointMaterializationRef,
            sourceInstanceId: transport.webhookRoutingSourceInstanceId,
            setup: transport.setup,
        },
    });
    if (correspondence.kind !== "ready") {
        throw new AutomationValidationError(
            "Automation Event durable-push endpoint is not in correspondence",
        );
    }
    return {
        ...base,
        observationTransport: "durablePush",
        webhookEndpointId: correspondence.webhookEndpointId,
        webhookRoutingSourceInstanceId: transport.webhookRoutingSourceInstanceId,
    };
}

async function normalizeEncryptedAutomationPluginEventWriteTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    automationId: string;
    triggerId: string;
    triggerRevision: number;
    serverIdentityId: string | null;
    input: AutomationPluginEventEncryptedDefinitionTrigger & { enabled: boolean };
    now: Date;
}>): Promise<Readonly<{
    sourceSelectorId: string;
    sourceContractVersion: number;
    observationTransport: "checkpointedPull" | "durablePush" | "socket";
    webhookEndpointId: string | null;
    observationStartsAt: Date | null;
    watcherMachineId: string | null;
    watcherMachineInstallationId: string | null;
    watcherPluginId: string | null;
    watcherMaterializationId: string | null;
    definitionEnvelope: string;
}>> {
    const currentness = await fetchAutomationAccountCurrentnessWitnessTx(
        params.tx,
        params.accountId,
    );
    if (!currentness) throw new AutomationValidationError("Automation Account is not current");
    if (currentness.mode !== "e2ee") {
        throw new AutomationStoredContentReadError("modeMismatch");
    }
    const binding = {
        v: 1 as const,
        automationId: params.automationId,
        triggerId: AutomationTriggerIdSchema.parse(params.triggerId),
        triggerRevision: params.triggerRevision,
        triggerKind: "pluginEvent" as const,
        eventRef: params.input.eventRef,
        sourceSelectorId: params.input.sourceSelectorId,
    };
    const definitionEnvelope = JSON.stringify(params.input.triggerDefinitionEnvelope);
    if (validateAutomationTriggerDefinitionEnvelopeOuterForMode({
        raw: definitionEnvelope,
        mode: currentness.mode,
        binding,
    }).kind !== "available") {
        throw new AutomationStoredContentReadError("contentInvalid");
    }

    const transport = params.input.observationTransport;
    const watcher = transport.kind === "durablePush"
        ? transport.endpointMaterializationRef
        : transport.watcherMaterializationRef;
    if (watcher.pluginId !== params.input.eventRef.pluginId) {
        throw new AutomationValidationError("Automation Event watcher must use the Event's declaring plugin");
    }
    const [materialization, machine] = await Promise.all([
        params.tx.pluginMachineMaterialization.findUnique({
            where: { machineId_materializationId: {
                machineId: watcher.machineId,
                materializationId: watcher.materializationId,
            } },
            select: { accountId: true, pluginId: true, version: true, serverIdentityId: true },
        }),
        params.tx.machine.findFirst({
            where: { accountId: params.accountId, id: watcher.machineId },
            select: { installationId: true },
        }),
    ]);
    if (!materialization || materialization.accountId !== params.accountId
        || materialization.pluginId !== watcher.pluginId || !machine?.installationId) {
        throw new AutomationValidationError("Automation Event watcher is not current");
    }
    const claimable = await resolveCurrentClaimablePluginMachineMaterializationTx({
        tx: params.tx,
        accountId: params.accountId,
        serverIdentityId: materialization.serverIdentityId,
        machineId: watcher.machineId,
        machineInstallationId: machine.installationId,
        materializationId: watcher.materializationId,
        pluginId: watcher.pluginId,
        version: materialization.version,
    });
    if (claimable.kind !== "current") {
        throw new AutomationValidationError("Automation Event watcher is not current");
    }
    let contribution;
    try {
        contribution = await resolveCurrentAutomationEventContributionTx({
            tx: params.tx,
            accountId: params.accountId,
            pluginId: params.input.eventRef.pluginId,
            version: materialization.version,
            eventLocalId: params.input.eventRef.localId,
            sourceContractVersion: params.input.sourceContractVersion,
        });
    } catch (error) {
        if (error instanceof AutomationEventCurrentnessError) {
            throw new AutomationValidationError("Automation Event declaration is not current");
        }
        throw error;
    }
    if (!contribution.automation.source.supportedObservationTransports.includes(transport.kind)) {
        throw new AutomationValidationError("Automation Event declaration does not support the selected transport");
    }
    if (transport.kind === "checkpointedPull" || transport.kind === "socket") {
        return {
            sourceSelectorId: params.input.sourceSelectorId,
            sourceContractVersion: params.input.sourceContractVersion,
            observationTransport: transport.kind,
            webhookEndpointId: null,
            observationStartsAt: null,
            watcherMachineId: watcher.machineId,
            watcherMachineInstallationId: machine.installationId,
            watcherPluginId: watcher.pluginId,
            watcherMaterializationId: watcher.materializationId,
            definitionEnvelope,
        };
    }
    const webhookContribution = readCurrentAutomationEventDurablePushWebhookContributionV1(contribution);
    if (!webhookContribution || params.serverIdentityId === null) {
        throw new AutomationValidationError("Automation Event declaration does not support durable push");
    }
    const correspondence = await checkCurrentPluginWebhookEndpointCorrespondenceTxV1({
        tx: params.tx,
        serverIdentityId: params.serverIdentityId,
        accountId: params.accountId,
        input: {
            webhookEndpointId: transport.webhookEndpointId,
            webhookContribution,
            targetMaterialization: transport.endpointMaterializationRef,
            sourceInstanceId: transport.webhookRoutingSourceInstanceId,
            setup: transport.setup,
        },
    });
    if (correspondence.kind !== "ready") {
        throw new AutomationValidationError("Automation Event durable-push endpoint is not in correspondence");
    }
    return {
        sourceSelectorId: params.input.sourceSelectorId,
        sourceContractVersion: params.input.sourceContractVersion,
        observationTransport: "durablePush",
        webhookEndpointId: correspondence.webhookEndpointId,
        observationStartsAt: params.now,
        watcherMachineId: null,
        watcherMachineInstallationId: null,
        watcherPluginId: null,
        watcherMaterializationId: null,
        definitionEnvelope,
    };
}

/**
 * Sole owner of the transport-discriminated Automation trigger columns. The
 * four watcher columns and the endpoint columns are mutually exclusive, so
 * every writer sets the whole group here rather than patching one arm.
 */
async function resolveAutomationDurablePushServerIdentityId(
    input: Pick<AutomationPluginEventWriteInput, "observationTransport"> | null | undefined,
): Promise<string | null> {
    return input?.observationTransport.kind === "durablePush"
        ? await getOrCreateServerIdentityId()
        : null;
}

function automationPluginEventTransportColumns(
    event: NormalizedAutomationPluginEventWrite,
    now: Date,
    retainedObservationStartsAt: Date | null = null,
): Readonly<{
    observationTransport: "checkpointedPull" | "durablePush" | "socket";
    webhookEndpointId: string | null;
    observationStartsAt: Date | null;
    watcherMachineId: string | null;
    watcherMachineInstallationId: string | null;
    watcherPluginId: string | null;
    watcherMaterializationId: string | null;
}> {
    if (event.observationTransport === "checkpointedPull" || event.observationTransport === "socket") {
        return {
            observationTransport: event.observationTransport,
            webhookEndpointId: null,
            observationStartsAt: null,
            watcherMachineId: event.watcherMachineId,
            watcherMachineInstallationId: event.watcherMachineInstallationId,
            watcherPluginId: event.watcherPluginId,
            watcherMaterializationId: event.watcherMaterializationId,
        };
    }
    return {
        observationTransport: "durablePush",
        webhookEndpointId: event.webhookEndpointId,
        observationStartsAt: retainedObservationStartsAt ?? now,
        watcherMachineId: null,
        watcherMachineInstallationId: null,
        watcherPluginId: null,
        watcherMaterializationId: null,
    };
}

function sealPlainAutomationPluginEventDefinition(params: Readonly<{
    automationId: string;
    triggerId: string;
    triggerRevision: number;
    sourceSelectorId: string;
    event: NormalizedAutomationPluginEventWrite;
}>): string {
    const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
        params.sourceSelectorId,
    );
    const definition = AutomationEventTriggerDefinitionStoredPayloadV1Schema.parse({
        v: 1,
        sourceInstanceId: params.event.sourceInstanceId,
        // The generic endpoint-routing source instance is retained privately
        // and stays separate from the provider's canonical source identity.
        ...(params.event.observationTransport === "durablePush"
            ? { webhookRoutingSourceInstanceId: params.event.webhookRoutingSourceInstanceId }
            : {}),
        sourceConfig: params.event.sourceConfig,
        displayLabel: params.event.displayLabel,
        filter: params.event.filter,
        maximumObservationAgeMs: params.event.maximumObservationAgeMs,
    });
    return JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: "plain",
        binding: {
            v: 1,
            automationId: params.automationId,
            triggerId: AutomationTriggerIdSchema.parse(params.triggerId),
            triggerRevision: params.triggerRevision,
            triggerKind: "pluginEvent",
            eventRef: params.event.eventRef,
            sourceSelectorId,
        },
        definition,
    }));
}

function readPlainAutomationPrivateTriggerDefinition(
    automation: Pick<AutomationListItem, "id" | "templateVersion">,
    trigger: AutomationTriggerItem,
) {
    const binding = readAutomationTriggerDefinitionBinding({
        automationId: automation.id,
        triggerId: trigger.id,
        triggerRevision: trigger.revision,
        triggerKind: trigger.kind,
        triggerEventPluginId: trigger.eventPluginId,
        triggerEventLocalId: trigger.eventLocalId,
        triggerSourceSelectorId: trigger.sourceSelectorId,
    });
    if (!binding || trigger.definitionEnvelope == null) {
        throw new AutomationValidationError(
            "Automation Event private definition is unavailable",
        );
    }
    let envelope: unknown;
    try {
        envelope = JSON.parse(trigger.definitionEnvelope);
    } catch {
        throw new AutomationValidationError(
            "Automation Event private definition is unavailable",
        );
    }
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: "plain",
        binding,
        envelope,
    });
    if (opened.kind !== "available") {
        throw new AutomationValidationError(
            "Automation Event private definition is unavailable",
        );
    }
    return opened.definition;
}

function readPlainAutomationPluginEventDefinition(
    automation: Pick<AutomationListItem, "id" | "templateVersion">,
    trigger: AutomationTriggerItem,
): ReturnType<typeof AutomationEventTriggerDefinitionStoredPayloadV1Schema.parse> {
    const parsed = AutomationEventTriggerDefinitionStoredPayloadV1Schema.safeParse(
        readPlainAutomationPrivateTriggerDefinition(automation, trigger),
    );
    if (!parsed.success) {
        throw new AutomationValidationError(
            "Automation Event private definition is unavailable",
        );
    }
    return parsed.data;
}

function automationCreateAssignmentsMatch(
    existing: AutomationListItem["assignments"],
    requested: AutomationCurrentUpsertInput["assignments"],
): boolean {
    const normalized = new Map(
        (requested ?? []).map((assignment) => [assignment.machineId, {
            machineId: assignment.machineId,
            enabled: assignment.enabled ?? true,
            priority: assignment.priority ?? 0,
        }] as const),
    );
    return existing.length === normalized.size && existing.every((assignment) => {
        const expected = normalized.get(assignment.machineId);
        return expected !== undefined
            && assignment.enabled === expected.enabled
            && assignment.priority === expected.priority;
    });
}

function automationPluginEventCreateTransportMatches(
    existing: AutomationTriggerItem,
    requested: AutomationPluginEventDefinitionTriggerInput,
): boolean {
    const transport = requested.observationTransport;
    if (transport.kind === "checkpointedPull" || transport.kind === "socket") {
        return existing.observationTransport === transport.kind
            && existing.webhookEndpointId === null
            && existing.watcherMachineId === transport.watcherMaterializationRef.machineId
            && existing.watcherPluginId === transport.watcherMaterializationRef.pluginId
            && existing.watcherMaterializationId
                === transport.watcherMaterializationRef.materializationId;
    }
    return existing.observationTransport === "durablePush"
        && existing.webhookEndpointId === transport.webhookEndpointId
        && existing.watcherMachineId === null
        && existing.watcherMachineInstallationId === null
        && existing.watcherPluginId === null
        && existing.watcherMaterializationId === null;
}

type AutomationTriggerCreateSemanticInput = Readonly<{
    triggerId: string;
    trigger: AutomationTriggerDefinitionInput;
}>;

/**
 * Compares only the canonical persisted meaning of a client-identified
 * trigger create. Transient setup/currentness proof is deliberately excluded:
 * it authorized the first commit but is not a second definition owner.
 */
function automationTriggerMatchesCreateInput(params: Readonly<{
    automation: Pick<AutomationListItem, "id" | "templateVersion" | "scopeSessionId">;
    existing: AutomationTriggerItem;
    requested: AutomationTriggerCreateSemanticInput;
}>): boolean {
    const { existing, requested } = params;
    if (
        existing.id !== requested.triggerId
        || existing.revision !== 0
        || existing.deletedAt !== null
        || existing.kind !== requested.trigger.kind
        || existing.enabled !== requested.trigger.enabled
    ) return false;

    if (requested.trigger.kind === "schedule") {
        const schedule = resolveTriggerDefinitionScheduleDbFields(
            requested.trigger.schedule,
        );
        return hasSameAutomationScheduleFields(existing, schedule);
    }
    if (requested.trigger.kind === "sessionLifecycle") {
        return automationSessionLifecycleConfigurationsEqual(existing, requested.trigger);
    }
    if (requested.trigger.kind === "runLifecycle") {
        return createCanonicalJsonSigningInput(decodeAutomationRunLifecycleConfiguration(existing))
            === createCanonicalJsonSigningInput({ kind: "runLifecycle", source: requested.trigger.source, condition: requested.trigger.condition });
    }
    if (requested.trigger.kind === "prComment" || requested.trigger.kind === "ciFailed") {
        if (existing.sourceSessionId !== params.automation.scopeSessionId || !existing.definitionEnvelope) return false;
        try {
            return "triggerDefinitionEnvelope" in requested.trigger
                ? pluginJsonValuesEqual(JSON.parse(existing.definitionEnvelope), requested.trigger.triggerDefinitionEnvelope)
                : pluginJsonValuesEqual(readPlainAutomationPrivateTriggerDefinition(params.automation, existing), {
                    kind: requested.trigger.kind, pullRequest: requested.trigger.pullRequest,
                });
        } catch { return false; }
    }
    if (requested.trigger.kind !== "pluginEvent") return false;
    if (
        existing.eventPluginId !== requested.trigger.eventRef.pluginId
        || existing.eventLocalId !== requested.trigger.eventRef.localId
        || existing.sourceContractVersion !== requested.trigger.sourceContractVersion
        || !automationPluginEventCreateTransportMatches(existing, requested.trigger)
        || existing.definitionEnvelope == null
    ) return false;

    if ("triggerDefinitionEnvelope" in requested.trigger) {
        if (existing.sourceSelectorId !== requested.trigger.sourceSelectorId) return false;
        try {
            return pluginJsonValuesEqual(
                JSON.parse(existing.definitionEnvelope),
                requested.trigger.triggerDefinitionEnvelope,
            );
        } catch {
            return false;
        }
    }

    try {
        return pluginJsonValuesEqual(
            readPlainAutomationPluginEventDefinition(params.automation, existing),
            {
                v: 1,
                sourceInstanceId: requested.trigger.sourceInstanceId,
                ...(requested.trigger.observationTransport.kind === "durablePush"
                    ? {
                        webhookRoutingSourceInstanceId:
                            requested.trigger.observationTransport.webhookRoutingSourceInstanceId,
                    }
                    : {}),
                sourceConfig: requested.trigger.sourceConfig,
                displayLabel: requested.trigger.displayLabel,
                filter: requested.trigger.filter,
                maximumObservationAgeMs: requested.trigger.maximumObservationAgeMs,
            },
        );
    } catch {
        return false;
    }
}

function automationMatchesCurrentCreateInput(
    existing: AutomationListItem,
    requested: AutomationCurrentUpsertInput,
): boolean {
    const serialized = serializeAutomationStoredWorkflowDefinitionRecipeV2(requested.executionRecipe);
    if (serialized.kind !== "available") return false;
    if (
        existing.id !== requested.automationId
        || existing.templateVersion !== 1
        || existing.name !== requested.name
        || existing.description !== (requested.description ?? null)
        || existing.enabled !== requested.enabled
        || existing.workflowDefinitionId !== (requested.workflowDefinitionId ?? null)
        || existing.scopeSessionId !== (requested.scopeSessionId ?? null)
        || existing.targetType !== null
        || existing.templateCiphertext !== serialized.serialized
        || !automationCreateAssignmentsMatch(existing.assignments, requested.assignments)
        || existing.triggers.length !== requested.triggers.length
    ) return false;

    const triggersById = new Map(existing.triggers.map((trigger) => [trigger.id, trigger] as const));
    return requested.triggers.every((trigger) => {
        const stored = triggersById.get(trigger.triggerId);
        return stored !== undefined && automationTriggerMatchesCreateInput({
            automation: existing,
            existing: stored,
            requested: trigger,
        });
    });
}

async function tryRejoinAutomationCreateTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    input: AutomationCurrentUpsertInput;
}>): Promise<AutomationListItem | null> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(
        params.tx,
        params.accountId,
    );
    if (fence.status !== "ready") {
        throw new AutomationStoredContentReadError("contentInvalid");
    }
    const existing = await loadAutomationTx(params.tx, {
        accountId: params.accountId,
        automationId: params.input.automationId,
    });
    if (!existing) return null;
    if (!automationMatchesCurrentCreateInput(existing, params.input)) {
        throw new AutomationDefinitionCreateConflictError();
    }
    return existing;
}

async function tryRejoinAutomationTriggerCreateTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    automationId: string;
    request: AutomationTriggerCreateSemanticInput;
}>): Promise<AutomationListItem | null> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(
        params.tx,
        params.accountId,
    );
    if (fence.status !== "ready") return null;
    const automation = await loadAutomationTx(params.tx, {
        accountId: params.accountId,
        automationId: params.automationId,
    });
    if (!automation) return null;
    const existing = await params.tx.automationTrigger.findUnique({
        where: { id: params.request.triggerId },
        select: automationTriggerSelect,
    }) as AutomationTriggerItem | null;
    if (!existing) return null;
    if (
        existing.automationId !== automation.id
        || !automationTriggerMatchesCreateInput({
            automation,
            existing,
            requested: params.request,
        })
    ) {
        throw new AutomationTriggerCreateConflictError();
    }
    return automation;
}

/**
 * Canonical Event source-definition catalog revision owner. Visible changes to
 * the enabled source projection advance the Account revision so watchers
 * re-adopt through their canonical read.
 */
export async function ensureAutomationEventCatalogStateTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    projectionChanged: boolean;
}>): Promise<void> {
    await params.tx.automationEventCatalogState.upsert({
        where: { accountId: params.accountId },
        create: {
            accountId: params.accountId,
            eventSourceDefinitionsRevision: params.projectionChanged ? 1n : 0n,
        },
        update: params.projectionChanged
            ? { eventSourceDefinitionsRevision: { increment: 1n } }
            : {},
    });
}

/**
 * An event source status row is keyed by the exact trigger identity a reporter
 * observed, and the V3 projection only ever reads the Automation's current
 * identity. Changing the event, the selector, or the trigger kind therefore
 * makes every row under the previous key permanently unreachable, so the change
 * that superseded them removes them here. There is no age rule: exact
 * currentness is the proof, and these rows are a projection of reporter
 * observations rather than durable history.
 */
async function deleteSupersededAutomationEventSourceStatusTx(params: Readonly<{
    tx: Tx;
    triggerId: string;
}>): Promise<void> {
    const current = await params.tx.automationTrigger.findUnique({
        where: { id: params.triggerId },
        select: {
            kind: true,
            deletedAt: true,
            eventPluginId: true,
            eventLocalId: true,
            sourceSelectorId: true,
        },
    });
    const currentKey = current !== null
        && current.deletedAt === null
        && current.kind === "pluginEvent"
        && current.eventPluginId !== null
        && current.eventLocalId !== null
        && current.sourceSelectorId !== null
        ? {
            eventPluginId: current.eventPluginId,
            eventLocalId: current.eventLocalId,
            sourceSelectorId: current.sourceSelectorId,
        }
        : null;
    await params.tx.automationEventSourceStatus.deleteMany({
        where: {
            triggerId: params.triggerId,
            ...(currentKey === null ? {} : { NOT: currentKey }),
        },
    });
}

/** A retained template may mutate only its own single schedule or manual-only state. */
function isRetainedAutomationSingleScheduleDefinition(item: AutomationListItem): boolean {
    const trigger = item.triggers.length === 1 ? item.triggers[0] : undefined;
    const hasSingleSchedule = item.triggers.length === 0
        || (trigger?.kind === "schedule" && trigger.enabled
            && (trigger.scheduleKind === "cron" || trigger.scheduleKind === "interval"));
    if (!hasSingleSchedule || item.targetType === null || item.targetType === "execution_run"
        || parseAutomationStoredDefinitionExecutionRecipeV1(item.templateCiphertext).kind === "available") return false;
    try {
        return normalizeAutomationTemplateEnvelopeStoredRead(JSON.parse(item.templateCiphertext)) !== null;
    } catch {
        return false;
    }
}

export async function loadAutomationTx(
    tx: Tx,
    params: {
        accountId: string;
        automationId: string;
        includeDeleted?: boolean;

    },
): Promise<AutomationListItem | null> {
    const row = await tx.automation.findFirst({
        where: {
            id: params.automationId,
            accountId: params.accountId,
            ...(params.includeDeleted ? {} : { deletedAt: null }),
        },
        select: automationListItemSelect,
    });

    if (!row) return null;
    const item = row as AutomationListItem;

    return item;
}

export class AutomationAccountEncryptionMigrationConflictError extends Error {
    constructor() {
        super(
            "Automation account-encryption migration lost its template-version precondition",
        );
        this.name = "AutomationAccountEncryptionMigrationConflictError";
    }
}

export class AutomationTemplateMutationConflictError
    extends AutomationValidationError {
    constructor() {
        super("Automation template changed during update; retry");
        this.name = "AutomationTemplateMutationConflictError";
    }
}

export class AutomationTriggerMutationConflictError
    extends AutomationValidationError {
    constructor() {
        super("Automation trigger revision no longer matches");
        this.name = "AutomationTriggerMutationConflictError";
    }
}

export class AutomationDefinitionCreateConflictError
    extends AutomationValidationError {
    constructor() {
        super("Automation identity is already bound to a different definition");
        this.name = "AutomationDefinitionCreateConflictError";
    }
}

export class AutomationTriggerCreateConflictError
    extends AutomationValidationError {
    constructor() {
        super("Automation trigger identity is already bound to a different trigger");
        this.name = "AutomationTriggerCreateConflictError";
    }
}

export class AutomationDisabledError extends Error {
    constructor() {
        super("Automation is paused");
        this.name = "AutomationDisabledError";
    }
}

export type AutomationAccountEncryptionMigrationResult =
    | Readonly<{ status: "applied" }>
    | Readonly<{ status: "not_empty" }>
    | Readonly<{ status: "migration_incomplete" }>
    | Readonly<{ status: "migration_too_large" }>
    | Readonly<{ status: "invalid_content" }>;

export type AutomationAccountEncryptionMigrationPostStateResult =
    | Readonly<{ status: "matched" }>
    | Readonly<{ status: "mismatch" }>;

const automationMigrationDefinitionSelect = {
    id: true,
    enabled: true,
    deletedAt: true,
    targetType: true,
    templateCiphertext: true,
    templateVersion: true,
    triggers: {
        where: { deletedAt: null },
        select: {
            id: true,
            kind: true,
            enabled: true,
            revision: true,
            deletedAt: true,
            eventPluginId: true,
            eventLocalId: true,
            sourceSelectorId: true,
            definitionEnvelope: true,
        },
        orderBy: { id: "asc" },
    },
    assignments: {
        select: {
            machineId: true,
            enabled: true,
            updatedAt: true,
        },
    },
} satisfies Prisma.AutomationSelect;

type AutomationAccountEncryptionMigrationRow = Prisma.AutomationGetPayload<{
    select: typeof automationMigrationDefinitionSelect;
}>;

/**
 * Internal projection of the guarded V5 Protocol participant shape. It stays
 * in the Automation owner until that unadvertised wire is built into the
 * workspace package; public parsing remains Protocol-owned.
 */
export type AutomationAccountEncryptionTransitionDefinitionContent = Readonly<{
    templateCiphertext: string;
    triggerDefinitionEnvelopes: readonly Readonly<{
        triggerId: string;
        triggerRevision: number;
        envelope: string;
    }>[];
}>;

export type AutomationAccountEncryptionTransitionRunSourceContent = Readonly<{
    triggerEvidenceEnvelope: string | null;
    occurrenceEvidenceEqualityTag: string | null;
    executionInputEnvelope: string | null;
    workflowAcceptedSnapshotEnvelope: string | null;
    workflowCheckpointEnvelope: string | null;
    resultEnvelope: string | null;
    replyContextEnvelope: string | null;
    failureDetailEnvelope: string | null;
    summaryCiphertext: string | null;
}>;

export type AutomationAccountEncryptionTransitionRunTargetContent = Readonly<
    Omit<AutomationAccountEncryptionTransitionRunSourceContent, "summaryCiphertext">
>;

export type AutomationAccountEncryptionTransitionInventoryItem =
    AccountEncryptionMigrateAutomationInventoryItem;

export type AutomationAccountEncryptionTransitionStageItem =
    AccountEncryptionMigrateAutomationStageItem;

export type AutomationAccountEncryptionTransitionSourceCursor = Readonly<{
    kind: "definition" | "run" | "workflow_invocation";
    participantId: string;
}>;

export type AutomationAccountEncryptionTransitionSourcePage = Readonly<{
    items: readonly AutomationAccountEncryptionTransitionInventoryItem[];
    sourceEncodedBytes: bigint;
    runCount: number;
    nextCursor?: AutomationAccountEncryptionTransitionSourceCursor;
}>;

function transitionInventoryDefinition(
    row: AutomationAccountEncryptionMigrationRow,
): Extract<AutomationAccountEncryptionTransitionInventoryItem, { kind: "definition" }> {
    return {
        kind: "definition",
        automationId: row.id,
        revision: row.templateVersion,
        source: {
            templateCiphertext: row.templateCiphertext,
            triggerDefinitionEnvelopes: row.triggers
                .filter((trigger) => trigger.kind === "pluginEvent" || trigger.kind === "prComment" || trigger.kind === "ciFailed")
                .map((trigger) => {
                    if (trigger.definitionEnvelope === null) {
                        throw new AutomationValidationError(
                            "Automation Event trigger has no definition envelope",
                        );
                    }
                    return {
                        triggerId: AutomationTriggerIdSchema.parse(trigger.id),
                        triggerRevision: trigger.revision,
                        envelope: trigger.definitionEnvelope,
                    };
                }),
        },
    };
}

/**
 * The released V2 `errorMessage` remains a public compatibility string. Only
 * the strict current failure-detail envelope participates in Account private-
 * content migration, while retaining the same physical column.
 */
function currentAutomationRunFailureDetailEnvelope(
    row: Pick<AutomationAccountEncryptionMigrationRunRow, "errorMessage">,
): string | null {
    return row.errorMessage !== null
        && parseAutomationRunFailureDetailStoredEnvelopeV1(row.errorMessage) !== null
        ? row.errorMessage
        : null;
}

function automationRunHasMigrationPrivateContent(
    row: AutomationAccountEncryptionMigrationRunRow,
): boolean {
    return row.triggerEvidenceEnvelope !== null
        || row.occurrenceEvidenceEqualityTag !== null
        || row.executionInputEnvelope !== null
        || row.workflowAcceptedSnapshotEnvelope !== null
        || row.workflowCheckpointEnvelope !== null
        || row.resultEnvelope !== null
        || row.replyContextEnvelope !== null
        || currentAutomationRunFailureDetailEnvelope(row) !== null
        || row.summaryCiphertext !== null;
}

function automationRunMigrationCandidateWhere(
    accountId: string,
    afterId?: string,
) {
    return {
        accountId,
        ...(afterId ? { id: { gt: afterId } } : {}),
        OR: [
            { triggerEvidenceEnvelope: { not: null } },
            { occurrenceEvidenceEqualityTag: { not: null } },
            { executionInputEnvelope: { not: null } },
            { workflowAcceptedSnapshotEnvelope: { not: null } },
            { workflowCheckpointEnvelope: { not: null } },
            { resultEnvelope: { not: null } },
            { replyContextEnvelope: { not: null } },
            // Released V2 public error text shares this column. The strict
            // parser above remains the final private-content discriminator.
            { errorMessage: { not: null } },
            { summaryCiphertext: { not: null } },
        ],
    };
}

const automationRunMigrationParticipantSelect = {
    ...automationRunCauseSelect,
    id: true,
    accountId: true,
    originKind: true,
    originSessionId: true,
    automationId: true,
    occurrenceEvidenceEqualityTag: true,
    triggerEvidenceEnvelope: true,
    executionInputEnvelope: true,
    workflowAcceptedSnapshotEnvelope: true,
    workflowCheckpointEnvelope: true,
    resultEnvelope: true,
    replyContextEnvelope: true,
    errorMessage: true,
    summaryCiphertext: true,
    workflowCustodyState: true,
    revision: true,
} satisfies Prisma.AutomationRunSelect;

type AutomationAccountEncryptionMigrationRunRow = Prisma.AutomationRunGetPayload<{
    select: typeof automationRunMigrationParticipantSelect;
}>;

const workflowInvocationMigrationParticipantSelect = {
    id: true,
    runId: true,
    sequence: true,
    parentRecordId: true,
    memberOrdinal: true,
    attempt: true,
    contentRevision: true,
    contentEnvelope: true,
} satisfies Prisma.WorkflowRunInvocationSelect;

type WorkflowInvocationEncryptionMigrationRow =
    Prisma.WorkflowRunInvocationGetPayload<{
        select: typeof workflowInvocationMigrationParticipantSelect;
    }>;

function workflowInvocationStoredBinding(
    accountId: string,
    row: WorkflowInvocationEncryptionMigrationRow,
) {
    return {
        v: 1 as const,
        purpose: "invocation_progress" as const,
        accountId,
        runId: row.runId,
        recordId: row.id,
        sequence: row.sequence.toString(),
        parentRecordId: row.parentRecordId,
        memberOrdinal: row.memberOrdinal.toString(),
        attempt: row.attempt.toString(),
    };
}

function transitionInventoryWorkflowInvocation(
    row: WorkflowInvocationEncryptionMigrationRow,
): Extract<AutomationAccountEncryptionTransitionInventoryItem, {
    kind: "workflow_invocation";
}> {
    return {
        kind: "workflow_invocation",
        runId: row.runId,
        invocationRecordId: row.id,
        source: { contentEnvelope: row.contentEnvelope },
    };
}

function transitionInventoryRun(
    row: AutomationAccountEncryptionMigrationRunRow,
): Extract<AutomationAccountEncryptionTransitionInventoryItem, { kind: "run" }> {
    const source = {
        triggerEvidenceEnvelope: row.triggerEvidenceEnvelope,
        occurrenceEvidenceEqualityTag: row.occurrenceEvidenceEqualityTag === null
            ? null
            : AutomationOccurrenceEvidenceEqualityTagV1Schema.parse(
                row.occurrenceEvidenceEqualityTag,
            ),
        executionInputEnvelope: row.executionInputEnvelope,
        workflowAcceptedSnapshotEnvelope: row.workflowAcceptedSnapshotEnvelope,
        workflowCheckpointEnvelope: row.workflowCheckpointEnvelope,
        resultEnvelope: row.resultEnvelope,
        replyContextEnvelope: row.replyContextEnvelope,
        failureDetailEnvelope: currentAutomationRunFailureDetailEnvelope(row),
        summaryCiphertext: row.summaryCiphertext,
    };
    if (row.originKind === "direct") {
        return {
            kind: "run",
            runId: row.id,
            origin: {
                kind: "direct",
                ...(row.originSessionId ? { originSessionId: row.originSessionId } : {}),
            },
            revision: row.revision,
            source,
        };
    }
    if (!isAutomationCauseRow(row)) {
        throw new AutomationValidationError("Automation-origin Run has invalid origin correspondence");
    }
    return {
        kind: "run",
        runId: row.id,
        origin: { kind: "automation", automationId: row.automationId },
        revision: row.revision,
        cause: decodeAutomationRunCause(row),
        source,
    };
}

function transitionInventoryItemEncodedBytes(
    item: AutomationAccountEncryptionTransitionInventoryItem,
): bigint {
    return BigInt(new TextEncoder().encode(JSON.stringify(item)).byteLength);
}

function transitionSourcePage(
    items: readonly AutomationAccountEncryptionTransitionInventoryItem[],
    runCount: number,
    nextCursor?: AutomationAccountEncryptionTransitionSourceCursor,
) {
    return {
        status: "complete" as const,
        page: {
            items,
            sourceEncodedBytes: items.reduce(
                (total, item) => total + transitionInventoryItemEncodedBytes(item),
                0n,
            ),
            runCount,
            ...(nextCursor ? { nextCursor } : {}),
        },
    };
}

function assertAutomationRunTransitionSourceForMode(
    row: AutomationAccountEncryptionMigrationRunRow,
    mode: "plain" | "e2ee",
): void {
    assertAutomationRunStoredContentForAccountMode({
        row,
        mode,
        content: automationRunMigrationStoredContent(row),
        allowLegacyResultSource: true,
    });
}

function assertAutomationRunTransitionTargetForMode(
    row: AutomationAccountEncryptionMigrationRunRow,
    content: Extract<AutomationAccountEncryptionTransitionStageItem, {
        kind: "run";
    }>["target"],
    mode: "plain" | "e2ee",
): void {
    assertAutomationRunStoredContentForAccountMode({ row, mode, content });
}

function isAutomationTransitionInvalidContentError(error: unknown): boolean {
    return error instanceof AutomationValidationError
        || error instanceof WorkflowStoredContentError;
}

function assertAutomationDefinitionStoredContentForAccountMode(params: Readonly<{
    row: AutomationAccountEncryptionMigrationRow;
    mode: "plain" | "e2ee";
}>): void {
    for (const trigger of params.row.triggers) {
        if (trigger.kind !== "pluginEvent" && trigger.kind !== "prComment" && trigger.kind !== "ciFailed") {
            if (trigger.definitionEnvelope !== null) {
                throw new AutomationValidationError(
                    "Non-Event Automation triggers must not retain trigger-definition content",
                );
            }
            continue;
        }
        if (trigger.definitionEnvelope === null) {
            throw new AutomationValidationError(
                "Event Automation triggers require retained trigger-definition content",
            );
        }
        const binding = readAutomationTriggerDefinitionBinding({
            automationId: params.row.id,
            triggerId: trigger.id,
            triggerRevision: trigger.revision,
            triggerKind: trigger.kind,
            triggerEventPluginId: trigger.eventPluginId,
            triggerEventLocalId: trigger.eventLocalId,
            triggerSourceSelectorId: trigger.sourceSelectorId,
        });
        if (!binding) {
            throw new AutomationValidationError(
                "Event Automation trigger identity is incomplete",
            );
        }
        const definition = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
            raw: trigger.definitionEnvelope,
            mode: params.mode,
            binding,
        });
        if (definition.kind !== "available") {
            throw new AutomationValidationError(
                "Automation trigger-definition source does not match the Account mode or definition binding",
            );
        }
    }

    const workflow = parseAutomationStoredWorkflowDefinitionRecipeV2(params.row.templateCiphertext);
    if (workflow.kind === "available") {
        if (params.row.targetType !== null || workflow.recipe.templateVersion !== params.row.templateVersion) {
            throw new AutomationValidationError("Stored Workflow definition does not match its template version or target");
        }
        const outer = validateAutomationStoredContentEnvelopeOuterForMode({
            raw: createCanonicalJsonSigningInput(workflow.recipe.workflow), mode: params.mode,
        });
        if (outer.kind !== "available") {
            throw new AutomationValidationError("Stored Workflow definition does not match the Account mode");
        }
        return;
    }
    const strict = parseAutomationStoredDefinitionExecutionRecipeV1(
        params.row.templateCiphertext,
    );
    if (strict.kind === "available") {
        assertStrictAutomationDefinitionMigrationRecipe(strict.recipe);
        if (
            strict.recipe.templateVersion !== params.row.templateVersion
            || toCurrentAutomationDefinitionTargetType(strict.recipe)
                !== params.row.targetType
        ) {
            throw new AutomationValidationError(
                "Stored strict Automation definition does not match its template version or target",
            );
        }
        assertStrictAutomationMigrationRecipeMode({
            recipe: strict.recipe,
            mode: params.mode,
        });
        return;
    }
    if (!isAutomationLegacyTargetType(params.row.targetType)) {
        throw new AutomationValidationError(
            "Legacy Automation migration templates cannot target execution_run",
        );
    }
    assertAutomationTemplateEnvelopeForAccountMode(
        params.row.templateCiphertext,
        params.mode,
        params.row.targetType,
        readRetainedMigrationTemplateAdmission({
            row: params.row,
            templateCiphertext: params.row.templateCiphertext,
        }),
    );
}

async function loadAutomationAccountEncryptionMigrationDefinitionPageInTx(
    tx: Tx,
    accountId: string,
    afterId: string | undefined,
    take: number,
): Promise<AutomationAccountEncryptionMigrationRow[]> {
    return await tx.automation.findMany({
        where: {
            accountId,
            ...(afterId ? { id: { gt: afterId } } : {}),
        },
        select: automationMigrationDefinitionSelect,
        orderBy: { id: "asc" },
        take,
    });
}

async function loadAutomationAccountEncryptionMigrationRunPageInTx(
    tx: Tx,
    accountId: string,
    afterId: string | undefined,
    take: number,
): Promise<AutomationAccountEncryptionMigrationRunRow[]> {
    const participants: AutomationAccountEncryptionMigrationRunRow[] = [];
    let scanAfterId = afterId;
    while (participants.length < take) {
        const rows = await tx.automationRun.findMany({
            where: automationRunMigrationCandidateWhere(accountId, scanAfterId),
            select: automationRunMigrationParticipantSelect,
            orderBy: { id: "asc" },
            take,
        });
        const last = rows.at(-1);
        if (!last) break;
        scanAfterId = last.id;
        participants.push(...rows.filter(automationRunHasMigrationPrivateContent));
        if (rows.length < take) break;
    }
    return participants.slice(0, take);
}

async function loadWorkflowInvocationEncryptionMigrationPageInTx(
    tx: Tx,
    accountId: string,
    afterId: string | undefined,
    take: number,
): Promise<WorkflowInvocationEncryptionMigrationRow[]> {
    return await tx.workflowRunInvocation.findMany({
        where: {
            run: { accountId },
            ...(afterId ? { id: { gt: afterId } } : {}),
        },
        select: workflowInvocationMigrationParticipantSelect,
        orderBy: { id: "asc" },
        take,
    });
}

/**
 * One bounded all-cause Automation source page for the Account transition.
 * Definitions are deliberately first so the durable stage's closed identity
 * ordering remains stable without inventing a participant registry.
 */
export async function inspectAutomationAccountEncryptionTransitionInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        sourceMode: "plain" | "e2ee";
        cursor?: AutomationAccountEncryptionTransitionSourceCursor;
    }>,
): Promise<
    | Readonly<{ status: "complete"; page: AutomationAccountEncryptionTransitionSourcePage }>
    | Readonly<{ status: "invalid_content" }>
> {
    const pageLimit = ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS;
    const items: AutomationAccountEncryptionTransitionInventoryItem[] = [];
    try {
        if (!params.cursor || params.cursor.kind === "definition") {
            const rows = await loadAutomationAccountEncryptionMigrationDefinitionPageInTx(
                params.tx,
                params.accountId,
                params.cursor?.kind === "definition"
                    ? params.cursor.participantId
                    : undefined,
                pageLimit + 1,
            );
            const selected = rows.slice(0, pageLimit);
            for (const row of selected) {
                assertAutomationDefinitionStoredContentForAccountMode({
                    row,
                    mode: params.sourceMode,
                });
                items.push(transitionInventoryDefinition(row));
            }
            if (selected.length === pageLimit) {
                return transitionSourcePage(items, 0, {
                    kind: "definition",
                    participantId: selected.at(-1)!.id,
                });
            }
        }

        let runCount = 0;
        if (items.length < pageLimit && params.cursor?.kind !== "workflow_invocation") {
            const rows = await loadAutomationAccountEncryptionMigrationRunPageInTx(
                params.tx,
                params.accountId,
                params.cursor?.kind === "run"
                    ? params.cursor.participantId
                    : undefined,
                pageLimit - items.length + 1,
            );
            const remaining = pageLimit - items.length;
            const selected = rows.slice(0, remaining);
            for (const row of selected) {
                assertAutomationRunTransitionSourceForMode(row, params.sourceMode);
                items.push(transitionInventoryRun(row));
            }
            runCount = selected.length;
            if (selected.length === remaining) {
                return transitionSourcePage(items, runCount, {
                    kind: "run",
                    participantId: selected.at(-1)!.id,
                });
            }
        }

        if (items.length < pageLimit) {
            const rows = await loadWorkflowInvocationEncryptionMigrationPageInTx(
                params.tx,
                params.accountId,
                params.cursor?.kind === "workflow_invocation"
                    ? params.cursor.participantId
                    : undefined,
                pageLimit - items.length + 1,
            );
            const remaining = pageLimit - items.length;
            const selected = rows.slice(0, remaining);
            for (const row of selected) {
                assertWorkflowStoredEnvelopeOuterForMode({
                    raw: row.contentEnvelope,
                    mode: params.sourceMode,
                    binding: workflowInvocationStoredBinding(params.accountId, row),
                });
                items.push(transitionInventoryWorkflowInvocation(row));
            }
            if (selected.length === remaining) {
                return transitionSourcePage(items, runCount, {
                    kind: "workflow_invocation",
                    participantId: selected.at(-1)!.id,
                });
            }
        }
        return transitionSourcePage(items, runCount);
    } catch (error) {
        if (isAutomationTransitionInvalidContentError(error)) {
            return { status: "invalid_content" };
        }
        throw error;
    }
}

type AutomationAccountEncryptionTransitionValidatedDefinition = Readonly<{
    row: AutomationAccountEncryptionMigrationRow;
    item: Extract<AutomationAccountEncryptionTransitionStageItem, { kind: "definition" }>;
    targetTriggerDefinitionEnvelopes: readonly Readonly<{
        triggerId: string;
        triggerKind: "pluginEvent" | "prComment" | "ciFailed";
        triggerRevision: number;
        sourceEnvelope: string;
        targetEnvelope: string;
    }>[];
}>;

type AutomationAccountEncryptionTransitionValidatedRun = Readonly<{
    row: AutomationAccountEncryptionMigrationRunRow;
    item: Extract<AutomationAccountEncryptionTransitionStageItem, { kind: "run" }>;
}>;

type AutomationAccountEncryptionTransitionValidatedWorkflowInvocation = Readonly<{
    row: WorkflowInvocationEncryptionMigrationRow;
    item: Extract<AutomationAccountEncryptionTransitionStageItem, {
        kind: "workflow_invocation";
    }>;
}>;

type AutomationAccountEncryptionTransitionValidatedStageBatch = Readonly<{
    definitions: readonly AutomationAccountEncryptionTransitionValidatedDefinition[];
    runs: readonly AutomationAccountEncryptionTransitionValidatedRun[];
    workflowInvocations:
        readonly AutomationAccountEncryptionTransitionValidatedWorkflowInvocation[];
}>;

export type AutomationAccountEncryptionTransitionStageValidationResult =
    | Readonly<{ status: "validated" }>
    | Readonly<{ status: "migration_incomplete" | "invalid_content" }>;

export type AutomationAccountEncryptionTransitionStageApplyResult =
    | Readonly<{ status: "applied" }>
    | Readonly<{ status: "migration_incomplete" | "invalid_content" }>;

function transitionStageIdentity(
    item: AutomationAccountEncryptionTransitionStageItem,
): string {
    return item.kind === "definition"
        ? `definition\u0000${item.automationId}`
        : item.kind === "run"
            ? `run\u0000${item.runId}`
            : `workflow_invocation\u0000${item.invocationRecordId}`;
}

function stageDefinitionSourceMatches(
    row: AutomationAccountEncryptionMigrationRow,
    item: Extract<AutomationAccountEncryptionTransitionStageItem, { kind: "definition" }>,
): boolean {
    return row.id === item.automationId
        && row.templateVersion === item.expectedRevision
        && pluginJsonValuesEqual(
            transitionInventoryDefinition(row).source,
            item.source,
        );
}

function stageRunSourceMatches(
    row: AutomationAccountEncryptionMigrationRunRow,
    item: Extract<AutomationAccountEncryptionTransitionStageItem, { kind: "run" }>,
): boolean {
    return row.id === item.runId
        && pluginJsonValuesEqual(
            row.originKind === "direct"
                ? {
                    kind: "direct",
                    ...(row.originSessionId ? { originSessionId: row.originSessionId } : {}),
                }
                : { kind: "automation", automationId: row.automationId },
            item.origin,
        )
        && row.revision === item.expectedRevision
        && (item.origin.kind === "direct"
            || ("cause" in item
                && pluginJsonValuesEqual(decodeAutomationRunCause(row), item.cause)))
        && row.triggerEvidenceEnvelope === item.source.triggerEvidenceEnvelope
        && row.occurrenceEvidenceEqualityTag
            === item.source.occurrenceEvidenceEqualityTag
        && row.executionInputEnvelope === item.source.executionInputEnvelope
        && row.workflowAcceptedSnapshotEnvelope
            === item.source.workflowAcceptedSnapshotEnvelope
        && row.workflowCheckpointEnvelope === item.source.workflowCheckpointEnvelope
        && row.resultEnvelope === item.source.resultEnvelope
        && row.replyContextEnvelope === item.source.replyContextEnvelope
        && currentAutomationRunFailureDetailEnvelope(row)
            === item.source.failureDetailEnvelope
        && row.summaryCiphertext === item.source.summaryCiphertext;
}

function stageWorkflowInvocationSourceMatches(
    row: WorkflowInvocationEncryptionMigrationRow,
    item: Extract<AutomationAccountEncryptionTransitionStageItem, {
        kind: "workflow_invocation";
    }>,
): boolean {
    return row.id === item.invocationRecordId
        && row.runId === item.runId
        && row.contentEnvelope === item.source.contentEnvelope;
}

function validateAutomationTriggerDefinitionTransitionTargets(params: Readonly<{
    row: AutomationAccountEncryptionMigrationRow;
    item: Extract<AutomationAccountEncryptionTransitionStageItem, { kind: "definition" }>;
    sourceMode: "plain" | "e2ee";
    targetMode: "plain" | "e2ee";
}>): AutomationAccountEncryptionTransitionValidatedDefinition["targetTriggerDefinitionEnvelopes"] {
    const pluginEventTriggers = params.row.triggers.filter(
        (trigger) => trigger.kind === "pluginEvent" || trigger.kind === "prComment" || trigger.kind === "ciFailed",
    );
    if (params.item.target.triggerDefinitionEnvelopes.length !== pluginEventTriggers.length) {
        throw new AutomationValidationError(
            "Automation trigger-definition transition must preserve the exact Event trigger set",
        );
    }
    const targetsById = new Map(
        params.item.target.triggerDefinitionEnvelopes.map((target) => [target.triggerId, target] as const),
    );
    if (targetsById.size !== pluginEventTriggers.length) {
        throw new AutomationValidationError(
            "Automation trigger-definition transition contains duplicate trigger identities",
        );
    }
    return pluginEventTriggers.map((trigger) => {
        const target = targetsById.get(AutomationTriggerIdSchema.parse(trigger.id));
        if (
            !target
            || target.triggerRevision !== trigger.revision
            || trigger.definitionEnvelope === null
        ) {
            throw new AutomationValidationError(
                "Automation trigger-definition transition lost exact trigger currentness",
            );
        }
        const binding = readAutomationTriggerDefinitionBinding({
            automationId: params.row.id,
            triggerId: trigger.id,
            triggerRevision: trigger.revision,
            triggerKind: trigger.kind,
            triggerEventPluginId: trigger.eventPluginId,
            triggerEventLocalId: trigger.eventLocalId,
            triggerSourceSelectorId: trigger.sourceSelectorId,
        });
        if (!binding) {
            throw new AutomationValidationError(
                "Automation Event trigger identity is incomplete",
            );
        }
        const sourceValidation = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
            raw: trigger.definitionEnvelope,
            mode: params.sourceMode,
            binding,
        });
        const targetValidation = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
            raw: target.envelope,
            mode: params.targetMode,
            binding,
        });
        if (sourceValidation.kind !== "available" || targetValidation.kind !== "available") {
            throw new AutomationValidationError(
                "Automation trigger-definition transition content does not match its mode or binding",
            );
        }
        return {
            triggerId: trigger.id,
            triggerKind: binding.triggerKind,
            triggerRevision: trigger.revision,
            sourceEnvelope: trigger.definitionEnvelope,
            targetEnvelope: target.envelope,
        };
    });
}

async function loadAutomationAccountEncryptionTransitionDefinitionsByIdsInTx(
    tx: Tx,
    accountId: string,
    ids: readonly string[],
): Promise<AutomationAccountEncryptionMigrationRow[]> {
    if (ids.length === 0) return [];
    return await tx.automation.findMany({
        where: { accountId, id: { in: [...ids] } },
        select: automationMigrationDefinitionSelect,
    });
}

async function loadAutomationAccountEncryptionTransitionRunsByIdsInTx(
    tx: Tx,
    accountId: string,
    ids: readonly string[],
): Promise<AutomationAccountEncryptionMigrationRunRow[]> {
    if (ids.length === 0) return [];
    return await tx.automationRun.findMany({
        where: { accountId, id: { in: [...ids] } },
        select: automationRunMigrationParticipantSelect,
    });
}

async function loadWorkflowInvocationEncryptionTransitionRowsByIdsInTx(
    tx: Tx,
    accountId: string,
    ids: readonly string[],
): Promise<WorkflowInvocationEncryptionMigrationRow[]> {
    if (ids.length === 0) return [];
    return await tx.workflowRunInvocation.findMany({
        where: { id: { in: [...ids] }, run: { accountId } },
        select: workflowInvocationMigrationParticipantSelect,
    });
}

/**
 * The Automation owner validates the exact staged source and target against
 * live Definition/Run rows. The Account coordinator owns the transition and
 * aggregate capacity; this helper owns no lifecycle state or storage.
 */
async function validateAutomationAccountEncryptionTransitionStageBatchInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        fromMode: "plain" | "e2ee";
        toMode: "plain" | "e2ee";
        items: readonly AutomationAccountEncryptionTransitionStageItem[];
    }>,
): Promise<
    | Readonly<{
        status: "validated";
        batch: AutomationAccountEncryptionTransitionValidatedStageBatch;
    }>
    | Readonly<{ status: "migration_incomplete" | "invalid_content" }>
> {
    if (
        params.items.length === 0
        || params.items.length
            > ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS
        || new Set(params.items.map(transitionStageIdentity)).size
            !== params.items.length
    ) {
        return { status: "invalid_content" };
    }
    const definitions = params.items.filter((item): item is Extract<
        AutomationAccountEncryptionTransitionStageItem,
        { kind: "definition" }
    > => item.kind === "definition");
    const runs = params.items.filter((item): item is Extract<
        AutomationAccountEncryptionTransitionStageItem,
        { kind: "run" }
    > => item.kind === "run");
    const workflowInvocations = params.items.filter((item): item is Extract<
        AutomationAccountEncryptionTransitionStageItem,
        { kind: "workflow_invocation" }
    > => item.kind === "workflow_invocation");
    const [definitionRows, runRows, invocationRows, actualSourceMode] = await Promise.all([
        loadAutomationAccountEncryptionTransitionDefinitionsByIdsInTx(
            params.tx,
            params.accountId,
            definitions.map((item) => item.automationId),
        ),
        loadAutomationAccountEncryptionTransitionRunsByIdsInTx(
            params.tx,
            params.accountId,
            runs.map((item) => item.runId),
        ),
        loadWorkflowInvocationEncryptionTransitionRowsByIdsInTx(
            params.tx,
            params.accountId,
            workflowInvocations.map((item) => item.invocationRecordId),
        ),
        readAutomationMigrationSourceModeInTx(params.tx, params.accountId),
    ]);
    if (
        actualSourceMode !== params.fromMode
        || definitionRows.length !== definitions.length
        || runRows.length !== runs.length
        || invocationRows.length !== workflowInvocations.length
    ) {
        return { status: "migration_incomplete" };
    }
    const definitionsById = new Map(
        definitionRows.map((row) => [row.id, row] as const),
    );
    const runsById = new Map(runRows.map((row) => [row.id, row] as const));
    const invocationsById = new Map(invocationRows.map((row) => [row.id, row] as const));
    if (
        definitions.some((item) => {
            const row = definitionsById.get(item.automationId);
            return !row || !stageDefinitionSourceMatches(row, item);
        })
        || runs.some((item) => {
            const row = runsById.get(item.runId);
            return !row || !stageRunSourceMatches(row, item);
        })
        || workflowInvocations.some((item) => {
            const row = invocationsById.get(item.invocationRecordId);
            return !row || !stageWorkflowInvocationSourceMatches(row, item);
        })
    ) {
        return { status: "migration_incomplete" };
    }
    try {
        const validatedDefinitions: AutomationAccountEncryptionTransitionValidatedDefinition[] = [];
        for (const item of definitions) {
            const row = definitionsById.get(item.automationId);
            if (!row) return { status: "migration_incomplete" };
            assertAutomationDefinitionStoredContentForAccountMode({
                row,
                mode: params.fromMode,
            });
            const target = classifyAutomationMigrationTemplate({
                row,
                templateCiphertext: item.target.templateCiphertext,
                expectedTemplateVersion: item.expectedRevision,
                toMode: params.toMode,
            });
            assertAutomationMigrationSourcePreserved({
                row,
                expectedTemplateVersion: item.expectedRevision,
                sourceMode: params.fromMode,
                target,
            });
            await validateExistingSessionAutomationTargetTx({
                tx: params.tx,
                accountId: params.accountId,
                targetType: row.targetType,
                accountMode: params.toMode,
                ...(target.kind === "strict"
                    ? { strictExistingSessionId: target.strictExistingSessionId }
                    : target.kind === "legacy" ? {
                        templateCiphertext: item.target.templateCiphertext,
                        legacyExistingSessionId:
                            target.legacyTemplateEnvelopeAdmission?.existingSessionId,
                    } : {}),
            });
            const targetTriggerDefinitionEnvelopes =
                validateAutomationTriggerDefinitionTransitionTargets({
                    row,
                    item,
                    sourceMode: params.fromMode,
                    targetMode: params.toMode,
                });
            validatedDefinitions.push({
                row,
                item,
                targetTriggerDefinitionEnvelopes,
            });
        }
        const validatedRuns: AutomationAccountEncryptionTransitionValidatedRun[] = [];
        for (const item of runs) {
            const row = runsById.get(item.runId);
            if (!row) return { status: "migration_incomplete" };
            assertAutomationRunTransitionSourceForMode(row, params.fromMode);
            assertAutomationRunOptionalContentNullnessPreserved({
                source: automationRunMigrationStoredContent(row),
                target: item.target,
            });
            assertAutomationRunTransitionTargetForMode(
                row,
                item.target,
                params.toMode,
            );
            validatedRuns.push({ row, item });
        }
        const validatedWorkflowInvocations:
            AutomationAccountEncryptionTransitionValidatedWorkflowInvocation[] = [];
        for (const item of workflowInvocations) {
            const row = invocationsById.get(item.invocationRecordId);
            if (!row) return { status: "migration_incomplete" };
            const binding = workflowInvocationStoredBinding(params.accountId, row);
            assertWorkflowStoredEnvelopeOuterForMode({
                raw: row.contentEnvelope,
                mode: params.fromMode,
                binding,
            });
            assertWorkflowStoredEnvelopeOuterForMode({
                raw: item.target.contentEnvelope,
                mode: params.toMode,
                binding,
            });
            validatedWorkflowInvocations.push({ row, item });
        }
        return {
            status: "validated",
            batch: {
                definitions: validatedDefinitions,
                runs: validatedRuns,
                workflowInvocations: validatedWorkflowInvocations,
            },
        };
    } catch (error) {
        if (isAutomationTransitionInvalidContentError(error)) {
            return { status: "invalid_content" };
        }
        throw error;
    }
}

export async function validateAutomationAccountEncryptionTransitionStageInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        fromMode: "plain" | "e2ee";
        toMode: "plain" | "e2ee";
        items: readonly AutomationAccountEncryptionTransitionStageItem[];
    }>,
): Promise<AutomationAccountEncryptionTransitionStageValidationResult> {
    const validated = await validateAutomationAccountEncryptionTransitionStageBatchInTx(params);
    return validated.status === "validated"
        ? { status: "validated" }
        : validated;
}

/**
 * Applies only an already persisted, source-bound stage page. A currentness
 * miss throws so the enclosing Account transition transaction rolls back
 * every prior participant mutation instead of committing a partial flip.
 */
export async function applyAutomationAccountEncryptionTransitionStageInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        fromMode: "plain" | "e2ee";
        toMode: "plain" | "e2ee";
        items: readonly AutomationAccountEncryptionTransitionStageItem[];
    }>,
): Promise<AutomationAccountEncryptionTransitionStageApplyResult> {
    const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
        params.tx,
        params.accountId,
    );
    if (
        accountFence.status !== "ready"
        || accountFence.account.currentness.encryptionMode !== params.fromMode
    ) {
        return { status: "migration_incomplete" };
    }
    const validated = await validateAutomationAccountEncryptionTransitionStageBatchInTx(params);
    if (validated.status !== "validated") return validated;
    for (const candidate of validated.batch.definitions) {
        const updated = await params.tx.automation.updateMany({
            where: {
                id: candidate.row.id,
                accountId: params.accountId,
                templateVersion: candidate.item.expectedRevision,
            },
            data: {
                templateCiphertext: candidate.item.target.templateCiphertext,
                templateVersion: { increment: 1 },
                // Re-sealing Account content preserves the plaintext template,
                // so the scheduling projection is unchanged. Clearing it here
                // would drop an unrelated next-run wake this write never
                // recomputes.
                updatedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new AutomationAccountEncryptionMigrationConflictError();
        }
        for (const trigger of candidate.targetTriggerDefinitionEnvelopes) {
            const triggerUpdated = await params.tx.automationTrigger.updateMany({
                where: {
                    id: trigger.triggerId,
                    automationId: candidate.row.id,
                    kind: trigger.triggerKind,
                    revision: trigger.triggerRevision,
                    definitionEnvelope: trigger.sourceEnvelope,
                },
                data: {
                    definitionEnvelope: trigger.targetEnvelope,
                    updatedAt: new Date(),
                },
            });
            if (triggerUpdated.count !== 1) {
                throw new AutomationAccountEncryptionMigrationConflictError();
            }
        }
        const automation = await loadAutomationTx(params.tx, {
            accountId: params.accountId,
            automationId: candidate.row.id,
            includeDeleted: true,
        });
        if (!automation) throw new AutomationAccountEncryptionMigrationConflictError();
        const cursor = await markAutomationChangedTx(params.tx, {
            accountId: params.accountId,
            automationId: candidate.row.id,
        });
        afterTx(params.tx, () => {
            emitAutomationUpsert({
                accountId: params.accountId,
                automation,
                cursor,
            });
        });
    }
    for (const candidate of validated.batch.runs) {
        const originWhere = candidate.item.origin.kind === "automation"
            ? (() => {
                if (!("cause" in candidate.item)) {
                    throw new AutomationAccountEncryptionMigrationConflictError();
                }
                return {
                    originKind: "automation" as const,
                    automationId: candidate.item.origin.automationId,
                    ...encodeAutomationRunCause(candidate.item.cause),
                };
            })()
            : {
                originKind: "direct" as const,
                automationId: null,
                originSessionId: candidate.item.origin.originSessionId ?? null,
            };
        const updated = await params.tx.automationRun.updateMany({
            where: {
                id: candidate.row.id,
                accountId: params.accountId,
                revision: candidate.item.expectedRevision,
                ...originWhere,
            },
            data: {
                triggerEvidenceEnvelope: candidate.item.target.triggerEvidenceEnvelope,
                occurrenceEvidenceEqualityTag:
                    candidate.item.target.occurrenceEvidenceEqualityTag,
                executionInputEnvelope: candidate.item.target.executionInputEnvelope,
                workflowAcceptedSnapshotEnvelope:
                    candidate.item.target.workflowAcceptedSnapshotEnvelope,
                workflowCheckpointEnvelope:
                    candidate.item.target.workflowCheckpointEnvelope,
                resultEnvelope: candidate.item.target.resultEnvelope,
                replyContextEnvelope: candidate.item.target.replyContextEnvelope,
                errorMessage: candidate.item.target.failureDetailEnvelope
                    ?? (currentAutomationRunFailureDetailEnvelope(candidate.row) === null
                        ? candidate.row.errorMessage
                        : null),
                summaryCiphertext: null,
                revision: { increment: 1 },
                updatedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new AutomationAccountEncryptionMigrationConflictError();
        }
        const run = await params.tx.automationRun.findFirst({
            where: { id: candidate.row.id, accountId: params.accountId },
            select: automationRunItemSelect,
        });
        if (!run) throw new AutomationAccountEncryptionMigrationConflictError();
        if (candidate.item.origin.kind === "automation") {
            const cursor = await markAutomationChangedTx(params.tx, {
                accountId: params.accountId,
                automationId: candidate.item.origin.automationId,
            });
            afterTx(params.tx, () => {
                emitAutomationRunUpdated({
                    accountId: params.accountId,
                    run: run as AutomationRunItem,
                    cursor,
                });
            });
        }
    }
    for (const candidate of validated.batch.workflowInvocations) {
        const updated = await params.tx.workflowRunInvocation.updateMany({
            where: {
                id: candidate.row.id,
                runId: candidate.row.runId,
                contentEnvelope: candidate.item.source.contentEnvelope,
                contentRevision: { equals: candidate.row.contentRevision, lt: 9_223_372_036_854_775_807n },
                run: { accountId: params.accountId },
            },
            data: {
                contentEnvelope: candidate.item.target.contentEnvelope,
                contentRevision: { increment: 1 },
                updatedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new AutomationAccountEncryptionMigrationConflictError();
        }
    }
    if (validated.batch.definitions.some((candidate) => (
        candidate.row.enabled
        && candidate.row.deletedAt === null
        && candidate.row.triggers.some((trigger) => (
            trigger.kind === "pluginEvent"
            && trigger.enabled
            && trigger.deletedAt === null
        ))
    ))) {
        await ensureAutomationEventCatalogStateTx({
            tx: params.tx,
            accountId: params.accountId,
            projectionChanged: true,
        });
    }
    return { status: "applied" };
}

async function loadAutomationAccountEncryptionMigrationRowsInTx(
    tx: Tx,
    accountId: string,
): Promise<AutomationAccountEncryptionMigrationRow[]> {
    return await tx.automation.findMany({
        where: { accountId },
        select: automationMigrationDefinitionSelect,
        orderBy: { id: "asc" },
    });
}

async function loadAutomationAccountEncryptionMigrationRunsInTx(
    tx: Tx,
    accountId: string,
): Promise<AutomationAccountEncryptionMigrationRunRow[]> {
    const rows = await tx.automationRun.findMany({
        where: automationRunMigrationCandidateWhere(accountId),
        select: automationRunMigrationParticipantSelect,
        orderBy: { id: "asc" },
    });
    return rows.filter(automationRunHasMigrationPrivateContent);
}

/** The development cut leaves recognized Account-key Workflow history untouched. */
function isPreCutWorkflowMigrationRun(row: AutomationAccountEncryptionMigrationRunRow): boolean {
    if (row.workflowCustodyState === null || row.workflowAcceptedSnapshotEnvelope === null) return false;
    const envelope = parseWorkflowStoredContentEnvelopeV1(row.workflowAcceptedSnapshotEnvelope);
    if (envelope?.t === "encrypted") {
        return isAccountScopedBlobCiphertextForKind({
            kind: "workflow_accepted_snapshot", ciphertext: envelope.c,
        });
    }
    return envelope?.t === "plain" && typeof envelope.v === "object"
        && envelope.v !== null && !Array.isArray(envelope.v) && envelope.v.v === 1;
}

export async function readAutomationAccountEncryptionMigrationInventoryInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
}>): Promise<AccountEncryptionMigrateAutomationsInventoryResponse> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(params.tx, params.accountId);
    if (fence.status !== "ready") throw new AutomationAccountEncryptionMigrationConflictError();
    const rows = await loadAutomationAccountEncryptionMigrationRowsInTx(params.tx, params.accountId);
    const runs = (await loadAutomationAccountEncryptionMigrationRunsInTx(params.tx, params.accountId))
        .filter((row) => !isPreCutWorkflowMigrationRun(row));
    return AccountEncryptionMigrateAutomationsInventoryResponseSchema.parse({
        templates: rows.map((row) => ({
            automationId: row.id, expectedTemplateVersion: row.templateVersion,
            ...transitionInventoryDefinition(row).source,
        })),
        runs: await Promise.all(runs.map(async (row) => {
            assertAutomationRunStoredContentForAccountMode({
                row, mode: fence.account.currentness.encryptionMode,
                content: automationRunMigrationStoredContent(row), allowLegacyResultSource: true,
            });
            const invocations = row.workflowAcceptedSnapshotEnvelope === null ? []
                : await params.tx.workflowRunInvocation.findMany({
                    where: { runId: row.id }, orderBy: [{ sequence: "asc" }, { id: "asc" }],
                    select: invocationSelect,
                });
            for (const invocation of invocations) {
                assertWorkflowStoredEnvelopeOuterForMode({
                    mode: fence.account.currentness.encryptionMode,
                    raw: invocation.contentEnvelope,
                    binding: workflowInvocationStoredBinding(params.accountId, invocation),
                });
            }
            return {
            runId: row.id, expectedRunRevision: row.revision,
            triggerEvidenceEnvelope: row.triggerEvidenceEnvelope,
            occurrenceEvidenceEqualityTag: row.occurrenceEvidenceEqualityTag,
            executionInputEnvelope: row.executionInputEnvelope,
            resultEnvelope: row.resultEnvelope,
            replyContextEnvelope: row.replyContextEnvelope,
            failureDetailEnvelope: currentAutomationRunFailureDetailEnvelope(row),
            automationId: row.automationId, occurrenceKey: row.occurrenceKey, triggerId: row.triggerId,
            summaryCiphertext: row.summaryCiphertext,
            ...(row.workflowCustodyState !== null && row.workflowAcceptedSnapshotEnvelope !== null ? {
                workflow: {
                    acceptedSnapshotEnvelope: row.workflowAcceptedSnapshotEnvelope,
                    checkpointEnvelope: row.workflowCheckpointEnvelope,
                    keyCensus: await readWorkflowRunKeyProjectionInTx(params.tx, {
                        actorAccountId: params.accountId, runId: row.id,
                    }),
                    invocations: invocations.map((invocation) => ({
                        index: projectInvocation(invocation), contentEnvelope: invocation.contentEnvelope,
                    })),
                },
            } : {}),
            };
        })),
    });
}

type AutomationAccountEncryptionMigrationTemplateItem = Extract<
    AccountEncryptionMigrateAutomationsDirective,
    { action: "migrate" }
>["templates"][number];

function migrationItemMatchesTriggerDefinitionPostState(
    row: AutomationAccountEncryptionMigrationRow,
    item: AutomationAccountEncryptionMigrationTemplateItem,
): boolean {
    return pluginJsonValuesEqual(
        transitionInventoryDefinition(row).source.triggerDefinitionEnvelopes,
        item.triggerDefinitionEnvelopes,
    );
}

function hasCompleteTriggerDefinitionMigrationTarget(
    row: AutomationAccountEncryptionMigrationRow,
    item: AutomationAccountEncryptionMigrationTemplateItem,
): boolean {
    const eventTriggers = row.triggers.filter((trigger) => trigger.kind === "pluginEvent" || trigger.kind === "prComment" || trigger.kind === "ciFailed");
    const targets = item.triggerDefinitionEnvelopes;
    if (
        targets.length !== eventTriggers.length
        || new Set(targets.map((target) => target.triggerId)).size
            !== eventTriggers.length
    ) return false;
    const eventTriggersById = new Map(eventTriggers.map((trigger) => [trigger.id, trigger] as const));
    return targets.every((target) => {
        const trigger = eventTriggersById.get(target.triggerId);
        return trigger !== undefined && target.triggerRevision === trigger.revision;
    });
}

/**
 * Definition content participates with its template at this existing
 * definition-version/CAS owner. Schedule and Manual rows omit it:
 * both source and target must have no retained trigger-definition envelope.
 */
function validateAutomationTriggerDefinitionMigrationCandidate(params: Readonly<{
    row: AutomationAccountEncryptionMigrationRow;
    item: AutomationAccountEncryptionMigrationTemplateItem;
    sourceMode: "plain" | "e2ee";
    toMode: "plain" | "e2ee";
}>): AutomationAccountEncryptionTransitionValidatedDefinition["targetTriggerDefinitionEnvelopes"] {
    return validateAutomationTriggerDefinitionTransitionTargets({
        row: params.row,
        item: {
            kind: "definition",
            automationId: params.row.id,
            expectedRevision: params.item.expectedTemplateVersion,
            source: transitionInventoryDefinition(params.row).source,
            target: {
                templateCiphertext: params.item.templateCiphertext,
                triggerDefinitionEnvelopes:
                    params.item.triggerDefinitionEnvelopes,
            },
        },
        sourceMode: params.sourceMode,
        targetMode: params.toMode,
    });
}

function assertAutomationTriggerDefinitionMigrationPostState(params: Readonly<{
    row: AutomationAccountEncryptionMigrationRow;
    item: AutomationAccountEncryptionMigrationTemplateItem;
    toMode: "plain" | "e2ee";
}>): void {
    if (!migrationItemMatchesTriggerDefinitionPostState(params.row, params.item)) {
        throw new AutomationValidationError(
            "Automation trigger-definition post-state does not match its migration target",
        );
    }
    validateAutomationTriggerDefinitionTransitionTargets({
        row: params.row,
        item: {
            kind: "definition",
            automationId: params.row.id,
            expectedRevision: params.item.expectedTemplateVersion,
            source: transitionInventoryDefinition(params.row).source,
            target: {
                templateCiphertext: params.item.templateCiphertext,
                triggerDefinitionEnvelopes:
                    params.item.triggerDefinitionEnvelopes,
            },
        },
        sourceMode: params.toMode,
        targetMode: params.toMode,
    });
}

function automationMigrationItemsMatchInventory(
    rows: ReadonlyArray<AutomationAccountEncryptionMigrationRow>,
    templates: Extract<
        AccountEncryptionMigrateAutomationsDirective,
        { action: "migrate" }
    >["templates"],
    params: Readonly<{
        versionOffset: 0 | 1;
        compareTargetContent: boolean;
    }>,
): "match" | "incomplete" | "stale" {
    const templatesById = new Map(
        templates.map((item) => [item.automationId, item] as const),
    );
    if (
        templatesById.size !== templates.length
        || templatesById.size !== rows.length
    ) {
        return "incomplete";
    }
    for (const row of rows) {
        const item = templatesById.get(row.id);
        if (!item) {
            return "incomplete";
        }
        if (
            item.expectedTemplateVersion + params.versionOffset
            !== row.templateVersion
        ) {
            return "stale";
        }
        if (
            params.compareTargetContent
            && (
                item.templateCiphertext !== row.templateCiphertext
                || !migrationItemMatchesTriggerDefinitionPostState(row, item)
            )
        ) {
            return "stale";
        }
    }
    return "match";
}

function automationMigrationRunItemsMatchInventory(
    rows: ReadonlyArray<AutomationAccountEncryptionMigrationRunRow>,
    runs: NonNullable<Extract<
        AccountEncryptionMigrateAutomationsDirective,
        { action: "migrate" }
    >["runs"]>,
    params: Readonly<{
        revisionOffset: 0 | 1;
        compareTargetContent: boolean;
    }>,
): "match" | "incomplete" | "stale" {
    const runsById = new Map(runs.map((item) => [item.runId, item] as const));
    if (runsById.size !== runs.length || runsById.size !== rows.length) {
        return "incomplete";
    }
    for (const row of rows) {
        const item = runsById.get(row.id);
        if (!item) {
            return "incomplete";
        }
        if (item.expectedRunRevision + params.revisionOffset !== row.revision) {
            return "stale";
        }
        if (
            params.compareTargetContent
            && (
                item.triggerEvidenceEnvelope !== row.triggerEvidenceEnvelope
                || item.occurrenceEvidenceEqualityTag
                    !== row.occurrenceEvidenceEqualityTag
                || item.executionInputEnvelope !== row.executionInputEnvelope
                || item.resultEnvelope !== row.resultEnvelope
                || item.replyContextEnvelope !== row.replyContextEnvelope
                || item.failureDetailEnvelope
                    !== currentAutomationRunFailureDetailEnvelope(row)
            )
        ) {
            return "stale";
        }
    }
    return "match";
}

type AutomationAccountEncryptionMigrationRunStoredContent = Pick<
    AutomationAccountEncryptionMigrationRunRow,
    | "triggerEvidenceEnvelope"
    | "occurrenceEvidenceEqualityTag"
    | "executionInputEnvelope"
    | "workflowAcceptedSnapshotEnvelope"
    | "workflowCheckpointEnvelope"
    | "resultEnvelope"
    | "replyContextEnvelope"
> & Readonly<{ failureDetailEnvelope: string | null }>;

function automationRunMigrationStoredContent(
    row: AutomationAccountEncryptionMigrationRunRow,
): AutomationAccountEncryptionMigrationRunStoredContent {
    return {
        triggerEvidenceEnvelope: row.triggerEvidenceEnvelope,
        occurrenceEvidenceEqualityTag: row.occurrenceEvidenceEqualityTag,
        executionInputEnvelope: row.executionInputEnvelope,
        workflowAcceptedSnapshotEnvelope: row.workflowAcceptedSnapshotEnvelope,
        workflowCheckpointEnvelope: row.workflowCheckpointEnvelope,
        resultEnvelope: row.resultEnvelope,
        replyContextEnvelope: row.replyContextEnvelope,
        failureDetailEnvelope: currentAutomationRunFailureDetailEnvelope(row),
    };
}

function automationRunMigrationDirectiveTargetContent(
    row: AutomationAccountEncryptionMigrationRunRow,
    item: NonNullable<Extract<
        AccountEncryptionMigrateAutomationsDirective,
        { action: "migrate" }
    >["runs"]>[number],
): AutomationAccountEncryptionMigrationRunStoredContent {
    return {
        triggerEvidenceEnvelope: item.triggerEvidenceEnvelope,
        occurrenceEvidenceEqualityTag: item.occurrenceEvidenceEqualityTag,
        executionInputEnvelope: item.executionInputEnvelope,
        // Omitted predecessor fields retain their source bytes so unsafe
        // current Workflow flips still fail target-mode admission.
        workflowAcceptedSnapshotEnvelope: item.workflow?.acceptedSnapshotEnvelope
            ?? row.workflowAcceptedSnapshotEnvelope,
        workflowCheckpointEnvelope: item.workflow
            ? item.workflow.checkpointEnvelope : row.workflowCheckpointEnvelope,
        resultEnvelope: item.resultEnvelope,
        replyContextEnvelope: item.replyContextEnvelope,
        failureDetailEnvelope: item.failureDetailEnvelope,
    };
}

function assertAutomationRunOptionalContentNullnessPreserved(params: Readonly<{
    source: AutomationAccountEncryptionMigrationRunStoredContent;
    target: AutomationAccountEncryptionMigrationRunStoredContent;
}>): void {
    for (const field of [
        "executionInputEnvelope",
        "workflowAcceptedSnapshotEnvelope",
        "workflowCheckpointEnvelope",
        "resultEnvelope",
        "replyContextEnvelope",
        "failureDetailEnvelope",
    ] as const) {
        if ((params.source[field] === null) !== (params.target[field] === null)) {
            throw new AutomationValidationError(
                "Run Account migration must retain each optional private-content field",
            );
        }
    }
}

function assertAutomationReplyHandoffStoredEnvelopeForAccountMode(params: Readonly<{
    content: "result" | "replyContext";
    raw: string | null;
    mode: "plain" | "e2ee";
    allowLegacyResultSource?: boolean;
}>): void {
    if (params.raw === null) return;
    let envelope: unknown;
    try {
        envelope = JSON.parse(params.raw);
    } catch {
        throw new AutomationValidationError(
            "Run private-content envelope is not valid JSON",
        );
    }
    const validation = validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
        content: params.content,
        mode: params.mode,
        envelope,
    });
    if (
        validation.kind === "legacyUnsupported"
        && params.content === "result"
        && params.allowLegacyResultSource === true
    ) {
        return;
    }
    if (validation.kind !== "available") {
        throw new AutomationValidationError(
            "Run private-content envelope does not match the Account mode",
        );
    }
}

function assertAutomationRunLegacySummarySource(
    row: AutomationAccountEncryptionMigrationRunRow,
): void {
    if (row.summaryCiphertext === null) return;
    if (row.resultEnvelope === null) {
        throw new AutomationValidationError(
            "Run legacy summary must retain its tagged predecessor result source",
        );
    }
    const parsed = parseAutomationRunResultStoredEnvelopeV1(row.resultEnvelope);
    if (
        parsed === null
        || parsed.t !== "legacySummaryCiphertext"
        || parsed.c !== row.summaryCiphertext
    ) {
        throw new AutomationValidationError(
            "Run legacy summary result source does not match its retained predecessor bytes",
        );
    }
}

function assertAutomationRunStoredContentForAccountMode(params: Readonly<{
    row: AutomationAccountEncryptionMigrationRunRow;
    mode: "plain" | "e2ee";
    content: AutomationAccountEncryptionMigrationRunStoredContent;
    /** Persisted source validation only; new transition targets retain canonical admission. */
    allowLegacyResultSource?: boolean;
}>): void {
    const isWorkflowRun = params.row.workflowCustodyState !== null;
    if (
        !isWorkflowRun
        && params.allowLegacyResultSource === true
        && params.row.errorMessage !== null
        && currentAutomationRunFailureDetailEnvelope(params.row) === null
        && parseAutomationRunExecutionRecipeV1(
            params.row.executionInputEnvelope,
        ).kind === "available"
    ) {
        throw new AutomationValidationError(
            "Current Run failure detail is not a valid private-content envelope",
        );
    }
    const cause = decodeAutomationRunCause(params.row);
    if (cause === null) {
        if (
            !isWorkflowRun
            || params.row.originKind !== "direct"
            || params.content.executionInputEnvelope === null
            || params.content.workflowAcceptedSnapshotEnvelope === null
        ) {
            throw new AutomationValidationError("Workflow Run has invalid origin correspondence");
        }
        const baseBinding = { v: 1 as const, accountId: params.row.accountId, runId: params.row.id };
        assertWorkflowStoredEnvelopeOuterForMode({
            raw: params.content.executionInputEnvelope,
            mode: params.mode,
            binding: { ...baseBinding, purpose: "accepted_snapshot" },
        });
        assertWorkflowStoredEnvelopeOuterForMode({
            raw: params.content.workflowAcceptedSnapshotEnvelope,
            mode: params.mode,
            binding: { ...baseBinding, purpose: "accepted_snapshot" },
        });
        if (
            params.content.executionInputEnvelope
            !== params.content.workflowAcceptedSnapshotEnvelope
        ) {
            throw new AutomationValidationError(
                "Direct Workflow Run must retain one accepted-snapshot envelope",
            );
        }
        if (params.content.workflowCheckpointEnvelope !== null) {
            assertWorkflowStoredEnvelopeOuterForMode({
                raw: params.content.workflowCheckpointEnvelope,
                mode: params.mode,
                binding: { ...baseBinding, purpose: "checkpoint" },
            });
        }
        if (params.content.resultEnvelope !== null) {
            assertWorkflowStoredEnvelopeOuterForMode({
                raw: params.content.resultEnvelope,
                mode: params.mode,
                binding: { ...baseBinding, purpose: "final_result" },
            });
        }
        if (
            params.content.triggerEvidenceEnvelope !== null
            || params.content.occurrenceEvidenceEqualityTag !== null
            || params.content.replyContextEnvelope !== null
            || params.content.failureDetailEnvelope !== null
            || params.row.summaryCiphertext !== null
        ) {
            throw new AutomationValidationError(
                "Direct Workflow Run must not retain Automation-only private content",
            );
        }
        return;
    }
    const retainsPrivateOccurrenceEvidence = cause.kind === "conversation"
        || (cause.kind === "trigger" && cause.triggerKind === "pluginEvent");
    if (retainsPrivateOccurrenceEvidence) {
        if (
            params.row.occurrenceKey === null
            || params.content.triggerEvidenceEnvelope === null
        ) {
            throw new AutomationValidationError(
                "Event and Conversation Run evidence must be retained during Account migration",
            );
        }
        const outer = validateAutomationStoredContentEnvelopeOuterForMode({
            raw: params.content.triggerEvidenceEnvelope,
            mode: params.mode,
        });
        if (outer.kind !== "available") {
            throw new AutomationValidationError(
                "Run evidence envelope does not match the Account mode",
            );
        }
        if (params.mode === "e2ee") {
            if (
                params.content.occurrenceEvidenceEqualityTag === null
                || !AutomationOccurrenceEvidenceEqualityTagV1Schema.safeParse(
                    params.content.occurrenceEvidenceEqualityTag,
                ).success
            ) {
                throw new AutomationValidationError(
                    "Encrypted Run evidence requires one valid equality tag",
                );
            }
        } else if (params.content.occurrenceEvidenceEqualityTag !== null) {
            throw new AutomationValidationError(
                "Plain Run evidence must not retain an equality tag",
            );
        } else if (outer.envelope.t !== "plain") {
            throw new AutomationValidationError(
                "Plain Run evidence must use a plaintext envelope",
            );
        } else {
            const evidence = (params.allowLegacyResultSource === true
                ? AutomationOccurrenceEvidenceV1ReadSchema
                : AutomationOccurrenceEvidenceV1Schema).safeParse(
                outer.envelope.v,
            );
            if (!evidence.success) {
                throw new AutomationValidationError(
                    "Plain Run evidence does not match its immutable occurrence",
                );
            }
            const derivedOccurrenceKey = cause.kind === "conversation"
                ? evidence.data.kind === "conversation"
                    ? deriveAutomationOccurrenceKeyV1(evidence.data)
                    : null
                : evidence.data.kind === "pluginEvent"
                    ? deriveAutomationOccurrenceKeyV1({
                        triggerId: cause.triggerId,
                        evidence: evidence.data,
                    })
                    : null;
            if (derivedOccurrenceKey !== params.row.occurrenceKey) {
                throw new AutomationValidationError(
                    "Plain Run evidence does not match its immutable occurrence",
                );
            }
        }
    } else if (
        params.content.triggerEvidenceEnvelope !== null
        || params.content.occurrenceEvidenceEqualityTag !== null
    ) {
        throw new AutomationValidationError(
            "Scheduled and manual Runs must not retain trigger evidence or an equality tag",
        );
    }

    if (isWorkflowRun) {
        if (
            params.row.originKind !== "automation"
            || params.content.executionInputEnvelope === null
            || params.row.summaryCiphertext !== null
        ) {
            throw new AutomationValidationError(
                "Automation Workflow Run has invalid retained private content",
            );
        }
        const executionInput = validateAutomationStoredContentEnvelopeOuterForMode({
            raw: params.content.executionInputEnvelope,
            mode: params.mode,
        });
        if (executionInput.kind !== "available") {
            throw new AutomationValidationError(
                "Workflow definition envelope does not match the Account mode",
            );
        }
        const baseBinding = {
            v: 1 as const,
            accountId: params.row.accountId,
            runId: params.row.id,
        };
        if (params.content.workflowAcceptedSnapshotEnvelope !== null) {
            assertWorkflowStoredEnvelopeOuterForMode({
                raw: params.content.workflowAcceptedSnapshotEnvelope,
                mode: params.mode,
                binding: { ...baseBinding, purpose: "accepted_snapshot" },
            });
        }
        if (params.content.workflowCheckpointEnvelope !== null) {
            assertWorkflowStoredEnvelopeOuterForMode({
                raw: params.content.workflowCheckpointEnvelope,
                mode: params.mode,
                binding: { ...baseBinding, purpose: "checkpoint" },
            });
        }
        if (params.content.resultEnvelope !== null) {
            assertWorkflowStoredEnvelopeOuterForMode({
                raw: params.content.resultEnvelope,
                mode: params.mode,
                binding: { ...baseBinding, purpose: "final_result" },
            });
        }
        assertAutomationReplyHandoffStoredEnvelopeForAccountMode({
            content: "replyContext",
            raw: params.content.replyContextEnvelope,
            mode: params.mode,
        });
        const failureDetail = params.content.failureDetailEnvelope === null
            ? null
            : validateAutomationRunFailureDetailEnvelopeOuterForMode({
                raw: params.content.failureDetailEnvelope,
                mode: params.mode,
            });
        if (failureDetail !== null && failureDetail.kind !== "available") {
            throw new AutomationValidationError(
                "Run failure detail does not match the Account mode",
            );
        }
        return;
    }

    if (params.allowLegacyResultSource === true) {
        assertAutomationRunLegacySummarySource(params.row);
    }

    try {
        assertAutomationExecutionInputEnvelopeOuterForMode({
            raw: params.content.executionInputEnvelope,
            mode: params.mode,
            retainedV2OriginKind: cause.kind === "manual"
                ? "manual"
                : cause.kind === "trigger" && cause.triggerKind === "schedule"
                    ? "scheduled"
                    : undefined,
        });
    } catch (error) {
        if (error instanceof AutomationStoredContentReadError) {
            throw new AutomationValidationError(
                "Run execution input does not match the Account mode",
            );
        }
        throw error;
    }
    assertAutomationReplyHandoffStoredEnvelopeForAccountMode({
        content: "result",
        raw: params.content.resultEnvelope,
        mode: params.mode,
        allowLegacyResultSource: params.allowLegacyResultSource,
    });
    assertAutomationReplyHandoffStoredEnvelopeForAccountMode({
        content: "replyContext",
        raw: params.content.replyContextEnvelope,
        mode: params.mode,
    });
    if (params.content.failureDetailEnvelope !== null) {
        const failureDetail = validateAutomationRunFailureDetailEnvelopeOuterForMode({
            raw: params.content.failureDetailEnvelope,
            mode: params.mode,
        });
        if (failureDetail.kind !== "available") {
            throw new AutomationValidationError(
                "Run failure detail does not match the Account mode",
            );
        }
    }
}

async function readAutomationMigrationSourceModeInTx(
    tx: Tx,
    accountId: string,
): Promise<"plain" | "e2ee"> {
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    if (!account) {
        throw new AutomationValidationError("Account not found");
    }
    const currentness = deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status !== "ready") {
        throw new AutomationValidationError(
            "Account encryption state is inconsistent",
        );
    }
    return currentness.currentness.encryptionMode;
}

function readRetainedMigrationTemplateAdmission(params: Readonly<{
    row: AutomationAccountEncryptionMigrationRow;
    templateCiphertext: string;
}>): AutomationLegacyTemplateEnvelopeAdmission | undefined {
    if (params.templateCiphertext !== params.row.templateCiphertext) {
        return undefined;
    }
    if (!isAutomationLegacyTargetType(params.row.targetType)) {
        return undefined;
    }
    return readLegacyExistingSessionTemplateAdmission(
        params.templateCiphertext,
        params.row.targetType,
    );
}

type AutomationMigrationTemplateClassification =
    | Readonly<{
        kind: "strict";
        recipe: AutomationStoredDefinitionExecutionRecipeV1;
        strictExistingSessionId?: string;
    }>
    | Readonly<{
        kind: "workflow";
        recipe: AutomationStoredWorkflowDefinitionRecipeV2;
    }>
    | Readonly<{
        kind: "legacy";
        legacyTemplateEnvelopeAdmission?: AutomationLegacyTemplateEnvelopeAdmission;
    }>;

/** Definitions have no occurrence evidence; that immutable fact belongs only to Runs. */
function assertStrictAutomationDefinitionMigrationRecipe(
    recipe: AutomationStoredDefinitionExecutionRecipeV1,
): void {
    if (recipe.triggerEvidence !== null) {
        throw new AutomationValidationError(
            "Strict Automation Definition migration recipes must not carry trigger evidence",
        );
    }
}

function assertStrictAutomationMigrationRecipeMode(params: Readonly<{
    recipe: AutomationStoredDefinitionExecutionRecipeV1;
    mode: "plain" | "e2ee";
}>): void {
    const expectedEnvelopeType = params.mode === "plain" ? "plain" : "encrypted";
    if (
        params.recipe.template.t !== expectedEnvelopeType
        || (
            params.recipe.triggerEvidence !== null
            && params.recipe.triggerEvidence.t !== expectedEnvelopeType
        )
    ) {
        throw new AutomationValidationError(
            "Strict Automation migration recipe envelopes do not match the target Account mode",
        );
    }
}

/**
 * Classifies one migration target at the sole Automation owner. Strict
 * current recipes are parsed before the released legacy envelope path, so a
 * current Definition never falls through to a second template reader.
 */
function classifyAutomationMigrationTemplate(params: Readonly<{
    row: AutomationAccountEncryptionMigrationRow;
    templateCiphertext: string;
    expectedTemplateVersion: number;
    toMode: "plain" | "e2ee";
}>): AutomationMigrationTemplateClassification {
    const workflow = parseAutomationStoredWorkflowDefinitionRecipeV2(params.templateCiphertext);
    if (workflow.kind === "available") {
        const nextTemplateVersion = params.expectedTemplateVersion + 1;
        if (params.row.targetType !== null || !Number.isSafeInteger(nextTemplateVersion)
            || workflow.recipe.templateVersion !== nextTemplateVersion) {
            throw new AutomationValidationError("Workflow migration recipe must preserve its target and next template version");
        }
        const outer = validateAutomationStoredContentEnvelopeOuterForMode({
            raw: createCanonicalJsonSigningInput(workflow.recipe.workflow), mode: params.toMode,
        });
        if (outer.kind !== "available") {
            throw new AutomationValidationError("Workflow migration recipe does not match the Account mode");
        }
        return { kind: "workflow", recipe: workflow.recipe };
    }
    const strict = parseAutomationStoredDefinitionExecutionRecipeV1(params.templateCiphertext);
    if (strict.kind === "available") {
        assertStrictAutomationDefinitionMigrationRecipe(strict.recipe);
        const nextTemplateVersion = params.expectedTemplateVersion + 1;
        if (
            !Number.isSafeInteger(nextTemplateVersion)
            || strict.recipe.templateVersion !== nextTemplateVersion
        ) {
            throw new AutomationValidationError(
                "Strict Automation migration recipe version must match the next template version",
            );
        }
        if (
            toCurrentAutomationDefinitionTargetType(strict.recipe)
            !== params.row.targetType
        ) {
            throw new AutomationValidationError(
                "Strict Automation migration recipe target does not match the Definition target",
            );
        }
        assertStrictAutomationMigrationRecipeMode({
            recipe: strict.recipe,
            mode: params.toMode,
        });
        return {
            kind: "strict",
            recipe: strict.recipe,
            ...(strict.recipe.target.kind === "existingSession"
                ? { strictExistingSessionId: strict.recipe.target.sessionId }
                : {}),
        };
    }

    if (!isAutomationLegacyTargetType(params.row.targetType)) {
        throw new AutomationValidationError(
            "Legacy Automation migration templates cannot target execution_run",
        );
    }
    const legacyTemplateEnvelopeAdmission = readRetainedMigrationTemplateAdmission({
        row: params.row,
        templateCiphertext: params.templateCiphertext,
    });
    assertAutomationTemplateEnvelopeForAccountMode(
        params.templateCiphertext,
        params.toMode,
        params.row.targetType,
        legacyTemplateEnvelopeAdmission,
    );
    return { kind: "legacy", legacyTemplateEnvelopeAdmission };
}

function assertAutomationMigrationSourcePreserved(params: Readonly<{
    row: AutomationAccountEncryptionMigrationRow;
    expectedTemplateVersion: number;
    sourceMode: "plain" | "e2ee";
    target: AutomationMigrationTemplateClassification;
}>): void {
    if (params.target.kind === "workflow") {
        assertAutomationDefinitionStoredContentForAccountMode({ row: params.row, mode: params.sourceMode });
        const source = parseAutomationStoredWorkflowDefinitionRecipeV2(params.row.templateCiphertext);
        if (source.kind !== "available" || params.row.targetType !== null
            || source.recipe.templateVersion !== params.expectedTemplateVersion) {
            throw new AutomationValidationError("Workflow migration cannot replace a different Definition format or version");
        }
        const expectedTarget = serializeAutomationStoredWorkflowDefinitionRecipeV2({
            ...source.recipe, templateVersion: params.target.recipe.templateVersion,
            workflow: params.target.recipe.workflow,
        });
        const actualTarget = serializeAutomationStoredWorkflowDefinitionRecipeV2(params.target.recipe);
        if (expectedTarget.kind !== "available" || actualTarget.kind !== "available"
            || expectedTarget.serialized !== actualTarget.serialized) {
            throw new AutomationValidationError("Workflow migration must preserve its recipe identity");
        }
        return;
    }
    const source = parseAutomationStoredDefinitionExecutionRecipeV1(
        params.row.templateCiphertext,
    );
    if (params.target.kind === "legacy") {
        if (source.kind === "available"
            || parseAutomationStoredWorkflowDefinitionRecipeV2(params.row.templateCiphertext).kind === "available") {
            throw new AutomationValidationError(
                "Strict Automation migration cannot be replaced with a legacy Definition",
            );
        }
        return;
    }
    if (source.kind !== "available") {
        throw new AutomationValidationError(
            "Strict Automation migration cannot replace a legacy Definition",
        );
    }
    assertStrictAutomationDefinitionMigrationRecipe(source.recipe);
    if (
        source.recipe.templateVersion !== params.expectedTemplateVersion
        || toCurrentAutomationDefinitionTargetType(source.recipe)
            !== params.row.targetType
    ) {
        throw new AutomationValidationError(
            "Stored strict Automation definition does not match its template version or target",
        );
    }

    const expectedTarget = serializeAutomationStoredDefinitionExecutionRecipeV1({
        ...source.recipe,
        templateVersion: params.target.recipe.templateVersion,
        template: params.target.recipe.template,
        triggerEvidence: params.target.recipe.triggerEvidence,
    });
    const actualTarget = serializeAutomationStoredDefinitionExecutionRecipeV1(
        params.target.recipe,
    );
    if (
        expectedTarget.kind !== "available"
        || actualTarget.kind !== "available"
        || expectedTarget.serialized !== actualTarget.serialized
    ) {
        throw new AutomationValidationError(
            "Strict Automation migration must preserve the recipe version and target",
        );
    }
}

async function clearLoadedAutomationsForAccountInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    rows: ReadonlyArray<AutomationAccountEncryptionMigrationRow>;
}>): Promise<"cleared" | "retained_runs"> {
    if (params.rows.length === 0) {
        return "cleared";
    }

    // Retained Runs deliberately restrict the Automation relation. Clearing a
    // migration directive must fail closed before a physical delete could
    // erase (or fail after touching) durable history.
    const retainedRunCount = await params.tx.automationRun.count({
        where: {
            accountId: params.accountId,
            automationId: { in: params.rows.map((automation) => automation.id) },
        },
    });
    if (retainedRunCount !== 0) {
        return "retained_runs";
    }

    const deleted = await params.tx.automation.deleteMany({
        where: {
            accountId: params.accountId,
            id: { in: params.rows.map((automation) => automation.id) },
        },
    });
    if (
        deleted.count !== params.rows.length
        || await params.tx.automation.count({
            where: { accountId: params.accountId },
            take: 1,
        }) !== 0
    ) {
        throw new AutomationAccountEncryptionMigrationConflictError();
    }

    if (params.rows.some((automation) =>
        automation.deletedAt === null
        && automation.triggers.some((trigger) => (
            trigger.kind === "pluginEvent"
            && trigger.deletedAt === null
        ))
    )) {
        await ensureAutomationEventCatalogStateTx({
            tx: params.tx,
            accountId: params.accountId,
            projectionChanged: true,
        });
    }

    const deletedAt = new Date();
    for (const automation of params.rows) {
        const cursor = await markAutomationChangedTx(params.tx, {
            accountId: params.accountId,
            automationId: automation.id,
        });
        afterTx(params.tx, () => {
            emitAutomationDelete({
                accountId: params.accountId,
                automationId: automation.id,
                cursor,
                deletedAt,
            });
            emitAssignmentUpdates({
                accountId: params.accountId,
                automationId: automation.id,
                cursor,
                assignments: buildAssignmentUpdateRows({
                    previousAssignments: automation.assignments,
                    nextAssignments: [],
                }),
            });
        });
    }
    return "cleared";
}

/**
 * Applies one complete Account-encryption Automation directive.
 *
 * The Automation domain owns exact inventory/version comparison, effective-template
 * validation, template CAS/version advance, and the canonical change/event path.
 */
export async function migrateAutomationAccountEncryptionInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    toMode: "plain" | "e2ee";
    directive: AccountEncryptionMigrateAutomationsDirectiveInput;
    ownerContentPublicKeyFingerprint?: string;
}>): Promise<AutomationAccountEncryptionMigrationResult> {
    const accountFence = await acquireAccountEncryptionTransitionFenceInTx(params.tx, params.accountId);
    if (accountFence.status !== "ready") return { status: "invalid_content" };
    const directive = AccountEncryptionMigrateAutomationsDirectiveSchema.parse(
        params.directive,
    );
    const rows =
        await loadAutomationAccountEncryptionMigrationRowsInTx(
            params.tx,
            params.accountId,
        );
    const runRows =
        (await loadAutomationAccountEncryptionMigrationRunsInTx(
            params.tx,
            params.accountId,
        )).filter((row) => !isPreCutWorkflowMigrationRun(row));

    if (directive.action === "assert_empty") {
        return rows.length === 0 && runRows.length === 0
            ? { status: "applied" }
            : { status: "not_empty" };
    }
    if (directive.action === "clear") {
        if (runRows.length > 0) return { status: "not_empty" };
        const clearResult = await clearLoadedAutomationsForAccountInTx({
            tx: params.tx,
            accountId: params.accountId,
            rows,
        });
        return clearResult === "cleared"
            ? { status: "applied" }
            : { status: "not_empty" };
    }
    if (
        rows.length > ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS
        || runRows.length > ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS
    ) {
        return { status: "migration_too_large" };
    }
    const directiveRuns = directive.runs;
    const inventoryMatch = automationMigrationItemsMatchInventory(
        rows,
        directive.templates,
        {
            versionOffset: 0,
            compareTargetContent: false,
        },
    );
    if (inventoryMatch === "incomplete") {
        return { status: "migration_incomplete" };
    }
    if (inventoryMatch === "stale") {
        throw new AutomationAccountEncryptionMigrationConflictError();
    }
    const runInventoryMatch = automationMigrationRunItemsMatchInventory(
        runRows,
        directiveRuns,
        {
            revisionOffset: 0,
            compareTargetContent: false,
        },
    );
    if (runInventoryMatch === "incomplete") {
        return { status: "migration_incomplete" };
    }
    if (runInventoryMatch === "stale") {
        throw new AutomationAccountEncryptionMigrationConflictError();
    }

    const templatesById = new Map(
        directive.templates.map((item) => [
            item.automationId,
            item,
        ] as const),
    );
    const runsById = new Map(
        directiveRuns.map((item) => [item.runId, item] as const),
    );
    if (rows.some((row) => {
        const item = templatesById.get(row.id)!;
        return !hasCompleteTriggerDefinitionMigrationTarget(row, item);
    })) {
        // The additive directive member can remain absent only for the exact
        // Schedule-or-Manual/null shape. A signed predecessor Event/Conversation
        // request must not flip Account mode around unpaired private bytes.
        return { status: "migration_incomplete" };
    }
    const requiresSourceMode = rows.some((row) =>
        row.triggers.some((trigger) => trigger.kind === "pluginEvent" || trigger.kind === "prComment" || trigger.kind === "ciFailed"))
        || runRows.length > 0;
    const targetTriggerDefinitionsById = new Map<string, ReturnType<
        typeof validateAutomationTriggerDefinitionMigrationCandidate
    >>();
    const workflowInvocationsByRunId = new Map<string, InvocationRow[]>();
    for (const row of runRows) {
        const workflow = runsById.get(row.id)!.workflow;
        const hasCurrentWorkflow = row.workflowCustodyState !== null
            && row.workflowAcceptedSnapshotEnvelope !== null;
        if (hasCurrentWorkflow && !workflow) return { status: "migration_incomplete" };
        if (!workflow) continue;
        if (!hasCurrentWorkflow) return { status: "invalid_content" };
        if (workflow.sourceAcceptedSnapshotEnvelope !== row.workflowAcceptedSnapshotEnvelope
            || workflow.sourceCheckpointEnvelope !== row.workflowCheckpointEnvelope) {
            throw new AutomationAccountEncryptionMigrationConflictError();
        }
        const invocations = await params.tx.workflowRunInvocation.findMany({
            where: { runId: row.id }, select: invocationSelect,
        });
        const byId = new Map(workflow.invocations.map((invocation) => [invocation.id, invocation]));
        if (byId.size !== workflow.invocations.length || byId.size !== invocations.length
            || invocations.some((invocation) => !byId.has(invocation.id))) {
            return { status: "migration_incomplete" };
        }
        for (const invocation of invocations) {
            const target = byId.get(invocation.id)!;
            if (invocation.contentEnvelope !== target.sourceContentEnvelope
                || invocation.contentRevision.toString() !== target.expectedContentRevision) {
                throw new AutomationAccountEncryptionMigrationConflictError();
            }
        }
        const census = await readWorkflowRunKeyProjectionInTx(params.tx, {
            actorAccountId: params.accountId, runId: row.id,
        });
        if (census.encryptionMode === "e2ee" && census.dataEncryptionKey === null) {
            return { status: "invalid_content" };
        }
        if (census.dataEncryptionKey !== workflow.expectedDataEncryptionKey) {
            throw new AutomationAccountEncryptionMigrationConflictError();
        }
        workflowInvocationsByRunId.set(row.id, invocations);
    }
    try {
        const sourceMode = requiresSourceMode
            ? await readAutomationMigrationSourceModeInTx(params.tx, params.accountId)
            : null;
        for (const row of rows) {
            const item = templatesById.get(row.id)!;
            const template = classifyAutomationMigrationTemplate({
                row,
                templateCiphertext: item.templateCiphertext,
                expectedTemplateVersion: item.expectedTemplateVersion,
                toMode: params.toMode,
            });
            assertAutomationMigrationSourcePreserved({
                row,
                expectedTemplateVersion: item.expectedTemplateVersion,
                sourceMode: accountFence.account.currentness.encryptionMode,
                target: template,
            });
            await validateExistingSessionAutomationTargetTx({
                tx: params.tx,
                accountId: params.accountId,
                targetType: row.targetType,
                accountMode: params.toMode,
                ...(template.kind === "strict"
                    ? {
                        strictExistingSessionId:
                            template.strictExistingSessionId,
                    }
                    : template.kind === "legacy" ? {
                        templateCiphertext: item.templateCiphertext,
                        legacyExistingSessionId:
                            template.legacyTemplateEnvelopeAdmission?.existingSessionId,
                    } : {}),
            });
            targetTriggerDefinitionsById.set(
                row.id,
                validateAutomationTriggerDefinitionMigrationCandidate({
                    row,
                    item,
                    sourceMode: sourceMode!,
                    toMode: params.toMode,
                }),
            );
        }
        if (runRows.length > 0) {
            for (const row of runRows) {
                const item = runsById.get(row.id)!;
                const targetContent = automationRunMigrationDirectiveTargetContent(
                    row,
                    item,
                );
                assertAutomationRunStoredContentForAccountMode({
                    row,
                    mode: sourceMode!,
                    content: automationRunMigrationStoredContent(row),
                    allowLegacyResultSource: true,
                });
                assertAutomationRunOptionalContentNullnessPreserved({
                    source: automationRunMigrationStoredContent(row),
                    target: targetContent,
                });
                assertAutomationRunStoredContentForAccountMode({
                    row,
                    mode: params.toMode,
                    content: targetContent,
                });
                const workflow = item.workflow;
                if (workflow) {
                    const byId = new Map(workflow.invocations.map((invocation) => [invocation.id, invocation]));
                    for (const invocation of workflowInvocationsByRunId.get(row.id)!) {
                        const binding = workflowInvocationStoredBinding(params.accountId, invocation);
                        assertWorkflowStoredEnvelopeOuterForMode({ raw: invocation.contentEnvelope, mode: sourceMode!, binding });
                        assertWorkflowStoredEnvelopeOuterForMode({ raw: byId.get(invocation.id)!.contentEnvelope, mode: params.toMode, binding });
                    }
                }
            }
        }
    } catch (error) {
        if (isAutomationTransitionInvalidContentError(error)) {
            return { status: "invalid_content" };
        }
        throw error;
    }

    for (const row of rows) {
        const item = templatesById.get(row.id)!;
        const updated = await params.tx.automation.updateMany({
            where: {
                id: row.id,
                accountId: params.accountId,
                templateVersion: item.expectedTemplateVersion,
            },
            data: {
                templateCiphertext: item.templateCiphertext,
                templateVersion: { increment: 1 },
                // Same scheduling semantics as the staged transition path: the
                // re-seal changes bytes, never the next-run projection.
                updatedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new AutomationAccountEncryptionMigrationConflictError();
        }
        const triggerDefinitionTargets = targetTriggerDefinitionsById.get(row.id) ?? [];
        for (const triggerDefinitionTarget of triggerDefinitionTargets) {
            const triggerUpdated = await params.tx.automationTrigger.updateMany({
                where: {
                    id: triggerDefinitionTarget.triggerId,
                    automationId: row.id,
                    kind: triggerDefinitionTarget.triggerKind,
                    revision: triggerDefinitionTarget.triggerRevision,
                    definitionEnvelope: triggerDefinitionTarget.sourceEnvelope,
                },
                data: {
                    definitionEnvelope: triggerDefinitionTarget.targetEnvelope,
                    updatedAt: new Date(),
                },
            });
            if (triggerUpdated.count !== 1) {
                throw new AutomationAccountEncryptionMigrationConflictError();
            }
        }

        const automation = await loadAutomationTx(params.tx, {
            accountId: params.accountId,
            automationId: row.id,
            includeDeleted: true,
        });
        if (!automation) {
            throw new AutomationAccountEncryptionMigrationConflictError();
        }
        const cursor = await markAutomationChangedTx(params.tx, {
            accountId: params.accountId,
            automationId: row.id,
        });
        afterTx(params.tx, () => {
            emitAutomationUpsert({
                accountId: params.accountId,
                automation,
                cursor,
            });
        });
    }

    for (const row of runRows) {
        const item = runsById.get(row.id)!;
        const cause = decodeAutomationRunCause(row);
        const updated = await params.tx.automationRun.updateMany({
            where: {
                id: row.id,
                accountId: params.accountId,
                revision: item.expectedRunRevision,
                ...(item.workflow ? {
                    workflowAcceptedSnapshotEnvelope: item.workflow.sourceAcceptedSnapshotEnvelope,
                    workflowCheckpointEnvelope: item.workflow.sourceCheckpointEnvelope,
                } : {}),
                ...(cause === null
                    ? { originKind: "direct", automationId: null, causeKind: null }
                    : encodeAutomationRunCause(cause)),
            },
            data: {
                triggerEvidenceEnvelope: item.triggerEvidenceEnvelope,
                occurrenceEvidenceEqualityTag:
                    item.occurrenceEvidenceEqualityTag,
                executionInputEnvelope: item.executionInputEnvelope,
                ...(item.workflow ? {
                    workflowAcceptedSnapshotEnvelope: item.workflow.acceptedSnapshotEnvelope,
                    workflowCheckpointEnvelope: item.workflow.checkpointEnvelope,
                } : {}),
                resultEnvelope: item.resultEnvelope,
                replyContextEnvelope: item.replyContextEnvelope,
                errorMessage: item.failureDetailEnvelope
                    ?? (currentAutomationRunFailureDetailEnvelope(row) === null
                        ? row.errorMessage
                        : null),
                summaryCiphertext: null,
                revision: { increment: 1 },
                updatedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new AutomationAccountEncryptionMigrationConflictError();
        }

        if (item.workflow) {
            for (const invocation of item.workflow.invocations) {
                const result = await params.tx.workflowRunInvocation.updateMany({
                    where: { id: invocation.id, runId: row.id,
                        contentRevision: BigInt(invocation.expectedContentRevision),
                        contentEnvelope: invocation.sourceContentEnvelope },
                    data: { contentEnvelope: invocation.contentEnvelope,
                        contentRevision: { increment: 1 }, updatedAt: new Date() },
                });
                if (result.count !== 1) throw new AutomationAccountEncryptionMigrationConflictError();
            }
            try {
                await replaceWorkflowRunKeyEnvelopesInTx(params.tx, {
                    actorAccountId: params.accountId, runId: row.id, encryptionMode: params.toMode,
                    expectedDataEncryptionKey: item.workflow.expectedDataEncryptionKey,
                    recipientKeyEnvelopes: item.workflow.recipientKeyEnvelopes,
                    ownerContentPublicKeyFingerprint: params.ownerContentPublicKeyFingerprint,
                });
            } catch (error) {
                if (error instanceof WorkflowRunAccessError && error.code === "currentness_conflict") {
                    throw new AutomationAccountEncryptionMigrationConflictError();
                }
                // Throw after mutations so the enclosing Account transaction rolls back.
                throw error;
            }
        }

        const run = await params.tx.automationRun.findFirst({
            where: {
                id: row.id,
                accountId: params.accountId,
            },
            select: automationRunItemSelect,
        });
        if (!run) {
            throw new AutomationAccountEncryptionMigrationConflictError();
        }
        if (row.automationId !== null) {
            const automationRun = projectAutomationOriginRun(run);
            if (!automationRun) throw new AutomationAccountEncryptionMigrationConflictError();
            const cursor = await markAutomationChangedTx(params.tx, {
                accountId: params.accountId,
                automationId: row.automationId,
            });
            afterTx(params.tx, () => {
                emitAutomationRunUpdated({
                    accountId: params.accountId,
                    run: automationRun,
                    cursor,
                });
            });
        }
    }

    if (rows.some((automation) =>
        automation.enabled
        && automation.deletedAt === null
        && automation.triggers.some((trigger) => (
            trigger.kind === "pluginEvent"
            && trigger.enabled
            && trigger.deletedAt === null
        ))
    )) {
        await ensureAutomationEventCatalogStateTx({
            tx: params.tx,
            accountId: params.accountId,
            projectionChanged: true,
        });
    }

    return { status: "applied" };
}

/**
 * Read-only exact Automation post-state matcher for Account-transition replay.
 */
export async function matchAutomationAccountEncryptionMigrationPostStateInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        toMode: "plain" | "e2ee";
        directive: AccountEncryptionMigrateAutomationsDirectiveInput;
    }>,
): Promise<AutomationAccountEncryptionMigrationPostStateResult> {
    const directive = AccountEncryptionMigrateAutomationsDirectiveSchema.parse(
        params.directive,
    );
    const rows =
        await loadAutomationAccountEncryptionMigrationRowsInTx(
            params.tx,
            params.accountId,
        );
    const runRows =
        (await loadAutomationAccountEncryptionMigrationRunsInTx(
            params.tx,
            params.accountId,
        )).filter((row) => !isPreCutWorkflowMigrationRun(row));
    if (
        directive.action === "assert_empty"
        || directive.action === "clear"
    ) {
        return {
            status: rows.length === 0 && runRows.length === 0
                ? "matched"
                : "mismatch",
        };
    }
    if (
        automationMigrationItemsMatchInventory(
            rows,
            directive.templates,
            {
                versionOffset: 1,
                compareTargetContent: true,
            },
        ) !== "match"
    ) {
        return { status: "mismatch" };
    }
    const directiveRuns = directive.runs;
    if (
        automationMigrationRunItemsMatchInventory(
            runRows,
            directiveRuns,
            {
                revisionOffset: 1,
                compareTargetContent: true,
            },
        ) !== "match"
    ) {
        return { status: "mismatch" };
    }
    try {
        const templatesById = new Map(
            directive.templates.map((item) => [item.automationId, item] as const),
        );
        for (const row of rows) {
            const item = templatesById.get(row.id)!;
            const template = classifyAutomationMigrationTemplate({
                row,
                templateCiphertext: row.templateCiphertext,
                expectedTemplateVersion: item.expectedTemplateVersion,
                toMode: params.toMode,
            });
            await validateExistingSessionAutomationTargetTx({
                tx: params.tx,
                accountId: params.accountId,
                targetType: row.targetType,
                accountMode: params.toMode,
                ...(template.kind === "strict"
                    ? {
                        strictExistingSessionId:
                            template.strictExistingSessionId,
                    }
                    : template.kind === "legacy" ? {
                        templateCiphertext: row.templateCiphertext,
                        legacyExistingSessionId:
                            template.legacyTemplateEnvelopeAdmission?.existingSessionId,
                    } : {}),
            });
            assertAutomationTriggerDefinitionMigrationPostState({
                row,
                item,
                toMode: params.toMode,
            });
        }
        const runsById = new Map(
            directiveRuns.map((item) => [item.runId, item] as const),
        );
        for (const row of runRows) {
            assertAutomationRunStoredContentForAccountMode({
                row,
                mode: params.toMode,
                content: automationRunMigrationStoredContent(row),
            });
            const item = runsById.get(row.id)!;
            if (item.workflow) {
                const workflow = item.workflow;
                if (row.workflowAcceptedSnapshotEnvelope !== workflow.acceptedSnapshotEnvelope
                    || row.workflowCheckpointEnvelope !== workflow.checkpointEnvelope) {
                    return { status: "mismatch" };
                }
                const invocations = await params.tx.workflowRunInvocation.findMany({
                    where: { runId: row.id }, select: invocationSelect,
                });
                const byId = new Map(workflow.invocations.map((invocation) => [invocation.id, invocation]));
                if (byId.size !== workflow.invocations.length || byId.size !== invocations.length) {
                    return { status: "mismatch" };
                }
                for (const invocation of invocations) {
                    const target = byId.get(invocation.id);
                    if (!target || invocation.contentRevision !== BigInt(target.expectedContentRevision) + 1n
                        || invocation.contentEnvelope !== target.contentEnvelope) return { status: "mismatch" };
                    assertWorkflowStoredEnvelopeOuterForMode({ raw: invocation.contentEnvelope,
                        mode: params.toMode, binding: workflowInvocationStoredBinding(params.accountId, invocation) });
                }
                const physicalKeyCount = await params.tx.workflowRunDataKeyEnvelope.count({ where: { runId: row.id } });
                if (params.toMode === "plain") {
                    if (physicalKeyCount !== 0) return { status: "mismatch" };
                } else {
                    const census = await readWorkflowRunKeyProjectionInTx(params.tx, {
                        actorAccountId: params.accountId, runId: row.id,
                    });
                    const preparedById = new Map(workflow.recipientKeyEnvelopes.map((envelope) => [envelope.recipientAccountId, envelope]));
                    const eligible = census.recipients.filter((recipient) => {
                        const prepared = preparedById.get(recipient.recipientAccountId);
                        return prepared && recipient.contentPublicKeyFingerprint === prepared.recipientContentPublicKeyFingerprint;
                    });
                    if (physicalKeyCount !== eligible.length || !eligible.some((recipient) => recipient.recipientAccountId === params.accountId)
                        || eligible.some((recipient) => {
                            const prepared = preparedById.get(recipient.recipientAccountId)!;
                            return recipient.encryptedDataKey !== prepared.encryptedDataKey
                                || recipient.recipientContentPublicKeyFingerprint !== prepared.recipientContentPublicKeyFingerprint;
                        })) return { status: "mismatch" };
                }
            } else if (row.workflowAcceptedSnapshotEnvelope !== null && row.workflowCustodyState !== null) {
                return { status: "mismatch" };
            }
            if (
                item.triggerEvidenceEnvelope !== row.triggerEvidenceEnvelope
                || item.occurrenceEvidenceEqualityTag
                    !== row.occurrenceEvidenceEqualityTag
                || item.executionInputEnvelope !== row.executionInputEnvelope
                || item.resultEnvelope !== row.resultEnvelope
                || item.replyContextEnvelope !== row.replyContextEnvelope
                || item.failureDetailEnvelope
                    !== currentAutomationRunFailureDetailEnvelope(row)
                || row.summaryCiphertext !== null
            ) {
                return { status: "mismatch" };
            }
        }
    } catch {
        return { status: "mismatch" };
    }
    return { status: "matched" };
}

export async function markAutomationChangedTx(tx: Tx, params: { accountId: string; automationId: string }): Promise<number> {
    await invalidateSessionReviewProjectionsForAutomationInTx(tx, params.automationId);
    return await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "automation",
        entityId: params.automationId,
    });
}

/**
 * A Run may leave retained history only after both its execution lifecycle and
 * any Conversation reply custody have reached terminal states. Retention and
 * the user-initiated clear operation share this exact predicate so neither
 * path can make a still-actionable Run disappear.
 */
export function automationRunCustodyTerminalWhere() {
    return {
        state: { in: [...AUTOMATION_RUN_TERMINAL_STATES] },
        replyHandoffState: { in: [...AUTOMATION_RUN_REPLY_HANDOFF_TERMINAL_STATES] },
        AND: [{ OR: [
            { workflowCustodyState: null },
            { workflowCustodyState: "settled" as const },
        ] }],
    };
}

/** Actual live Run/turn publishers keep their retained cause ancestors readable. */
export async function readAutomationLiveCauseRunIdsTx(tx: Tx, accountId: string): Promise<ReadonlySet<string>> {
    const liveRuns = await tx.automationRun.findMany({ where: {
        accountId, NOT: automationRunCustodyTerminalWhere(),
    }, select: { id: true } });
    const liveTurns = await tx.sessionTurn.findMany({ where: {
        status: "in_progress", initiator: "workflow", session: { accountId },
    }, select: { initiator: true, workDepth: true, workflowInvocationJson: true } });
    const roots = new Set(liveRuns.map(run => run.id));
    for (const turn of liveTurns) {
        const runId = parseStoredSessionTurnFacts(turn).workflowInvocation?.runId;
        if (runId !== undefined) roots.add(runId);
    }
    const retainedRunIds = new Set<string>();
    for (const root of roots) {
        for (const runId of (await readAutomationRunCauseChainTx(tx, root)).runIds) retainedRunIds.add(runId);
    }
    return retainedRunIds;
}

export type ClearAutomationRunHistoryResult =
    | Readonly<{ status: "not_found" }>
    | Readonly<{ status: "cleared"; clearedRuns: number }>;

/**
 * The one user-facing history clear owner. It intentionally never cancels or
 * terminalizes a Run: the lifecycle owner remains authoritative for any work
 * that has not reached the shared retained-history predicate above.
 */
export async function clearAutomationRunHistory(params: {
    accountId: string;
    automationId: string;
}): Promise<ClearAutomationRunHistoryResult> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
            tx,
            params.accountId,
        );
        if (accountFence.status !== "ready") {
            return { status: "not_found" };
        }
        const automation = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
        });
        if (!automation) {
            return { status: "not_found" };
        }
        // Live descendants and exact in-progress Workflow turns still publish
        // events. Their canonical cause chains must survive an ordinary clear.
        const retainedRunIds = await readAutomationLiveCauseRunIdsTx(tx, params.accountId);
        const candidates = await tx.automationRun.findMany({
            where: {
                accountId: params.accountId,
                automationId: automation.id,
                ...automationRunCustodyTerminalWhere(),
            },
            select: { id: true },
        });
        let clearedRuns = 0;
        for (const ids of automationPortableQueryChunks({
            values: candidates.filter(run => !retainedRunIds.has(run.id)).map(run => run.id),
            bindingsPerValue: 1,
            fixedBindings: 3 + AUTOMATION_RUN_TERMINAL_STATES.length + AUTOMATION_RUN_REPLY_HANDOFF_TERMINAL_STATES.length,
        })) {
            clearedRuns += (await tx.automationRun.deleteMany({ where: {
                id: { in: [...ids] }, accountId: params.accountId, automationId: automation.id,
                ...automationRunCustodyTerminalWhere(),
            } })).count;
        }
        if (clearedRuns > 0) {
            const cursor = await markAutomationChangedTx(tx, {
                accountId: params.accountId,
                automationId: automation.id,
            });
            afterTx(tx, () => emitAutomationUpsert({
                accountId: params.accountId,
                automation,
                cursor,
            }));
        }
        return { status: "cleared", clearedRuns };
    });
}

function emitAssignmentUpdates(params: {
    accountId: string;
    automationId: string;
    cursor: number;
    assignments: ReadonlyArray<{ machineId: string; enabled: boolean; updatedAt?: Date }>;
}): void {
    for (const assignment of params.assignments) {
        emitAutomationAssignmentUpdated({
            accountId: params.accountId,
            machineId: assignment.machineId,
            automationId: params.automationId,
            enabled: assignment.enabled,
            cursor: params.cursor,
            updatedAt: assignment.updatedAt ?? new Date(),
        });
    }
}

function buildAssignmentUpdateRows(params: {
    previousAssignments: ReadonlyArray<{ machineId: string; enabled: boolean; updatedAt?: Date }>;
    nextAssignments: ReadonlyArray<{ machineId: string; enabled: boolean; updatedAt?: Date }>;
}): Array<{ machineId: string; enabled: boolean; updatedAt?: Date }> {
    const nextByMachineId = new Map(
        params.nextAssignments.map((assignment) => [assignment.machineId, assignment] as const),
    );
    const rows: Array<{ machineId: string; enabled: boolean; updatedAt?: Date }> = [];
    const seenMachineIds = new Set<string>();

    for (const assignment of params.previousAssignments) {
        const nextAssignment = nextByMachineId.get(assignment.machineId);
        rows.push(nextAssignment ?? {
            machineId: assignment.machineId,
            enabled: false,
            updatedAt: assignment.updatedAt,
        });
        seenMachineIds.add(assignment.machineId);
    }

    for (const assignment of params.nextAssignments) {
        if (seenMachineIds.has(assignment.machineId)) {
            continue;
        }
        rows.push(assignment);
        seenMachineIds.add(assignment.machineId);
    }

    return rows;
}

type NormalizedAutomationTriggerWrite = Readonly<{
    data: Omit<Prisma.AutomationTriggerUncheckedCreateInput,
        "automationId" | "id" | "revision" | "createdAt" | "updatedAt">;
    isEvent: boolean;
}>;

const AUTOMATION_TRIGGER_PRIVATE_FIELDS_CLEARED = {
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
    sessionLifecycleEventsJson: null,
    sessionLifecyclePolicyKind: null,
    sessionLifecycleMatchCount: null,
    remainingOccurrences: null,
    sourceSessionId: null,
    sourceTurnId: null,
    sourceRunId: null,
    sourceRunMachineId: null,
    runLifecycleConfigurationJson: null,
} as const;

const AUTOMATION_TRIGGER_KIND_FIELDS_CLEARED = {
    ...AUTOMATION_TRIGGER_PRIVATE_FIELDS_CLEARED,
    eventPluginId: null,
    eventLocalId: null,
    sourceSelectorId: null,
    sourceContractVersion: null,
} as const;

function automationTriggerTombstoneUpdate(
    deletedAt: Date,
    kind: AutomationTriggerItem["kind"],
): Prisma.AutomationTriggerUncheckedUpdateInput {
    return {
        enabled: false,
        deletedAt,
        ...(kind === "pluginEvent"
            ? AUTOMATION_TRIGGER_PRIVATE_FIELDS_CLEARED
            : AUTOMATION_TRIGGER_KIND_FIELDS_CLEARED),
        revision: { increment: 1 },
        updatedAt: deletedAt,
    };
}

function readAutomationExistingSessionTargetId(
    automation: Pick<AutomationListItem, "targetType" | "templateCiphertext">,
): string | null {
    if (automation.targetType !== "existing_session") return null;
    const parsed = parseAutomationStoredDefinitionExecutionRecipeV1(
        automation.templateCiphertext,
    );
    return parsed.kind === "available"
        && parsed.recipe.target.kind === "existingSession"
        ? parsed.recipe.target.sessionId
        : null;
}

async function normalizeAutomationTriggerWriteTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    automation: Pick<AutomationListItem,
        "id" | "targetType" | "templateCiphertext" | "templateVersion" | "scopeSessionId">;
    triggerId: string;
    triggerRevision: number;
    input: AutomationTriggerDefinitionInput;
    serverIdentityId: string | null;
    now: Date;
    existing?: AutomationTriggerItem | null;
    newbornSession?: AutomationSessionBirthContext;
}>): Promise<NormalizedAutomationTriggerWrite> {
    const common = {
        enabled: params.input.enabled,
        deletedAt: null,
        ...AUTOMATION_TRIGGER_KIND_FIELDS_CLEARED,
    } as const;

    if (params.input.kind === "prComment" || params.input.kind === "ciFailed") {
        if (!params.automation.scopeSessionId) {
            throw new AutomationValidationError("Pull-request triggers require a scoped session");
        }
        const currentness = await fetchAutomationAccountCurrentnessWitnessTx(params.tx, params.accountId);
        if (!currentness) throw new AutomationStoredContentReadError("contentInvalid");
        const binding = {
            v: 1 as const, automationId: params.automation.id,
            triggerId: AutomationTriggerIdSchema.parse(params.triggerId),
            triggerRevision: params.triggerRevision, triggerKind: params.input.kind,
        };
        let envelope: string;
        if ("triggerDefinitionEnvelope" in params.input) {
            envelope = JSON.stringify(params.input.triggerDefinitionEnvelope);
            if (validateAutomationTriggerDefinitionEnvelopeOuterForMode({
                raw: envelope, mode: currentness.mode, binding,
            }).kind !== "available") throw new AutomationStoredContentReadError("modeMismatch");
        } else {
            if (currentness.mode !== "plain") throw new AutomationStoredContentReadError("modeMismatch");
            const definition = AutomationPullRequestTriggerSchema.parse({
                kind: params.input.kind, pullRequest: params.input.pullRequest,
            });
            envelope = JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: "plain", binding, definition }));
        }
        return { isEvent: false, data: { ...common, kind: params.input.kind,
            sourceSessionId: params.automation.scopeSessionId, definitionEnvelope: envelope } };
    }

    if (params.input.kind === "schedule") {
        const schedule = resolveScheduleDbFields(
            params.input.schedule.kind === "interval"
                ? {
                    kind: "interval",
                    everyMs: params.input.schedule.everyMs,
                    timezone: params.input.schedule.timezone,
                }
                : {
                    kind: "cron",
                    scheduleExpr: params.input.schedule.scheduleExpr,
                    timezone: params.input.schedule.timezone,
                },
        );
        const unchangedSchedule = params.existing?.kind === "schedule"
            && hasSameAutomationScheduleFields(params.existing, schedule);
        return {
            isEvent: false,
            data: {
                ...common,
                kind: "schedule",
                ...schedule,
                // Effective enablement owns the cursor, independent of the
                // request shape: a paused trigger has no next occurrence even
                // when the same definition is redundantly supplied, an
                // unchanged active cadence retains its cursor (a null cursor
                // is then initialized from the transaction clock by the
                // canonical schedule-cursor owner), and a changed cadence
                // resets it.
                nextRunAt: params.input.enabled && unchangedSchedule
                    ? params.existing?.nextRunAt ?? null
                    : null,
            },
        };
    }

    if (params.input.kind === "runLifecycle") {
        const definition = { kind: "runLifecycle" as const, source: params.input.source, condition: params.input.condition };
        await validateAutomationRunLifecycleSourceTx(params.tx, params.accountId, definition);
        const encoded = createCanonicalJsonSigningInput(definition);
        const retains = params.existing?.kind === "runLifecycle"
            && createCanonicalJsonSigningInput(decodeAutomationRunLifecycleConfiguration(params.existing)) === encoded;
        return { isEvent: false, data: { ...common, kind: "runLifecycle", sourceRunId: definition.source.runId,
            sourceRunMachineId: definition.source.kind === "execution_run" ? definition.source.machineId : null,
            runLifecycleConfigurationJson: encoded, remainingOccurrences: retains ? params.existing?.remainingOccurrences ?? 1 : 1 } };
    }

    if (params.input.kind === "sessionLifecycle") {
        const automationExistingSessionId =
            readAutomationExistingSessionTargetId(params.automation);
        // Enablement is not part of the registration, so the comparison and
        // the encoder both consume the definition alone.
        const submittedDefinition: AutomationSessionLifecycleTrigger = {
            kind: "sessionLifecycle",
            sourceSessionId: params.input.sourceSessionId,
            events: params.input.events,
            policy: params.input.policy,
        };
        const retainsRegistration = params.existing?.kind === "sessionLifecycle"
            && automationSessionLifecycleConfigurationsEqual(params.existing, submittedDefinition);
        // Source/target inequality is a property of the effective recipe, not
        // of registration freshness: every normalized lifecycle write re-proves
        // it (and target-ID presence) against the current execution target, so
        // a recipe retarget cannot slip past an unchanged exact-turn patch.
        // Only a new, changed, or re-enabled registration additionally re-runs
        // the current-turn eligibility proof, keeping terminal historical
        // triggers inert instead of blocking unrelated edits.
        validateSessionLifecycleExecutionTargetInequality({
            automationTargetType: params.automation.targetType,
            automationExistingSessionId,
            sourceSessionId: params.input.sourceSessionId,
        });
        const reArms = params.existing?.enabled === false && params.input.enabled;
        const mustRegister = !retainsRegistration || reArms;
        const lifecycle = mustRegister
            ? await validateSessionLifecycleTriggerRegistrationTx({
                tx: params.tx,
                accountId: params.accountId,
                automationTargetType: params.automation.targetType,
                automationExistingSessionId,
                input: params.input,
                newbornSession: params.newbornSession,
            })
            : submittedDefinition;
        const encoded = encodeAutomationSessionLifecycleConfiguration(lifecycle);
        return {
            isEvent: false,
            data: {
                ...common,
                kind: "sessionLifecycle",
                ...encoded,
                // Pause/resume and unrelated editor saves preserve runtime
                // consumption; semantic definition edits initialize a fresh
                // policy budget.
                remainingOccurrences: retainsRegistration
                    ? params.existing?.remainingOccurrences ?? encoded.remainingOccurrences
                    : encoded.remainingOccurrences,
            },
        };
    }

    if (params.input.kind !== "pluginEvent") {
        throw new AutomationValidationError("Unsupported Automation trigger kind");
    }
    if ("triggerDefinitionEnvelope" in params.input) {
        const event = await normalizeEncryptedAutomationPluginEventWriteTx({
            tx: params.tx,
            accountId: params.accountId,
            automationId: params.automation.id,
            triggerId: params.triggerId,
            triggerRevision: params.triggerRevision,
            serverIdentityId: params.serverIdentityId,
            input: params.input,
            now: params.now,
        });
        return {
            isEvent: true,
            data: {
                ...common,
                kind: "pluginEvent",
                eventPluginId: params.input.eventRef.pluginId,
                eventLocalId: params.input.eventRef.localId,
                ...event,
            },
        };
    }

    const event = await normalizeAutomationPluginEventWriteTx({
        tx: params.tx,
        accountId: params.accountId,
        serverIdentityId: params.serverIdentityId,
        input: params.input,
    });
    const previousDefinition = params.existing?.kind === "pluginEvent"
        ? readPlainAutomationPluginEventDefinition(params.automation, params.existing)
        : null;
    const sameSourceIdentity = params.existing?.kind === "pluginEvent"
        && params.existing.eventPluginId === event.eventRef.pluginId
        && params.existing.eventLocalId === event.eventRef.localId
        && previousDefinition?.sourceInstanceId === event.sourceInstanceId;
    const sourceSelectorId = sameSourceIdentity
        ? AutomationSourceSelectorIdV1Schema.parse(params.existing?.sourceSelectorId)
        : AutomationSourceSelectorIdV1Schema.parse(randomUUID());
    let retainedObservationStartsAt: Date | null = null;
    if (
        params.existing?.kind === "pluginEvent"
        && event.observationTransport === "durablePush"
        && params.existing.observationTransport === "durablePush"
        && params.existing.observationStartsAt !== null
        && params.existing.enabled
        && params.input.enabled
        && previousDefinition
        && durablePushObservationEligibilityFingerprint(event)
            === durablePushObservationEligibilityFingerprint({
                ...event,
                eventRef: {
                    pluginId: params.existing.eventPluginId ?? "",
                    localId: params.existing.eventLocalId ?? "",
                },
                sourceInstanceId: previousDefinition.sourceInstanceId,
                sourceContractVersion: params.existing.sourceContractVersion ?? 0,
                sourceConfig: previousDefinition.sourceConfig,
                filter: previousDefinition.filter,
                maximumObservationAgeMs:
                    previousDefinition.maximumObservationAgeMs,
                webhookEndpointId: params.existing.webhookEndpointId ?? "",
                webhookRoutingSourceInstanceId:
                    previousDefinition.webhookRoutingSourceInstanceId ?? "",
            })
    ) {
        retainedObservationStartsAt = params.existing.observationStartsAt;
    }
    return {
        isEvent: true,
        data: {
            ...common,
            kind: "pluginEvent",
            eventPluginId: event.eventRef.pluginId,
            eventLocalId: event.eventRef.localId,
            sourceSelectorId,
            sourceContractVersion: event.sourceContractVersion,
            ...automationPluginEventTransportColumns(
                event,
                params.now,
                retainedObservationStartsAt,
            ),
            definitionEnvelope: sealPlainAutomationPluginEventDefinition({
                automationId: params.automation.id,
                triggerId: params.triggerId,
                triggerRevision: params.triggerRevision,
                sourceSelectorId,
                event,
            }),
        },
    };
}

/** The one post-commit publication seam for a committed Automation mutation. */
export function emitAutomationMutationAfterTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    automation: AutomationListItem;
    cursor: number;
    previousAssignments?: AutomationListItem["assignments"];
}>): void {
    afterTx(params.tx, () => {
        emitAutomationUpsert({
            accountId: params.accountId,
            automation: params.automation,
            cursor: params.cursor,
        });
        if (params.previousAssignments) {
            emitAssignmentUpdates({
                accountId: params.accountId,
                automationId: params.automation.id,
                cursor: params.cursor,
                assignments: buildAssignmentUpdateRows({
                    previousAssignments: params.previousAssignments,
                    nextAssignments: params.automation.assignments,
                }),
            });
        }
    });
}

export async function listAutomations(params: {
    accountId: string;

}): Promise<AutomationListItem[]> {
    const rows = await db.automation.findMany({
        where: {
            accountId: params.accountId,
            deletedAt: null,
        },
        // The list read never loads private trigger definition envelopes; the
        // canonical full definition read remains the detail/mutation owner.
        select: automationDefinitionListItemSelect,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });

    const items = rows as AutomationListItem[];
    return items;
}

const AUTOMATION_DEFINITION_LIST_CURSOR_PREFIX = "automation-definition-v1";

function encodeAutomationDefinitionListCursor(
    row: Pick<AutomationListItem, "id" | "updatedAt">,
): string {
    return Buffer.from(JSON.stringify([
        AUTOMATION_DEFINITION_LIST_CURSOR_PREFIX,
        row.updatedAt.getTime(),
        row.id,
    ]), "utf8").toString("base64url");
}

function decodeAutomationDefinitionListCursor(
    cursor: string | null | undefined,
): Readonly<{ updatedAt: Date; id: string }> | null {
    if (!cursor) return null;
    try {
        const decoded: unknown = JSON.parse(
            Buffer.from(cursor, "base64url").toString("utf8"),
        );
        if (!Array.isArray(decoded) || decoded.length !== 3) {
            throw new Error("invalid shape");
        }
        const [prefix, updatedAtMs, id] = decoded;
        if (
            prefix !== AUTOMATION_DEFINITION_LIST_CURSOR_PREFIX
            || typeof updatedAtMs !== "number"
            || !Number.isSafeInteger(updatedAtMs)
            || updatedAtMs < 0
            || typeof id !== "string"
            || id.length === 0
        ) {
            throw new Error("invalid fields");
        }
        const updatedAt = new Date(updatedAtMs);
        if (Number.isNaN(updatedAt.getTime())) throw new Error("invalid timestamp");
        return { updatedAt, id };
    } catch {
        throw new AutomationValidationError("Invalid Automation definition list cursor");
    }
}

/**
 * Current V3 definition paging through the canonical list projection. The
 * cursor carries exactly the stable public ordering tuple; it is not a
 * snapshot, count ceiling, or second catalog revision.
 */
export async function listAutomationDefinitionsPage(params: Readonly<{
    accountId: string;
    limit?: number;
    cursor?: string | null;
    workflowDefinitionId?: string;
    scopeSessionId?: string;
    scope?: "account_inline";
}>): Promise<Readonly<{
    automations: AutomationListItem[];
    nextCursor: string | null;
}>> {
    const limit = Math.min(
        Math.max(Math.floor(params.limit ?? AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS), 1),
        AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS,
    );
    const cursor = decodeAutomationDefinitionListCursor(params.cursor);
    const rows = await db.automation.findMany({
        where: {
            accountId: params.accountId,
            deletedAt: null,
            ...(params.workflowDefinitionId !== undefined ? { workflowDefinitionId: params.workflowDefinitionId } : {}),
            ...(params.scopeSessionId !== undefined ? { scopeSessionId: params.scopeSessionId } : {}),
            ...(params.scope === "account_inline" ? { workflowDefinitionId: null, scopeSessionId: null } : {}),
            ...(cursor ? {
                OR: [
                    { updatedAt: { lt: cursor.updatedAt } },
                    { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
                ],
            } : {}),
        },
        select: automationDefinitionListItemSelect,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: limit + 1,
    });
    const page = rows.slice(0, limit) as AutomationListItem[];
    const last = page[page.length - 1];
    return {
        automations: page,
        nextCursor: rows.length > limit && last
            ? encodeAutomationDefinitionListCursor(last)
            : null,
    };
}

export async function getAutomation(params: {
    accountId: string;
    automationId: string;

}): Promise<AutomationListItem | null> {
    return await inTx(async (tx) => {
        return await loadAutomationTx(tx, params);
    });
}

/** Validates the scope and assignment of the one existing trigger-set owner. */
async function assertWorkflowTriggerContextTx(tx: Tx, params: Readonly<{
    accountId: string;
    targetType: AutomationTargetType | null;
    workflowDefinitionId: string | null;
    scopeSessionId: string | null;
    enabled: boolean;
    assignments: readonly AutomationAssignmentInput[];
    existingAssignments?: AutomationListItem['assignments'];
}>): Promise<void> {
    if (params.targetType !== null) {
        if (params.workflowDefinitionId !== null || params.scopeSessionId !== null) {
            throw new AutomationValidationError("Workflow trigger context requires a workflow recipe");
        }
        return;
    }
    // New authoring remains single-project. A disabled draft may own no
    // assignment, and a same-row conversion/metadata edit preserves the exact
    // existing placement census rather than fabricating a replacement Machine.
    if (params.assignments.length !== 1
        && !(params.assignments.length === 0 && !params.enabled)
        && !(params.existingAssignments
            && automationCreateAssignmentsMatch(params.existingAssignments, params.assignments))) {
        throw new AutomationValidationError("A workflow trigger set requires exactly one machine assignment");
    }
    if (params.scopeSessionId !== null && !await tx.session.findFirst({
        where: { id: params.scopeSessionId, accountId: params.accountId }, select: { id: true },
    })) {
        throw new AutomationValidationError("Workflow trigger scope session is unavailable");
    }
}

function resolveAutomationCreateTriggerInputs(input: AutomationUpsertInput): readonly AutomationTriggerCreateRequest[] {
    return isAutomationCurrentUpsertInput(input)
            ? input.triggers
            : input.schedule.kind === "manual" ? [] : [{
                triggerId: AutomationTriggerIdSchema.parse(randomUUID()),
                trigger: {
                    kind: "schedule",
                    enabled: true,
                    schedule: input.schedule.kind === "interval"
                        ? {
                            kind: "interval",
                            scheduleExpr: null,
                            everyMs: input.schedule.everyMs,
                            timezone: input.schedule.timezone ?? null,
                        }
                        : {
                            kind: "cron",
                            scheduleExpr: input.schedule.scheduleExpr,
                            everyMs: null,
                            timezone: input.schedule.timezone ?? null,
                        },
                },
            }];
}

/** Canonical Automation create writer, composable with Session birth in its transaction. */
export async function createAutomationInTx(tx: Tx, params: Readonly<{
    accountId: string;
    input: AutomationUpsertInput;
    serverIdentityId?: string | null;
    newbornSession?: AutomationSessionBirthContext;
}>): Promise<AutomationListItem> {
    const triggerInputs = resolveAutomationCreateTriggerInputs(params.input);
    if (isAutomationCurrentUpsertInput(params.input)) {
        const rejoined = await tryRejoinAutomationCreateTx({
            tx,
            accountId: params.accountId,
            input: params.input,
        });
        if (rejoined) return rejoined;
    }
    let currentDefinition: CurrentAutomationDefinitionWrite | null = null;
    let legacyDefinition: Readonly<{
        targetType: AutomationLegacyTargetType;
        templateCiphertext: string;
        accountMode: "e2ee" | "plain";
        legacyExistingSessionId?: string;
    }> | null = null;

    if (isAutomationCurrentUpsertInput(params.input)) {

        currentDefinition = await normalizeCurrentAutomationDefinitionWriteTx({
            tx,
            accountId: params.accountId,
            executionRecipe: params.input.executionRecipe,
            expectedTemplateVersion: 1,
        });
    } else {
        legacyDefinition = {
            targetType: params.input.targetType,
            templateCiphertext: params.input.templateCiphertext,
            accountMode: await assertAutomationTemplateMatchesCurrentAccountModeTx(tx, {
                accountId: params.accountId,
                targetType: params.input.targetType,
                templateCiphertext: params.input.templateCiphertext,
                legacyTemplateEnvelopeAdmission:
                    params.input.legacyTemplateEnvelopeAdmission,
            }),
            ...(params.input.legacyTemplateEnvelopeAdmission
                ? {
                    legacyExistingSessionId:
                        params.input.legacyTemplateEnvelopeAdmission.existingSessionId,
                }
                : {}),
        };
    }
    const definition = currentDefinition ?? legacyDefinition;
    if (!definition) {
        throw new Error("Automation definition normalization failed");
    }
    // Assignment-liveness: an enabled Automation must own at least one
    // enabled execution assignment; a disabled draft may own none.
    assertAutomationAssignmentLiveness({
        enabled: params.input.enabled,
        assignments: params.input.assignments ?? [],
    });
    await assertWorkflowTriggerContextTx(tx, {
        accountId: params.accountId, targetType: definition.targetType,
        workflowDefinitionId: params.input.workflowDefinitionId ?? null,
        scopeSessionId: params.input.scopeSessionId ?? null,
        enabled: params.input.enabled,
        assignments: params.input.assignments ?? [],
    });

    await validateExistingSessionAutomationTargetTx({
        tx,
        accountId: params.accountId,
        targetType: definition.targetType,
        templateCiphertext: definition.templateCiphertext,
        accountMode: definition.accountMode,
        ...(currentDefinition?.strictExistingSessionId
            ? { strictExistingSessionId: currentDefinition.strictExistingSessionId }
            : {}),
        ...(legacyDefinition?.legacyExistingSessionId
            ? { legacyExistingSessionId: legacyDefinition.legacyExistingSessionId }
            : {}),
    });

    const now = new Date();
    const automationId = isAutomationCurrentUpsertInput(params.input)
        ? params.input.automationId
        : randomUUID();
    const created = await tx.automation.create({
        data: {
            id: automationId,
            accountId: params.accountId,
            name: params.input.name,
            description: params.input.description ?? null,
            enabled: params.input.enabled,
            targetType: definition.targetType,
            workflowDefinitionId: params.input.workflowDefinitionId ?? null,
            scopeSessionId: params.input.scopeSessionId ?? null,
            templateCiphertext: definition.templateCiphertext,
            templateVersion: 1,
        },
        select: { id: true },
    });
    let hasEnabledEventTrigger = false;
    for (const { triggerId, trigger: input } of triggerInputs) {
        const normalized = await normalizeAutomationTriggerWriteTx({
            tx,
            accountId: params.accountId,
            automation: {
                id: created.id,
                targetType: definition.targetType,
                templateCiphertext: definition.templateCiphertext,
                templateVersion: 1,
                scopeSessionId: params.input.scopeSessionId ?? null,
            },
            triggerId,
            triggerRevision: 0,
            input,
            serverIdentityId: params.serverIdentityId ?? null,
            newbornSession: params.newbornSession,
            now,
        });
        await tx.automationTrigger.create({
            data: {
                id: triggerId,
                automationId: created.id,
                revision: 0,
                ...normalized.data,
            },
        });
        hasEnabledEventTrigger ||= normalized.isEvent && input.enabled;
    }

    if (hasEnabledEventTrigger) {
        await ensureAutomationEventCatalogStateTx({
            tx,
            accountId: params.accountId,
            projectionChanged: params.input.enabled,
        });
    }

    const assignments = await replaceAutomationAssignmentsTx({
        tx,
        accountId: params.accountId,
        automationId: created.id,
        assignments: params.input.assignments ?? [],
    });

    if (params.input.enabled) {
        await ensureAutomationScheduleCursorsTx({
            tx,
            automationId: created.id,
            now,
        });
    }

    const automation = await loadAutomationTx(tx, {
        accountId: params.accountId,
        automationId: created.id,
    });
    if (!automation) {
        throw new Error("Failed to load created automation");
    }

    const cursor = await markAutomationChangedTx(tx, {
        accountId: params.accountId,
        automationId: created.id,
    });

    afterTx(tx, () => {
        emitAutomationUpsert({ accountId: params.accountId, automation, cursor });
        emitAssignmentUpdates({
            accountId: params.accountId,
            automationId: automation.id,
            cursor,
            assignments,
        });
    });

    return automation;
}

export async function createAutomation(params: {
    accountId: string;
    input: AutomationUpsertInput;
}): Promise<AutomationListItem> {
    const triggerInputs = resolveAutomationCreateTriggerInputs(params.input);
    // Durable-push correspondence is resolved against this host's server
    // identity; acquiring it must not nest inside the definition transaction.
    const durablePushEvent = triggerInputs.find(({ trigger }) =>
        trigger.kind === "pluginEvent"
        && trigger.observationTransport.kind === "durablePush",
    );
    const serverIdentityId = await resolveAutomationDurablePushServerIdentityId(
        durablePushEvent?.trigger.kind === "pluginEvent" ? durablePushEvent.trigger : null,
    );
    const create = async () => await inTx((tx) => createAutomationInTx(tx, { ...params, serverIdentityId }));
    try {
        return await create();
    } catch (error) {
        if (!isAutomationCurrentUpsertInput(params.input) || !isPrismaErrorCode(error, "P2002")) {
            throw error;
        }
        const currentInput = params.input;
        const rejoined = await inTx(async (tx) => await tryRejoinAutomationCreateTx({
            tx,
            accountId: params.accountId,
            input: currentInput,
        }));
        if (!rejoined) {
            const identityIsBound = await db.automation.findUnique({
                where: { id: params.input.automationId },
                select: { id: true },
            });
            if (identityIsBound) throw new AutomationDefinitionCreateConflictError();
            throw error;
        }
        return rejoined;
    }
}

function assertRetainedLegacyAutomationTemplateForAccountMode(
    row: Pick<AutomationListItem, "targetType" | "templateCiphertext">,
    mode: "plain" | "e2ee",
): void {
    if (
        !isAutomationLegacyTargetType(row.targetType)
        || parseAutomationStoredDefinitionExecutionRecipeV1(row.templateCiphertext).kind === "available"
    ) return;
    assertAutomationTemplateEnvelopeForAccountMode(
        row.templateCiphertext,
        mode,
        row.targetType,
        readLegacyExistingSessionTemplateAdmission(row.templateCiphertext, row.targetType),
    );
}

export async function updateAutomation(params: {
    accountId: string;
    automationId: string;
    input: AutomationPatchInput;

    expectedTemplateVersion?: number;
    retainedLegacyTemplateRecovery?: boolean;
}): Promise<AutomationListItem | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;
        const existing = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
        });
        if (!existing) {
            return null;
        }
        if (
            params.expectedTemplateVersion !== undefined
            && existing.templateVersion !== params.expectedTemplateVersion
        ) {
            throw new AutomationTemplateMutationConflictError();
        }

        const legacyInput = isAutomationCurrentPatchInput(params.input)
            ? null
            : params.input;
        if (params.retainedLegacyTemplateRecovery) {
            if (
                accountFence.account.currentness.encryptionMode !== "plain"
                || params.expectedTemplateVersion === undefined
                || !legacyInput?.templateCiphertext
                || legacyInput.targetType !== undefined
                || !isAutomationLegacyTargetType(existing.targetType)
                || parseAutomationStoredDefinitionExecutionRecipeV1(existing.templateCiphertext).kind === "available"
            ) {
                throw new AutomationValidationError("Only a stored predecessor template in a plain Account can be recovered");
            }
            let source;
            try {
                source = normalizeAutomationTemplateEnvelopeStoredRead(JSON.parse(existing.templateCiphertext));
            } catch {
                throw new AutomationValidationError("Stored predecessor template is invalid");
            }
            if (!source) throw new AutomationValidationError("Stored predecessor template is invalid");
            if (source.legacyExistingSessionId && source.envelope.kind === AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND) {
                const session = await tx.session.findFirst({
                    where: { id: source.legacyExistingSessionId, accountId: params.accountId },
                    select: { encryptionMode: true },
                });
                if (session?.encryptionMode === "e2ee") {
                    throw new AutomationValidationError("Retained E2EE Session templates must remain encrypted");
                }
            }
            assertAutomationTemplateEnvelopeForAccountMode(
                legacyInput.templateCiphertext, "plain", existing.targetType,
            );
            const target = normalizeAutomationTemplateEnvelopeStoredRead(JSON.parse(legacyInput.templateCiphertext));
            const targetPayload = target && "payload" in target.envelope
                ? AutomationTemplatePayloadV1Schema.safeParse(target.envelope.payload)
                : null;
            if (!targetPayload?.success
                || targetPayload.data.sessionEncryptionKeyBase64 !== undefined
                || targetPayload.data.sessionEncryptionVariant !== undefined
                || targetPayload.data.sessionEncryptionMode === "e2ee"
                || (existing.targetType === "new_session" && targetPayload.data.existingSessionId !== undefined)) {
                throw new AutomationValidationError("Recovered predecessor template must contain a valid plain Automation payload");
            }
            if (existing.targetType === "existing_session") {
                const sourcePayload = "payload" in source.envelope
                    ? AutomationTemplatePayloadV1Schema.safeParse(source.envelope.payload)
                    : null;
                const sourceSessionId = source.legacyExistingSessionId
                    ?? (sourcePayload?.success
                        ? sourcePayload.data.existingSessionId
                        : undefined);
                const targetSessionId = targetPayload.data.existingSessionId;
                if (!sourceSessionId || sourceSessionId !== targetSessionId) {
                    throw new AutomationValidationError("Predecessor template recovery must preserve its existing Session target");
                }
            }
        }
        const currentDefinition = isAutomationCurrentPatchInput(params.input)
            ? await normalizeCurrentAutomationDefinitionWriteTx({
                tx,
                accountId: params.accountId,
                executionRecipe: params.input.executionRecipe,
                expectedTemplateVersion: existing.templateVersion + 1,
            })
            : null;
        const effectiveTargetType = currentDefinition
            ? currentDefinition.targetType
            : legacyInput?.targetType ?? existing.targetType;
        const inputSuppliesTemplate = currentDefinition !== null
            || typeof legacyInput?.templateCiphertext === "string";
        const inputSuppliesTarget = currentDefinition !== null
            || legacyInput?.targetType !== undefined;
        const effectiveTemplateCiphertext = currentDefinition?.templateCiphertext
            ?? legacyInput?.templateCiphertext
            ?? existing.templateCiphertext;
        // A retained predecessor template is a read compatibility shape, not
        // a new writer input. Derive its admission only from the exact loaded
        // row when a target-only edit revalidates that same stored byte string.
        const retainedLegacyTemplateEnvelopeAdmission = !inputSuppliesTemplate
            ? (isAutomationLegacyTargetType(existing.targetType)
                ? readLegacyExistingSessionTemplateAdmission(
                    existing.templateCiphertext,
                    existing.targetType,
                )
                : undefined)
            : undefined;
        const effectiveLegacyTemplateEnvelopeAdmission = inputSuppliesTemplate && currentDefinition === null
            ? legacyInput?.legacyTemplateEnvelopeAdmission
            : retainedLegacyTemplateEnvelopeAdmission;
        const legacyDefinitionMutation = currentDefinition === null
            && (
                typeof legacyInput?.templateCiphertext === "string"
                || legacyInput?.targetType !== undefined
            );
        let accountMode = currentDefinition?.accountMode ?? accountFence.account.currentness.encryptionMode;
        if (legacyDefinitionMutation) {
            if (!isAutomationLegacyTargetType(effectiveTargetType)) {
                throw new AutomationValidationError(
                    "Legacy Automation definition writes cannot target execution_run",
                );
            }
            accountMode = await assertAutomationTemplateMatchesCurrentAccountModeTx(tx, {
                accountId: params.accountId,
                targetType: effectiveTargetType,
                templateCiphertext: effectiveTemplateCiphertext,
                legacyTemplateEnvelopeAdmission:
                    effectiveLegacyTemplateEnvelopeAdmission,
            });
        } else if (!currentDefinition) {
            assertRetainedLegacyAutomationTemplateForAccountMode(existing, accountMode);
        }

        // The retained strict recipe already carries the schema-owned target
        // identity; a non-template patch (enable/disable/rename) must revalidate
        // against that same target instead of reparsing the stored recipe as a
        // legacy template envelope.
        const effectiveExistingSessionId = currentDefinition?.strictExistingSessionId
            ?? readAutomationExistingSessionTargetId({
                targetType: effectiveTargetType,
                templateCiphertext: effectiveTemplateCiphertext,
            });
        await validateExistingSessionAutomationTargetTx({
            tx,
            accountId: params.accountId,
            targetType: effectiveTargetType,
            templateCiphertext: effectiveTemplateCiphertext,
            accountMode,
            ...(effectiveExistingSessionId
                ? { strictExistingSessionId: effectiveExistingSessionId }
                : {}),
            ...(effectiveLegacyTemplateEnvelopeAdmission
                ? {
                    legacyExistingSessionId:
                        effectiveLegacyTemplateEnvelopeAdmission.existingSessionId,
                }
                : {}),
        });
        for (const trigger of existing.triggers) {
            if (trigger.kind !== "sessionLifecycle" || trigger.sourceSessionId === null) continue;
            validateSessionLifecycleExecutionTargetInequality({
                automationTargetType: effectiveTargetType,
                automationExistingSessionId: effectiveExistingSessionId,
                sourceSessionId: trigger.sourceSessionId,
            });
        }

        const schedule = legacyInput?.schedule;
        const effectiveEnabled = params.input.enabled ?? existing.enabled;
        const effectiveWorkflowDefinitionId = params.input.workflowDefinitionId === undefined
            ? existing.workflowDefinitionId : params.input.workflowDefinitionId;
        const effectiveScopeSessionId = params.input.scopeSessionId === undefined
            ? existing.scopeSessionId : params.input.scopeSessionId;
        if (existing.triggers.some((trigger) => (trigger.kind === "prComment" || trigger.kind === "ciFailed")
            && trigger.sourceSessionId !== effectiveScopeSessionId)) {
            throw new AutomationValidationError("Pull-request trigger session scope cannot be changed independently");
        }
        await assertWorkflowTriggerContextTx(tx, {
            accountId: params.accountId, targetType: effectiveTargetType,
            workflowDefinitionId: effectiveWorkflowDefinitionId, scopeSessionId: effectiveScopeSessionId,
            enabled: effectiveEnabled,
            existingAssignments: existing.assignments,
            assignments: params.input.assignments ?? existing.assignments,
        });
        // Assignment-liveness against the exact post-patch set: a replacement
        // set when one is supplied, otherwise the loaded persisted set. Throws
        // before any write so enabling without an assignment — or removing or
        // disabling the last enabled assignment of an enabled Automation —
        // rolls the whole patch back atomically.
        assertAutomationAssignmentLiveness({
            enabled: effectiveEnabled,
            assignments: params.input.assignments ?? existing.assignments,
        });
        const targetTypeChanged =
            inputSuppliesTarget
            && effectiveTargetType !== existing.targetType;
        const templateSemanticsWritten =
            inputSuppliesTemplate || targetTypeChanged;
        const observationBoundaryNow = new Date();
        const automationUpdate = {
            updatedAt: observationBoundaryNow,
            ...(params.input.workflowDefinitionId !== undefined ? { workflowDefinitionId: params.input.workflowDefinitionId } : {}),
            ...(params.input.scopeSessionId !== undefined ? { scopeSessionId: params.input.scopeSessionId } : {}),
            ...(typeof params.input.name === "string"
                ? { name: params.input.name }
                : {}),
            ...(params.input.description !== undefined
                ? { description: params.input.description ?? null }
                : {}),
            ...(typeof params.input.enabled === "boolean"
                ? { enabled: params.input.enabled }
                : {}),
            ...(templateSemanticsWritten
                ? {
                    targetType: effectiveTargetType,
                    templateCiphertext: effectiveTemplateCiphertext,
                }
                : {}),
            ...(templateSemanticsWritten
                ? { templateVersion: { increment: 1 } }
                : {}),
        };

        if (templateSemanticsWritten) {
            const updated = await tx.automation.updateMany({
                where: {
                    id: existing.id,
                    accountId: params.accountId,
                    templateVersion: existing.templateVersion,
                },
                data: automationUpdate,
            });
            if (updated.count !== 1) {
                throw new AutomationTemplateMutationConflictError();
            }
        } else if (Object.keys(automationUpdate).length > 0) {
            const updated = await tx.automation.updateMany({
                where: {
                    id: existing.id,
                    accountId: params.accountId,
                },
                data: automationUpdate,
            });
            if (updated.count !== 1) {
                return null;
            }
        }

        let scheduleChanged = false;
        if (schedule) {
            if (!isRetainedAutomationSingleScheduleDefinition(existing)) {
                throw new AutomationTemplateMutationConflictError();
            }
            const trigger = existing.triggers[0];
            if (schedule.kind === "manual") {
                if (trigger) {
                    scheduleChanged = true;
                    const triggerUpdated = await tx.automationTrigger.updateMany({
                        where: {
                            id: trigger.id,
                            automationId: existing.id,
                            revision: trigger.revision,
                            deletedAt: null,
                            kind: "schedule",
                        },
                        data: automationTriggerTombstoneUpdate(
                            observationBoundaryNow,
                            "schedule",
                        ),
                    });
                    if (triggerUpdated.count !== 1) {
                        throw new AutomationTemplateMutationConflictError();
                    }
                }
            } else {
                const fields = resolveScheduleDbFields(schedule);
                scheduleChanged = !trigger || !hasSameAutomationScheduleFields(trigger, fields);
                if (!trigger) {
                    await tx.automationTrigger.create({
                        data: {
                            id: AutomationTriggerIdSchema.parse(randomUUID()),
                            automationId: existing.id,
                            revision: 0,
                            kind: "schedule",
                            enabled: true,
                            deletedAt: null,
                            ...AUTOMATION_TRIGGER_KIND_FIELDS_CLEARED,
                            ...fields,
                            nextRunAt: null,
                            createdAt: observationBoundaryNow,
                            updatedAt: observationBoundaryNow,
                        },
                    });
                } else {
                    const triggerUpdated = await tx.automationTrigger.updateMany({
                        where: {
                            id: trigger.id,
                            automationId: existing.id,
                            revision: trigger.revision,
                            deletedAt: null,
                            kind: "schedule",
                        },
                        data: {
                            ...fields,
                            ...(scheduleChanged
                                ? { nextRunAt: null, revision: { increment: 1 } }
                                : {}),
                            updatedAt: observationBoundaryNow,
                        },
                    });
                    if (triggerUpdated.count !== 1) {
                        throw new AutomationTemplateMutationConflictError();
                    }
                }
            }
        }

        if (scheduleChanged && !templateSemanticsWritten) {
            await advanceAutomationTriggerSetRevisionTx(tx, existing, observationBoundaryNow);
        }

        if (!existing.enabled && effectiveEnabled) {
            await tx.automationTrigger.updateMany({
                where: {
                    automationId: existing.id,
                    kind: "pluginEvent",
                    enabled: true,
                    deletedAt: null,
                    observationTransport: "durablePush",
                },
                data: { observationStartsAt: observationBoundaryNow },
            });
        }

        const hasEventTrigger = existing.triggers.some(
            (trigger) => trigger.kind === "pluginEvent",
        );
        const eventProjectionChanged = hasEventTrigger
            && existing.enabled !== effectiveEnabled;
        if (hasEventTrigger) {
            await ensureAutomationEventCatalogStateTx({
                tx,
                accountId: params.accountId,
                projectionChanged: eventProjectionChanged,
            });
        }
        if (existing.enabled && !effectiveEnabled) {
            await tx.automationTrigger.updateMany({
                where: {
                    automationId: existing.id,
                    kind: "schedule",
                    deletedAt: null,
                },
                data: { nextRunAt: null },
            });
        }
        if (params.input.assignments) {

            await replaceAutomationAssignmentsTx({
                tx,
                accountId: params.accountId,
                automationId: existing.id,
                assignments: params.input.assignments,
            });
        }

        const now = new Date();

        if (effectiveEnabled) {
            await ensureAutomationScheduleCursorsTx({
                tx,
                automationId: existing.id,
                now,
            });
        }

        const updated = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: existing.id,
        });
        if (!updated) {
            return null;
        }

        const cursor = await markAutomationChangedTx(tx, {
            accountId: params.accountId,
            automationId: existing.id,
        });

        emitAutomationMutationAfterTx({
            tx,
            accountId: params.accountId,
            automation: updated,
            cursor,
            previousAssignments: existing.assignments,
        });

        return updated;
    });
}

/**
 * Canonical whole-editor mutation. Definition, independent recipe revision,
 * assignments, and the complete trigger census commit together; a stale row
 * or membership witness rolls the entire save back.
 */
export async function reconcileAutomationDefinition(params: Readonly<{
    accountId: string;
    automationId: string;
    input: AutomationDefinitionReconcileRequest;
}>): Promise<AutomationListItem | null> {
    const durablePushInput = params.input.triggers.find((item) =>
        (item.kind === "new" && item.trigger.kind === "pluginEvent"
            && item.trigger.observationTransport.kind === "durablePush")
        || (item.kind === "existing" && item.trigger?.kind === "pluginEvent"
            && item.trigger.observationTransport.kind === "durablePush"),
    );
    const durablePushTrigger = durablePushInput?.kind === "new"
        ? durablePushInput.trigger
        : durablePushInput?.kind === "existing" ? durablePushInput.trigger : null;
    const serverIdentityId = await resolveAutomationDurablePushServerIdentityId(
        durablePushTrigger?.kind === "pluginEvent" ? durablePushTrigger : null,
    );

    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
            tx,
            params.accountId,
        );
        if (accountFence.status !== "ready") return null;
        const existing = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
        });
        if (!existing) return null;
        if (existing.templateVersion !== params.input.expectedTemplateVersion) {
            throw new AutomationTemplateMutationConflictError();
        }

        const retained = new Map(params.input.triggers.flatMap((item) =>
            item.kind === "existing" ? [[item.triggerId, item] as const] : [],
        ));
        const removed = new Map(params.input.removedTriggers.map((item) =>
            [item.triggerId, item] as const,
        ));
        if (retained.size + removed.size !== existing.triggers.length) {
            throw new AutomationTriggerMutationConflictError();
        }
        for (const trigger of existing.triggers) {
            const triggerId = AutomationTriggerIdSchema.parse(trigger.id);
            const witness = retained.get(triggerId) ?? removed.get(triggerId);
            if (!witness || witness.expectedRevision !== trigger.revision) {
                throw new AutomationTriggerMutationConflictError();
            }
        }
        // Assignment-liveness before any write: a whole-editor Save of an
        // enabled Automation must commit at least one enabled execution
        // assignment or roll the entire reconciliation back atomically.
        assertAutomationAssignmentLiveness({
            enabled: params.input.enabled,
            assignments: params.input.assignments,
        });

        const currentDefinition = params.input.executionRecipe
            ? await normalizeCurrentAutomationDefinitionWriteTx({
                tx,
                accountId: params.accountId,
                executionRecipe: params.input.executionRecipe,
                expectedTemplateVersion: existing.templateVersion + 1,
            })
            : null;
        if (!currentDefinition) {
            assertRetainedLegacyAutomationTemplateForAccountMode(
                existing,
                accountFence.account.currentness.encryptionMode,
            );
        }
        const revisionUpdate = currentDefinition
            ? { templateVersion: existing.templateVersion + 1, templateCiphertext: currentDefinition.templateCiphertext }
            : advanceAutomationDefinitionRevision(existing);
        const effectiveAutomation: AutomationListItem = {
            ...existing,
            ...revisionUpdate,
            ...(currentDefinition ? { targetType: currentDefinition.targetType } : {}),
            workflowDefinitionId: params.input.workflowDefinitionId === undefined
                ? existing.workflowDefinitionId : params.input.workflowDefinitionId,
            scopeSessionId: params.input.scopeSessionId === undefined
                ? existing.scopeSessionId : params.input.scopeSessionId,
        };
        if (params.input.triggers.some((item) => item.kind === "existing"
            && existing.triggers.some((trigger) => trigger.id === item.triggerId
                && (trigger.kind === "prComment" || trigger.kind === "ciFailed")
                && trigger.sourceSessionId !== effectiveAutomation.scopeSessionId))) {
            throw new AutomationValidationError("Pull-request trigger session scope cannot be changed independently");
        }
        const effectiveExistingSessionId = currentDefinition?.strictExistingSessionId
            ?? readAutomationExistingSessionTargetId(effectiveAutomation);
        await assertWorkflowTriggerContextTx(tx, {
            accountId: params.accountId, targetType: effectiveAutomation.targetType,
            workflowDefinitionId: params.input.workflowDefinitionId === undefined
                ? existing.workflowDefinitionId : params.input.workflowDefinitionId,
            scopeSessionId: params.input.scopeSessionId === undefined
                ? existing.scopeSessionId : params.input.scopeSessionId,
            enabled: params.input.enabled,
            existingAssignments: existing.assignments,
            assignments: params.input.assignments,
        });
        await validateExistingSessionAutomationTargetTx({
            tx,
            accountId: params.accountId,
            targetType: effectiveAutomation.targetType,
            templateCiphertext: effectiveAutomation.templateCiphertext,
            accountMode: currentDefinition?.accountMode ?? accountFence.account.currentness.encryptionMode,
            ...(effectiveExistingSessionId ? { strictExistingSessionId: effectiveExistingSessionId } : {}),
            ...(!currentDefinition && isAutomationLegacyTargetType(existing.targetType)
                ? { legacyExistingSessionId: readLegacyExistingSessionTemplateAdmission(
                    existing.templateCiphertext, existing.targetType,
                )?.existingSessionId }
                : {}),
        });
        for (const item of params.input.triggers) {
            if (item.kind !== "existing") continue;
            const trigger = existing.triggers.find((candidate) => candidate.id === item.triggerId)!;
            if (item.trigger || trigger.kind !== "sessionLifecycle" || trigger.sourceSessionId === null) continue;
            validateSessionLifecycleExecutionTargetInequality({
                automationTargetType: effectiveAutomation.targetType,
                automationExistingSessionId: effectiveExistingSessionId,
                sourceSessionId: trigger.sourceSessionId,
            });
        }

        const now = new Date();
        const definitionUpdated = await tx.automation.updateMany({
            where: {
                id: existing.id,
                accountId: params.accountId,
                deletedAt: null,
                templateVersion: existing.templateVersion,
            },
            data: {
                name: params.input.name,
                description: params.input.description,
                enabled: params.input.enabled,
                updatedAt: now,
                ...revisionUpdate,
                ...(params.input.workflowDefinitionId !== undefined ? { workflowDefinitionId: params.input.workflowDefinitionId } : {}),
                ...(params.input.scopeSessionId !== undefined ? { scopeSessionId: params.input.scopeSessionId } : {}),
                ...(currentDefinition ? {
                    targetType: currentDefinition.targetType,
                } : {}),
            },
        });
        if (definitionUpdated.count !== 1) {
            throw new AutomationTemplateMutationConflictError();
        }
        await replaceAutomationAssignmentsTx({
            tx,
            accountId: params.accountId,
            automationId: existing.id,
            assignments: params.input.assignments,
        });

        let eventProjectionChanged = existing.enabled !== params.input.enabled
            && existing.triggers.some((trigger) => trigger.kind === "pluginEvent");
        const changedEventTriggerIds = new Set<string>();

        for (const item of params.input.removedTriggers) {
            const trigger = existing.triggers.find((candidate) => candidate.id === item.triggerId)!;
            const deleted = await tx.automationTrigger.updateMany({
                where: {
                    id: trigger.id,
                    automationId: existing.id,
                    revision: item.expectedRevision,
                    deletedAt: null,
                },
                data: automationTriggerTombstoneUpdate(now, trigger.kind),
            });
            if (deleted.count !== 1) throw new AutomationTriggerMutationConflictError();
            if (trigger.kind === "pluginEvent") {
                // Removed Event triggers change checkpoint-retirement truth
                // even when the definition or trigger was already paused.
                eventProjectionChanged = true;
                changedEventTriggerIds.add(trigger.id);
            }
        }

        for (const item of params.input.triggers) {
            if (item.kind === "new") {
                const normalized = await normalizeAutomationTriggerWriteTx({
                    tx,
                    accountId: params.accountId,
                    automation: effectiveAutomation,
                    triggerId: item.triggerId,
                    triggerRevision: 0,
                    input: item.trigger,
                    serverIdentityId,
                    now,
                });
                await tx.automationTrigger.create({
                    data: {
                        id: item.triggerId,
                        automationId: existing.id,
                        revision: 0,
                        ...normalized.data,
                    },
                });
                if (normalized.isEvent) eventProjectionChanged ||= params.input.enabled && item.trigger.enabled;
                continue;
            }
            if (item.enabled === undefined && item.trigger === undefined) continue;
            const trigger = existing.triggers.find((candidate) => candidate.id === item.triggerId)!;
            const nextEnabled = item.enabled ?? trigger.enabled;
            const unchangedScheduleDefinition = item.trigger?.kind === "schedule"
                && trigger.kind === "schedule"
                && nextEnabled === trigger.enabled
                && hasSameAutomationScheduleFields(
                    trigger,
                    resolveTriggerDefinitionScheduleDbFields(item.trigger.schedule),
                );
            const nextRevision = unchangedScheduleDefinition ? trigger.revision : trigger.revision + 1;
            let nextKind = trigger.kind;
            let data: Prisma.AutomationTriggerUncheckedUpdateInput;
            if (item.trigger) {
                const normalized = await normalizeAutomationTriggerWriteTx({
                    tx,
                    accountId: params.accountId,
                    automation: effectiveAutomation,
                    triggerId: trigger.id,
                    triggerRevision: nextRevision,
                    input: { ...item.trigger, enabled: nextEnabled },
                    serverIdentityId,
                    now,
                    existing: trigger,
                });
                data = { ...normalized.data, revision: nextRevision, updatedAt: now };
                nextKind = item.trigger.kind;
            } else {
                data = {
                    enabled: nextEnabled,
                    revision: nextRevision,
                    updatedAt: now,
                    ...(!nextEnabled ? { nextRunAt: null } : {}),
                };
                if (trigger.kind === "sessionLifecycle" && !trigger.enabled && nextEnabled) {
                    await validateSessionLifecycleTriggerRegistrationTx({
                        tx,
                        accountId: params.accountId,
                        automationTargetType: effectiveAutomation.targetType,
                        automationExistingSessionId: effectiveExistingSessionId,
                        input: {
                            ...decodeAutomationSessionLifecycleConfiguration(trigger).definition,
                            enabled: true,
                        },
                    });
                }
                if (trigger.kind === "runLifecycle" && !trigger.enabled && nextEnabled) {
                    await validateAutomationRunLifecycleSourceTx(tx, params.accountId, decodeAutomationRunLifecycleConfiguration(trigger));
                }
                if (trigger.kind === "pluginEvent" || trigger.kind === "prComment" || trigger.kind === "ciFailed") {
                    const currentness = await fetchAutomationAccountCurrentnessWitnessTx(tx, params.accountId);
                    if (!currentness) throw new AutomationStoredContentReadError("contentInvalid");
                    if (currentness.mode === "e2ee") {
                        if (!item.triggerDefinitionEnvelope) {
                            throw new AutomationValidationError(
                                "Encrypted Automation Event enablement requires a next-revision trigger definition envelope",
                            );
                        }
                        const binding = readAutomationTriggerDefinitionBinding({
                            automationId: existing.id,
                            triggerId: trigger.id,
                            triggerRevision: nextRevision,
                            triggerKind: trigger.kind,
                            triggerEventPluginId: trigger.eventPluginId,
                            triggerEventLocalId: trigger.eventLocalId,
                            triggerSourceSelectorId: trigger.sourceSelectorId,
                        });
                        if (!binding || validateAutomationTriggerDefinitionEnvelopeOuterForMode({
                            raw: JSON.stringify(item.triggerDefinitionEnvelope),
                            mode: "e2ee",
                            binding,
                        }).kind !== "available") {
                            throw new AutomationStoredContentReadError("contentInvalid");
                        }
                        data.definitionEnvelope = JSON.stringify(item.triggerDefinitionEnvelope);
                    } else {
                        if (item.triggerDefinitionEnvelope) {
                            throw new AutomationValidationError(
                                "Plain Automation Event enablement must not supply an encrypted definition envelope",
                            );
                        }
                        data.definitionEnvelope = JSON.stringify(
                            sealAutomationTriggerDefinitionStoredEnvelopeV1({
                                mode: "plain",
                                binding: readAutomationTriggerDefinitionBinding({ automationId: existing.id,
                                    triggerId: trigger.id, triggerRevision: nextRevision, triggerKind: trigger.kind,
                                    triggerEventPluginId: trigger.eventPluginId, triggerEventLocalId: trigger.eventLocalId,
                                    triggerSourceSelectorId: trigger.sourceSelectorId })!,
                                definition: readPlainAutomationPrivateTriggerDefinition(existing, trigger),
                            }),
                        );
                    }
                    if (!trigger.enabled && nextEnabled && trigger.observationTransport === "durablePush") {
                        data.observationStartsAt = now;
                    }
                } else if (item.triggerDefinitionEnvelope) {
                    throw new AutomationValidationError(
                        "Only an encrypted Automation Event trigger accepts a resealed definition envelope",
                    );
                }
            }
            const updated = await tx.automationTrigger.updateMany({
                where: {
                    id: trigger.id,
                    automationId: existing.id,
                    revision: item.expectedRevision,
                    deletedAt: null,
                },
                data,
            });
            if (updated.count !== 1) throw new AutomationTriggerMutationConflictError();
            if (trigger.kind === "pluginEvent" || nextKind === "pluginEvent") {
                eventProjectionChanged ||= params.input.enabled;
                changedEventTriggerIds.add(trigger.id);
            }
        }

        if (existing.enabled && !params.input.enabled) {
            await tx.automationTrigger.updateMany({
                where: { automationId: existing.id, kind: "schedule", deletedAt: null },
                data: { nextRunAt: null },
            });
        }
        if (!existing.enabled && params.input.enabled) {
            await tx.automationTrigger.updateMany({
                where: {
                    automationId: existing.id,
                    kind: "pluginEvent",
                    enabled: true,
                    deletedAt: null,
                    observationTransport: "durablePush",
                },
                data: { observationStartsAt: now },
            });
        }
        if (eventProjectionChanged) {
            await ensureAutomationEventCatalogStateTx({
                tx,
                accountId: params.accountId,
                projectionChanged: true,
            });
        }
        for (const triggerId of changedEventTriggerIds) {
            await deleteSupersededAutomationEventSourceStatusTx({ tx, triggerId });
        }
        if (params.input.enabled) {
            await ensureAutomationScheduleCursorsTx({ tx, automationId: existing.id, now });
        }

        const result = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: existing.id,
        });
        if (!result) throw new Error("Failed to load reconciled Automation");
        const cursor = await markAutomationChangedTx(tx, {
            accountId: params.accountId,
            automationId: existing.id,
        });
        emitAutomationMutationAfterTx({
            tx,
            accountId: params.accountId,
            automation: result,
            cursor,
            previousAssignments: existing.assignments,
        });
        return result;
    });
}

export async function createAutomationTrigger(params: Readonly<{
    accountId: string;
    automationId: string;
    triggerId: string;
    trigger: AutomationTriggerDefinitionInput;
}>): Promise<AutomationListItem | null> {
    const serverIdentityId = await resolveAutomationDurablePushServerIdentityId(
        params.trigger.kind === "pluginEvent" ? params.trigger : null,
    );
    const request = { triggerId: params.triggerId, trigger: params.trigger };
    const create = async () => await inTx(async (tx) => {
        const rejoined = await tryRejoinAutomationTriggerCreateTx({
            tx,
            accountId: params.accountId,
            automationId: params.automationId,
            request,
        });
        if (rejoined) return rejoined;
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
            tx,
            params.accountId,
        );
        if (accountFence.status !== "ready") return null;
        const automation = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
        });
        if (!automation) return null;

        const now = new Date();
        const normalized = await normalizeAutomationTriggerWriteTx({
            tx,
            accountId: params.accountId,
            automation,
            triggerId: params.triggerId,
            triggerRevision: 0,
            input: params.trigger,
            serverIdentityId,
            now,
        });
        await tx.automationTrigger.create({
            data: {
                id: params.triggerId,
                automationId: automation.id,
                revision: 0,
                ...normalized.data,
            },
        });
        await advanceAutomationTriggerSetRevisionTx(tx, automation, now);
        if (normalized.isEvent) {
            await ensureAutomationEventCatalogStateTx({
                tx,
                accountId: params.accountId,
                projectionChanged: automation.enabled && params.trigger.enabled,
            });
        }
        if (automation.enabled) {
            await ensureAutomationScheduleCursorsTx({
                tx,
                automationId: automation.id,
                now,
            });
        }
        const updated = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: automation.id,
        });
        if (!updated) throw new Error("Failed to load Automation after trigger creation");
        const cursor = await markAutomationChangedTx(tx, {
            accountId: params.accountId,
            automationId: automation.id,
        });
        emitAutomationMutationAfterTx({
            tx,
            accountId: params.accountId,
            automation: updated,
            cursor,
        });
        return updated;
    });
    try {
        return await create();
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        const rejoined = await inTx(async (tx) =>
            await tryRejoinAutomationTriggerCreateTx({
                tx,
                accountId: params.accountId,
                automationId: params.automationId,
                request,
            }),
        );
        if (!rejoined) {
            const identityIsBound = await db.automationTrigger.findUnique({
                where: { id: params.triggerId },
                select: { id: true },
            });
            if (identityIsBound) throw new AutomationTriggerCreateConflictError();
            throw error;
        }
        return rejoined;
    }
}

export async function updateAutomationTrigger(params: Readonly<{
    accountId: string;
    automationId: string;
    triggerId: string;
    expectedRevision: number;
    enabled?: boolean;
    trigger?: AutomationTriggerDefinition;
    triggerDefinitionEnvelope?: AutomationTriggerPatchRequest["triggerDefinitionEnvelope"];
}>): Promise<AutomationListItem | null> {
    if (params.enabled === undefined && params.trigger === undefined) {
        throw new AutomationValidationError(
            "Automation trigger patch must change enablement or definition",
        );
    }
    if (params.trigger !== undefined && params.triggerDefinitionEnvelope !== undefined) {
        throw new AutomationValidationError(
            "A trigger semantic patch must carry its definition envelope in the trigger arm",
        );
    }
    const serverIdentityId = await resolveAutomationDurablePushServerIdentityId(
        params.trigger?.kind === "pluginEvent" ? params.trigger : null,
    );
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
            tx,
            params.accountId,
        );
        if (accountFence.status !== "ready") return null;
        const automation = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
        });
        if (!automation) return null;
        const existing = automation.triggers.find(
            (trigger) => trigger.id === params.triggerId,
        );
        if (!existing) return null;
        if (existing.revision !== params.expectedRevision) {
            throw new AutomationTriggerMutationConflictError();
        }

        const now = new Date();
        const nextEnabled = params.enabled ?? existing.enabled;
        const unchangedScheduleDefinition = params.trigger?.kind === "schedule"
            && existing.kind === "schedule"
            && nextEnabled === existing.enabled
            && (() => {
                const fields = resolveTriggerDefinitionScheduleDbFields(
                    params.trigger.schedule,
                );
                return hasSameAutomationScheduleFields(existing, fields);
            })();
        const nextRevision = unchangedScheduleDefinition
            ? existing.revision
            : existing.revision + 1;
        let data: Prisma.AutomationTriggerUncheckedUpdateInput;
        let nextKind = existing.kind;
        let resolvedNextEnabled = nextEnabled;
        if (params.trigger) {
            const input: AutomationTriggerDefinitionInput = {
                ...params.trigger,
                enabled: resolvedNextEnabled,
            };
            const normalized = await normalizeAutomationTriggerWriteTx({
                tx,
                accountId: params.accountId,
                automation,
                triggerId: existing.id,
                triggerRevision: nextRevision,
                input,
                serverIdentityId,
                now,
                existing,
            });
            data = { ...normalized.data, revision: nextRevision, updatedAt: now };
            nextKind = input.kind;
            resolvedNextEnabled = input.enabled;
        } else {
            if (existing.kind === "sessionLifecycle" && !existing.enabled && resolvedNextEnabled) {
                await validateSessionLifecycleTriggerRegistrationTx({
                    tx,
                    accountId: params.accountId,
                    automationTargetType: automation.targetType,
                    automationExistingSessionId: readAutomationExistingSessionTargetId(automation),
                    input: {
                        ...decodeAutomationSessionLifecycleConfiguration(existing).definition,
                        enabled: true,
                    },
                });
            }
            if (existing.kind === "runLifecycle" && !existing.enabled && resolvedNextEnabled) {
                await validateAutomationRunLifecycleSourceTx(tx, params.accountId, decodeAutomationRunLifecycleConfiguration(existing));
            }
            data = {
                enabled: resolvedNextEnabled,
                revision: nextRevision,
                updatedAt: now,
                ...(!resolvedNextEnabled ? { nextRunAt: null } : {}),
            };
            if (existing.kind === "pluginEvent" || existing.kind === "prComment" || existing.kind === "ciFailed") {
                const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(
                    tx,
                    params.accountId,
                );
                if (!accountCurrentness) {
                    throw new AutomationStoredContentReadError("contentInvalid");
                }
                if (accountCurrentness.mode === "e2ee") {
                    if (!params.triggerDefinitionEnvelope) {
                        throw new AutomationValidationError(
                            "Encrypted Automation Event enablement requires a next-revision trigger definition envelope",
                        );
                    }
                    const binding = readAutomationTriggerDefinitionBinding({
                        automationId: automation.id,
                        triggerId: existing.id,
                        triggerRevision: nextRevision,
                        triggerKind: existing.kind,
                        triggerEventPluginId: existing.eventPluginId,
                        triggerEventLocalId: existing.eventLocalId,
                        triggerSourceSelectorId: existing.sourceSelectorId,
                    });
                    if (!binding || validateAutomationTriggerDefinitionEnvelopeOuterForMode({
                        raw: JSON.stringify(params.triggerDefinitionEnvelope),
                        mode: "e2ee",
                        binding,
                    }).kind !== "available") {
                        throw new AutomationStoredContentReadError("contentInvalid");
                    }
                    data.definitionEnvelope = JSON.stringify(params.triggerDefinitionEnvelope);
                } else {
                    if (params.triggerDefinitionEnvelope) {
                        throw new AutomationValidationError(
                            "Plain Automation Event enablement must not supply an encrypted definition envelope",
                        );
                    }
                    const definition = readPlainAutomationPrivateTriggerDefinition(
                        automation,
                        existing,
                    );
                    data.definitionEnvelope = JSON.stringify(
                        sealAutomationTriggerDefinitionStoredEnvelopeV1({
                            mode: "plain",
                            binding: readAutomationTriggerDefinitionBinding({ automationId: automation.id,
                                triggerId: existing.id, triggerRevision: nextRevision, triggerKind: existing.kind,
                                triggerEventPluginId: existing.eventPluginId, triggerEventLocalId: existing.eventLocalId,
                                triggerSourceSelectorId: existing.sourceSelectorId })!,
                            definition,
                        }),
                    );
                }
                if (
                    !existing.enabled
                    && resolvedNextEnabled
                    && existing.observationTransport === "durablePush"
                ) {
                    data.observationStartsAt = now;
                }
            } else if (params.triggerDefinitionEnvelope) {
                throw new AutomationValidationError(
                    "Only an encrypted Automation Event trigger accepts a resealed definition envelope",
                );
            }
        }

        const updatedTrigger = await tx.automationTrigger.updateMany({
            where: {
                id: existing.id,
                automationId: automation.id,
                revision: params.expectedRevision,
                deletedAt: null,
            },
            data,
        });
        if (updatedTrigger.count !== 1) {
            throw new AutomationTriggerMutationConflictError();
        }
        await advanceAutomationTriggerSetRevisionTx(tx, automation, now);
        const eventProjectionChanged = automation.enabled && (
            existing.kind === "pluginEvent" || nextKind === "pluginEvent"
        );
        if (eventProjectionChanged) {
            await ensureAutomationEventCatalogStateTx({
                tx,
                accountId: params.accountId,
                projectionChanged: true,
            });
        }
        if (existing.kind === "pluginEvent" || nextKind === "pluginEvent") {
            await deleteSupersededAutomationEventSourceStatusTx({
                tx,
                triggerId: existing.id,
            });
        }
        if (automation.enabled && resolvedNextEnabled) {
            await ensureAutomationScheduleCursorsTx({
                tx,
                automationId: automation.id,
                now,
            });
        }
        const updated = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: automation.id,
        });
        if (!updated) throw new Error("Failed to load Automation after trigger update");
        const cursor = await markAutomationChangedTx(tx, {
            accountId: params.accountId,
            automationId: automation.id,
        });
        emitAutomationMutationAfterTx({
            tx,
            accountId: params.accountId,
            automation: updated,
            cursor,
        });
        return updated;
    });
}

export async function deleteAutomationTrigger(params: Readonly<{
    accountId: string;
    automationId: string;
    triggerId: string;
    expectedRevision: number;
}>): Promise<AutomationListItem | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
            tx,
            params.accountId,
        );
        if (accountFence.status !== "ready") return null;
        const automation = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
        });
        if (!automation) return null;
        const existing = automation.triggers.find(
            (trigger) => trigger.id === params.triggerId,
        );
        if (!existing) return null;
        if (existing.revision !== params.expectedRevision) {
            throw new AutomationTriggerMutationConflictError();
        }
        const now = new Date();
        const deleted = await tx.automationTrigger.updateMany({
            where: {
                id: existing.id,
                automationId: automation.id,
                revision: params.expectedRevision,
                deletedAt: null,
            },
            data: automationTriggerTombstoneUpdate(now, existing.kind),
        });
        if (deleted.count !== 1) {
            throw new AutomationTriggerMutationConflictError();
        }
        await advanceAutomationTriggerSetRevisionTx(tx, automation, now);
        if (existing.kind === "pluginEvent") {
            await ensureAutomationEventCatalogStateTx({
                tx,
                accountId: params.accountId,
                // A disabled Event trigger still owns checkpoint continuity.
                // Deletion changes its retirement classification even though
                // it was absent from active admission, so the provider must
                // observe a new catalog revision and reclassify it.
                projectionChanged: true,
            });
            await deleteSupersededAutomationEventSourceStatusTx({
                tx,
                triggerId: existing.id,
            });
        }
        const updated = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: automation.id,
        });
        if (!updated) throw new Error("Failed to load Automation after trigger deletion");
        const cursor = await markAutomationChangedTx(tx, {
            accountId: params.accountId,
            automationId: automation.id,
        });
        emitAutomationMutationAfterTx({
            tx,
            accountId: params.accountId,
            automation: updated,
            cursor,
        });
        return updated;
    });
}

export async function deleteAutomation(params: {
    accountId: string;
    automationId: string;

}): Promise<boolean> {
    return await inTx(async (tx) => deleteAutomationTx(tx, params));
}

/** Session deletion composes the same soft-deletion owner in its transaction. */
export async function deleteAutomationTx(tx: Tx, params: {
    accountId: string;
    automationId: string;

}): Promise<boolean> {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return false;
        const existing = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
        });

        if (!existing) {
            return false;
        }

        const deletedAt = new Date();
        const softDeleted = await tx.automation.updateMany({
            where: {
                id: existing.id,
                accountId: params.accountId,
                deletedAt: null,
            },
            data: {
                enabled: false,
                deletedAt,
            },
        });
        if (softDeleted.count !== 1) {
            return false;
        }

        await tx.automationAssignment.deleteMany({
            where: { automationId: existing.id },
        });

        await tx.automationTrigger.updateMany({
            where: { automationId: existing.id, deletedAt: null },
            data: { enabled: false, nextRunAt: null, updatedAt: deletedAt },
        });

        if (existing.triggers.some((trigger) => trigger.kind === "pluginEvent")) {
            await ensureAutomationEventCatalogStateTx({
                tx,
                accountId: params.accountId,
                // Definition deletion changes checkpoint-retirement truth even
                // when the Automation was already paused. The same catalog
                // owner tells providers to reclassify; no deletion watcher or
                // provider-specific invalidation path is needed.
                projectionChanged: true,
            });
        }
        // Source status is current projection state, not history. Delete every
        // child row, including any row attached to an already-retired trigger;
        // immutable Run causes and trigger tombstones retain historical truth.
        await tx.automationEventSourceStatus.deleteMany({
            where: { trigger: { automationId: existing.id } },
        });

        const cursor = await markAutomationChangedTx(tx, {
            accountId: params.accountId,
            automationId: existing.id,
        });

        afterTx(tx, () => {
            emitAutomationDelete({
                accountId: params.accountId,
                automationId: existing.id,
                cursor,
                deletedAt,
            });
            emitAssignmentUpdates({
                accountId: params.accountId,
                automationId: existing.id,
                cursor,
                assignments: buildAssignmentUpdateRows({
                    previousAssignments: existing.assignments,
                    nextAssignments: [],
                }),
            });
        });

        return true;
}

/**
 * The second phase of `deleteAutomation`. The first phase soft-deletes the
 * definition and drops its mutable assignments, but it cannot
 * remove the row: `AutomationRun` restricts its parent, so the definition must
 * outlive every retained Run. Retention removes those Runs, and finishes the
 * deletion here — otherwise a deleted Automation stays in the table forever.
 *
 * There is no separate age rule. A soft-deleted definition with no retained Run
 * is already unreachable by every product path, so the relation emptiness is
 * the exact currentness proof. This helper is deliberately Account-scoped: the
 * Account transition fence must precede both the candidate scan and delete.
 * The relation filter is repeated on the delete so a Run created between the
 * scan and the delete simply excludes that row rather than raising the restrict
 * error.
 */
export async function finalizeDeletedAutomationsWithoutRetainedRunsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    limit: number;
}>): Promise<number> {
    const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
        params.tx,
        params.accountId,
    );
    if (accountFence.status !== "ready") return 0;
    const candidates = await params.tx.automation.findMany({
        where: {
            accountId: params.accountId,
            deletedAt: { not: null },
            runs: { none: {} },
        },
        orderBy: { deletedAt: "asc" },
        take: params.limit,
        select: { id: true },
    });
    if (candidates.length === 0) return 0;
    const deleted = await params.tx.automation.deleteMany({
        where: {
            id: { in: candidates.map((candidate) => candidate.id) },
            accountId: params.accountId,
            deletedAt: { not: null },
            runs: { none: {} },
        },
    });
    return deleted.count;
}

export async function setAutomationEnabled(params: {
    accountId: string;
    automationId: string;
    enabled: boolean;

}): Promise<AutomationListItem | null> {
    return await updateAutomation({
        accountId: params.accountId,
        automationId: params.automationId,
        input: { enabled: params.enabled },
    });
}

export async function runAutomationNow(params: {
    accountId: string;
    automationId: string;
    idempotencyKey?: string;

    recipeFeaturePolicy?: AutomationRecipeFeaturePolicy;
}): Promise<AutomationRunItem | null> {
    const idempotencyKey = params.idempotencyKey?.trim();
    if (params.idempotencyKey !== undefined && !idempotencyKey) {
        throw new AutomationValidationError("Idempotency-Key must not be empty");
    }
    return await rejoinAutomationOccurrenceInsertRace(async () => await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;


        const now = new Date();
        const admitted = await admitAutomationRunTx({
            tx,
            automationId: params.automationId,
            accountId: params.accountId,
            now,
            cause: { kind: "manual", invokedAt: now.getTime() },
            ...(idempotencyKey ? { manualIdempotencyKey: idempotencyKey } : {}),
            ...(params.recipeFeaturePolicy ? { recipeFeaturePolicy: params.recipeFeaturePolicy } : {}),
        });
        if (admitted.kind === "ineligible") {
            if (admitted.reason === "automationNotFound") return null;
            if (admitted.reason === "automationDisabled") throw new AutomationDisabledError();
            throw new AutomationValidationError(`Cannot admit manual Automation Run: ${admitted.reason}`);
        }
        return admitted.run as AutomationRunItem;
    }));
}

type AutomationRunListParams = Readonly<{
    accountId: string;
    limit: number;
    cursor?: string | null;
}> & ({ automationId: string; attention?: "required" } | { automationId?: never; attention: "required" });

type AutomationRunListResult = {
    runs: AutomationRunV3ListItem[];
    nextCursor: string | null;
};
export function listAutomationRuns(params: AutomationRunListParams & { automationId?: never }): Promise<AutomationRunListResult>;
export function listAutomationRuns(params: AutomationRunListParams): Promise<AutomationRunListResult | null>;
export async function listAutomationRuns(params: AutomationRunListParams): Promise<AutomationRunListResult | null> {
    const normalizedLimit = Math.min(
        Math.max(Math.floor(params.limit || 20), 1),
        AUTOMATION_V3_RUN_LIST_MAX_ITEMS,
    );
    if (params.automationId !== undefined) {
        const automationExists = await db.automation.findFirst({
            where: { id: params.automationId, accountId: params.accountId },
            select: { id: true },
        });
        if (!automationExists) return null;
    }

    const rows = await db.automationRun.findMany({
        where: {
            accountId: params.accountId,
            automationId: params.automationId,
            originKind: "automation",
            causeKind: { not: null },
            // Exclude the anchor by identity rather than skipping the first match:
            // its attention state may have changed since the previous page.
            ...(params.cursor ? { id: { not: params.cursor } } : {}),
            ...(params.attention === "required" ? {
                // Accepted managed Runs already belong to the Workflow attention predicate.
                // Before acceptance, ordinary failures must be visible even without a Session.
                workflowAcceptedSnapshotEnvelope: null,
                OR: [
                    { state: { in: ["failed", "dispatch_failed", "outcome_uncertain"] } },
                    { replyHandoffState: "blocked" },
                ],
            } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: normalizedLimit + 1,
        ...(params.cursor
            ? {
                cursor: { id: params.cursor },
            }
            : {}),
        select: automationRunV3ListItemSelect,
    });
    const hasNext = rows.length > normalizedLimit;
    const rawResultRows = hasNext ? rows.slice(0, normalizedLimit) : rows;
    const resultRows: AutomationRunV3ListItem[] = [];
    for (const run of rawResultRows) {
        const state = run.state;
        if (!isAutomationCauseRow(run)) {
            throw new Error("Stored Automation history Run has invalid origin correspondence");
        }
        if (!isAutomationRunState(state)) continue;
        resultRows.push({ ...run, state });
    }
    const nextCursor = hasNext ? rawResultRows[rawResultRows.length - 1]?.id ?? null : null;

    const currentTriggerIds = new Set((await db.automationTrigger.findMany({
        where: {
            id: { in: resultRows.flatMap((run) => run.triggerId ? [run.triggerId] : []) },
            deletedAt: null,
        },
        select: { id: true },
    })).map((trigger) => trigger.id));
    return {
        runs: resultRows.map((run) => ({
            ...run,
            triggerRetired: run.triggerId !== null && !currentTriggerIds.has(run.triggerId),
        })),
        nextCursor,
    };
}

/** Exact Run lookup for authenticated current-version detail reads. */
export async function getAutomationRun(params: {
    accountId: string;
    automationId: string;
    runId: string;
}): Promise<AutomationRunDetailItem | null> {
    const row = await db.automationRun.findFirst({
        where: {
            id: params.runId,
            accountId: params.accountId,
            automationId: params.automationId,
            originKind: "automation",
            causeKind: { not: null },
        },
        select: automationRunDetailSelect,
    });
    if (!row) return null;
    const triggerRetired = row.triggerId === null
        ? false
        : await db.automationTrigger.findFirst({
            where: { id: row.triggerId, deletedAt: null },
            select: { id: true },
        }) === null;
    return { ...row, triggerRetired } as AutomationRunDetailItem;
}
