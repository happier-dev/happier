import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { isPrismaErrorCode } from "@/storage/prisma";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import type {
    AccountEncryptionMigrateAutomationsDirective,
    AccountEncryptionMigrateAutomationsDirectiveInput,
} from "@happier-dev/protocol";
import {
    ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS,
    ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
    AUTOMATION_V3_RUN_LIST_MAX_ITEMS,
    AccountEncryptionMigrateAutomationsDirectiveSchema,
    AutomationEventTriggerDefinitionStoredPayloadV1Schema,
    AutomationSourceSelectorIdV1Schema,
    AutomationOccurrenceEvidenceEqualityTagV1Schema,
    AutomationOccurrenceEvidenceV1Schema,
    AutomationRunResultStoredV1Schema,
    deriveAutomationOccurrenceKeyV1,
    parseAutomationStoredDefinitionExecutionRecipeV1,
    pluginJsonValuesEqual,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    parseAutomationRunFailureDetailStoredEnvelopeV1,
    parseAutomationRunExecutionRecipeV1,
    compilePluginJsonSchema,
    createCanonicalJsonSigningInput,
    isValidPluginJsonSchemaValue,
    validateAutomationEventFilterAgainstPayloadSchemaV1,
    validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1,
    validateAutomationStoredDefinitionExecutionRecipeOuterV1,
    type AutomationRunCause,
    type AutomationDefinitionReconcileRequest,
    type AutomationStoredDefinitionExecutionRecipeV1,
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
import { replaceAutomationAssignmentsTx } from "./automationAssignmentService";
import { ensureAutomationScheduleCursorsTx } from "./automationRunQueueService";
import { admitAutomationRunTx } from "./automationRunAdmissionService";
import { validateExistingSessionAutomationTargetTx } from "./automationExistingSessionValidation";
import { fetchAutomationAccountCurrentnessWitnessTx } from "./automationAccountCurrentness";
import {
    isAutomationDefinitionRepresentableInV2,
    isAutomationRunV2Compatible,
} from "./automationApiProjection";
import {
    automationListItemSelect,
    automationRunDetailSelect,
    automationRunItemSelect,
    automationTriggerSelect,
} from "./automationPersistenceSelect";
import {
    AutomationEventCurrentnessError,
    readCurrentAutomationEventDurablePushWebhookContributionV1,
    resolveCurrentAutomationEventContributionTx,
} from "./automationEventCurrentness";
import { rejoinAutomationOccurrenceInsertRace } from "./automationOccurrencePersistence";
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
    assertAutomationRunFailureDetailEnvelopeOuterForMode,
} from "./automationStoredContentRead";
import {
    decodeAutomationRunCause,
    encodeAutomationRunCause,
} from "./automationRunCauseCodec";
import {
    validateSessionLifecycleExecutionTargetInequality,
    validateSessionLifecycleTriggerRegistrationTx,
} from "./automationSessionLifecycleRegistration";
import {
    AUTOMATION_RUN_REPLY_HANDOFF_TERMINAL_STATES,
    AUTOMATION_RUN_TERMINAL_STATES,
    isAutomationCurrentPatchInput,
    isAutomationCurrentUpsertInput,
    isAutomationLegacyTargetType,
} from "./automationTypes";
import type {
    AutomationLegacyTemplateEnvelopeAdmission,
    AutomationLegacyTargetType,
    AutomationListItem,
    AutomationPatchInput,
    AutomationCurrentUpsertInput,
    AutomationRunDetailItem,
    AutomationRunItem,
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
 * recipe intact, maps only its public target arm to the physical column, and
 * fences the Account and validates the opaque private envelopes against its
 * current mode. The server never opens current-definition content here.
 */
async function normalizeCurrentAutomationDefinitionWriteTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    executionRecipe: AutomationStoredDefinitionExecutionRecipeV1;
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
    const serialized = serializeAutomationStoredDefinitionExecutionRecipeV1(params.executionRecipe);
    if (serialized.kind !== "available") {
        throw new AutomationValidationError("Automation execution recipe is invalid");
    }
    if (serialized.recipe.templateVersion !== params.expectedTemplateVersion) {
        throw new AutomationValidationError(
            "Automation execution recipe version must match the next template version",
        );
    }
    const outer = validateAutomationStoredDefinitionExecutionRecipeOuterV1({
        recipe: serialized.recipe,
        accountCurrentness,
    });
    if (outer.kind !== "available") {
        throw new AutomationValidationError("Automation execution recipe does not match the Account");
    }

    return {
        targetType: toCurrentAutomationDefinitionTargetType(serialized.recipe),
        templateCiphertext: serialized.serialized,
        accountMode: accountCurrentness.mode,
        ...(serialized.recipe.target.kind === "existingSession"
            ? { strictExistingSessionId: serialized.recipe.target.sessionId }
            : {}),
    };
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
 * trigger. The pull arm owns the four watcher columns; the push arm owns the
 * canonical endpoint scalar and leaves every watcher column null.
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
    const observationTarget = transport.kind === "checkpointedPull"
        ? transport.watcherMaterializationRef
        : transport.endpointMaterializationRef;
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
            transport.kind === "checkpointedPull"
                ? "Automation Event declaration does not support checkpointed pull"
                : "Automation Event declaration does not support durable push",
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
    if (transport.kind === "checkpointedPull") {
        return {
            ...base,
            observationTransport: "checkpointedPull",
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
    observationTransport: "checkpointedPull" | "durablePush";
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
        triggerId: params.triggerId,
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
    const watcher = transport.kind === "checkpointedPull"
        ? transport.watcherMaterializationRef
        : transport.endpointMaterializationRef;
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
    if (transport.kind === "checkpointedPull") {
        return {
            sourceSelectorId: params.input.sourceSelectorId,
            sourceContractVersion: params.input.sourceContractVersion,
            observationTransport: "checkpointedPull",
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
    input: AutomationPluginEventWriteInput | null | undefined,
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
    observationTransport: "checkpointedPull" | "durablePush";
    webhookEndpointId: string | null;
    observationStartsAt: Date | null;
    watcherMachineId: string | null;
    watcherMachineInstallationId: string | null;
    watcherPluginId: string | null;
    watcherMaterializationId: string | null;
}> {
    if (event.observationTransport === "checkpointedPull") {
        return {
            observationTransport: "checkpointedPull",
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
            triggerId: params.triggerId,
            triggerRevision: params.triggerRevision,
            triggerKind: "pluginEvent",
            eventRef: params.event.eventRef,
            sourceSelectorId,
        },
        definition,
    }));
}

function readPlainAutomationPluginEventDefinition(
    automation: Pick<AutomationListItem, "id" | "templateVersion">,
    trigger: AutomationTriggerItem,
): ReturnType<typeof AutomationEventTriggerDefinitionStoredPayloadV1Schema.parse> {
    const binding = readAutomationTriggerDefinitionBinding({
        automationId: automation.id,
        triggerId: trigger.id,
        triggerRevision: trigger.revision,
        triggerKind: trigger.kind,
        triggerEventPluginId: trigger.eventPluginId,
        triggerEventLocalId: trigger.eventLocalId,
        triggerSourceSelectorId: trigger.sourceSelectorId,
    });
    if (!binding || trigger.definitionEnvelope === null) {
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
    const parsed = AutomationEventTriggerDefinitionStoredPayloadV1Schema.safeParse(
        opened.definition,
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
    if (transport.kind === "checkpointedPull") {
        return existing.observationTransport === "checkpointedPull"
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
    automation: Pick<AutomationListItem, "id" | "templateVersion">;
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
        const schedule = resolveScheduleDbFields(requested.trigger.schedule);
        return hasSameAutomationScheduleFields(existing, schedule);
    }
    if (requested.trigger.kind === "sessionLifecycle") {
        return existing.sessionLifecycleEvent === requested.trigger.event
            && existing.sourceSessionId === requested.trigger.scope.sourceSessionId
            && existing.sourceTurnId === requested.trigger.scope.sourceTurnId;
    }
    if (
        existing.eventPluginId !== requested.trigger.eventRef.pluginId
        || existing.eventLocalId !== requested.trigger.eventRef.localId
        || existing.sourceContractVersion !== requested.trigger.sourceContractVersion
        || !automationPluginEventCreateTransportMatches(existing, requested.trigger)
        || existing.definitionEnvelope === null
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
    const serialized = serializeAutomationStoredDefinitionExecutionRecipeV1(
        requested.executionRecipe,
    );
    if (serialized.kind !== "available") return false;
    if (
        existing.id !== requested.automationId
        || existing.templateVersion !== 1
        || existing.name !== requested.name
        || existing.description !== (requested.description ?? null)
        || existing.enabled !== requested.enabled
        || existing.targetType !== toCurrentAutomationDefinitionTargetType(serialized.recipe)
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

async function ensureAutomationEventCatalogStateTx(params: Readonly<{
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
            eventPluginId: true,
            eventLocalId: true,
            sourceSelectorId: true,
        },
    });
    const currentKey = current !== null
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

/**
 * A V2 endpoint asks the owner for a released-shape Definition, not merely a
 * schedule trigger. Keep the snapshot columns in conditional mutations so a
 * concurrent V3 replacement cannot be modified after this check.
 */
function v2DefinitionCurrentnessWhere(
    requireV2DefinitionRepresentability: boolean | undefined,
    existing: AutomationListItem,
): Readonly<{
    targetType?: AutomationLegacyTargetType;
    templateCiphertext?: string;
}> {
    if (!requireV2DefinitionRepresentability) return {};
    if (!isAutomationDefinitionRepresentableInV2(existing)) {
        throw new Error("V2 mutation requires a representable Automation Definition");
    }
    return {
        targetType: existing.targetType,
        templateCiphertext: existing.templateCiphertext,
    };
}

export async function loadAutomationTx(
    tx: Tx,
    params: {
        accountId: string;
        automationId: string;
        includeDeleted?: boolean;
        requireV2DefinitionRepresentability?: boolean;
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
    if (
        params.requireV2DefinitionRepresentability
        && !isAutomationDefinitionRepresentableInV2(item)
    ) {
        return null;
    }
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

interface AutomationAccountEncryptionMigrationRow {
    id: string;
    enabled: boolean;
    deletedAt: Date | null;
    targetType: AutomationListItem["targetType"];
    templateCiphertext: string;
    templateVersion: number;
    triggers: ReadonlyArray<{
        id: string;
        kind: AutomationTriggerKind;
        enabled: boolean;
        revision: number;
        deletedAt: Date | null;
        eventPluginId: string | null;
        eventLocalId: string | null;
        sourceSelectorId: string | null;
        definitionEnvelope: string | null;
    }>;
    assignments: ReadonlyArray<{
        machineId: string;
        enabled: boolean;
        updatedAt: Date;
    }>;
}

interface AutomationAccountEncryptionMigrationRunRow {
    id: string;
    automationId: string;
    triggerId: string | null;
    causeKind: AutomationRunItem["causeKind"];
    causeTriggerKind: AutomationRunItem["causeTriggerKind"];
    causeTriggerRevision: number | null;
    causeOccurredAt: Date | null;
    causeEventPluginId: string | null;
    causeEventLocalId: string | null;
    causeScheduledFor: Date | null;
    causeSessionLifecycleEvent: AutomationRunItem["causeSessionLifecycleEvent"];
    causeSourceSessionId: string | null;
    causeSourceTurnId: string | null;
    causeSourceSelectorId: string | null;
    createdAt: Date;
    occurrenceKey: string | null;
    occurrenceEvidenceEqualityTag: string | null;
    triggerEvidenceEnvelope: string | null;
    executionInputEnvelope: string | null;
    resultEnvelope: string | null;
    replyContextEnvelope: string | null;
    replyHandoffReceiptEnvelope: string | null;
    errorMessage: string | null;
    summaryCiphertext: string | null;
    revision: number;
}

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
    resultEnvelope: string | null;
    replyContextEnvelope: string | null;
    replyHandoffReceiptEnvelope: string | null;
    failureDetailEnvelope: string | null;
    summaryCiphertext: string | null;
}>;

export type AutomationAccountEncryptionTransitionRunTargetContent = Readonly<
    Omit<AutomationAccountEncryptionTransitionRunSourceContent, "summaryCiphertext">
>;

export type AutomationAccountEncryptionTransitionInventoryItem =
    | Readonly<{
        kind: "definition";
        automationId: string;
        revision: number;
        source: AutomationAccountEncryptionTransitionDefinitionContent;
    }>
    | Readonly<{
        kind: "run";
        runId: string;
        automationId: string;
        revision: number;
        cause: AutomationRunCause;
        source: AutomationAccountEncryptionTransitionRunSourceContent;
    }>;

export type AutomationAccountEncryptionTransitionStageItem =
    | Readonly<{
        kind: "definition";
        automationId: string;
        expectedRevision: number;
        source: AutomationAccountEncryptionTransitionDefinitionContent;
        target: AutomationAccountEncryptionTransitionDefinitionContent;
    }>
    | Readonly<{
        kind: "run";
        runId: string;
        automationId: string;
        expectedRevision: number;
        cause: AutomationRunCause;
        source: AutomationAccountEncryptionTransitionRunSourceContent;
        target: AutomationAccountEncryptionTransitionRunTargetContent;
    }>;

export type AutomationAccountEncryptionTransitionSourceCursor = Readonly<{
    kind: "definition" | "run";
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
                .filter((trigger) => trigger.kind === "pluginEvent")
                .map((trigger) => ({
                    triggerId: trigger.id,
                    triggerRevision: trigger.revision,
                    envelope: trigger.definitionEnvelope!,
                })),
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

function transitionInventoryRun(
    row: AutomationAccountEncryptionMigrationRunRow,
): Extract<AutomationAccountEncryptionTransitionInventoryItem, { kind: "run" }> {
    return {
        kind: "run",
        runId: row.id,
        automationId: row.automationId,
        revision: row.revision,
        cause: decodeAutomationRunCause(row),
        source: {
            triggerEvidenceEnvelope: row.triggerEvidenceEnvelope,
            occurrenceEvidenceEqualityTag: row.occurrenceEvidenceEqualityTag,
            executionInputEnvelope: row.executionInputEnvelope,
            resultEnvelope: row.resultEnvelope,
            replyContextEnvelope: row.replyContextEnvelope,
            replyHandoffReceiptEnvelope: row.replyHandoffReceiptEnvelope,
            failureDetailEnvelope: currentAutomationRunFailureDetailEnvelope(row),
            summaryCiphertext: row.summaryCiphertext,
        },
    };
}

function transitionInventoryItemEncodedBytes(
    item: AutomationAccountEncryptionTransitionInventoryItem,
): bigint {
    return BigInt(new TextEncoder().encode(JSON.stringify(item)).byteLength);
}

function assertAutomationDefinitionStoredContentForAccountMode(params: Readonly<{
    row: AutomationAccountEncryptionMigrationRow;
    mode: "plain" | "e2ee";
}>): void {
    for (const trigger of params.row.triggers) {
        if (trigger.kind !== "pluginEvent") {
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
        select: {
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
        },
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
    return await tx.automationRun.findMany({
        where: {
            accountId,
            ...(afterId ? { id: { gt: afterId } } : {}),
            OR: [
                { triggerEvidenceEnvelope: { not: null } },
                { occurrenceEvidenceEqualityTag: { not: null } },
                { executionInputEnvelope: { not: null } },
                { resultEnvelope: { not: null } },
                { replyContextEnvelope: { not: null } },
                { replyHandoffReceiptEnvelope: { not: null } },
                { summaryCiphertext: { not: null } },
            ],
        },
        select: {
            id: true,
            automationId: true,
            triggerId: true,
            causeKind: true,
            causeTriggerKind: true,
            causeTriggerRevision: true,
            causeOccurredAt: true,
            causeEventPluginId: true,
            causeEventLocalId: true,
            causeScheduledFor: true,
            causeSessionLifecycleEvent: true,
            causeSourceSessionId: true,
            causeSourceTurnId: true,
            causeSourceSelectorId: true,
            createdAt: true,
            occurrenceKey: true,
            occurrenceEvidenceEqualityTag: true,
            triggerEvidenceEnvelope: true,
            executionInputEnvelope: true,
            resultEnvelope: true,
            replyContextEnvelope: true,
            replyHandoffReceiptEnvelope: true,
            errorMessage: true,
            summaryCiphertext: true,
            revision: true,
        },
        orderBy: { id: "asc" },
        take,
    }) as AutomationAccountEncryptionMigrationRunRow[];
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
    const definitionRows = params.cursor?.kind === "run"
        ? []
        : await loadAutomationAccountEncryptionMigrationDefinitionPageInTx(
            params.tx,
            params.accountId,
            params.cursor?.kind === "definition"
                ? params.cursor.participantId
                : undefined,
            pageLimit + 1,
        );
    const definitions = definitionRows.slice(0, pageLimit);
    const definitionHasMore = definitionRows.length > definitions.length;
    const items: AutomationAccountEncryptionTransitionInventoryItem[] = [];
    try {
        for (const row of definitions) {
            assertAutomationDefinitionStoredContentForAccountMode({
                row,
                mode: params.sourceMode,
            });
            items.push(transitionInventoryDefinition(row));
        }
        if (!definitionHasMore) {
            const remaining = pageLimit - items.length;
            const runRows = await loadAutomationAccountEncryptionMigrationRunPageInTx(
                params.tx,
                params.accountId,
                params.cursor?.kind === "run"
                    ? params.cursor.participantId
                    : undefined,
                remaining + 1,
            );
            const runs = runRows.slice(0, remaining);
            for (const row of runs) {
                assertAutomationRunStoredContentForAccountMode({
                    row,
                    mode: params.sourceMode,
                    content: automationRunMigrationStoredContent(row),
                    allowLegacyResultSource: true,
                });
                items.push(transitionInventoryRun(row));
            }
            const runHasMore = runRows.length > runs.length;
            const lastRun = runs.at(-1);
            const lastDefinition = definitions.at(-1);
            const nextCursor = runHasMore && lastRun
                ? { kind: "run" as const, participantId: lastRun.id }
                : definitionRows.length === pageLimit && lastDefinition && runRows.length > 0
                    ? { kind: "definition" as const, participantId: lastDefinition.id }
                    : undefined;
            return {
                status: "complete",
                page: {
                    items,
                    sourceEncodedBytes: items.reduce(
                        (total, item) => total + transitionInventoryItemEncodedBytes(item),
                        0n,
                    ),
                    runCount: runs.length,
                    ...(nextCursor ? { nextCursor } : {}),
                },
            };
        }
        const last = definitions.at(-1);
        return {
            status: "complete",
            page: {
                items,
                sourceEncodedBytes: items.reduce(
                    (total, item) => total + transitionInventoryItemEncodedBytes(item),
                    0n,
                ),
                runCount: 0,
                ...(last
                    ? { nextCursor: { kind: "definition" as const, participantId: last.id } }
                    : {}),
            },
        };
    } catch (error) {
        if (error instanceof AutomationValidationError) {
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
        triggerRevision: number;
        sourceEnvelope: string;
        targetEnvelope: string;
    }>[];
}>;

type AutomationAccountEncryptionTransitionValidatedRun = Readonly<{
    row: AutomationAccountEncryptionMigrationRunRow;
    item: Extract<AutomationAccountEncryptionTransitionStageItem, { kind: "run" }>;
}>;

type AutomationAccountEncryptionTransitionValidatedStageBatch = Readonly<{
    definitions: readonly AutomationAccountEncryptionTransitionValidatedDefinition[];
    runs: readonly AutomationAccountEncryptionTransitionValidatedRun[];
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
        : `run\u0000${item.runId}`;
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
        && row.automationId === item.automationId
        && row.revision === item.expectedRevision
        && pluginJsonValuesEqual(
            decodeAutomationRunCause(row),
            item.cause,
        )
        && row.triggerEvidenceEnvelope === item.source.triggerEvidenceEnvelope
        && row.occurrenceEvidenceEqualityTag
            === item.source.occurrenceEvidenceEqualityTag
        && row.executionInputEnvelope === item.source.executionInputEnvelope
        && row.resultEnvelope === item.source.resultEnvelope
        && row.replyContextEnvelope === item.source.replyContextEnvelope
        && row.replyHandoffReceiptEnvelope === item.source.replyHandoffReceiptEnvelope
        && currentAutomationRunFailureDetailEnvelope(row)
            === item.source.failureDetailEnvelope
        && row.summaryCiphertext === item.source.summaryCiphertext;
}

function validateAutomationTriggerDefinitionTransitionTargets(params: Readonly<{
    row: AutomationAccountEncryptionMigrationRow;
    item: Extract<AutomationAccountEncryptionTransitionStageItem, { kind: "definition" }>;
    sourceMode: "plain" | "e2ee";
    targetMode: "plain" | "e2ee";
}>): AutomationAccountEncryptionTransitionValidatedDefinition["targetTriggerDefinitionEnvelopes"] {
    const pluginEventTriggers = params.row.triggers.filter(
        (trigger) => trigger.kind === "pluginEvent",
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
        const target = targetsById.get(trigger.id);
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
        select: {
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
        },
    }) as AutomationAccountEncryptionMigrationRow[];
}

async function loadAutomationAccountEncryptionTransitionRunsByIdsInTx(
    tx: Tx,
    accountId: string,
    ids: readonly string[],
): Promise<AutomationAccountEncryptionMigrationRunRow[]> {
    if (ids.length === 0) return [];
    return await tx.automationRun.findMany({
        where: { accountId, id: { in: [...ids] } },
        select: {
            id: true,
            automationId: true,
            triggerId: true,
            causeKind: true,
            causeTriggerKind: true,
            causeTriggerRevision: true,
            causeOccurredAt: true,
            causeEventPluginId: true,
            causeEventLocalId: true,
            causeScheduledFor: true,
            causeSessionLifecycleEvent: true,
            causeSourceSessionId: true,
            causeSourceTurnId: true,
            causeSourceSelectorId: true,
            createdAt: true,
            occurrenceKey: true,
            occurrenceEvidenceEqualityTag: true,
            triggerEvidenceEnvelope: true,
            executionInputEnvelope: true,
            resultEnvelope: true,
            replyContextEnvelope: true,
            replyHandoffReceiptEnvelope: true,
            errorMessage: true,
            summaryCiphertext: true,
            revision: true,
        },
    }) as AutomationAccountEncryptionMigrationRunRow[];
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
    const [definitionRows, runRows, actualSourceMode] = await Promise.all([
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
        readAutomationMigrationSourceModeInTx(params.tx, params.accountId),
    ]);
    if (
        actualSourceMode !== params.fromMode
        || definitionRows.length !== definitions.length
        || runRows.length !== runs.length
    ) {
        return { status: "migration_incomplete" };
    }
    const definitionsById = new Map(
        definitionRows.map((row) => [row.id, row] as const),
    );
    const runsById = new Map(runRows.map((row) => [row.id, row] as const));
    if (
        definitions.some((item) => {
            const row = definitionsById.get(item.automationId);
            return !row || !stageDefinitionSourceMatches(row, item);
        })
        || runs.some((item) => {
            const row = runsById.get(item.runId);
            return !row || !stageRunSourceMatches(row, item);
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
                target,
            });
            await validateExistingSessionAutomationTargetTx({
                tx: params.tx,
                accountId: params.accountId,
                targetType: row.targetType,
                accountMode: params.toMode,
                ...(target.kind === "strict"
                    ? { strictExistingSessionId: target.strictExistingSessionId }
                    : {
                        templateCiphertext: item.target.templateCiphertext,
                        legacyExistingSessionId:
                            target.legacyTemplateEnvelopeAdmission?.existingSessionId,
                    }),
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
            assertAutomationRunStoredContentForAccountMode({
                row,
                mode: params.fromMode,
                content: automationRunMigrationStoredContent(row),
                allowLegacyResultSource: true,
            });
            assertAutomationRunOptionalContentNullnessPreserved({
                source: automationRunMigrationStoredContent(row),
                target: item.target,
            });
            assertAutomationRunStoredContentForAccountMode({
                row,
                mode: params.toMode,
                content: item.target,
            });
            validatedRuns.push({ row, item });
        }
        return {
            status: "validated",
            batch: { definitions: validatedDefinitions, runs: validatedRuns },
        };
    } catch (error) {
        if (error instanceof AutomationValidationError) {
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
                    kind: "pluginEvent",
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
        const updated = await params.tx.automationRun.updateMany({
            where: {
                id: candidate.row.id,
                accountId: params.accountId,
                revision: candidate.item.expectedRevision,
                ...encodeAutomationRunCause(candidate.item.cause),
            },
            data: {
                triggerEvidenceEnvelope: candidate.item.target.triggerEvidenceEnvelope,
                occurrenceEvidenceEqualityTag:
                    candidate.item.target.occurrenceEvidenceEqualityTag,
                executionInputEnvelope: candidate.item.target.executionInputEnvelope,
                resultEnvelope: candidate.item.target.resultEnvelope,
                replyContextEnvelope: candidate.item.target.replyContextEnvelope,
                replyHandoffReceiptEnvelope:
                    candidate.item.target.replyHandoffReceiptEnvelope,
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
        const cursor = await markAutomationChangedTx(params.tx, {
            accountId: params.accountId,
            automationId: candidate.row.automationId,
        });
        afterTx(params.tx, () => {
            emitAutomationRunUpdated({
                accountId: params.accountId,
                run: run as AutomationRunItem,
                cursor,
            });
        });
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
        select: {
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
        },
        orderBy: { id: "asc" },
    });
}

async function loadAutomationAccountEncryptionMigrationRunsInTx(
    tx: Tx,
    accountId: string,
): Promise<AutomationAccountEncryptionMigrationRunRow[]> {
    return await tx.automationRun.findMany({
        where: {
            accountId,
            OR: [
                { triggerEvidenceEnvelope: { not: null } },
                { occurrenceEvidenceEqualityTag: { not: null } },
                { executionInputEnvelope: { not: null } },
                { resultEnvelope: { not: null } },
                { replyContextEnvelope: { not: null } },
                { replyHandoffReceiptEnvelope: { not: null } },
                { summaryCiphertext: { not: null } },
            ],
        },
        select: {
            id: true,
            automationId: true,
            triggerId: true,
            causeKind: true,
            causeTriggerKind: true,
            causeTriggerRevision: true,
            causeOccurredAt: true,
            causeEventPluginId: true,
            causeEventLocalId: true,
            causeScheduledFor: true,
            causeSessionLifecycleEvent: true,
            causeSourceSessionId: true,
            causeSourceTurnId: true,
            causeSourceSelectorId: true,
            createdAt: true,
            occurrenceKey: true,
            occurrenceEvidenceEqualityTag: true,
            triggerEvidenceEnvelope: true,
            executionInputEnvelope: true,
            resultEnvelope: true,
            replyContextEnvelope: true,
            replyHandoffReceiptEnvelope: true,
            errorMessage: true,
            summaryCiphertext: true,
            revision: true,
        },
        orderBy: { id: "asc" },
    }) as AutomationAccountEncryptionMigrationRunRow[];
}

type AutomationAccountEncryptionMigrationTemplateItem = Extract<
    AccountEncryptionMigrateAutomationsDirective,
    { action: "migrate" }
>["templates"][number];

function readAutomationMigrationTriggerDefinitionTargets(
    item: AutomationAccountEncryptionMigrationTemplateItem,
): NonNullable<AutomationAccountEncryptionMigrationTemplateItem["triggerDefinitionEnvelopes"]> {
    // Older signed migration requests predate Event trigger-definition
    // replacement. Omission means the caller submitted zero replacements; it
    // must remain byte-distinct from a synthesized member at the Protocol seam.
    return item.triggerDefinitionEnvelopes ?? [];
}

function migrationItemMatchesTriggerDefinitionPostState(
    row: AutomationAccountEncryptionMigrationRow,
    item: AutomationAccountEncryptionMigrationTemplateItem,
): boolean {
    return pluginJsonValuesEqual(
        transitionInventoryDefinition(row).source.triggerDefinitionEnvelopes,
        readAutomationMigrationTriggerDefinitionTargets(item),
    );
}

function hasCompleteTriggerDefinitionMigrationTarget(
    row: AutomationAccountEncryptionMigrationRow,
    item: AutomationAccountEncryptionMigrationTemplateItem,
): boolean {
    const eventTriggers = row.triggers.filter((trigger) => trigger.kind === "pluginEvent");
    const targets = readAutomationMigrationTriggerDefinitionTargets(item);
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
}>): readonly Readonly<{
    triggerId: string;
    triggerRevision: number;
    sourceEnvelope: string;
    targetEnvelope: string;
}>[] {
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
                    readAutomationMigrationTriggerDefinitionTargets(params.item),
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
                    readAutomationMigrationTriggerDefinitionTargets(params.item),
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
                || item.replyHandoffReceiptEnvelope
                    !== row.replyHandoffReceiptEnvelope
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
    | "resultEnvelope"
    | "replyContextEnvelope"
    | "replyHandoffReceiptEnvelope"
> & Readonly<{ failureDetailEnvelope: string | null }>;

function automationRunMigrationStoredContent(
    row: AutomationAccountEncryptionMigrationRunRow,
): AutomationAccountEncryptionMigrationRunStoredContent {
    return {
        triggerEvidenceEnvelope: row.triggerEvidenceEnvelope,
        occurrenceEvidenceEqualityTag: row.occurrenceEvidenceEqualityTag,
        executionInputEnvelope: row.executionInputEnvelope,
        resultEnvelope: row.resultEnvelope,
        replyContextEnvelope: row.replyContextEnvelope,
        replyHandoffReceiptEnvelope: row.replyHandoffReceiptEnvelope,
        failureDetailEnvelope: currentAutomationRunFailureDetailEnvelope(row),
    };
}

function assertAutomationRunOptionalContentNullnessPreserved(params: Readonly<{
    source: AutomationAccountEncryptionMigrationRunStoredContent;
    target: AutomationAccountEncryptionMigrationRunStoredContent;
}>): void {
    for (const field of [
        "executionInputEnvelope",
        "resultEnvelope",
        "replyContextEnvelope",
        "replyHandoffReceiptEnvelope",
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
    content: "result" | "replyContext" | "receipt";
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
    let resultEnvelope: unknown;
    try {
        resultEnvelope = JSON.parse(row.resultEnvelope);
    } catch {
        throw new AutomationValidationError(
            "Run legacy summary result source is not valid JSON",
        );
    }
    const parsed = AutomationRunResultStoredV1Schema.safeParse(resultEnvelope);
    if (
        !parsed.success
        || parsed.data.t !== "legacySummaryCiphertext"
        || parsed.data.c !== row.summaryCiphertext
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
    allowLegacyResultSource?: boolean;
}>): void {
    if (
        params.allowLegacyResultSource === true
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
            const evidence = AutomationOccurrenceEvidenceV1Schema.safeParse(
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
    assertAutomationReplyHandoffStoredEnvelopeForAccountMode({
        content: "receipt",
        raw: params.content.replyHandoffReceiptEnvelope,
        mode: params.mode,
    });
    try {
        assertAutomationRunFailureDetailEnvelopeOuterForMode({
            raw: params.content.failureDetailEnvelope,
            mode: params.mode,
        });
    } catch (error) {
        if (error instanceof AutomationStoredContentReadError) {
            throw new AutomationValidationError(
                "Run failure detail does not match the Account mode",
            );
        }
        throw error;
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
        recipe: AutomationRunExecutionRecipeV1;
        strictExistingSessionId?: string;
    }>
    | Readonly<{
        kind: "legacy";
        legacyTemplateEnvelopeAdmission?: AutomationLegacyTemplateEnvelopeAdmission;
    }>;

/** Definitions have no occurrence evidence; that immutable fact belongs only to Runs. */
function assertStrictAutomationDefinitionMigrationRecipe(
    recipe: AutomationRunExecutionRecipeV1,
): void {
    if (recipe.triggerEvidence !== null) {
        throw new AutomationValidationError(
            "Strict Automation Definition migration recipes must not carry trigger evidence",
        );
    }
}

function assertStrictAutomationMigrationRecipeMode(params: Readonly<{
    recipe: AutomationRunExecutionRecipeV1;
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
    target: AutomationMigrationTemplateClassification;
}>): void {
    const source = parseAutomationStoredDefinitionExecutionRecipeV1(
        params.row.templateCiphertext,
    );
    if (params.target.kind === "legacy") {
        if (source.kind === "available") {
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
        await loadAutomationAccountEncryptionMigrationRunsInTx(
            params.tx,
            params.accountId,
        );

    if (directive.action === "assert_empty") {
        return rows.length === 0 && runRows.length === 0
            ? { status: "applied" }
            : { status: "not_empty" };
    }
    if (directive.action === "clear") {
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
    // Keep the migration owner compatible with existing signed directives
    // whose wire shape predates the retained-Run inventory and therefore has
    // no `runs` member.
    const directiveRuns = directive.runs ?? [];
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
        row.triggers.some((trigger) => trigger.kind === "pluginEvent"))
        || runRows.length > 0;
    const targetTriggerDefinitionsById = new Map<string, ReturnType<
        typeof validateAutomationTriggerDefinitionMigrationCandidate
    >>();
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
                    : {
                        templateCiphertext: item.templateCiphertext,
                        legacyExistingSessionId:
                            template.legacyTemplateEnvelopeAdmission?.existingSessionId,
                    }),
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
                assertAutomationRunStoredContentForAccountMode({
                    row,
                    mode: sourceMode!,
                    content: automationRunMigrationStoredContent(row),
                    allowLegacyResultSource: true,
                });
                assertAutomationRunOptionalContentNullnessPreserved({
                    source: automationRunMigrationStoredContent(row),
                    target: item,
                });
                assertAutomationRunStoredContentForAccountMode({
                    row,
                    mode: params.toMode,
                    content: item,
                });
            }
        }
    } catch (error) {
        if (error instanceof AutomationValidationError) {
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
                    kind: "pluginEvent",
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
        const updated = await params.tx.automationRun.updateMany({
            where: {
                id: row.id,
                accountId: params.accountId,
                revision: item.expectedRunRevision,
                ...encodeAutomationRunCause(decodeAutomationRunCause(row)),
            },
            data: {
                triggerEvidenceEnvelope: item.triggerEvidenceEnvelope,
                occurrenceEvidenceEqualityTag:
                    item.occurrenceEvidenceEqualityTag,
                executionInputEnvelope: item.executionInputEnvelope,
                resultEnvelope: item.resultEnvelope,
                replyContextEnvelope: item.replyContextEnvelope,
                replyHandoffReceiptEnvelope:
                    item.replyHandoffReceiptEnvelope,
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
        const cursor = await markAutomationChangedTx(params.tx, {
            accountId: params.accountId,
            automationId: row.automationId,
        });
        afterTx(params.tx, () => {
            emitAutomationRunUpdated({
                accountId: params.accountId,
                run: run as AutomationRunItem,
                cursor,
            });
        });
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
        await loadAutomationAccountEncryptionMigrationRunsInTx(
            params.tx,
            params.accountId,
        );
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
    // See the matching migration normalizer above. Existing signed directives
    // may omit this newly additive inventory.
    const directiveRuns = directive.runs ?? [];
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
                    : {
                        templateCiphertext: row.templateCiphertext,
                        legacyExistingSessionId:
                            template.legacyTemplateEnvelopeAdmission?.existingSessionId,
                    }),
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
            if (
                item.triggerEvidenceEnvelope !== row.triggerEvidenceEnvelope
                || item.occurrenceEvidenceEqualityTag
                    !== row.occurrenceEvidenceEqualityTag
                || item.executionInputEnvelope !== row.executionInputEnvelope
                || item.resultEnvelope !== row.resultEnvelope
                || item.replyContextEnvelope !== row.replyContextEnvelope
                || item.replyHandoffReceiptEnvelope
                    !== row.replyHandoffReceiptEnvelope
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

async function markAutomationChangedTx(tx: Tx, params: { accountId: string; automationId: string }): Promise<number> {
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
    };
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
        const cleared = await tx.automationRun.deleteMany({
            where: {
                accountId: params.accountId,
                automationId: automation.id,
                ...automationRunCustodyTerminalWhere(),
            },
        });
        if (cleared.count > 0) {
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
        return { status: "cleared", clearedRuns: cleared.count };
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
    sessionLifecycleEvent: null,
    sourceSessionId: null,
    sourceTurnId: null,
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
        "id" | "targetType" | "templateCiphertext">;
    triggerId: string;
    triggerRevision: number;
    input: AutomationTriggerDefinitionInput;
    serverIdentityId: string | null;
    now: Date;
    existing?: AutomationTriggerItem | null;
}>): Promise<NormalizedAutomationTriggerWrite> {
    const common = {
        enabled: params.input.enabled,
        deletedAt: null,
        ...AUTOMATION_TRIGGER_KIND_FIELDS_CLEARED,
    } as const;

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
                nextRunAt: unchangedSchedule
                    ? params.existing?.nextRunAt ?? null
                    : null,
            },
        };
    }

    if (params.input.kind === "sessionLifecycle") {
        const retainsExactRegistration = params.existing?.kind === "sessionLifecycle"
            && params.existing.sessionLifecycleEvent === params.input.event
            && params.existing.sourceSessionId === params.input.scope.sourceSessionId
            && params.existing.sourceTurnId === params.input.scope.sourceTurnId;
        const mustRegister = !retainsExactRegistration
            || (params.existing?.enabled === false && params.input.enabled);
        const lifecycle = mustRegister
            ? await validateSessionLifecycleTriggerRegistrationTx({
                tx: params.tx,
                accountId: params.accountId,
                automationTargetType: params.automation.targetType,
                automationExistingSessionId:
                    readAutomationExistingSessionTargetId(params.automation),
                input: params.input,
            })
            : {
                sessionLifecycleEvent: params.input.event,
                sourceSessionId: params.input.scope.sourceSessionId,
                sourceTurnId: params.input.scope.sourceTurnId,
            };
        return {
            isEvent: false,
            data: {
                ...common,
                kind: "sessionLifecycle",
                sessionLifecycleEvent: lifecycle.sessionLifecycleEvent,
                sourceSessionId: lifecycle.sourceSessionId,
                sourceTurnId: lifecycle.sourceTurnId,
            },
        };
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

function emitAutomationMutationAfterTx(params: Readonly<{
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
    requireV2DefinitionRepresentability?: boolean;
}): Promise<AutomationListItem[]> {
    const rows = await db.automation.findMany({
        where: {
            accountId: params.accountId,
            deletedAt: null,
        },
        select: automationListItemSelect,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });

    const items = rows as AutomationListItem[];
    return params.requireV2DefinitionRepresentability
        ? items.filter(isAutomationDefinitionRepresentableInV2)
        : items;
}

export async function getAutomation(params: {
    accountId: string;
    automationId: string;
    requireV2DefinitionRepresentability?: boolean;
}): Promise<AutomationListItem | null> {
    return await inTx(async (tx) => {
        return await loadAutomationTx(tx, params);
    });
}

export async function createAutomation(params: {
    accountId: string;
    input: AutomationUpsertInput;
    requireV2DefinitionRepresentability?: boolean;
}): Promise<AutomationListItem> {
    const triggerInputs: readonly AutomationTriggerCreateRequest[] =
        isAutomationCurrentUpsertInput(params.input)
            ? params.input.triggers
            : [{
                triggerId: randomUUID(),
                trigger: {
                    kind: "schedule",
                    enabled: true,
                    schedule: params.input.schedule.kind === "interval"
                        ? {
                            kind: "interval",
                            scheduleExpr: null,
                            everyMs: params.input.schedule.everyMs,
                            timezone: params.input.schedule.timezone ?? null,
                        }
                        : {
                            kind: "cron",
                            scheduleExpr: params.input.schedule.scheduleExpr,
                            everyMs: null,
                            timezone: params.input.schedule.timezone ?? null,
                        },
                },
            }];
    // Durable-push correspondence is resolved against this host's server
    // identity; acquiring it must not nest inside the definition transaction.
    const durablePushEvent = triggerInputs.find(({ trigger }) =>
        trigger.kind === "pluginEvent"
        && trigger.observationTransport.kind === "durablePush",
    );
    const serverIdentityId = await resolveAutomationDurablePushServerIdentityId(
        durablePushEvent?.trigger.kind === "pluginEvent" ? durablePushEvent.trigger : null,
    );
    const create = async () => await inTx(async (tx) => {
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
            if (params.requireV2DefinitionRepresentability) {
                throw new AutomationValidationError("V2 create requires a representable Automation Definition");
            }
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
                },
                triggerId,
                triggerRevision: 0,
                input,
                serverIdentityId,
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
    });
    try {
        return await create();
    } catch (error) {
        if (!isAutomationCurrentUpsertInput(params.input) || !isPrismaErrorCode(error, "P2002")) {
            throw error;
        }
        const rejoined = await inTx(async (tx) => await tryRejoinAutomationCreateTx({
            tx,
            accountId: params.accountId,
            input: params.input,
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

export async function updateAutomation(params: {
    accountId: string;
    automationId: string;
    input: AutomationPatchInput;
    requireV2DefinitionRepresentability?: boolean;
    expectedTemplateVersion?: number;
}): Promise<AutomationListItem | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;
        const existing = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
            requireV2DefinitionRepresentability:
                params.requireV2DefinitionRepresentability,
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
        const currentDefinition = isAutomationCurrentPatchInput(params.input)
            ? await normalizeCurrentAutomationDefinitionWriteTx({
                tx,
                accountId: params.accountId,
                executionRecipe: params.input.executionRecipe,
                expectedTemplateVersion: existing.templateVersion + 1,
            })
            : null;
        const effectiveTargetType = currentDefinition?.targetType
            ?? legacyInput?.targetType
            ?? existing.targetType;
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
        let accountMode: "e2ee" | "plain" | undefined = currentDefinition?.accountMode;
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
        }

        await validateExistingSessionAutomationTargetTx({
            tx,
            accountId: params.accountId,
            targetType: effectiveTargetType,
            templateCiphertext: effectiveTemplateCiphertext,
            ...(accountMode ? { accountMode } : {}),
            ...(currentDefinition?.strictExistingSessionId
                ? { strictExistingSessionId: currentDefinition.strictExistingSessionId }
                : {}),
            ...(effectiveLegacyTemplateEnvelopeAdmission
                ? {
                    legacyExistingSessionId:
                        effectiveLegacyTemplateEnvelopeAdmission.existingSessionId,
                }
                : {}),
        });
        const effectiveExistingSessionId = currentDefinition?.strictExistingSessionId
            ?? (effectiveTargetType === "existing_session"
                ? readAutomationExistingSessionTargetId({
                    targetType: effectiveTargetType,
                    templateCiphertext: effectiveTemplateCiphertext,
                })
                : null);
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
        const targetTypeChanged =
            inputSuppliesTarget
            && effectiveTargetType !== existing.targetType;
        const templateSemanticsWritten =
            inputSuppliesTemplate || targetTypeChanged;
        const observationBoundaryNow = new Date();
        const automationUpdate = {
            updatedAt: observationBoundaryNow,
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
                    ...v2DefinitionCurrentnessWhere(
                        params.requireV2DefinitionRepresentability,
                        existing,
                    ),
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
                    ...v2DefinitionCurrentnessWhere(
                        params.requireV2DefinitionRepresentability,
                        existing,
                    ),
                },
                data: automationUpdate,
            });
            if (updated.count !== 1) {
                return null;
            }
        }

        let scheduleChanged = false;
        if (schedule) {
            if (!isAutomationDefinitionRepresentableInV2(existing)) {
                throw new AutomationTemplateMutationConflictError();
            }
            const trigger = existing.triggers[0]!;
            const fields = resolveScheduleDbFields(schedule);
            scheduleChanged = !hasSameAutomationScheduleFields(trigger, fields);
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
            // Assignment replacement has no Definition update of its own. A
            // V2 caller must therefore recheck the same Definition snapshot
            // immediately before changing its assignments, or a concurrent
            // strict V3 replacement could receive a legacy assignment write.
            if (params.requireV2DefinitionRepresentability) {
                const currentDefinition = await tx.automation.findFirst({
                    where: {
                        id: existing.id,
                        accountId: params.accountId,
                        deletedAt: null,
                        ...v2DefinitionCurrentnessWhere(
                            params.requireV2DefinitionRepresentability,
                            existing,
                        ),
                    },
                    select: { id: true },
                });
                if (!currentDefinition) {
                    throw new AutomationTemplateMutationConflictError();
                }
            }
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
            requireV2DefinitionRepresentability:
                params.requireV2DefinitionRepresentability,
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
            const witness = retained.get(trigger.id) ?? removed.get(trigger.id);
            if (!witness || witness.expectedRevision !== trigger.revision) {
                throw new AutomationTriggerMutationConflictError();
            }
        }

        const currentDefinition = params.input.executionRecipe
            ? await normalizeCurrentAutomationDefinitionWriteTx({
                tx,
                accountId: params.accountId,
                executionRecipe: params.input.executionRecipe,
                expectedTemplateVersion: existing.templateVersion + 1,
            })
            : null;
        const effectiveAutomation: AutomationListItem = currentDefinition
            ? {
                ...existing,
                targetType: currentDefinition.targetType,
                templateCiphertext: currentDefinition.templateCiphertext,
                templateVersion: existing.templateVersion + 1,
            }
            : existing;
        const effectiveExistingSessionId = currentDefinition?.strictExistingSessionId
            ?? readAutomationExistingSessionTargetId(effectiveAutomation);
        await validateExistingSessionAutomationTargetTx({
            tx,
            accountId: params.accountId,
            targetType: effectiveAutomation.targetType,
            templateCiphertext: effectiveAutomation.templateCiphertext,
            ...(currentDefinition ? { accountMode: currentDefinition.accountMode } : {}),
            ...(effectiveExistingSessionId ? { strictExistingSessionId: effectiveExistingSessionId } : {}),
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
                ...(currentDefinition ? {
                    targetType: currentDefinition.targetType,
                    templateCiphertext: currentDefinition.templateCiphertext,
                    templateVersion: { increment: 1 },
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
                eventProjectionChanged ||= existing.enabled && trigger.enabled;
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
                && hasSameAutomationScheduleFields(trigger, resolveScheduleDbFields(item.trigger.schedule));
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
                            kind: "sessionLifecycle",
                            enabled: true,
                            event: "parentTurnCompleted",
                            scope: {
                                kind: "exactTurn",
                                sourceSessionId: trigger.sourceSessionId!,
                                sourceTurnId: trigger.sourceTurnId!,
                            },
                            consumption: "once",
                        },
                    });
                }
                if (trigger.kind === "pluginEvent") {
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
                                binding: {
                                    v: 1,
                                    automationId: existing.id,
                                    triggerId: trigger.id,
                                    triggerRevision: nextRevision,
                                    triggerKind: "pluginEvent",
                                    eventRef: {
                                        pluginId: trigger.eventPluginId!,
                                        localId: trigger.eventLocalId!,
                                    },
                                    sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(trigger.sourceSelectorId),
                                },
                                definition: readPlainAutomationPluginEventDefinition(existing, trigger),
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
        await tx.automation.update({
            where: { id: automation.id },
            data: { updatedAt: now },
        });
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
                const fields = resolveScheduleDbFields(params.trigger.schedule);
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
                        kind: "sessionLifecycle",
                        enabled: true,
                        event: "parentTurnCompleted",
                        scope: {
                            kind: "exactTurn",
                            sourceSessionId: existing.sourceSessionId!,
                            sourceTurnId: existing.sourceTurnId!,
                        },
                        consumption: "once",
                    },
                });
            }
            data = {
                enabled: resolvedNextEnabled,
                revision: nextRevision,
                updatedAt: now,
                ...(!resolvedNextEnabled ? { nextRunAt: null } : {}),
            };
            if (existing.kind === "pluginEvent") {
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
                    const definition = readPlainAutomationPluginEventDefinition(
                        automation,
                        existing,
                    );
                    data.definitionEnvelope = JSON.stringify(
                        sealAutomationTriggerDefinitionStoredEnvelopeV1({
                            mode: "plain",
                            binding: {
                                v: 1,
                                automationId: automation.id,
                                triggerId: existing.id,
                                triggerRevision: nextRevision,
                                triggerKind: "pluginEvent",
                                eventRef: {
                                    pluginId: existing.eventPluginId!,
                                    localId: existing.eventLocalId!,
                                },
                                sourceSelectorId: existing.sourceSelectorId!,
                            },
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
        await tx.automation.update({
            where: { id: automation.id },
            data: { updatedAt: now },
        });
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
        await tx.automation.update({
            where: { id: automation.id },
            data: { updatedAt: now },
        });
        if (existing.kind === "pluginEvent") {
            await ensureAutomationEventCatalogStateTx({
                tx,
                accountId: params.accountId,
                projectionChanged: automation.enabled && existing.enabled,
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
    requireV2DefinitionRepresentability?: boolean;
}): Promise<boolean> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return false;
        const existing = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
            requireV2DefinitionRepresentability:
                params.requireV2DefinitionRepresentability,
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
                ...v2DefinitionCurrentnessWhere(
                    params.requireV2DefinitionRepresentability,
                    existing,
                ),
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
                projectionChanged: existing.enabled,
            });
        }

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
    });
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
    requireV2DefinitionRepresentability?: boolean;
}): Promise<AutomationListItem | null> {
    return await updateAutomation({
        accountId: params.accountId,
        automationId: params.automationId,
        input: { enabled: params.enabled },
        requireV2DefinitionRepresentability:
            params.requireV2DefinitionRepresentability,
    });
}

export async function runAutomationNow(params: {
    accountId: string;
    automationId: string;
    idempotencyKey?: string;
    requireV2DefinitionRepresentability?: boolean;
}): Promise<AutomationRunItem | null> {
    const idempotencyKey = params.idempotencyKey?.trim();
    if (params.idempotencyKey !== undefined && !idempotencyKey) {
        throw new AutomationValidationError("Idempotency-Key must not be empty");
    }
    return await rejoinAutomationOccurrenceInsertRace(async () => await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;
        if (params.requireV2DefinitionRepresentability) {
            const representable = await loadAutomationTx(tx, {
                accountId: params.accountId,
                automationId: params.automationId,
                requireV2DefinitionRepresentability: true,
            });
            if (!representable) return null;
        }

        const now = new Date();
        const admitted = await admitAutomationRunTx({
            tx,
            automationId: params.automationId,
            accountId: params.accountId,
            now,
            cause: { kind: "manual", invokedAt: now.getTime() },
            ...(idempotencyKey ? { manualIdempotencyKey: idempotencyKey } : {}),
        });
        if (admitted.kind === "ineligible") {
            if (admitted.reason === "automationNotFound") return null;
            if (admitted.reason === "automationDisabled") throw new AutomationDisabledError();
            throw new AutomationValidationError(`Cannot admit manual Automation Run: ${admitted.reason}`);
        }
        return admitted.run as AutomationRunItem;
    }));
}

export async function listAutomationRuns(params: {
    accountId: string;
    automationId: string;
    limit: number;
    cursor?: string | null;
    requireV2DefinitionRepresentability?: boolean;
    requireV2RunRepresentability?: boolean;
}): Promise<{ runs: AutomationRunItem[]; nextCursor: string | null } | null> {
    if (params.requireV2DefinitionRepresentability) {
        const automation = await getAutomation({
            accountId: params.accountId,
            automationId: params.automationId,
            requireV2DefinitionRepresentability: true,
        });
        if (!automation) return null;
    }
    const normalizedLimit = Math.min(
        Math.max(Math.floor(params.limit || 20), 1),
        AUTOMATION_V3_RUN_LIST_MAX_ITEMS,
    );
    const readRows = async (client: Tx, cursor?: string | null, take = normalizedLimit + 1) => await client.automationRun.findMany({
        where: {
            accountId: params.accountId,
            automationId: params.automationId,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        ...(cursor
            ? {
                cursor: { id: cursor },
                skip: 1,
            }
            : {}),
        select: automationRunItemSelect,
    });
    const rows = params.requireV2RunRepresentability
        ? await inTx(async (tx) => {
            const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
            if (accountFence.status !== "ready") return [];
            const automationExists = await tx.automation.findFirst({
                where: {
                    id: params.automationId,
                    accountId: params.accountId,
                },
                select: { id: true },
            });
            if (!automationExists) return null;

            const representable = [] as Awaited<ReturnType<typeof readRows>>;
            const scanSize = Math.max(50, (normalizedLimit + 1) * 2);
            let scanCursor = params.cursor;
            while (representable.length <= normalizedLimit) {
                const candidates = await readRows(tx, scanCursor, scanSize);
                for (const run of candidates) {
                    if (isAutomationRunV2Compatible(run as AutomationRunItem)) {
                        representable.push(run);
                        if (representable.length > normalizedLimit) break;
                    }
                }
                if (representable.length > normalizedLimit || candidates.length < scanSize) break;
                scanCursor = candidates[candidates.length - 1]?.id;
                if (!scanCursor) break;
            }
            return representable;
        })
        : await db.automationRun.findMany({
            where: {
                accountId: params.accountId,
                automationId: params.automationId,
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: normalizedLimit + 1,
            ...(params.cursor
                ? {
                    cursor: { id: params.cursor },
                    skip: 1,
                }
                : {}),
            select: automationRunItemSelect,
        });

    if (rows === null) return null;
    const hasNext = rows.length > normalizedLimit;
    const resultRows = hasNext ? rows.slice(0, normalizedLimit) : rows;
    const nextCursor = hasNext ? resultRows[resultRows.length - 1]?.id ?? null : null;

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
        })) as AutomationRunItem[],
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
