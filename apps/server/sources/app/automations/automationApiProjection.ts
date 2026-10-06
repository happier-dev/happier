import {
    AutomationDefinitionDetailSchema,
    AutomationDefinitionListItemSchema,
    parseAutomationRunResultStoredEnvelopeV1,
    AutomationV3RunDetailSchema,
    AutomationV3RunListItemSchema,
    createCanonicalJsonSigningInput,
    parseAutomationStoredDefinitionExecutionRecipeV1,
    parseAutomationStoredWorkflowDefinitionRecipeV2,
    parseAutomationRunFailureDetailStoredEnvelopeV1,
    validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1,
    validateAutomationStoredDefinitionExecutionRecipeOuterV1,
    validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1,
    type AutomationAccountCurrentnessWitnessV1,
} from "@happier-dev/protocol";

import type { AutomationEventStatusProjection } from "./automationEventStatusProjection";
import type { AutomationSessionLifecycleTriggerStatus } from "@happier-dev/protocol";
import { classifyAutomationReplyHandoffDispatchability } from "./automationReplyHandoffDispatchability";
import { decodeAutomationRunCause, retainedV2OriginKindForRun } from "./automationRunCauseCodec";
import {
    assertAutomationExecutionInputEnvelopeOuterForMode,
    assertAutomationStoredContentEnvelopeOuterForMode,
    assertAutomationTriggerDefinitionEnvelopeOuterForMode,
    AutomationStoredContentReadError,
    readAutomationTriggerDefinitionBinding,
} from "./automationStoredContentRead";
import type {
    AutomationListItem,
    AutomationRunDetailItem,
    AutomationRunEventRow,
    AutomationRunItem,
    AutomationRunV3ListItem,
    AutomationTargetType,
    AutomationTriggerItem,
} from "./automationTypes";
import { decodeAutomationSessionLifecycleConfiguration } from "./automationSessionLifecycleConfigurationCodec";
import { decodeAutomationRunLifecycleConfiguration } from "./automationRunLifecycleConfigurationCodec";
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

function targetTypeV3(targetType: AutomationTargetType | null) {
    if (targetType === null) return null;
    return targetType === "new_session" ? "newSession" as const
        : targetType === "existing_session" ? "existingSession" as const
            : "executionRun" as const;
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
    if (trigger.kind === "prComment" || trigger.kind === "ciFailed") {
        return { ...common, kind: trigger.kind, sourceSessionId: required(trigger.sourceSessionId, "sourceSessionId"),
            ...(includeDefinition ? { triggerDefinitionEnvelope: required(trigger.definitionEnvelope, "definitionEnvelope") } : {}) };
    }
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
        const lifecycle = decodeAutomationSessionLifecycleConfiguration(trigger);
        return {
            ...common,
            ...lifecycle.definition,
            remainingOccurrences: lifecycle.remainingOccurrences,
            status: required(lifecycleStatuses.get(trigger.id), "sessionLifecycle status"),
            ...(includeDefinition ? { triggerDefinitionEnvelope: null } : {}),
        };
    }
    if (trigger.kind === "runLifecycle") {
        return { ...common, ...decodeAutomationRunLifecycleConfiguration(trigger), remainingOccurrences: trigger.remainingOccurrences,
            status: { state: !trigger.enabled ? "paused" as const : trigger.remainingOccurrences === 1 ? "waiting" as const : "finished" as const, runId: null },
            ...(includeDefinition ? { triggerDefinitionEnvelope: null } : {}) };
    }
    const status = statuses.get(trigger.id);
    const watcherObservation = () => ({
        watcher: trigger.watcherMachineId === null ? null : {
            machineId: trigger.watcherMachineId,
            machineInstallationId: required(trigger.watcherMachineInstallationId, "watcherMachineInstallationId"),
            pluginId: required(trigger.watcherPluginId, "watcherPluginId"),
            materializationId: required(trigger.watcherMaterializationId, "watcherMaterializationId"),
        },
    });
    const observation = trigger.observationTransport === "checkpointedPull"
        ? { kind: "checkpointedPull" as const, ...watcherObservation() }
        : trigger.observationTransport === "socket"
            ? { kind: "socket" as const, ...watcherObservation() }
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
) {
    return {
        id: item.id, name: item.name, description: item.description, enabled: item.enabled,
        targetType: targetTypeV3(item.targetType), existingSessionId: readExistingSessionId(item),
        workflowDefinitionId: item.workflowDefinitionId, scopeSessionId: item.scopeSessionId,
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
    };
}

export function toAutomationDefinitionListItemApiDto(
    item: AutomationListItem,
    statuses: ReadonlyMap<string, AutomationEventStatusProjection> = new Map(),
    lifecycleStatuses: ReadonlyMap<string, AutomationSessionLifecycleTriggerStatus> = new Map(),
) {
    return AutomationDefinitionListItemSchema.parse(definitionCommon(
        item,
        statuses,
        lifecycleStatuses,
        false,
    ));
}

export function toAutomationDefinitionDetailApiDto(
    item: AutomationListItem,
    accountCurrentness: AutomationAccountCurrentnessWitnessV1,
    statuses: ReadonlyMap<string, AutomationEventStatusProjection> = new Map(),
    lifecycleStatuses: ReadonlyMap<string, AutomationSessionLifecycleTriggerStatus> = new Map(),
) {
    for (const trigger of item.triggers) {
        if (trigger.kind !== "pluginEvent" && trigger.kind !== "prComment" && trigger.kind !== "ciFailed") continue;
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
        const workflow = parseAutomationStoredWorkflowDefinitionRecipeV2(item.templateCiphertext);
        if (workflow.kind === "available") {
            if (item.targetType !== null || workflow.recipe.templateVersion !== item.templateVersion) {
                throw new AutomationStoredContentReadError("contentInvalid");
            }
            assertAutomationStoredContentEnvelopeOuterForMode({
                raw: createCanonicalJsonSigningInput(workflow.recipe.workflow),
                mode: accountCurrentness.mode,
            });
            content = { executionRecipe: workflow.recipe };
            return AutomationDefinitionDetailSchema.parse({
                ...definitionCommon(item, statuses, lifecycleStatuses, true),
                ...content,
            });
        }
        if (item.targetType === null || item.targetType === "execution_run") {
            throw new AutomationStoredContentReadError("contentInvalid");
        }
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
        ...definitionCommon(item, statuses, lifecycleStatuses, true),
        ...content,
    });
}

/** Sole public projection of immutable Run cause. */
export function toAutomationRunCauseApiDto(item: AutomationRunV3ListItem | AutomationRunItem) {
    return decodeAutomationRunCause(item);
}

export function toAutomationRunV3ListApiDto(item: AutomationRunV3ListItem | AutomationRunItem) {
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
    const parsed = parseAutomationRunResultStoredEnvelopeV1(raw);
    if (parsed === null) throw new AutomationStoredContentReadError("contentInvalid");
    const outer = validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({ content: "result", mode, envelope: parsed });
    if (outer.kind === "legacyUnsupported") {
        return { resultEnvelope: null, legacySummaryCiphertext: parsed.t === "legacySummaryCiphertext" ? parsed.c : null };
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

/**
 * Whether a present user can do anything about a blocked Conversation reply
 * handoff. It asks the one dispatchability owner the claim path uses, so the
 * product never offers a recovery the server is guaranteed to refuse. Only a
 * `blocked` handoff answers this question; every other state is either still
 * moving or already settled.
 */
function isAutomationReplyHandoffRecoverable(
    item: AutomationRunItem | AutomationRunDetailItem,
    mode: "plain" | "e2ee",
): boolean | null {
    if (item.replyHandoffState !== "blocked") return null;
    return classifyAutomationReplyHandoffDispatchability({
        facts: item,
        mode,
    }) === "dispatchable";
}

export function toAutomationRunV3DetailApiDto(
    item: AutomationRunItem | AutomationRunDetailItem,
    mode: "plain" | "e2ee",
) {
    const listItem = toAutomationRunV3ListApiDto(item);
    const common = {
        ...listItem,
        replyHandoffRecoverable: isAutomationReplyHandoffRecoverable(item, mode),
        executionNativeRunId: item.executionNativeRunId,
        executionNativeCallId: item.executionNativeCallId,
        executionNativeSidechainId: item.executionNativeSidechainId,
        events: projectRunEvents("events" in item ? item.events : undefined),
    };
    assertAutomationStoredContentEnvelopeOuterForMode({ raw: item.triggerEvidenceEnvelope, mode });
    assertAutomationExecutionInputEnvelopeOuterForMode({
        raw: item.executionInputEnvelope, mode,
        retainedV2OriginKind: retainedV2OriginKindForRun(item),
    });
    return AutomationV3RunDetailSchema.parse({
        ...common, triggerEvidenceEnvelope: item.triggerEvidenceEnvelope,
        executionInputEnvelope: item.executionInputEnvelope,
        ...storedResultDetail(item.resultEnvelope, mode),
        errorDetailEnvelope: storedFailureDetail(item.errorMessage, mode),
    });
}
