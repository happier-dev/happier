import {
    AutomationApiV2Schema,
    AutomationDefinitionDetailSchema,
    AutomationDefinitionListItemSchema,
    AutomationRunApiV2Schema,
    AutomationRunResultStoredV1Schema,
    AutomationV3RunDetailSchema,
    AutomationV3RunListItemSchema,
    normalizeAutomationTemplateEnvelopeStoredRead,
    parseAutomationStoredDefinitionExecutionRecipeV1,
    parseAutomationRunFailureDetailStoredEnvelopeV1,
    validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1,
    validateAutomationStoredDefinitionExecutionRecipeOuterV1,
    validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1,
    type AutomationAccountCurrentnessWitnessV1,
} from "@happier-dev/protocol";

import type { AutomationEventStatusProjection } from "./automationEventStatusProjection";
import type { AutomationSessionLifecycleTriggerStatus } from "@happier-dev/protocol";
import type { AutomationRetiredTriggerProjectionItem } from "./automationRetiredTriggerProjection";
import { decodeAutomationRunCause } from "./automationRunCauseCodec";
import {
    assertAutomationExecutionInputEnvelopeOuterForMode,
    assertAutomationStoredContentEnvelopeOuterForMode,
    assertAutomationTriggerDefinitionEnvelopeOuterForMode,
    AutomationStoredContentReadError,
    readAutomationTriggerDefinitionBinding,
    readRetainedAutomationRunExecutionInputV2,
} from "./automationStoredContentRead";
import type {
    AutomationLegacyTargetType,
    AutomationListItem,
    AutomationRunDetailItem,
    AutomationRunEventRow,
    AutomationRunItem,
    AutomationTargetType,
    AutomationTriggerItem,
} from "./automationTypes";
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
    try { return JSON.parse(raw); } catch { throw new AutomationStoredContentReadError("contentInvalid"); }
}

function targetTypeV3(targetType: AutomationTargetType) {
    return targetType === "new_session" ? "newSession" as const
        : targetType === "existing_session" ? "existingSession" as const
            : "executionRun" as const;
}

function hasRetainedV2TemplateEnvelope(raw: string): boolean {
    try { return normalizeAutomationTemplateEnvelopeStoredRead(JSON.parse(raw)) !== null; } catch { return false; }
}

/** Released V2 represents exactly one retained schedule and nothing else. */
export function isAutomationDefinitionRepresentableInV2(
    item: AutomationListItem,
): item is AutomationListItem & Readonly<{ targetType: AutomationLegacyTargetType }> {
    const trigger = item.triggers.length === 1 ? item.triggers[0] : undefined;
    return trigger?.kind === "schedule"
        && trigger.scheduleKind !== null
        && item.targetType !== "execution_run"
        && parseAutomationStoredDefinitionExecutionRecipeV1(item.templateCiphertext).kind !== "available"
        && hasRetainedV2TemplateEnvelope(item.templateCiphertext);
}

function retainedV2CauseKind(item: AutomationRunItem): "scheduled" | "manual" | null {
    const cause = decodeAutomationRunCause(item);
    if (cause.kind === "manual") return "manual";
    return cause.kind === "trigger" && cause.triggerKind === "schedule" ? "scheduled" : null;
}

export function isAutomationRunV2Compatible(item: AutomationRunItem): boolean {
    const retainedV2OriginKind = retainedV2CauseKind(item);
    return retainedV2OriginKind !== null
        && item.executionInputEnvelope !== null
        && readRetainedAutomationRunExecutionInputV2({
            raw: item.executionInputEnvelope,
            retainedV2OriginKind,
        }) !== null;
}

export function toAutomationV2ApiDto(item: AutomationListItem) {
    if (!isAutomationDefinitionRepresentableInV2(item)) {
        throw new Error("Automation is not representable by the V2 contract");
    }
    const trigger = required(item.triggers[0], "sole schedule trigger");
    return AutomationApiV2Schema.parse({
        id: item.id, name: item.name, description: item.description, enabled: item.enabled,
        schedule: {
            kind: required(trigger.scheduleKind, "scheduleKind"),
            scheduleExpr: trigger.scheduleExpr, everyMs: trigger.everyMs, timezone: trigger.timezone,
        },
        targetType: item.targetType,
        templateCiphertext: item.templateCiphertext,
        templateVersion: item.templateVersion,
        nextRunAt: trigger.nextRunAt?.getTime() ?? null,
        lastRunAt: item.lastRunAt?.getTime() ?? null,
        createdAt: item.createdAt.getTime(), updatedAt: item.updatedAt.getTime(),
        assignments: item.assignments.map((assignment) => ({
            machineId: assignment.machineId, enabled: assignment.enabled, priority: assignment.priority,
            updatedAt: assignment.updatedAt?.getTime() ?? null,
        })),
    });
}

export function toAutomationRunV2ApiDto(item: AutomationRunItem) {
    if (!isAutomationRunV2Compatible(item)) {
        throw new Error("Automation Run is not representable by the V2 contract");
    }
    let summaryCiphertext: string | null = null;
    if (item.resultEnvelope !== null) {
        const result = AutomationRunResultStoredV1Schema.safeParse(parseStoredContentEnvelope(item.resultEnvelope));
        if (!result.success) throw new AutomationStoredContentReadError("contentInvalid");
        summaryCiphertext = result.data.t === "legacySummaryCiphertext" ? result.data.c : null;
    }
    return AutomationRunApiV2Schema.parse({
        id: item.id, automationId: item.automationId, state: item.state,
        scheduledAt: item.scheduledAt.getTime(), dueAt: item.dueAt.getTime(),
        claimedAt: item.claimedAt?.getTime() ?? null, startedAt: item.startedAt?.getTime() ?? null,
        finishedAt: item.finishedAt?.getTime() ?? null, claimedByMachineId: item.claimedByMachineId,
        leaseExpiresAt: item.leaseExpiresAt?.getTime() ?? null, attempt: item.attempt,
        summaryCiphertext, errorCode: item.errorCode,
        errorMessage: item.errorMessage !== null
            && parseAutomationRunFailureDetailStoredEnvelopeV1(item.errorMessage) === null
            ? item.errorMessage : null,
        producedSessionId: item.producedSessionId,
        createdAt: item.createdAt.getTime(), updatedAt: item.updatedAt.getTime(),
    });
}

function triggerProjection(
    trigger: AutomationTriggerItem,
    statuses: ReadonlyMap<string, AutomationEventStatusProjection>,
    lifecycleStatuses: ReadonlyMap<string, AutomationSessionLifecycleTriggerStatus>,
    includeDefinition: boolean,
) {
    const common = {
        id: trigger.id, revision: trigger.revision, enabled: trigger.enabled,
        createdAt: trigger.createdAt.getTime(), updatedAt: trigger.updatedAt.getTime(),
    };
    if (trigger.kind === "schedule") {
        return {
            ...common, kind: "schedule" as const,
            schedule: {
                kind: required(trigger.scheduleKind, "scheduleKind"),
                scheduleExpr: trigger.scheduleExpr, everyMs: trigger.everyMs, timezone: trigger.timezone,
            },
            nextRunAt: trigger.nextRunAt?.getTime() ?? null,
            ...(includeDefinition ? { triggerDefinitionEnvelope: null } : {}),
        };
    }
    if (trigger.kind === "sessionLifecycle") {
        return {
            ...common, kind: "sessionLifecycle" as const,
            event: required(trigger.sessionLifecycleEvent, "sessionLifecycleEvent"),
            scope: {
                kind: "exactTurn" as const,
                sourceSessionId: required(trigger.sourceSessionId, "sourceSessionId"),
                sourceTurnId: required(trigger.sourceTurnId, "sourceTurnId"),
            },
            consumption: "once" as const,
            status: required(lifecycleStatuses.get(trigger.id), "sessionLifecycle status"),
            ...(includeDefinition ? { triggerDefinitionEnvelope: null } : {}),
        };
    }
    const status = statuses.get(trigger.id);
    const observation = trigger.observationTransport === "checkpointedPull"
        ? {
            kind: "checkpointedPull" as const,
            watcher: trigger.watcherMachineId === null ? null : {
                machineId: trigger.watcherMachineId,
                machineInstallationId: required(trigger.watcherMachineInstallationId, "watcherMachineInstallationId"),
                pluginId: required(trigger.watcherPluginId, "watcherPluginId"),
                materializationId: required(trigger.watcherMaterializationId, "watcherMaterializationId"),
            },
        }
        : {
            kind: "durablePush" as const,
            webhookEndpointId: required(trigger.webhookEndpointId, "webhookEndpointId"),
            endpointMaterializationRef: status?.durablePushEndpointMaterializationRef ?? null,
            observationStartsAt: required(trigger.observationStartsAt, "observationStartsAt").getTime(),
        };
    return {
        ...common, kind: "pluginEvent" as const,
        eventRef: { pluginId: required(trigger.eventPluginId, "eventPluginId"), localId: required(trigger.eventLocalId, "eventLocalId") },
        sourceSelectorId: required(trigger.sourceSelectorId, "sourceSelectorId"),
        sourceContractVersion: required(trigger.sourceContractVersion, "sourceContractVersion"),
        observation,
        sourceStatus: status?.sourceStatus ?? null,
        sourceCatalogStatus: status?.sourceCatalogStatus ?? null,
        ...(includeDefinition
            ? { triggerDefinitionEnvelope: required(trigger.definitionEnvelope, "definitionEnvelope") }
            : {}),
    };
}

function readExistingSessionId(item: AutomationListItem): string | null {
    if (item.targetType !== "existing_session") return null;
    const parsed = parseAutomationStoredDefinitionExecutionRecipeV1(item.templateCiphertext);
    if (parsed.kind !== "available" || parsed.recipe.templateVersion !== item.templateVersion) return null;
    return parsed.recipe.target.kind === "existingSession" ? parsed.recipe.target.sessionId : null;
}

function definitionCommon(
    item: AutomationListItem,
    statuses: ReadonlyMap<string, AutomationEventStatusProjection>,
    lifecycleStatuses: ReadonlyMap<string, AutomationSessionLifecycleTriggerStatus>,
    includeDefinitions: boolean,
    retiredTriggers: readonly AutomationRetiredTriggerProjectionItem[],
) {
    return {
        id: item.id, name: item.name, description: item.description, enabled: item.enabled,
        targetType: targetTypeV3(item.targetType), existingSessionId: readExistingSessionId(item),
        templateVersion: item.templateVersion, lastRunAt: item.lastRunAt?.getTime() ?? null,
        createdAt: item.createdAt.getTime(), updatedAt: item.updatedAt.getTime(),
        assignments: item.assignments.map((assignment) => ({
            machineId: assignment.machineId, enabled: assignment.enabled, priority: assignment.priority,
            updatedAt: assignment.updatedAt?.getTime() ?? null,
        })),
        triggers: item.triggers.map((trigger) => triggerProjection(
            trigger,
            statuses,
            lifecycleStatuses,
            includeDefinitions,
        )),
        retiredTriggers: retiredTriggers.map((trigger) => ({
            id: trigger.id,
            kind: trigger.kind,
            revision: trigger.revision,
            retiredAt: trigger.retiredAt.getTime(),
        })),
    };
}

export function toAutomationDefinitionListItemApiDto(
    item: AutomationListItem,
    statuses: ReadonlyMap<string, AutomationEventStatusProjection> = new Map(),
    lifecycleStatuses: ReadonlyMap<string, AutomationSessionLifecycleTriggerStatus> = new Map(),
    retiredTriggers: readonly AutomationRetiredTriggerProjectionItem[] = [],
) {
    return AutomationDefinitionListItemSchema.parse(definitionCommon(
        item,
        statuses,
        lifecycleStatuses,
        false,
        retiredTriggers,
    ));
}

export function toAutomationDefinitionDetailApiDto(
    item: AutomationListItem,
    accountCurrentness: AutomationAccountCurrentnessWitnessV1,
    statuses: ReadonlyMap<string, AutomationEventStatusProjection> = new Map(),
    lifecycleStatuses: ReadonlyMap<string, AutomationSessionLifecycleTriggerStatus> = new Map(),
    retiredTriggers: readonly AutomationRetiredTriggerProjectionItem[] = [],
) {
    for (const trigger of item.triggers) {
        if (trigger.kind !== "pluginEvent") continue;
        const binding = readAutomationTriggerDefinitionBinding({
            automationId: item.id, triggerId: trigger.id, triggerRevision: trigger.revision,
            triggerKind: trigger.kind,
            triggerEventPluginId: trigger.eventPluginId, triggerEventLocalId: trigger.eventLocalId,
            triggerSourceSelectorId: trigger.sourceSelectorId,
        });
        if (binding === null) throw new AutomationStoredContentReadError("contentInvalid");
        assertAutomationTriggerDefinitionEnvelopeOuterForMode({
            raw: required(trigger.definitionEnvelope, "definitionEnvelope"),
            mode: accountCurrentness.mode, binding,
        });
    }
    const parsed = parseAutomationStoredDefinitionExecutionRecipeV1(item.templateCiphertext);
    let content: Readonly<{ executionRecipe: unknown }> | Readonly<{ templateCiphertext: string }>;
    if (parsed.kind === "available") {
        const outer = validateAutomationStoredDefinitionExecutionRecipeOuterV1({
            recipe: parsed.recipe, accountCurrentness,
        });
        if (outer.kind !== "available") throw new AutomationStoredContentReadError("modeMismatch");
        content = { executionRecipe: outer.recipe };
    } else {
        if (item.targetType === "execution_run") throw new AutomationStoredContentReadError("contentInvalid");
        try {
            assertAutomationTemplateEnvelopeForAccountMode(
                item.templateCiphertext, accountCurrentness.mode, item.targetType,
                readLegacyExistingSessionTemplateAdmission(item.templateCiphertext, item.targetType),
            );
        } catch (error) {
            if (error instanceof AutomationValidationError) throw new AutomationStoredContentReadError("contentInvalid");
            throw error;
        }
        content = { templateCiphertext: item.templateCiphertext };
    }
    return AutomationDefinitionDetailSchema.parse({
        ...definitionCommon(item, statuses, lifecycleStatuses, true, retiredTriggers),
        ...content,
    });
}

/** Sole public projection of immutable Run cause. */
export function toAutomationRunCauseApiDto(item: AutomationRunItem) {
    return decodeAutomationRunCause(item);
}

export function toAutomationRunV3ListApiDto(item: AutomationRunItem) {
    const triggerRetired = item.triggerId === null
        ? false
        : required(item.triggerRetired, "triggerRetired currentness projection");
    return AutomationV3RunListItemSchema.parse({
        id: item.id, automationId: item.automationId, revision: item.revision,
        triggerId: item.triggerId, triggerRetired,
        state: item.state, cause: toAutomationRunCauseApiDto(item), dueAt: item.dueAt.getTime(),
        claimedAt: item.claimedAt?.getTime() ?? null, startedAt: item.startedAt?.getTime() ?? null,
        finishedAt: item.finishedAt?.getTime() ?? null, claimedByMachineId: item.claimedByMachineId,
        leaseExpiresAt: item.leaseExpiresAt?.getTime() ?? null, attempt: item.attempt,
        errorCode: item.errorCode, producedSessionId: item.producedSessionId,
        executionDispatchState: item.executionDispatchState, executionAttempt: item.executionAttempt,
        replyHandoffState: item.replyHandoffState, replyHandoffAttempt: item.replyHandoffAttempt,
        replyHandoffDueAt: item.replyHandoffDueAt?.getTime() ?? null,
        createdAt: item.createdAt.getTime(), updatedAt: item.updatedAt.getTime(),
    });
}

function eventString(payload: Record<string, unknown> | null, key: string, max: number): string | null {
    const value = payload?.[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function eventInteger(payload: Record<string, unknown> | null, key: string): number | null {
    const value = payload?.[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function projectRunEvents(events: readonly AutomationRunEventRow[] | undefined): readonly unknown[] {
    return [...(events ?? [])].reverse().map((event) => {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? event.payload as Record<string, unknown> : null;
        return {
            at: event.ts.getTime(), type: event.type.slice(0, 64),
            machineId: eventString(payload, "machineId", 128), errorCode: eventString(payload, "errorCode", 128),
            executionAttempt: eventInteger(payload, "executionAttempt"), outcome: eventString(payload, "outcome", 64),
            reason: eventString(payload, "reason", 128),
        };
    });
}

function storedResultDetail(raw: string | null, mode: "plain" | "e2ee") {
    if (raw === null) return { resultEnvelope: null, legacySummaryCiphertext: null };
    const parsedRaw = parseStoredContentEnvelope(raw);
    const parsed = AutomationRunResultStoredV1Schema.safeParse(parsedRaw);
    if (!parsed.success) throw new AutomationStoredContentReadError("contentInvalid");
    const outer = validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({ content: "result", mode, envelope: parsedRaw });
    if (outer.kind === "legacyUnsupported") {
        return { resultEnvelope: null, legacySummaryCiphertext: parsed.data.t === "legacySummaryCiphertext" ? parsed.data.c : null };
    }
    if (outer.kind !== "available") throw new AutomationStoredContentReadError(outer.kind === "modeMismatch" ? "modeMismatch" : "contentInvalid");
    return { resultEnvelope: raw, legacySummaryCiphertext: null };
}

function storedFailureDetail(raw: string | null, mode: "plain" | "e2ee"): string | null {
    if (raw === null) return null;
    const envelope = parseAutomationRunFailureDetailStoredEnvelopeV1(raw);
    if (envelope === null) return null;
    const outer = validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1({ mode, envelope });
    if (outer.kind !== "available") throw new AutomationStoredContentReadError(outer.kind === "modeMismatch" ? "modeMismatch" : "contentInvalid");
    return raw;
}

export function toAutomationRunV3DetailApiDto(
    item: AutomationRunItem | AutomationRunDetailItem,
    mode: "plain" | "e2ee",
) {
    const listItem = toAutomationRunV3ListApiDto(item);
    const common = {
        ...listItem,
        executionNativeRunId: item.executionNativeRunId,
        executionNativeCallId: item.executionNativeCallId,
        executionNativeSidechainId: item.executionNativeSidechainId,
        events: projectRunEvents("events" in item ? item.events : undefined),
    };
    assertAutomationStoredContentEnvelopeOuterForMode({ raw: item.triggerEvidenceEnvelope, mode });
    assertAutomationExecutionInputEnvelopeOuterForMode({
        raw: item.executionInputEnvelope, mode,
        retainedV2OriginKind: retainedV2CauseKind(item) ?? undefined,
    });
    return AutomationV3RunDetailSchema.parse({
        ...common, triggerEvidenceEnvelope: item.triggerEvidenceEnvelope,
        executionInputEnvelope: item.executionInputEnvelope,
        ...storedResultDetail(item.resultEnvelope, mode),
        errorDetailEnvelope: storedFailureDetail(item.errorMessage, mode),
    });
}
