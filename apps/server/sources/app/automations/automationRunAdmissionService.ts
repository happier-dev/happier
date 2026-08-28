import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
    MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT,
    AutomationRunCauseSchema,
    AutomationRunExecutionInputV1Schema,
    createCanonicalJsonSigningInput,
    normalizeAutomationTemplateEnvelopeStoredRead,
    parseAutomationStoredDefinitionExecutionRecipeV1,
    serializeAutomationRunExecutionRecipeV1,
    toAutomationRunExecutionInputV1Origin,
    type AutomationRunCause,
} from "@happier-dev/protocol";

import { afterTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

import { automationRunItemSelect } from "./automationPersistenceSelect";
import {
    decodeAutomationRunCause,
    encodeAutomationRunCause,
} from "./automationRunCauseCodec";
import {
    AUTOMATION_RUN_TERMINAL_STATES,
    initialAutomationExecutionDispatchStateForRun,
    type AutomationRunItem,
} from "./automationTypes";
import {
    emitAutomationRunTransition,
    emitAutomationRunUpdatedToMachineOnly,
} from "./automationChangePublisher";

export type AutomationRunAdmissionIneligibleReason =
    | "automationNotFound"
    | "automationDisabled"
    | "triggerNotFound"
    | "triggerDisabled"
    | "triggerRevisionMismatch"
    | "triggerKindMismatch"
    | "capacity"
    | "idempotencyKeyInvalid"
    | "definitionInvalid";

export type AutomationRunAdmissionResult =
    | Readonly<{ kind: "admitted"; run: AutomationRunItem }>
    | Readonly<{ kind: "rejoined"; run: AutomationRunItem }>
    | Readonly<{ kind: "ineligible"; reason: AutomationRunAdmissionIneligibleReason }>;

export type AutomationRunReplyHandoffAdmission = Readonly<{
    contextEnvelope: string;
    actionPluginId: string;
    actionLocalId: string;
    targetMachineId: string;
    targetMachineInstallationId: string;
    targetMaterializationId: string;
}>;

function replyHandoffIdForRun(runId: string): string {
    return `automation-reply-handoff:${runId}`;
}

function sameOccurrenceCause(left: AutomationRunCause, right: AutomationRunCause): boolean {
    // A manual idempotency key identifies the invocation. Retry wall-clock
    // time is not a second immutable fact and must not make that retry collide.
    if (left.kind === "manual" && right.kind === "manual") return true;
    const withoutMutableRevision = (cause: AutomationRunCause): unknown => {
        if (cause.kind !== "trigger") return cause;
        const { triggerRevision: _mutableRevision, ...immutableOccurrence } = cause;
        return immutableOccurrence;
    };
    return createCanonicalJsonSigningInput(withoutMutableRevision(left))
        === createCanonicalJsonSigningInput(withoutMutableRevision(right));
}

export type AutomationRunAdmissionRequest = Readonly<{
    automationId: string;
    now: Date;
    cause: AutomationRunCause;
    triggerEvidenceEnvelope?: string | null;
    executionTriggerEvidenceEnvelope?: string | null;
    occurrenceEvidenceEqualityTag?: string | null;
    manualIdempotencyKey?: string;
    replyHandoff?: AutomationRunReplyHandoffAdmission;
}>;

function parseTriggerEvidenceEnvelope(raw: string | null | undefined): unknown | null {
    if (raw === null || raw === undefined) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

function targetTypeForRecipe(recipe: Readonly<{ target: Readonly<{ kind: string }> }>) {
    if (recipe.target.kind === "newSession") return "new_session" as const;
    if (recipe.target.kind === "existingSession") return "existing_session" as const;
    return "execution_run" as const;
}

function occurrenceDiscriminator(params: Readonly<{
    automationId: string;
    cause: AutomationRunCause;
    manualIdempotencyKey?: string;
}>): Prisma.AutomationRunWhereInput | null {
    return params.cause.kind === "trigger"
        ? { triggerId: params.cause.triggerId, occurrenceKey: params.cause.occurrenceKey }
        : params.cause.kind === "conversation"
            ? {
                automationId: params.automationId,
                causeKind: "conversation",
                occurrenceKey: params.cause.occurrenceKey,
            }
            : params.manualIdempotencyKey
                ? {
                    automationId: params.automationId,
                    causeKind: "manual",
                    legacyManualIdempotencyKey: params.manualIdempotencyKey,
                }
                : null;
}

function findExistingRun(params: Readonly<{
    rows: readonly AutomationRunItem[];
    automationId: string;
    cause: AutomationRunCause;
    manualIdempotencyKey?: string;
    occurrenceEvidenceEqualityTag?: string | null;
}>): AutomationRunItem | null {
    const existing = params.rows.find((row) => {
        if (row.automationId !== params.automationId) return false;
        if (params.cause.kind === "trigger") {
            return row.triggerId === params.cause.triggerId
                && row.occurrenceKey === params.cause.occurrenceKey;
        }
        if (params.cause.kind === "conversation") {
            return row.causeKind === "conversation"
                && row.occurrenceKey === params.cause.occurrenceKey;
        }
        return params.manualIdempotencyKey !== undefined
            && row.causeKind === "manual"
            && row.legacyManualIdempotencyKey === params.manualIdempotencyKey;
    }) ?? null;
    if (!existing) return null;
    if (!sameOccurrenceCause(decodeAutomationRunCause(existing), params.cause)
        || existing.occurrenceEvidenceEqualityTag !== (params.occurrenceEvidenceEqualityTag ?? null)) {
        throw new Error("Automation occurrence identity collided with different immutable cause evidence");
    }
    return existing;
}

const automationAdmissionDefinitionSelect = {
    id: true,
    enabled: true,
    targetType: true,
    templateVersion: true,
    templateCiphertext: true,
    assignments: {
        where: { enabled: true },
        select: { machineId: true, priority: true },
        orderBy: [{ priority: "desc" as const }, { machineId: "asc" as const }],
    },
} satisfies Prisma.AutomationSelect;

type AutomationAdmissionDefinition = Prisma.AutomationGetPayload<{
    select: typeof automationAdmissionDefinitionSelect;
}>;

const automationAdmissionTriggerSelect = {
    id: true,
    automationId: true,
    enabled: true,
    revision: true,
    kind: true,
} satisfies Prisma.AutomationTriggerSelect;

type AutomationAdmissionTrigger = Prisma.AutomationTriggerGetPayload<{
    select: typeof automationAdmissionTriggerSelect;
}>;

type PreparedAutomationRunAdmission = Readonly<{
    request: AutomationRunAdmissionRequest;
    cause: AutomationRunCause;
    executionInputEnvelope: string;
    automation: AutomationAdmissionDefinition;
}>;

type PreparedAutomationRunAdmissionResult =
    | AutomationRunAdmissionResult
    | Readonly<{ kind: "prepared"; admission: PreparedAutomationRunAdmission }>;

function consumesEventConversationCapacity(cause: AutomationRunCause): boolean {
    return cause.kind === "conversation"
        || (cause.kind === "trigger" && cause.triggerKind === "pluginEvent");
}

function prepareAutomationRunAdmission(params: Readonly<{
    request: AutomationRunAdmissionRequest;
    cause: AutomationRunCause;
    existingRuns: readonly AutomationRunItem[];
    automationsById: ReadonlyMap<string, AutomationAdmissionDefinition>;
    triggersById: ReadonlyMap<string, AutomationAdmissionTrigger>;
}>): PreparedAutomationRunAdmissionResult {
    const cause = params.cause;
    const existing = findExistingRun({
        rows: params.existingRuns,
        ...params.request,
        cause,
    });
    if (existing) return { kind: "rejoined", run: existing };

    const automation = params.automationsById.get(params.request.automationId);
    if (!automation) return { kind: "ineligible", reason: "automationNotFound" };
    if (!automation.enabled) return { kind: "ineligible", reason: "automationDisabled" };
    if (cause.kind === "trigger") {
        const trigger = params.triggersById.get(cause.triggerId);
        if (!trigger || trigger.automationId !== params.request.automationId) {
            return { kind: "ineligible", reason: "triggerNotFound" };
        }
        if (!trigger.enabled) return { kind: "ineligible", reason: "triggerDisabled" };
        if (trigger.revision !== cause.triggerRevision) {
            return { kind: "ineligible", reason: "triggerRevisionMismatch" };
        }
        if (trigger.kind !== cause.triggerKind) {
            return { kind: "ineligible", reason: "triggerKindMismatch" };
        }
    }

    const definition = parseAutomationStoredDefinitionExecutionRecipeV1(automation.templateCiphertext);
    const triggerEvidence = parseTriggerEvidenceEnvelope(
        params.request.executionTriggerEvidenceEnvelope ?? params.request.triggerEvidenceEnvelope,
    );
    let executionInputEnvelope: string;
    if (definition.kind === "available") {
        if (
            definition.recipe.templateVersion !== automation.templateVersion
            || definition.recipe.triggerEvidence !== null
            || targetTypeForRecipe(definition.recipe) !== automation.targetType
            || triggerEvidence === undefined
            || ((cause.kind === "conversation" || (cause.kind === "trigger" && cause.triggerKind === "pluginEvent"))
                && triggerEvidence === null)
            || ((cause.kind === "manual" || (cause.kind === "trigger" && cause.triggerKind !== "pluginEvent"))
                && triggerEvidence !== null)
        ) return { kind: "ineligible", reason: "definitionInvalid" };
        const frozen = serializeAutomationRunExecutionRecipeV1({
            ...definition.recipe,
            triggerEvidence,
            assignmentMachineIds: automation.assignments.map((assignment) => assignment.machineId),
        });
        if (frozen.kind !== "available") return { kind: "ineligible", reason: "definitionInvalid" };
        executionInputEnvelope = frozen.serialized;
    } else {
        const legacyCause = cause.kind === "manual"
            || (cause.kind === "trigger" && cause.triggerKind === "schedule");
        let legacyTemplate: unknown;
        try { legacyTemplate = JSON.parse(automation.templateCiphertext); } catch { legacyTemplate = null; }
        if (
            !legacyCause
            || automation.targetType === "execution_run"
            || triggerEvidence !== null
            || normalizeAutomationTemplateEnvelopeStoredRead(legacyTemplate) === null
        ) return { kind: "ineligible", reason: "definitionInvalid" };
        const origin = toAutomationRunExecutionInputV1Origin(cause);
        if (!origin) return { kind: "ineligible", reason: "definitionInvalid" };
        executionInputEnvelope = JSON.stringify(AutomationRunExecutionInputV1Schema.parse({
            kind: "happier_automation_run_execution_input_v1",
            targetType: automation.targetType,
            templateVersion: automation.templateVersion,
            templateCiphertext: automation.templateCiphertext,
            origin,
        }));
    }

    return {
        kind: "prepared",
        admission: {
            request: params.request,
            cause,
            executionInputEnvelope,
            automation,
        },
    };
}

async function insertPreparedAutomationRunTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    admission: PreparedAutomationRunAdmission;
}>): Promise<AutomationRunAdmissionResult> {
    const { request, cause, executionInputEnvelope, automation } = params.admission;
    const dueAt = cause.kind === "trigger" && cause.triggerKind === "schedule"
        ? new Date(cause.evidence.scheduledFor)
        : request.now;
    const causeFields = encodeAutomationRunCause(cause);
    const runId = request.replyHandoff ? randomUUID() : undefined;
    const initialExecutionDispatchState = initialAutomationExecutionDispatchStateForRun(
        executionInputEnvelope,
    );
    const run = await params.tx.automationRun.create({
        data: {
            ...(runId ? { id: runId } : {}),
            automationId: request.automationId,
            accountId: params.accountId,
            state: "queued",
            ...causeFields,
            legacyManualIdempotencyKey: cause.kind === "manual"
                    ? request.manualIdempotencyKey ?? null
                    : null,
            occurrenceEvidenceEqualityTag: request.occurrenceEvidenceEqualityTag ?? null,
            triggerEvidenceEnvelope: request.triggerEvidenceEnvelope ?? null,
            executionInputEnvelope,
            executionDispatchState: initialExecutionDispatchState,
            assignments: {
                // Query index derived atomically from current strict recipe
                // assignmentMachineIds. Released V2 cannot gain that field,
                // so this child index is its isolated compatibility carrier.
                create: automation.assignments.map((assignment) => ({
                    machineId: assignment.machineId,
                    priority: assignment.priority,
                })),
            },
            scheduledAt: request.now,
            dueAt,
            ...(request.replyHandoff
                ? {
                    replyContextEnvelope: request.replyHandoff.contextEnvelope,
                    replyHandoffActionPluginId: request.replyHandoff.actionPluginId,
                    replyHandoffActionLocalId: request.replyHandoff.actionLocalId,
                    replyHandoffTargetMachineId: request.replyHandoff.targetMachineId,
                    replyHandoffTargetMachineInstallationId: request.replyHandoff.targetMachineInstallationId,
                    replyHandoffTargetMaterializationId: request.replyHandoff.targetMaterializationId,
                    replyHandoffId: replyHandoffIdForRun(runId!),
                    replyHandoffState: "awaitingResult" as const,
                }
                : {}),
        } satisfies Prisma.AutomationRunUncheckedCreateInput,
        select: automationRunItemSelect,
    });
    await params.tx.automation.update({
        where: { id: request.automationId },
        data: { lastRunAt: request.now },
    });
    const cursor = await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "automation",
        entityId: request.automationId,
    });
    afterTx(params.tx, () => {
        emitAutomationRunTransition({
            accountId: params.accountId,
            run,
            previousState: null,
            cursor,
        });
        for (const assignment of automation.assignments) {
            emitAutomationRunUpdatedToMachineOnly({
                accountId: params.accountId,
                machineId: assignment.machineId,
                run,
                cursor,
            });
        }
    });
    return { kind: "admitted", run };
}

/**
 * The one admission owner for trigger and direct invocation batches. It
 * rejoins immutable occurrences before mutable checks, freezes current recipe
 * and assignments, and applies Event/Conversation capacity once across every
 * net-new capacity-consuming candidate in this bounded request.
 */
export async function admitAutomationRunsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    admissions: readonly AutomationRunAdmissionRequest[];
}>): Promise<readonly AutomationRunAdmissionResult[]> {
    if (params.admissions.length === 0) return [];
    const parsedAdmissions = params.admissions.map((request) => ({
        request,
        cause: AutomationRunCauseSchema.parse(request.cause),
    }));
    const occurrenceDiscriminators = parsedAdmissions.flatMap(({ request, cause }) => {
        const discriminator = occurrenceDiscriminator({
            automationId: request.automationId,
            cause,
            manualIdempotencyKey: request.manualIdempotencyKey,
        });
        return discriminator === null ? [] : [discriminator];
    });
    const existingRuns = occurrenceDiscriminators.length === 0
        ? []
        : await params.tx.automationRun.findMany({
            where: { accountId: params.accountId, OR: occurrenceDiscriminators },
            select: automationRunItemSelect,
        });
    const automationIds = [...new Set(parsedAdmissions.map(({ request }) => request.automationId))];
    const triggerIds = [...new Set(parsedAdmissions.flatMap(({ cause }) => (
        cause.kind === "trigger" ? [cause.triggerId] : []
    )))];
    const automations = await params.tx.automation.findMany({
        where: {
            id: { in: automationIds },
            accountId: params.accountId,
            deletedAt: null,
        },
        select: automationAdmissionDefinitionSelect,
    });
    const triggers = triggerIds.length === 0
        ? []
        : await params.tx.automationTrigger.findMany({
            where: { id: { in: triggerIds }, deletedAt: null },
            select: automationAdmissionTriggerSelect,
        });
    const automationsById = new Map(automations.map((automation) => [automation.id, automation]));
    const triggersById = new Map(triggers.map((trigger) => [trigger.id, trigger]));
    const prepared = parsedAdmissions.map(({ request, cause }) => prepareAutomationRunAdmission({
        request,
        cause,
        existingRuns,
        automationsById,
        triggersById,
    }));

    const netNewCapacityAdmissions = prepared.filter((result): result is Readonly<{
        kind: "prepared";
        admission: PreparedAutomationRunAdmission;
    }> => result.kind === "prepared" && consumesEventConversationCapacity(result.admission.cause));
    let remainingCapacity = MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT;
    if (netNewCapacityAdmissions.length > 0) {
        const occupied = await params.tx.automationRun.count({
            where: {
                accountId: params.accountId,
                OR: [
                    { causeKind: "conversation" },
                    { causeKind: "trigger", causeTriggerKind: "pluginEvent" },
                ],
                state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] },
            },
        });
        remainingCapacity = Math.max(
            0,
            MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT - occupied,
        );
    }
    const capacityBatchExceedsCapacity = netNewCapacityAdmissions.length > remainingCapacity;

    const results: AutomationRunAdmissionResult[] = [];
    for (const result of prepared) {
        if (result.kind !== "prepared") {
            results.push(result);
            continue;
        }
        const consumesCapacity = consumesEventConversationCapacity(result.admission.cause);
        if (consumesCapacity && capacityBatchExceedsCapacity) {
            results.push({ kind: "ineligible", reason: "capacity" });
            continue;
        }
        results.push(await insertPreparedAutomationRunTx({
            tx: params.tx,
            accountId: params.accountId,
            admission: result.admission,
        }));
    }
    return results;
}

/** The scalar adapter over the canonical bounded admission owner. */
export async function admitAutomationRunTx(params: Readonly<{
    tx: Tx;
    accountId: string;
}> & AutomationRunAdmissionRequest): Promise<AutomationRunAdmissionResult> {
    const [result] = await admitAutomationRunsTx({
        tx: params.tx,
        accountId: params.accountId,
        admissions: [params],
    });
    if (!result) throw new Error("Automation admission produced no result");
    return result;
}
