import {
    AutomationApiV2Schema,
    AutomationRunApiV2Schema,
    AutomationRunResultStoredV1Schema,
    parseAutomationRunFailureDetailStoredEnvelopeV1,
    normalizeAutomationTemplateEnvelopeStoredRead,
    parseAutomationRunExecutionRecipeV1,
    AutomationV3DefinitionDetailSchema,
    AutomationV3DefinitionListItemSchema,
    AutomationV3RunOriginSchema,
    AutomationV3RunDetailSchema,
    AutomationV3RunListItemSchema,
    validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1,
    validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1,
    validateAutomationRunExecutionRecipeOuterV1,
    type AutomationAccountCurrentnessWitnessV1,
} from "@happier-dev/protocol";

import type {
    AutomationLegacyTargetType,
    AutomationListItem,
    AutomationRunDetailItem,
    AutomationRunEventRow,
    AutomationRunItem,
    AutomationTargetType,
} from "./automationTypes";
import type { AutomationV3EventStatusProjection } from "./automationV3EventStatusProjection";
import {
    assertAutomationExecutionInputEnvelopeOuterForMode,
    assertAutomationStoredContentEnvelopeOuterForMode,
    assertAutomationTriggerDefinitionEnvelopeOuterForMode,
    AutomationStoredContentReadError,
    readRetainedAutomationRunExecutionInputV2,
    readAutomationTriggerDefinitionBinding,
} from "./automationStoredContentRead";
import {
    assertAutomationTemplateEnvelopeForAccountMode,
    AutomationValidationError,
    readLegacyExistingSessionTemplateAdmission,
} from "./automationValidation";

function required<T>(value: T | null | undefined, field: string): T {
    if (value === null || value === undefined) {
        throw new Error(`Automation row has no ${field} for its declared arm`);
    }
    return value;
}

function parseStoredContentEnvelope(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        throw new AutomationStoredContentReadError("contentInvalid");
    }
}

function toAutomationTargetTypeV3(
    targetType: AutomationTargetType,
): "newSession" | "existingSession" | "executionRun" {
    if (targetType === "new_session") return "newSession";
    if (targetType === "existing_session") return "existingSession";
    return "executionRun";
}

function hasRetainedV2TemplateEnvelope(raw: string): boolean {
    try {
        return normalizeAutomationTemplateEnvelopeStoredRead(JSON.parse(raw)) !== null;
    } catch {
        return false;
    }
}

/** A released V2 reader can represent only this schedule-only Definition shape. */
export function isAutomationDefinitionRepresentableInV2<
    T extends Pick<
        AutomationListItem,
        "triggerKind" | "scheduleKind" | "targetType" | "templateCiphertext"
    >,
>(
    item: T,
): item is T & Readonly<{
    targetType: AutomationLegacyTargetType;
    scheduleKind: NonNullable<AutomationListItem["scheduleKind"]>;
}> {
    return item.triggerKind === "schedule"
        && item.scheduleKind !== null
        && item.targetType !== "execution_run"
        && parseAutomationRunExecutionRecipeV1(item.templateCiphertext).kind !== "available"
        && hasRetainedV2TemplateEnvelope(item.templateCiphertext);
}

/** @deprecated Use isAutomationDefinitionRepresentableInV2 at service boundaries. */
export const isAutomationV2Compatible = isAutomationDefinitionRepresentableInV2;

/** A released V2 Run DTO deliberately has no Event/Conversation origin arm. */
export function isAutomationRunV2Compatible(item: AutomationRunItem): boolean {
    return item.executionInputEnvelope !== null
        && readRetainedAutomationRunExecutionInputV2({
            raw: item.executionInputEnvelope,
            originKind: item.originKind,
        }) !== null;
}

function projectLegacyV2SummaryCiphertext(resultEnvelope: string | null): string | null {
    if (resultEnvelope === null) return null;
    const parsed = AutomationRunResultStoredV1Schema.safeParse(
        parseStoredContentEnvelope(resultEnvelope),
    );
    if (!parsed.success) {
        throw new AutomationStoredContentReadError("contentInvalid");
    }
    return parsed.data.t === "legacySummaryCiphertext" ? parsed.data.c : null;
}

/**
 * The predecessor contract has only a raw error field. Current V3 private
 * envelopes are intentionally opaque to it, while actual released-V2 strings
 * remain readable by the narrow compatibility adapter.
 */
function projectLegacyV2ErrorMessage(errorMessage: string | null): string | null {
    if (errorMessage === null) return null;
    return parseAutomationRunFailureDetailStoredEnvelopeV1(errorMessage) === null
        ? errorMessage
        : null;
}

/**
 * Strict predecessor projection. Callers must filter before projecting rather
 * than leaking current fields into a released UI/daemon schema.
 */
export function toAutomationV2ApiDto(item: AutomationListItem) {
    if (!isAutomationV2Compatible(item)) {
        throw new Error("Automation is not representable by the V2 contract");
    }
    return AutomationApiV2Schema.parse({
        id: item.id,
        name: item.name,
        description: item.description,
        enabled: item.enabled,
        schedule: {
            kind: required(item.scheduleKind, "scheduleKind"),
            scheduleExpr: item.scheduleExpr,
            everyMs: item.everyMs,
            timezone: item.timezone,
        },
        targetType: item.targetType,
        templateCiphertext: item.templateCiphertext,
        templateVersion: item.templateVersion,
        nextRunAt: item.nextRunAt?.getTime() ?? null,
        lastRunAt: item.lastRunAt?.getTime() ?? null,
        createdAt: item.createdAt.getTime(),
        updatedAt: item.updatedAt.getTime(),
        assignments: item.assignments.map((assignment) => ({
            machineId: assignment.machineId,
            enabled: assignment.enabled,
            priority: assignment.priority,
            updatedAt: assignment.updatedAt?.getTime() ?? null,
        })),
    });
}

export function toAutomationRunV2ApiDto(item: AutomationRunItem) {
    if (!isAutomationRunV2Compatible(item)) {
        throw new Error("Automation Run is not representable by the V2 contract");
    }
    return AutomationRunApiV2Schema.parse({
        id: item.id,
        automationId: item.automationId,
        state: item.state,
        scheduledAt: item.scheduledAt.getTime(),
        dueAt: item.dueAt.getTime(),
        claimedAt: item.claimedAt?.getTime() ?? null,
        startedAt: item.startedAt?.getTime() ?? null,
        finishedAt: item.finishedAt?.getTime() ?? null,
        claimedByMachineId: item.claimedByMachineId,
        leaseExpiresAt: item.leaseExpiresAt?.getTime() ?? null,
        attempt: item.attempt,
        // The predecessor shape can represent only its own exact legacy
        // summary member. A current envelope is intentionally opaque/null.
        summaryCiphertext: projectLegacyV2SummaryCiphertext(item.resultEnvelope),
        errorCode: item.errorCode,
        errorMessage: projectLegacyV2ErrorMessage(item.errorMessage),
        producedSessionId: item.producedSessionId,
        createdAt: item.createdAt.getTime(),
        updatedAt: item.updatedAt.getTime(),
    });
}

function toAutomationV3Trigger(item: AutomationListItem) {
    if (item.triggerKind === "schedule") {
        return {
            kind: "schedule" as const,
            schedule: {
                kind: required(item.scheduleKind, "scheduleKind"),
                scheduleExpr: item.scheduleExpr,
                everyMs: item.everyMs,
                timezone: item.timezone,
            },
        };
    }

    if (item.triggerKind === "manual") {
        return { kind: "manual" as const };
    }

    if (item.triggerKind === "conversation") {
        return { kind: "conversation" as const };
    }

    const observation = item.triggerObservationTransport === "checkpointedPull"
        ? {
            kind: "checkpointedPull" as const,
            watcher: item.watcherMachineId === null
                ? null
                : {
                    machineId: item.watcherMachineId,
                    machineInstallationId: required(
                        item.watcherMachineInstallationId,
                        "watcherMachineInstallationId",
                    ),
                    pluginId: required(item.watcherPluginId, "watcherPluginId"),
                    materializationId: required(
                        item.watcherMaterializationId, "watcherMaterializationId",
                    ),
                },
        }
        : {
            kind: "durablePush" as const,
            webhookEndpointId: required(item.triggerWebhookEndpointId, "triggerWebhookEndpointId"),
            observationStartsAt: required(
                item.triggerObservationStartsAt,
                "triggerObservationStartsAt",
            ).getTime(),
        };

    return {
        kind: "pluginEvent" as const,
        eventRef: {
            pluginId: required(item.triggerEventPluginId, "triggerEventPluginId"),
            localId: required(item.triggerEventLocalId, "triggerEventLocalId"),
        },
        sourceSelectorId: required(item.triggerSourceSelectorId, "triggerSourceSelectorId"),
        sourceContractVersion: required(
            item.triggerSourceContractVersion,
            "triggerSourceContractVersion",
        ),
        observation,
    };
}

/**
 * One owner for the bounded existing-Session association. It reads the target
 * structurally from the current strict recipe, which the Definition writer only
 * accepts on a plaintext Account, so this discloses nothing the same reader
 * cannot already see in the exact definition. A retained predecessor template
 * stays undisclosed: its association is an outer identifier that only a client
 * able to open the template may trust.
 */
function readAutomationDefinitionExistingSessionId(item: AutomationListItem): string | null {
    if (item.targetType !== "existing_session") {
        return null;
    }
    const parsed = parseAutomationRunExecutionRecipeV1(item.templateCiphertext);
    if (parsed.kind !== "available" || parsed.recipe.templateVersion !== item.templateVersion) {
        return null;
    }
    const target = parsed.recipe.target;
    return target.kind === "existingSession" ? target.sessionId : null;
}

function toAutomationV3DefinitionCommon(
    item: AutomationListItem,
    eventStatusProjection?: AutomationV3EventStatusProjection,
) {
    return {
        id: item.id,
        name: item.name,
        description: item.description,
        enabled: item.enabled,
        trigger: toAutomationV3Trigger(item),
        targetType: toAutomationTargetTypeV3(item.targetType),
        existingSessionId: readAutomationDefinitionExistingSessionId(item),
        templateVersion: item.templateVersion,
        nextRunAt: item.nextRunAt?.getTime() ?? null,
        lastRunAt: item.lastRunAt?.getTime() ?? null,
        createdAt: item.createdAt.getTime(),
        updatedAt: item.updatedAt.getTime(),
        assignments: item.assignments.map((assignment) => ({
            machineId: assignment.machineId,
            enabled: assignment.enabled,
            priority: assignment.priority,
            updatedAt: assignment.updatedAt?.getTime() ?? null,
        })),
        ...(item.triggerKind === "pluginEvent"
            ? {
                sourceStatus: eventStatusProjection?.sourceStatus ?? null,
                sourceCatalogStatus: eventStatusProjection?.sourceCatalogStatus ?? null,
            }
            : {}),
    };
}

function projectAutomationV3DefinitionDetailContent(params: Readonly<{
    item: AutomationListItem;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
}>) {
    const parsedRecipe = parseAutomationRunExecutionRecipeV1(params.item.templateCiphertext);
    if (parsedRecipe.kind === "available") {
        const outer = validateAutomationRunExecutionRecipeOuterV1({
            recipe: parsedRecipe.recipe,
            accountCurrentness: params.accountCurrentness,
        });
        if (outer.kind !== "available") {
            throw new AutomationStoredContentReadError("modeMismatch");
        }
        return { executionRecipe: outer.recipe };
    }

    if (params.item.targetType === "execution_run") {
        throw new AutomationStoredContentReadError("contentInvalid");
    }
    try {
        assertAutomationTemplateEnvelopeForAccountMode(
            params.item.templateCiphertext,
            params.accountCurrentness.mode,
            params.item.targetType,
            readLegacyExistingSessionTemplateAdmission(
                params.item.templateCiphertext,
                params.item.targetType,
            ),
        );
    } catch (error) {
        if (error instanceof AutomationValidationError) {
            throw new AutomationStoredContentReadError("contentInvalid");
        }
        throw error;
    }
    return { templateCiphertext: params.item.templateCiphertext };
}

/** Current bounded list projection; it never carries private source/configuration bytes. */
export function toAutomationV3DefinitionListItemApiDto(
    item: AutomationListItem,
    eventStatusProjection?: AutomationV3EventStatusProjection,
) {
    return AutomationV3DefinitionListItemSchema.parse(
        toAutomationV3DefinitionCommon(item, eventStatusProjection),
    );
}

/** Current authenticated definition detail; no synthetic schedule fields. */
export function toAutomationV3DefinitionDetailApiDto(
    item: AutomationListItem,
    accountCurrentness: AutomationAccountCurrentnessWitnessV1,
    eventStatusProjection?: AutomationV3EventStatusProjection,
) {
    if (item.triggerKind === "pluginEvent" || item.triggerKind === "conversation") {
        const binding = readAutomationTriggerDefinitionBinding({
            automationId: item.id,
            templateVersion: item.templateVersion,
            triggerKind: item.triggerKind,
            triggerEventPluginId: item.triggerEventPluginId,
            triggerEventLocalId: item.triggerEventLocalId,
            triggerSourceSelectorId: item.triggerSourceSelectorId,
        });
        if (binding === null) {
            throw new AutomationStoredContentReadError("contentInvalid");
        }
        assertAutomationTriggerDefinitionEnvelopeOuterForMode({
            raw: required(item.triggerDefinitionEnvelope, "triggerDefinitionEnvelope"),
            mode: accountCurrentness.mode,
            binding,
        });
    }
    return AutomationV3DefinitionDetailSchema.parse({
        ...toAutomationV3DefinitionCommon(item, eventStatusProjection),
        ...projectAutomationV3DefinitionDetailContent({ item, accountCurrentness }),
        triggerDefinitionEnvelope: item.triggerKind === "schedule" || item.triggerKind === "manual"
            ? null
            : required(item.triggerDefinitionEnvelope, "triggerDefinitionEnvelope"),
    });
}

function toAutomationV3Origin(item: AutomationRunItem) {
    if (item.originKind === "scheduled") {
        return { kind: "scheduled" as const, scheduledFor: item.dueAt.getTime() };
    }
    if (item.originKind === "manual") {
        return { kind: "manual" as const, invokedAt: item.createdAt.getTime() };
    }
    if (item.originKind === "pluginEvent") {
        return {
            kind: "pluginEvent" as const,
            occurrenceKey: required(item.occurrenceKey, "occurrenceKey"),
            sourceSelectorId: required(item.originSourceSelectorId, "originSourceSelectorId"),
            occurredAt: required(item.originOccurredAt, "originOccurredAt").getTime(),
        };
    }
    return {
        kind: "conversation" as const,
        occurrenceKey: required(item.occurrenceKey, "occurrenceKey"),
        occurredAt: required(item.originOccurredAt, "originOccurredAt").getTime(),
    };
}

/** The one immutable Run-origin projection shared by public and worker reads. */
export function toAutomationRunV3OriginApiDto(item: AutomationRunItem) {
    return AutomationV3RunOriginSchema.parse(toAutomationV3Origin(item));
}

/** Bounded V3 list projection; private data belongs only in exact detail. */
export function toAutomationRunV3ListApiDto(item: AutomationRunItem) {
    return AutomationV3RunListItemSchema.parse({
        id: item.id,
        automationId: item.automationId,
        state: item.state,
        origin: toAutomationRunV3OriginApiDto(item),
        dueAt: item.dueAt.getTime(),
        claimedAt: item.claimedAt?.getTime() ?? null,
        startedAt: item.startedAt?.getTime() ?? null,
        finishedAt: item.finishedAt?.getTime() ?? null,
        claimedByMachineId: item.claimedByMachineId,
        leaseExpiresAt: item.leaseExpiresAt?.getTime() ?? null,
        attempt: item.attempt,
        errorCode: item.errorCode,
        producedSessionId: item.producedSessionId,
        executionDispatchState: item.executionDispatchState,
        executionAttempt: item.executionAttempt,
        replyHandoffState: item.replyHandoffState,
        replyHandoffAttempt: item.replyHandoffAttempt,
        replyHandoffDueAt: item.replyHandoffDueAt?.getTime() ?? null,
        createdAt: item.createdAt.getTime(),
        updatedAt: item.updatedAt.getTime(),
    });
}

function projectStoredResultDetail(
    resultEnvelope: string | null,
    mode?: "plain" | "e2ee",
): Readonly<{
    resultEnvelope: string | null;
    legacySummaryCiphertext: string | null;
}> {
    if (resultEnvelope === null) {
        return { resultEnvelope: null, legacySummaryCiphertext: null };
    }
    const raw = parseStoredContentEnvelope(resultEnvelope);
    const parsed = AutomationRunResultStoredV1Schema.safeParse(raw);
    if (!parsed.success) {
        throw new AutomationStoredContentReadError("contentInvalid");
    }
    if (mode === undefined) {
        return { resultEnvelope, legacySummaryCiphertext: null };
    }
    const outer = validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
        content: "result",
        mode,
        envelope: raw,
    });
    if (outer.kind === "legacyUnsupported") {
        return {
            resultEnvelope: null,
            legacySummaryCiphertext: parsed.data.t === "legacySummaryCiphertext"
                ? parsed.data.c
                : null,
        };
    }
    if (outer.kind === "modeMismatch") {
        throw new AutomationStoredContentReadError("modeMismatch");
    }
    if (outer.kind !== "available") {
        throw new AutomationStoredContentReadError("contentInvalid");
    }
    return { resultEnvelope, legacySummaryCiphertext: null };
}

/**
 * The legacy database column carries either a released-V2 raw message or the
 * current exact private envelope. A V3 detail never reinterprets raw legacy
 * text as current private content; only the strict current carrier is exposed.
 */
function projectStoredFailureDetail(
    errorMessage: string | null,
    mode: "plain" | "e2ee",
): string | null {
    if (errorMessage === null) return null;
    const envelope = parseAutomationRunFailureDetailStoredEnvelopeV1(errorMessage);
    if (envelope === null) return null;
    const outer = validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1({
        mode,
        envelope,
    });
    if (outer.kind === "modeMismatch") {
        throw new AutomationStoredContentReadError("modeMismatch");
    }
    if (outer.kind !== "available") {
        throw new AutomationStoredContentReadError("contentInvalid");
    }
    return errorMessage;
}

function readBoundedEventString(
    payload: Record<string, unknown> | null,
    key: string,
    maxChars: number,
): string | null {
    const value = payload?.[key];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.slice(0, maxChars) : null;
}

function readEventInteger(
    payload: Record<string, unknown> | null,
    key: string,
): number | null {
    const value = payload?.[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

/**
 * The Run transition history the lifecycle owners already write, projected as
 * bounded non-secret facts. Persisted payloads are server-authored, but this
 * projection still reads only the named keys so a future writer cannot leak an
 * unexpected field into a user-facing response.
 */
function projectRunEvents(
    events: readonly AutomationRunEventRow[] | undefined,
): readonly unknown[] {
    if (!events || events.length === 0) return [];
    // Selected newest-first so a long-lived Run keeps its decision-relevant
    // tail; the contract presents transitions in the order they happened.
    return [...events].reverse().map((event) => {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? event.payload as Record<string, unknown>
            : null;
        return {
            at: event.ts.getTime(),
            type: event.type.slice(0, 64),
            machineId: readBoundedEventString(payload, "machineId", 128),
            errorCode: readBoundedEventString(payload, "errorCode", 128),
            executionAttempt: readEventInteger(payload, "executionAttempt"),
            outcome: readBoundedEventString(payload, "outcome", 64),
            reason: readBoundedEventString(payload, "reason", 128),
        };
    });
}

/**
 * Exact authenticated detail: direct request/result content is available, but
 * opaque reply routing and delivery receipt bytes never leave their owner.
 */
export function toAutomationRunV3DetailApiDto(
    item: AutomationRunItem | AutomationRunDetailItem,
    mode: "plain" | "e2ee",
) {
    assertAutomationStoredContentEnvelopeOuterForMode({
        raw: item.triggerEvidenceEnvelope,
        mode,
    });
    assertAutomationExecutionInputEnvelopeOuterForMode({
        raw: item.executionInputEnvelope,
        mode,
        originKind: item.originKind,
    });
    return AutomationV3RunDetailSchema.parse({
        ...toAutomationRunV3ListApiDto(item),
        triggerEvidenceEnvelope: item.triggerEvidenceEnvelope,
        executionInputEnvelope: item.executionInputEnvelope,
        // The native execution identity is what makes an uncertain Run
        // actionable: without it the user is told the outcome is unknown and
        // given nothing to inspect or stop.
        executionNativeRunId: item.executionNativeRunId,
        executionNativeCallId: item.executionNativeCallId,
        executionNativeSidechainId: item.executionNativeSidechainId,
        events: projectRunEvents("events" in item ? item.events : undefined),
        ...projectStoredResultDetail(item.resultEnvelope, mode),
        errorDetailEnvelope: projectStoredFailureDetail(item.errorMessage, mode),
    });
}
