import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
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
    AccountEncryptionMigrateAutomationsDirectiveSchema,
    AutomationEventTriggerDefinitionStoredPayloadV1Schema,
    AutomationSourceSelectorIdV1Schema,
    MAX_ENABLED_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_ACCOUNT,
    AutomationOccurrenceEvidenceEqualityTagV1Schema,
    AutomationOccurrenceEvidenceV1Schema,
    AutomationRunResultStoredV1Schema,
    deriveAutomationOccurrenceKeyV1,
    deriveAutomationManualOccurrenceKeyV1,
    parseAutomationRunExecutionRecipeV1,
    serializeAutomationRunExecutionRecipeV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
    validateAutomationEventFilterAgainstPayloadSchemaV1,
    validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1,
    validateAutomationRunExecutionRecipeOuterV1,
    type AutomationRunExecutionRecipeV1,
} from "@happier-dev/protocol";

import {
    emitAutomationAssignmentUpdated,
    emitAutomationDelete,
    emitAutomationRunTransition,
    emitAutomationRunUpdated,
    emitAutomationRunUpdatedToMachineOnly,
    emitAutomationUpsert,
} from "./automationChangePublisher";
import { replaceAutomationAssignmentsTx } from "./automationAssignmentService";
import { enqueueImmediateRunTx, enqueueNextScheduledRunIfMissingTx, resolveScheduledRunDueAt } from "./automationRunQueueService";
import { cancelQueuedAutomationRunsTx } from "./automationRunService";
import { validateExistingSessionAutomationTargetTx } from "./automationExistingSessionValidation";
import { fetchAutomationAccountCurrentnessWitnessTx } from "./automationAccountCurrentness";
import { isAutomationDefinitionRepresentableInV2 } from "./automationApiProjection";
import { automationListItemSelect, automationRunItemSelect } from "./automationPersistenceSelect";
import {
    findAutomationOccurrenceTx,
    rejoinAutomationOccurrenceInsertRace,
} from "./automationOccurrencePersistence";
import {
    AutomationEventCurrentnessError,
    resolveCurrentAutomationEventContributionTx,
} from "./automationEventCurrentness";
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
    validateRetainedAutomationRunExecutionInputV2OuterForMode,
    validateAutomationStoredContentEnvelopeOuterForMode,
    validateAutomationTriggerDefinitionEnvelopeOuterForMode,
} from "./automationStoredContentRead";
import {
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
    AutomationRunItem,
    AutomationRunOriginKind,
    AutomationScheduleKind,
    AutomationScheduleInput,
    AutomationTriggerKind,
    AutomationUpsertInput,
} from "./automationTypes";

const AUTOMATION_DISABLE_CANCELLABLE_RUN_ORIGINS: readonly AutomationRunOriginKind[] = [
    "scheduled",
    "manual",
    "pluginEvent",
    "conversation",
];

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
    accountMode: "plain";
    strictExistingSessionId?: string;
}>;

function toCurrentAutomationDefinitionTargetType(
    recipe: AutomationRunExecutionRecipeV1,
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
 * fences the Account before accepting the plaintext-only current authoring
 * contract. E2EE current authoring remains intentionally unavailable until
 * the adopted stored-definition lookup/crypto owner lands.
 */
async function normalizeCurrentAutomationDefinitionWriteTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    executionRecipe: AutomationRunExecutionRecipeV1;
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
    if (accountCurrentness.mode !== "plain") {
        throw new AutomationStoredContentReadError("modeMismatch");
    }

    const serialized = serializeAutomationRunExecutionRecipeV1(params.executionRecipe);
    if (serialized.kind !== "available") {
        throw new AutomationValidationError("Automation execution recipe is invalid");
    }
    if (serialized.recipe.templateVersion !== params.expectedTemplateVersion) {
        throw new AutomationValidationError(
            "Automation execution recipe version must match the next template version",
        );
    }
    const outer = validateAutomationRunExecutionRecipeOuterV1({
        recipe: serialized.recipe,
        accountCurrentness,
    });
    if (outer.kind !== "available") {
        throw new AutomationValidationError("Automation execution recipe does not match the Account");
    }

    return {
        targetType: toCurrentAutomationDefinitionTargetType(serialized.recipe),
        templateCiphertext: serialized.serialized,
        accountMode: "plain",
        ...(serialized.recipe.target.kind === "existingSession"
            ? { strictExistingSessionId: serialized.recipe.target.sessionId }
            : {}),
    };
}

function resolveScheduleDbFields(schedule: AutomationScheduleInput): Readonly<{
    scheduleKind: "cron" | "interval";
    scheduleExpr: string | null;
    everyMs: number | null;
    timezone: string | null;
}> {
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

type AutomationPluginEventWriteInput = NonNullable<
    AutomationCurrentUpsertInput["pluginEvent"]
>;

type NormalizedAutomationPluginEventWrite = Readonly<{
    eventRef: AutomationPluginEventWriteInput["eventRef"];
    sourceInstanceId: string;
    sourceContractVersion: number;
    sourceConfig: AutomationPluginEventWriteInput["sourceConfig"];
    displayLabel: string;
    filter: AutomationPluginEventWriteInput["filter"];
    maximumObservationAgeMs: number | null;
    watcherMachineId: string;
    watcherMachineInstallationId: string;
    watcherPluginId: string;
    watcherMaterializationId: string;
}>;

async function normalizeAutomationPluginEventWriteTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    input: AutomationPluginEventWriteInput;
}>): Promise<NormalizedAutomationPluginEventWrite> {
    const watcher = params.input.observationTransport.watcherMaterializationRef;
    if (watcher.pluginId !== params.input.eventRef.pluginId) {
        throw new AutomationValidationError(
            "Automation Event watcher must use the Event's declaring plugin",
        );
    }
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
    if (!contribution.automation.source.supportedObservationTransports.includes("checkpointedPull")) {
        throw new AutomationValidationError(
            "Automation Event declaration does not support checkpointed pull",
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
    return {
        eventRef: params.input.eventRef,
        sourceInstanceId: params.input.sourceInstanceId,
        sourceContractVersion: params.input.sourceContractVersion,
        sourceConfig: params.input.sourceConfig,
        displayLabel: params.input.displayLabel,
        filter: params.input.filter,
        maximumObservationAgeMs: params.input.maximumObservationAgeMs,
        watcherMachineId: watcher.machineId,
        watcherMachineInstallationId: machine.installationId,
        watcherPluginId: watcher.pluginId,
        watcherMaterializationId: watcher.materializationId,
    };
}

function sealPlainAutomationPluginEventDefinition(params: Readonly<{
    automationId: string;
    templateVersion: number;
    sourceSelectorId: string;
    event: NormalizedAutomationPluginEventWrite;
}>): string {
    const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
        params.sourceSelectorId,
    );
    const definition = AutomationEventTriggerDefinitionStoredPayloadV1Schema.parse({
        v: 1,
        sourceInstanceId: params.event.sourceInstanceId,
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
            templateVersion: params.templateVersion,
            triggerKind: "pluginEvent",
            eventRef: params.event.eventRef,
            sourceSelectorId,
        },
        definition,
    }));
}

function readPlainAutomationPluginEventDefinition(
    existing: AutomationListItem,
): ReturnType<typeof AutomationEventTriggerDefinitionStoredPayloadV1Schema.parse> {
    const binding = readAutomationTriggerDefinitionBinding({
        automationId: existing.id,
        templateVersion: existing.templateVersion,
        triggerKind: existing.triggerKind,
        triggerEventPluginId: existing.triggerEventPluginId,
        triggerEventLocalId: existing.triggerEventLocalId,
        triggerSourceSelectorId: existing.triggerSourceSelectorId,
    });
    if (!binding || existing.triggerDefinitionEnvelope === null) {
        throw new AutomationValidationError(
            "Automation Event private definition is unavailable",
        );
    }
    let envelope: unknown;
    try {
        envelope = JSON.parse(existing.triggerDefinitionEnvelope);
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

async function assertEnabledAutomationEventSourceCapacityTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    excludeAutomationId?: string;
}>): Promise<void> {
    const enabledCount = await params.tx.automation.count({
        where: {
            accountId: params.accountId,
            triggerKind: "pluginEvent",
            enabled: true,
            deletedAt: null,
            ...(params.excludeAutomationId
                ? { id: { not: params.excludeAutomationId } }
                : {}),
        },
    });
    if (enabledCount >= MAX_ENABLED_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_ACCOUNT) {
        throw new AutomationEventDefinitionCapacityConflictError(enabledCount);
    }
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
    scheduleKind?: AutomationScheduleKind;
}> {
    if (!requireV2DefinitionRepresentability) return {};
    if (!isAutomationDefinitionRepresentableInV2(existing)) {
        throw new Error("V2 mutation requires a representable Automation Definition");
    }
    return {
        targetType: existing.targetType,
        templateCiphertext: existing.templateCiphertext,
        scheduleKind: existing.scheduleKind,
    };
}

export async function loadAutomationTx(
    tx: Tx,
    params: {
        accountId: string;
        automationId: string;
        includeDeleted?: boolean;
        expectedTriggerKind?: AutomationTriggerKind;
        requireV2DefinitionRepresentability?: boolean;
    },
): Promise<AutomationListItem | null> {
    const row = await tx.automation.findFirst({
        where: {
            id: params.automationId,
            accountId: params.accountId,
            ...(params.includeDeleted ? {} : { deletedAt: null }),
            ...(params.expectedTriggerKind
                ? { triggerKind: params.expectedTriggerKind }
                : {}),
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

export class AutomationEventDefinitionCapacityConflictError extends Error {
    constructor(readonly enabledCount: number) {
        super("Enabled Automation Event source definition limit exceeded");
        this.name = "AutomationEventDefinitionCapacityConflictError";
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
    triggerKind: AutomationListItem["triggerKind"];
    targetType: AutomationListItem["targetType"];
    templateCiphertext: string;
    templateVersion: number;
    triggerEventPluginId: string | null;
    triggerEventLocalId: string | null;
    triggerSourceSelectorId: string | null;
    triggerDefinitionEnvelope: string | null;
    assignments: ReadonlyArray<{
        machineId: string;
        enabled: boolean;
        updatedAt: Date;
    }>;
}

interface AutomationAccountEncryptionMigrationRunRow {
    id: string;
    automationId: string;
    originKind: AutomationRunOriginKind;
    occurrenceKey: string | null;
    occurrenceEvidenceEqualityTag: string | null;
    triggerEvidenceEnvelope: string | null;
    executionInputEnvelope: string | null;
    resultEnvelope: string | null;
    replyContextEnvelope: string | null;
    replyHandoffReceiptEnvelope: string | null;
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
    triggerDefinitionEnvelope: string | null;
}>;

export type AutomationAccountEncryptionTransitionRunSourceContent = Readonly<{
    triggerEvidenceEnvelope: string | null;
    occurrenceEvidenceEqualityTag: string | null;
    executionInputEnvelope: string | null;
    resultEnvelope: string | null;
    replyContextEnvelope: string | null;
    replyHandoffReceiptEnvelope: string | null;
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
        originKind: AutomationRunOriginKind;
        occurrenceKey: string | null;
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
        originKind: AutomationRunOriginKind;
        occurrenceKey: string | null;
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
            triggerDefinitionEnvelope: row.triggerDefinitionEnvelope,
        },
    };
}

function transitionInventoryRun(
    row: AutomationAccountEncryptionMigrationRunRow,
): Extract<AutomationAccountEncryptionTransitionInventoryItem, { kind: "run" }> {
    return {
        kind: "run",
        runId: row.id,
        automationId: row.automationId,
        revision: row.revision,
        originKind: row.originKind,
        occurrenceKey: row.occurrenceKey,
        source: {
            triggerEvidenceEnvelope: row.triggerEvidenceEnvelope,
            occurrenceEvidenceEqualityTag: row.occurrenceEvidenceEqualityTag,
            executionInputEnvelope: row.executionInputEnvelope,
            resultEnvelope: row.resultEnvelope,
            replyContextEnvelope: row.replyContextEnvelope,
            replyHandoffReceiptEnvelope: row.replyHandoffReceiptEnvelope,
            summaryCiphertext: row.summaryCiphertext,
        },
    };
}

function transitionInventoryItemEncodedBytes(
    item: AutomationAccountEncryptionTransitionInventoryItem,
): bigint {
    return BigInt(new TextEncoder().encode(JSON.stringify(item)).byteLength);
}

function automationTriggerRetainsDefinitionContent(
    triggerKind: AutomationTriggerKind,
): triggerKind is "pluginEvent" | "conversation" {
    return triggerKind === "pluginEvent" || triggerKind === "conversation";
}

function assertAutomationDefinitionStoredContentForAccountMode(params: Readonly<{
    row: AutomationAccountEncryptionMigrationRow;
    mode: "plain" | "e2ee";
}>): void {
    if (!automationTriggerRetainsDefinitionContent(params.row.triggerKind)) {
        if (params.row.triggerDefinitionEnvelope !== null) {
            throw new AutomationValidationError(
                "Schedule and Manual Automation definitions must not retain trigger-definition content",
            );
        }
    } else {
        if (params.row.triggerDefinitionEnvelope === null) {
            throw new AutomationValidationError(
                "Event and Conversation Automation definitions require retained trigger-definition content",
            );
        }
        const definition = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
            raw: params.row.triggerDefinitionEnvelope,
            mode: params.mode,
            binding: definitionBindingForMigrationRow(
                params.row,
                params.row.templateVersion,
            ),
        });
        if (definition.kind !== "available") {
            throw new AutomationValidationError(
                "Automation trigger-definition source does not match the Account mode or definition binding",
            );
        }
    }

    const strict = parseAutomationRunExecutionRecipeV1(
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
            triggerKind: true,
            targetType: true,
            templateCiphertext: true,
            templateVersion: true,
            triggerEventPluginId: true,
            triggerEventLocalId: true,
            triggerSourceSelectorId: true,
            triggerDefinitionEnvelope: true,
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
            originKind: true,
            occurrenceKey: true,
            occurrenceEvidenceEqualityTag: true,
            triggerEvidenceEnvelope: true,
            executionInputEnvelope: true,
            resultEnvelope: true,
            replyContextEnvelope: true,
            replyHandoffReceiptEnvelope: true,
            summaryCiphertext: true,
            revision: true,
        },
        orderBy: { id: "asc" },
        take,
    }) as AutomationAccountEncryptionMigrationRunRow[];
}

/**
 * One bounded all-origin Automation source page for the Account transition.
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
                    content: row,
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
    targetTriggerDefinitionEnvelope: string | null;
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
        && row.templateCiphertext === item.source.templateCiphertext
        && row.triggerDefinitionEnvelope === item.source.triggerDefinitionEnvelope;
}

function stageRunSourceMatches(
    row: AutomationAccountEncryptionMigrationRunRow,
    item: Extract<AutomationAccountEncryptionTransitionStageItem, { kind: "run" }>,
): boolean {
    return row.id === item.runId
        && row.automationId === item.automationId
        && row.revision === item.expectedRevision
        && row.originKind === item.originKind
        && row.occurrenceKey === item.occurrenceKey
        && row.triggerEvidenceEnvelope === item.source.triggerEvidenceEnvelope
        && row.occurrenceEvidenceEqualityTag
            === item.source.occurrenceEvidenceEqualityTag
        && row.executionInputEnvelope === item.source.executionInputEnvelope
        && row.resultEnvelope === item.source.resultEnvelope
        && row.replyContextEnvelope === item.source.replyContextEnvelope
        && row.replyHandoffReceiptEnvelope === item.source.replyHandoffReceiptEnvelope
        && row.summaryCiphertext === item.source.summaryCiphertext;
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
            triggerKind: true,
            targetType: true,
            templateCiphertext: true,
            templateVersion: true,
            triggerEventPluginId: true,
            triggerEventLocalId: true,
            triggerSourceSelectorId: true,
            triggerDefinitionEnvelope: true,
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
            originKind: true,
            occurrenceKey: true,
            occurrenceEvidenceEqualityTag: true,
            triggerEvidenceEnvelope: true,
            executionInputEnvelope: true,
            resultEnvelope: true,
            replyContextEnvelope: true,
            replyHandoffReceiptEnvelope: true,
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
            const targetTriggerDefinitionEnvelope =
                validateAutomationTriggerDefinitionMigrationCandidate({
                    row,
                    item: {
                        automationId: item.automationId,
                        expectedTemplateVersion: item.expectedRevision,
                        templateCiphertext: item.target.templateCiphertext,
                        triggerDefinitionEnvelope:
                            item.target.triggerDefinitionEnvelope,
                    },
                    sourceMode: params.fromMode,
                    toMode: params.toMode,
                });
            validatedDefinitions.push({
                row,
                item,
                targetTriggerDefinitionEnvelope,
            });
        }
        const validatedRuns: AutomationAccountEncryptionTransitionValidatedRun[] = [];
        for (const item of runs) {
            const row = runsById.get(item.runId);
            if (!row) return { status: "migration_incomplete" };
            assertAutomationRunStoredContentForAccountMode({
                row,
                mode: params.fromMode,
                content: row,
                allowLegacyResultSource: true,
            });
            assertAutomationRunOptionalContentNullnessPreserved({
                source: row,
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
                triggerDefinitionEnvelope: candidate.targetTriggerDefinitionEnvelope,
                templateVersion: { increment: 1 },
                nextRunAt: null,
                updatedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new AutomationAccountEncryptionMigrationConflictError();
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
                originKind: candidate.item.originKind,
                revision: candidate.item.expectedRevision,
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
        candidate.row.triggerKind === "pluginEvent"
        && candidate.row.enabled
        && candidate.row.deletedAt === null
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
            triggerKind: true,
            targetType: true,
            templateCiphertext: true,
            templateVersion: true,
            triggerEventPluginId: true,
            triggerEventLocalId: true,
            triggerSourceSelectorId: true,
            triggerDefinitionEnvelope: true,
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
            originKind: true,
            occurrenceKey: true,
            occurrenceEvidenceEqualityTag: true,
            triggerEvidenceEnvelope: true,
            executionInputEnvelope: true,
            resultEnvelope: true,
            replyContextEnvelope: true,
            replyHandoffReceiptEnvelope: true,
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

function migrationItemMatchesTriggerDefinitionPostState(
    row: AutomationAccountEncryptionMigrationRow,
    item: AutomationAccountEncryptionMigrationTemplateItem,
): boolean {
    if (!automationTriggerRetainsDefinitionContent(row.triggerKind)) {
        return row.triggerDefinitionEnvelope === null
            && (
                item.triggerDefinitionEnvelope === undefined
                || item.triggerDefinitionEnvelope === null
            );
    }
    return typeof item.triggerDefinitionEnvelope === "string"
        && item.triggerDefinitionEnvelope === row.triggerDefinitionEnvelope;
}

function hasCompleteTriggerDefinitionMigrationTarget(
    row: AutomationAccountEncryptionMigrationRow,
    item: AutomationAccountEncryptionMigrationTemplateItem,
): boolean {
    return !automationTriggerRetainsDefinitionContent(row.triggerKind)
        || typeof item.triggerDefinitionEnvelope === "string";
}

function definitionBindingForMigrationRow(
    row: AutomationAccountEncryptionMigrationRow,
    templateVersion: number,
) {
    const binding = readAutomationTriggerDefinitionBinding({
        automationId: row.id,
        templateVersion,
        triggerKind: row.triggerKind,
        triggerEventPluginId: row.triggerEventPluginId,
        triggerEventLocalId: row.triggerEventLocalId,
        triggerSourceSelectorId: row.triggerSourceSelectorId,
    });
    if (binding === null) {
        throw new AutomationValidationError(
            "Automation trigger-definition binding does not match its durable definition",
        );
    }
    return binding;
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
}>): string | null {
    if (!automationTriggerRetainsDefinitionContent(params.row.triggerKind)) {
        if (
            params.row.triggerDefinitionEnvelope !== null
            || (
                params.item.triggerDefinitionEnvelope !== undefined
                && params.item.triggerDefinitionEnvelope !== null
            )
        ) {
            throw new AutomationValidationError(
                "Schedule and Manual Automation definitions must not retain trigger-definition content",
            );
        }
        return null;
    }
    if (params.row.triggerDefinitionEnvelope === null) {
        throw new AutomationValidationError(
            "Event and Conversation Automation definitions require retained trigger-definition content",
        );
    }
    if (typeof params.item.triggerDefinitionEnvelope !== "string") {
        throw new AutomationValidationError(
            "Event and Conversation Automation migrations require one trigger-definition target",
        );
    }
    const nextTemplateVersion = params.item.expectedTemplateVersion + 1;
    if (!Number.isSafeInteger(nextTemplateVersion)) {
        throw new AutomationValidationError(
            "Automation trigger-definition migration exceeds the template version range",
        );
    }
    const source = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
        raw: params.row.triggerDefinitionEnvelope,
        mode: params.sourceMode,
        binding: definitionBindingForMigrationRow(
            params.row,
            params.row.templateVersion,
        ),
    });
    if (source.kind !== "available") {
        throw new AutomationValidationError(
            "Automation trigger-definition source does not match the Account mode or definition binding",
        );
    }
    const target = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
        raw: params.item.triggerDefinitionEnvelope,
        mode: params.toMode,
        binding: definitionBindingForMigrationRow(params.row, nextTemplateVersion),
    });
    if (target.kind !== "available") {
        throw new AutomationValidationError(
            "Automation trigger-definition target does not match the Account mode or next definition binding",
        );
    }
    return params.item.triggerDefinitionEnvelope;
}

function assertAutomationTriggerDefinitionMigrationPostState(params: Readonly<{
    row: AutomationAccountEncryptionMigrationRow;
    item: AutomationAccountEncryptionMigrationTemplateItem;
    toMode: "plain" | "e2ee";
}>): void {
    if (!automationTriggerRetainsDefinitionContent(params.row.triggerKind)) {
        if (!migrationItemMatchesTriggerDefinitionPostState(params.row, params.item)) {
            throw new AutomationValidationError(
                "Schedule or Manual Automation trigger-definition post-state does not match its null contract",
            );
        }
        return;
    }
    if (
        typeof params.item.triggerDefinitionEnvelope !== "string"
        || params.row.triggerDefinitionEnvelope !== params.item.triggerDefinitionEnvelope
    ) {
        throw new AutomationValidationError(
            "Automation trigger-definition post-state does not match its migration target",
        );
    }
    const validation = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
        raw: params.row.triggerDefinitionEnvelope,
        mode: params.toMode,
        binding: definitionBindingForMigrationRow(
            params.row,
            params.row.templateVersion,
        ),
    });
    if (validation.kind !== "available") {
        throw new AutomationValidationError(
            "Automation trigger-definition post-state is not mode-correct and bound",
        );
    }
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
>;

function assertAutomationRunOptionalContentNullnessPreserved(params: Readonly<{
    source: AutomationAccountEncryptionMigrationRunStoredContent;
    target: AutomationAccountEncryptionMigrationRunStoredContent;
}>): void {
    for (const field of [
        "executionInputEnvelope",
        "resultEnvelope",
        "replyContextEnvelope",
        "replyHandoffReceiptEnvelope",
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
        params.row.originKind === "pluginEvent"
        || params.row.originKind === "conversation"
    ) {
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
            if (
                !evidence.success
                || evidence.data.kind !== params.row.originKind
                || deriveAutomationOccurrenceKeyV1(evidence.data)
                    !== params.row.occurrenceKey
            ) {
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
            originKind: params.row.originKind,
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
    const strict = parseAutomationRunExecutionRecipeV1(params.templateCiphertext);
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
    const source = parseAutomationRunExecutionRecipeV1(
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

    const expectedTarget = serializeAutomationRunExecutionRecipeV1({
        ...source.recipe,
        templateVersion: params.target.recipe.templateVersion,
        template: params.target.recipe.template,
        triggerEvidence: params.target.recipe.triggerEvidence,
    });
    const actualTarget = serializeAutomationRunExecutionRecipeV1(
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
        automation.triggerKind === "pluginEvent"
        && automation.enabled
        && automation.deletedAt === null
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
        automationTriggerRetainsDefinitionContent(row.triggerKind))
        || runRows.length > 0;
    const targetTriggerDefinitionsById = new Map<string, string | null>();
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
                    content: row,
                    allowLegacyResultSource: true,
                });
                assertAutomationRunOptionalContentNullnessPreserved({
                    source: row,
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
                triggerDefinitionEnvelope: targetTriggerDefinitionsById.get(row.id)!,
                templateVersion: { increment: 1 },
                nextRunAt: null,
                updatedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new AutomationAccountEncryptionMigrationConflictError();
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
                originKind: row.originKind,
                revision: item.expectedRunRevision,
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
        automation.triggerKind === "pluginEvent"
        && automation.enabled
        && automation.deletedAt === null
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
                content: row,
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

export async function listAutomations(params: {
    accountId: string;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2DefinitionRepresentability?: boolean;
}): Promise<AutomationListItem[]> {
    const rows = await db.automation.findMany({
        where: {
            accountId: params.accountId,
            deletedAt: null,
            ...(params.expectedTriggerKind
                ? { triggerKind: params.expectedTriggerKind }
                : {}),
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
    expectedTriggerKind?: AutomationTriggerKind;
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
    return await inTx(async (tx) => {
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
        const triggerInputCount = Number(params.input.schedule !== undefined)
            + Number(params.input.pluginEvent !== undefined)
            + Number(params.input.manual === true);
        if (triggerInputCount !== 1) {
            throw new AutomationValidationError(
                "Automation definitions require exactly one trigger",
            );
        }
        if (params.input.pluginEvent && params.input.enabled) {
            await assertEnabledAutomationEventSourceCapacityTx({
                tx,
                accountId: params.accountId,
            });
        }
        const pluginEvent = params.input.pluginEvent
            ? await normalizeAutomationPluginEventWriteTx({
                tx,
                accountId: params.accountId,
                input: params.input.pluginEvent,
            })
            : null;
        const scheduleFields = params.input.schedule
            ? resolveScheduleDbFields(params.input.schedule)
            : null;
        const sourceSelectorId = pluginEvent
            ? AutomationSourceSelectorIdV1Schema.parse(randomUUID())
            : null;
        const automationId = pluginEvent ? randomUUID() : null;
        const triggerDefinitionEnvelope = pluginEvent && sourceSelectorId && automationId
            ? sealPlainAutomationPluginEventDefinition({
                automationId,
                templateVersion: 1,
                sourceSelectorId,
                event: pluginEvent,
            })
            : null;
        const created = await tx.automation.create({
            data: {
                ...(automationId ? { id: automationId } : {}),
                accountId: params.accountId,
                name: params.input.name,
                description: params.input.description ?? null,
                enabled: params.input.enabled,
                triggerKind: pluginEvent
                    ? "pluginEvent"
                    : params.input.manual
                        ? "manual"
                        : "schedule",
                scheduleKind: scheduleFields?.scheduleKind ?? null,
                scheduleExpr: scheduleFields?.scheduleExpr ?? null,
                everyMs: scheduleFields?.everyMs ?? null,
                timezone: scheduleFields?.timezone ?? null,
                targetType: definition.targetType,
                templateCiphertext: definition.templateCiphertext,
                templateVersion: 1,
                ...(pluginEvent
                    ? {
                        triggerEventPluginId: pluginEvent.eventRef.pluginId,
                        triggerEventLocalId: pluginEvent.eventRef.localId,
                        triggerSourceSelectorId: sourceSelectorId,
                        triggerSourceContractVersion: pluginEvent.sourceContractVersion,
                        triggerObservationTransport: "checkpointedPull" as const,
                        watcherMachineId: pluginEvent.watcherMachineId,
                        watcherMachineInstallationId:
                            pluginEvent.watcherMachineInstallationId,
                        watcherPluginId: pluginEvent.watcherPluginId,
                        watcherMaterializationId:
                            pluginEvent.watcherMaterializationId,
                        triggerDefinitionEnvelope,
                    }
                    : {}),
            },
            select: { id: true },
        });

        if (pluginEvent) {
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

        const queued = params.input.enabled && scheduleFields
            ? await enqueueNextScheduledRunIfMissingTx({ tx, automationId: created.id, now })
            : null;

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
            if (queued) {
                emitAutomationRunTransition({
                    accountId: params.accountId,
                    run: queued,
                    previousState: null,
                    cursor,
                });
            }
        });

        return automation;
    });
}

export async function updateAutomation(params: {
    accountId: string;
    automationId: string;
    input: AutomationPatchInput;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2DefinitionRepresentability?: boolean;
    expectedTemplateVersion?: number;
}): Promise<AutomationListItem | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;
        const existing = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
            expectedTriggerKind: params.expectedTriggerKind,
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

        const schedule = params.input.schedule;
        const triggerPatchCount = Number(schedule !== undefined)
            + Number(params.input.pluginEvent !== undefined)
            + Number(params.input.manual === true);
        if (triggerPatchCount > 1) {
            throw new AutomationValidationError(
                "Automation definitions require exactly one trigger",
            );
        }
        const effectiveEnabled = params.input.enabled ?? existing.enabled;
        if (existing.triggerKind === "pluginEvent" && effectiveEnabled && !existing.enabled) {
            await assertEnabledAutomationEventSourceCapacityTx({
                tx,
                accountId: params.accountId,
                excludeAutomationId: existing.id,
            });
        }
        const pluginEvent = params.input.pluginEvent
            ? await normalizeAutomationPluginEventWriteTx({
                tx,
                accountId: params.accountId,
                input: params.input.pluginEvent,
            })
            : null;
        if (pluginEvent && existing.triggerKind !== "pluginEvent") {
            throw new AutomationValidationError(
                "Automation Event patches require an Event definition",
            );
        }
        if (pluginEvent && currentDefinition === null) {
            throw new AutomationValidationError(
                "Automation Event patches require a current execution recipe",
            );
        }
        const scheduleFields = schedule ? resolveScheduleDbFields(schedule) : null;
        const templateCiphertextChanged = inputSuppliesTemplate
            && effectiveTemplateCiphertext !== existing.templateCiphertext;
        const targetTypeChanged =
            inputSuppliesTarget
            && effectiveTargetType !== existing.targetType;
        const templateSemanticsWritten =
            inputSuppliesTemplate || targetTypeChanged;
        let nextSourceSelectorId = existing.triggerSourceSelectorId;
        let triggerDefinitionEnvelope: string | null = null;
        if (pluginEvent) {
            const priorDefinition = readPlainAutomationPluginEventDefinition(existing);
            const identityChanged = existing.triggerEventPluginId
                !== pluginEvent.eventRef.pluginId
                || existing.triggerEventLocalId !== pluginEvent.eventRef.localId
                || priorDefinition.sourceInstanceId !== pluginEvent.sourceInstanceId;
            nextSourceSelectorId = identityChanged
                ? AutomationSourceSelectorIdV1Schema.parse(randomUUID())
                : AutomationSourceSelectorIdV1Schema.parse(
                    existing.triggerSourceSelectorId,
                );
            triggerDefinitionEnvelope = sealPlainAutomationPluginEventDefinition({
                automationId: existing.id,
                templateVersion: existing.templateVersion + 1,
                sourceSelectorId: nextSourceSelectorId,
                event: pluginEvent,
            });
        }
        const automationUpdate = {
            ...(typeof params.input.name === "string"
                ? { name: params.input.name }
                : {}),
            ...(params.input.description !== undefined
                ? { description: params.input.description ?? null }
                : {}),
            ...(typeof params.input.enabled === "boolean"
                ? { enabled: params.input.enabled }
                : {}),
            ...(schedule
                ? {
                    triggerKind: "schedule" as const,
                    scheduleKind: scheduleFields!.scheduleKind,
                    scheduleExpr: scheduleFields!.scheduleExpr,
                    everyMs: scheduleFields!.everyMs,
                    timezone: scheduleFields!.timezone,
                }
                : {}),
            ...(params.input.manual
                ? {
                    triggerKind: "manual" as const,
                    scheduleKind: null,
                    scheduleExpr: null,
                    everyMs: null,
                    timezone: null,
                }
                : {}),
            ...(pluginEvent
                ? {
                    triggerKind: "pluginEvent" as const,
                    scheduleKind: null,
                    scheduleExpr: null,
                    everyMs: null,
                    timezone: null,
                    triggerEventPluginId: pluginEvent.eventRef.pluginId,
                    triggerEventLocalId: pluginEvent.eventRef.localId,
                    triggerSourceSelectorId: nextSourceSelectorId,
                    triggerSourceContractVersion: pluginEvent.sourceContractVersion,
                    triggerObservationTransport: "checkpointedPull" as const,
                    triggerWebhookEndpointId: null,
                    triggerObservationStartsAt: null,
                    watcherMachineId: pluginEvent.watcherMachineId,
                    watcherMachineInstallationId:
                        pluginEvent.watcherMachineInstallationId,
                    watcherPluginId: pluginEvent.watcherPluginId,
                    watcherMaterializationId:
                        pluginEvent.watcherMaterializationId,
                    triggerDefinitionEnvelope,
                }
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
            ...(templateCiphertextChanged || targetTypeChanged
                ? { nextRunAt: null }
                : {}),
            ...(params.input.enabled === false
                ? { nextRunAt: null }
                : {}),
        };

        if (templateSemanticsWritten) {
            const updated = await tx.automation.updateMany({
                where: {
                    id: existing.id,
                    accountId: params.accountId,
                    templateVersion: existing.templateVersion,
                    ...(params.expectedTriggerKind
                        ? { triggerKind: params.expectedTriggerKind }
                        : {}),
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
                    ...(params.expectedTriggerKind
                        ? { triggerKind: params.expectedTriggerKind }
                        : {}),
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

        const eventProjectionChanged = existing.triggerKind === "pluginEvent" && (
            existing.enabled !== effectiveEnabled
            || (
                effectiveEnabled
                && (pluginEvent !== null || templateSemanticsWritten)
            )
        );
        if (existing.triggerKind === "pluginEvent") {
            await ensureAutomationEventCatalogStateTx({
                tx,
                accountId: params.accountId,
                projectionChanged: eventProjectionChanged,
            });
        }

        // Disabling stops queued automatic work, while an explicit manual Run
        // and incumbent claimed/running lease-retirement handling remain intact.
        let terminalizedRuns: AutomationRunItem[] = [];
        if (params.input.enabled === false) {
            for (const originKind of AUTOMATION_DISABLE_CANCELLABLE_RUN_ORIGINS) {
                terminalizedRuns = terminalizedRuns.concat(
                    await cancelQueuedAutomationRunsTx({
                        tx,
                        accountId: params.accountId,
                        automationId: existing.id,
                        originKind,
                    }),
                );
            }
        }

        let assignmentRows = existing.assignments;
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
                        ...(params.expectedTriggerKind
                            ? { triggerKind: params.expectedTriggerKind }
                            : {}),
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
            assignmentRows = await replaceAutomationAssignmentsTx({
                tx,
                accountId: params.accountId,
                automationId: existing.id,
                assignments: params.input.assignments,
            });
        }

        const now = new Date();

        // If the schedule changes while there is still a queued scheduled run, update its dueAt so
        // "next run" reflects the new schedule immediately. (Leave immediate run-now runs intact.)
        if (schedule && existing.triggerKind === "schedule" && params.input.enabled !== false) {
            const nextDueAt = resolveScheduledRunDueAt({
                now,
                scheduleKind: scheduleFields!.scheduleKind,
                everyMs: scheduleFields!.everyMs,
                scheduleExpr: scheduleFields!.scheduleExpr,
                timezone: scheduleFields!.timezone,
                nextRunAt: existing.nextRunAt,
            });

            if (nextDueAt) {
                const scheduledQueued = await tx.automationRun.findFirst({
                    where: {
                        automationId: existing.id,
                        state: "queued",
                        originKind: "scheduled",
                        dueAt: { gt: now },
                    },
                    orderBy: [{ dueAt: "desc" }, { createdAt: "desc" }],
                    select: { id: true },
                });
                if (scheduledQueued) {
                    await tx.automationRun.update({
                        where: { id: scheduledQueued.id },
                        data: { dueAt: nextDueAt, revision: { increment: 1 }, updatedAt: now },
                    });
                }

                await tx.automation.update({
                    where: { id: existing.id },
                    data: { nextRunAt: nextDueAt },
                });
            } else {
                await tx.automation.update({
                    where: { id: existing.id },
                    data: { nextRunAt: null },
                });
                terminalizedRuns = terminalizedRuns.concat(
                    await cancelQueuedAutomationRunsTx({
                        tx,
                        accountId: params.accountId,
                        automationId: existing.id,
                        originKind: "scheduled",
                    }),
                );
            }
        }

        const nextRun = existing.triggerKind === "schedule"
            ? await enqueueNextScheduledRunIfMissingTx({
                tx,
                automationId: existing.id,
                now,
            })
            : null;

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

        afterTx(tx, () => {
            emitAutomationUpsert({ accountId: params.accountId, automation: updated, cursor });
            emitAssignmentUpdates({
                accountId: params.accountId,
                automationId: updated.id,
                cursor,
                assignments: buildAssignmentUpdateRows({
                    previousAssignments: existing.assignments,
                    nextAssignments: assignmentRows,
                }),
            });
            if (nextRun) {
                emitAutomationRunTransition({
                    accountId: params.accountId,
                    run: nextRun,
                    previousState: null,
                    cursor,
                });
            }
            for (const terminalizedRun of terminalizedRuns) {
                emitAutomationRunTransition({
                    accountId: params.accountId,
                    run: terminalizedRun,
                    previousState: "queued",
                    cursor,
                });
            }
        });

        return updated;
    });
}

export async function deleteAutomation(params: {
    accountId: string;
    automationId: string;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2DefinitionRepresentability?: boolean;
}): Promise<boolean> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return false;
        const existing = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
            expectedTriggerKind: params.expectedTriggerKind,
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
                ...(params.expectedTriggerKind
                    ? { triggerKind: params.expectedTriggerKind }
                    : {}),
                ...v2DefinitionCurrentnessWhere(
                    params.requireV2DefinitionRepresentability,
                    existing,
                ),
            },
            data: {
                enabled: false,
                deletedAt,
                nextRunAt: null,
            },
        });
        if (softDeleted.count !== 1) {
            return false;
        }

        const terminalizedRuns = await cancelQueuedAutomationRunsTx({
            tx,
            accountId: params.accountId,
            automationId: existing.id,
        });

        await tx.automationAssignment.deleteMany({
            where: { automationId: existing.id },
        });

        if (existing.triggerKind === "pluginEvent") {
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
            for (const terminalizedRun of terminalizedRuns) {
                emitAutomationRunTransition({
                    accountId: params.accountId,
                    run: terminalizedRun,
                    previousState: "queued",
                    cursor,
                });
            }
        });

        return true;
    });
}

export async function setAutomationEnabled(params: {
    accountId: string;
    automationId: string;
    enabled: boolean;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2DefinitionRepresentability?: boolean;
}): Promise<AutomationListItem | null> {
    return await updateAutomation({
        accountId: params.accountId,
        automationId: params.automationId,
        input: { enabled: params.enabled },
        expectedTriggerKind: params.expectedTriggerKind,
        requireV2DefinitionRepresentability:
            params.requireV2DefinitionRepresentability,
    });
}

export async function runAutomationNow(params: {
    accountId: string;
    automationId: string;
    idempotencyKey?: string;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2DefinitionRepresentability?: boolean;
}): Promise<AutomationRunItem | null> {
    const idempotencyKey = params.idempotencyKey?.trim();
    if (params.idempotencyKey !== undefined && !idempotencyKey) {
        throw new AutomationValidationError("Idempotency-Key must not be empty");
    }
    const occurrenceKey = idempotencyKey
        ? deriveAutomationManualOccurrenceKeyV1({
            automationId: params.automationId,
            idempotencyKey,
        })
        : null;

    return await rejoinAutomationOccurrenceInsertRace(async () => await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;
        const automation = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
            expectedTriggerKind: params.expectedTriggerKind,
            requireV2DefinitionRepresentability:
                params.requireV2DefinitionRepresentability,
        });
        if (!automation) {
            return null;
        }

        if (occurrenceKey) {
            const existingRun = await findAutomationOccurrenceTx({
                tx,
                accountId: params.accountId,
                automationId: automation.id,
                occurrenceKey,
                select: automationRunItemSelect,
            });
            if (existingRun) return existingRun as AutomationRunItem;
        }
        if (idempotencyKey) {
            // remote-dev wrote the caller key directly before V3 made the
            // domain-separated occurrence key canonical. Rejoin those retained
            // Runs here; all new writes continue through occurrenceKey above.
            const predecessorRun = await tx.automationRun.findFirst({
                where: {
                    accountId: params.accountId,
                    automationId: automation.id,
                    legacyManualIdempotencyKey: idempotencyKey,
                },
                select: automationRunItemSelect,
            });
            if (predecessorRun) return predecessorRun as AutomationRunItem;
        }
        if (!automation.enabled) {
            throw new AutomationDisabledError();
        }

        const now = new Date();
        const run = await enqueueImmediateRunTx({
            tx,
            automationId: automation.id,
            accountId: automation.accountId,
            now,
            occurrenceKey,
        });

        const assignedMachines = await tx.automationAssignment.findMany({
            where: {
                automationId: automation.id,
                enabled: true,
            },
            select: { machineId: true },
        });

        const cursor = await markAutomationChangedTx(tx, {
            accountId: params.accountId,
            automationId: automation.id,
        });

        afterTx(tx, () => {
            emitAutomationRunTransition({
                accountId: params.accountId,
                run,
                previousState: null,
                cursor,
            });

            // Daemon-only hint: wake assigned machines so a run-now doesn't wait for the next scheduled poll.
            for (const assignment of assignedMachines) {
                emitAutomationRunUpdatedToMachineOnly({
                    accountId: params.accountId,
                    machineId: assignment.machineId,
                    run,
                    cursor,
                });
            }
        });

        return run as AutomationRunItem;
    }));
}

export async function listAutomationRuns(params: {
    accountId: string;
    automationId: string;
    limit: number;
    cursor?: string | null;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2DefinitionRepresentability?: boolean;
    requireV2RunRepresentability?: boolean;
}): Promise<{ runs: AutomationRunItem[]; nextCursor: string | null } | null> {
    if (params.requireV2DefinitionRepresentability) {
        const automation = await getAutomation({
            accountId: params.accountId,
            automationId: params.automationId,
            expectedTriggerKind: params.expectedTriggerKind,
            requireV2DefinitionRepresentability: true,
        });
        if (!automation) return null;
    }
    const normalizedLimit = Math.min(Math.max(Math.floor(params.limit || 20), 1), 100);
    const readRows = async (client: Tx, cursor?: string | null, take = normalizedLimit + 1) => await client.automationRun.findMany({
        where: {
            accountId: params.accountId,
            automationId: params.automationId,
            ...(params.expectedTriggerKind
                ? { automation: { triggerKind: params.expectedTriggerKind } }
                : {}),
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
                    ...(params.expectedTriggerKind
                        ? { triggerKind: params.expectedTriggerKind }
                        : {}),
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
                    if (
                        typeof run.executionInputEnvelope === "string"
                        && validateRetainedAutomationRunExecutionInputV2OuterForMode({
                            raw: run.executionInputEnvelope,
                            mode: accountFence.account.currentness.encryptionMode,
                            originKind: run.originKind,
                        })?.kind === "available"
                    ) {
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
                ...(params.expectedTriggerKind
                    ? { automation: { triggerKind: params.expectedTriggerKind } }
                    : {}),
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

    return {
        runs: resultRows as AutomationRunItem[],
        nextCursor,
    };
}

/** Exact Run lookup for authenticated current-version detail reads. */
export async function getAutomationRun(params: {
    accountId: string;
    automationId: string;
    runId: string;
}): Promise<AutomationRunItem | null> {
    const row = await db.automationRun.findFirst({
        where: {
            id: params.runId,
            accountId: params.accountId,
            automationId: params.automationId,
        },
        select: automationRunItemSelect,
    });
    return row as AutomationRunItem | null;
}
import { randomUUID } from "node:crypto";
