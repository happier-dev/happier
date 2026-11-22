import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AutomationRunCauseSchema, type AutomationRunCause } from '@happier-dev/protocol/automations/run-cause';
import { AutomationRunExecutionInputV1Schema, toAutomationRunExecutionInputV1Origin } from '@happier-dev/protocol/automations/automationApiV3';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { deriveAutomationManualOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { normalizeAutomationTemplateEnvelopeStoredRead } from '@happier-dev/protocol/automations/automationTemplateEnvelope';
import { automationRunExecutionTargetTypeV1, parseAutomationStoredDefinitionExecutionRecipeV1, serializeAutomationRunExecutionRecipeV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import { parseAutomationObservationOnlyDefinitionV1, parseAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { automationReplyHandoffIdForRunV1 } from '@happier-dev/protocol/automations/automationReplyHandoffIdentityV1';
import { type AutomationConversationScopedTriggerRefV1 } from '@happier-dev/protocol/automations/result-delivery';

import { afterTx, type Tx } from "@/storage/inTx";
import { publishManagedRunWakeInTx } from '@/app/machines/managed/managedWake';
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { getSessionReviewProjectionIdForRun, invalidateSessionReviewProjectionForRunInTx } from './sessionReviewProjectionInvalidation';
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { classifyMachinePresenceAtInstant } from "@/app/presence/machinePresenceAtInstant";
import { resolveMachineAdmissionsInTx, type WorkflowMachineAdmission } from '@/app/machines/machineAccess';
import { publishWorkflowRunMachineWakeInTx } from '@/app/workflows/workflowRunMachineRouting';
import { attachAutomationWorkflowBodyTx } from "@/app/workflows/workflowRunService";
import { acquireWorkflowPublicationLocksInTx } from "@/app/workflows/acquireWorkflowPublicationLocksInTx";
import {
    resolveAutomationRecipeFeaturePolicy,
    type AutomationRecipeFeaturePolicy,
} from "./automationRecipeFeaturePolicy";

import { automationRunItemSelect } from "./automationPersistenceSelect";
import { portableQueryChunks as automationPortableQueryChunks } from "@/storage/portableQueryChunks";
import { lockScopedAutomationTriggerInTx } from "./automationScopedTrigger";
import { matchesScopedAutomationConversationTriggerTx } from "./automationConversationTargetVerificationService";
import { applyAutomationRunTerminalEffectsTx } from "./automationRunSucceeded";
import {
    decodeAutomationRunCause,
    encodeAutomationRunCause,
    projectAutomationOriginRun,
    retainedV2OriginKindForRun,
} from "./automationRunCauseCodec";
import {
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
    | "noEnabledAssignment"
    | "machineRequired"
    | "triggerNotFound"
    | "triggerDisabled"
    | "triggerRevisionMismatch"
    | "triggerKindMismatch"
    | "idempotencyKeyInvalid"
    | "featureDisabled"
    | "definitionInvalid"
    | "observationOnly";

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

function sameOccurrenceCause(left: AutomationRunCause, right: AutomationRunCause): boolean {
    // A manual idempotency key identifies the invocation. Retry wall-clock
    // time is not a second immutable fact and must not make that retry collide.
    if (left.kind === "manual" && right.kind === "manual") return true;
    const withoutMutableOccurrenceFields = (cause: AutomationRunCause): unknown => {
        if (cause.kind !== "trigger") return cause;
        if (cause.triggerKind === "action") {
            // Approval replay retains the material request id but may rebuild
            // the host timestamp. Status and safe evidence remain immutable.
            const { triggerRevision: _revision, occurredAt: _timestamp, ...immutableAction } = cause;
            return immutableAction;
        }
        const { triggerRevision: _mutableRevision, ...immutableOccurrence } = cause;
        return immutableOccurrence;
    };
    return createCanonicalJsonSigningInput(withoutMutableOccurrenceFields(left))
        === createCanonicalJsonSigningInput(withoutMutableOccurrenceFields(right));
}

export type AutomationRunAdmissionRequest = Readonly<{
    automationId: string;
    /** Invocation placement, frozen on this Run rather than the consent definition. */
    runTargetMachineId?: string;
    now: Date;
    cause: AutomationRunCause;
    triggerEvidenceEnvelope?: string | null;
    executionTriggerEvidenceEnvelope?: string | null;
    occurrenceEvidenceEqualityTag?: string | null;
    /** Current V3 manual retry identity, projected to the canonical occurrence key. */
    manualIdempotencyKey?: string;
    replyHandoff?: AutomationRunReplyHandoffAdmission;
    /** Host-authenticated PR correspondence, revalidated after the existing scoped lock. */
    scopedConversationTrigger?: AutomationConversationScopedTriggerRefV1 | Omit<AutomationConversationScopedTriggerRefV1, 'pullRequest'>;
}>;

/** Material Action requests and admitted PR feedback retain each queued occurrence. */
function preservesDistinctScopedOccurrences(request: AutomationRunAdmissionRequest, cause: AutomationRunCause): boolean {
    return (cause.kind === "trigger" && cause.triggerKind === "action")
        || (cause.kind === "conversation" && request.scopedConversationTrigger !== undefined);
}

function parseTriggerEvidenceEnvelope(raw: string | null | undefined): unknown | null {
    if (raw === null || raw === undefined) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

function hasCauseOwnedPrivateInput(cause: AutomationRunCause): boolean {
    return cause.kind === "conversation"
        || (cause.kind === "trigger" && cause.triggerKind === "pluginEvent");
}

function triggerEvidenceMatchesCause(
    cause: AutomationRunCause,
    triggerEvidence: unknown | null,
): boolean {
    return hasCauseOwnedPrivateInput(cause)
        ? triggerEvidence !== null
        : triggerEvidence === null;
}

/**
 * The one persisted occurrence identity for an admission request. Trigger and
 * Conversation causes carry the key their evidence already derived; an
 * idempotent V3 manual invocation derives the canonical manual key so a lost
 * response rejoins the same Run. A non-idempotent invocation has no occurrence
 * key. Retained predecessor rows keep their stored retry column unchanged.
 */
function admissionOccurrenceKey(params: Readonly<{
    automationId: string;
    cause: AutomationRunCause;
    manualIdempotencyKey?: string;
}>): string | null {
    if (params.cause.kind !== "manual") return params.cause.occurrenceKey;
    return params.manualIdempotencyKey
        ? deriveAutomationManualOccurrenceKeyV1({
            automationId: params.automationId,
            idempotencyKey: params.manualIdempotencyKey,
        })
        : null;
}

function occurrenceDiscriminator(params: Readonly<{
    automationId: string;
    cause: AutomationRunCause;
    manualIdempotencyKey?: string;
}>): Prisma.AutomationRunWhereInput | null {
    const occurrenceKey = admissionOccurrenceKey(params);
    if (occurrenceKey !== null) return { automationId: params.automationId, occurrenceKey };
    return null;
}

function findExistingRun(params: Readonly<{
    rows: readonly AutomationRunItem[];
    automationId: string;
    cause: AutomationRunCause;
    manualIdempotencyKey?: string;
    occurrenceEvidenceEqualityTag?: string | null;
}>): AutomationRunItem | null {
    // The `(automationId, occurrenceKey)` unique is the single rejoin owner,
    // so the key alone selects the candidate row. A same-key row admitted
    // under a different cause is a collision, not a second namespace, and the
    // immutable-evidence check below rejects it.
    const occurrenceKey = admissionOccurrenceKey(params);
    const existing = params.rows.find((row) => {
        if (row.automationId !== params.automationId) return false;
        if (occurrenceKey !== null) return row.occurrenceKey === occurrenceKey;
        return false;
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
    scopeSessionId: true,
    targetType: true,
    templateVersion: true,
    templateCiphertext: true,
    assignments: {
        where: { enabled: true },
        select: {
            machineId: true,
            priority: true,
            machine: {
                select: { accountId: true, installationId: true, revokedAt: true, replacedByMachineId: true, active: true, presenceTransitions: true },
            },
        },
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
    scheduleKind: true,
} satisfies Prisma.AutomationTriggerSelect;

type AutomationAdmissionTrigger = Prisma.AutomationTriggerGetPayload<{
    select: typeof automationAdmissionTriggerSelect;
}>;

type PreparedAutomationRunAdmission = Readonly<{
    request: AutomationRunAdmissionRequest;
    cause: AutomationRunCause;
    executionInputEnvelope: string | null;
    workflowDefinitionEnvelope: string | null;
    automation: Omit<AutomationAdmissionDefinition, 'assignments'> & Readonly<{
        assignments: readonly Readonly<{ machineId: string; priority: number;
            machine: Readonly<{ accountId: string; installationId: string | null }> }>[];
    }>;
    missedReason: "machine_offline" | "machine_presence_at_due_unavailable" | null;
}>;

type PreparedAutomationRunAdmissionResult =
    | AutomationRunAdmissionResult
    | Readonly<{ kind: "prepared"; admission: PreparedAutomationRunAdmission }>;

function isSessionLifecycleCause(cause: AutomationRunCause): boolean {
    return cause.kind === "trigger"
        && cause.triggerKind === "sessionLifecycle";
}

/** The same definition-to-frozen-input owner serves new admission and safe predecessor claims. */
export function freezeAutomationRunInput(params: Readonly<{
    definition: Pick<AutomationAdmissionDefinition, "targetType" | "templateVersion" | "templateCiphertext">;
    cause: AutomationRunCause;
    assignmentMachineIds: readonly string[];
    triggerEvidenceEnvelope: string | null | undefined;
    recipeFeaturePolicy: AutomationRecipeFeaturePolicy;
}>): Readonly<{ kind: "available"; executionInputEnvelope: string; workflowDefinitionEnvelope: string | null }>
    | Readonly<{ kind: "ineligible"; reason: "definitionInvalid" | "featureDisabled" }> {
    const automation = params.definition;
    const cause = params.cause;
    const definition = parseAutomationStoredDefinitionExecutionRecipeV1(automation.templateCiphertext);
    const triggerEvidence = parseTriggerEvidenceEnvelope(params.triggerEvidenceEnvelope);
    if (definition.kind === "available") {
        if (
            definition.recipe.templateVersion !== automation.templateVersion
            || definition.recipe.triggerEvidence !== null
            || automationRunExecutionTargetTypeV1(definition.recipe.target) !== automation.targetType
            || triggerEvidence === undefined
            || !triggerEvidenceMatchesCause(cause, triggerEvidence)
        ) return { kind: "ineligible", reason: "definitionInvalid" };
        const frozen = serializeAutomationRunExecutionRecipeV1({
            ...definition.recipe,
            triggerEvidence,
            assignmentMachineIds: [...params.assignmentMachineIds],
        });
        return frozen.kind === "available"
            ? { kind: "available", executionInputEnvelope: frozen.serialized, workflowDefinitionEnvelope: null }
            : { kind: "ineligible", reason: "definitionInvalid" };
    }
    const workflowDefinition = parseAutomationStoredWorkflowDefinitionRecipeV2(automation.templateCiphertext);
    if (workflowDefinition.kind === "available") {
        if (!params.recipeFeaturePolicy.workflowsEnabled) return { kind: "ineligible", reason: "featureDisabled" };
        if (
            workflowDefinition.recipe.templateVersion !== automation.templateVersion
            || workflowDefinition.recipe.triggerEvidence !== null
            || automation.targetType !== null
            || triggerEvidence === undefined
            || !triggerEvidenceMatchesCause(cause, triggerEvidence)
        ) return { kind: "ineligible", reason: "definitionInvalid" };
        const workflowDefinitionEnvelope = createCanonicalJsonSigningInput(workflowDefinition.recipe.workflow);
        return { kind: "available", executionInputEnvelope: workflowDefinitionEnvelope, workflowDefinitionEnvelope };
    }
    const legacyCause = cause.kind === "manual" || (cause.kind === "trigger" && cause.triggerKind === "schedule");
    let legacyTemplate: unknown;
    try { legacyTemplate = JSON.parse(automation.templateCiphertext); } catch { legacyTemplate = null; }
    if (
        !legacyCause
        || automation.targetType === null
        || automation.targetType === "execution_run"
        || triggerEvidence !== null
        || normalizeAutomationTemplateEnvelopeStoredRead(legacyTemplate) === null
    ) return { kind: "ineligible", reason: "definitionInvalid" };
    const origin = toAutomationRunExecutionInputV1Origin(cause);
    if (!origin) return { kind: "ineligible", reason: "definitionInvalid" };
    return {
        kind: "available",
        executionInputEnvelope: JSON.stringify(AutomationRunExecutionInputV1Schema.parse({
            kind: "happier_automation_run_execution_input_v1",
            targetType: automation.targetType,
            templateVersion: automation.templateVersion,
            templateCiphertext: automation.templateCiphertext,
            origin,
        })),
        workflowDefinitionEnvelope: null,
    };
}

function prepareAutomationRunAdmission(params: Readonly<{
    request: AutomationRunAdmissionRequest;
    cause: AutomationRunCause;
    existingRuns: readonly AutomationRunItem[];
    automationsById: ReadonlyMap<string, AutomationAdmissionDefinition>;
    triggersById: ReadonlyMap<string, AutomationAdmissionTrigger>;
    recipeFeaturePolicy: AutomationRecipeFeaturePolicy;
    scopedConversationMatches: boolean;
    invocationPlacement: boolean;
    runTargetAdmission: WorkflowMachineAdmission | undefined;
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
    if (parseAutomationObservationOnlyDefinitionV1(automation.templateCiphertext) !== null) {
        return { kind: "ineligible", reason: "observationOnly" };
    }
    const assignmentMayBeFrozen = (assignment: AutomationAdmissionDefinition["assignments"][number]): boolean => {
        const availability = classifyMachineAvailabilityState(assignment.machine);
        return availability === "available"
            || (availability === "replaced" && isSessionLifecycleCause(cause));
    };
    const availableAssignments = automation.assignments.filter(assignmentMayBeFrozen);
    const once = cause.kind === "trigger" && cause.triggerKind === "schedule"
        && params.triggersById.get(cause.triggerId)?.scheduleKind === "once";
    const presenceAtDue = once && cause.kind === "trigger" && cause.triggerKind === "schedule"
        ? availableAssignments.map(assignment => ({ assignment,
            presence: classifyMachinePresenceAtInstant(assignment.machine, cause.evidence.scheduledFor) }))
        : null;
    const onTimeAssignments = presenceAtDue?.filter(item => item.presence === "present").map(item => item.assignment)
        ?? availableAssignments;
    const missedReason = once && onTimeAssignments.length === 0
        ? presenceAtDue?.some(item => item.presence === "unavailable")
            ? "machine_presence_at_due_unavailable" : "machine_offline"
        : null;
    const target = params.request.runTargetMachineId === undefined ? undefined : params.runTargetAdmission;
    const targetAssignments = target?.kind === 'admitted' && target.availability === 'available'
        ? [{ machineId: target.machineId, priority: 0,
            machine: { accountId: target.custodianAccountId, installationId: target.installationId } }] : [];
    const admissionAutomation: PreparedAutomationRunAdmission['automation'] = {
        ...automation,
        assignments: params.request.runTargetMachineId === undefined
            ? missedReason !== null ? availableAssignments : onTimeAssignments
            : targetAssignments,
    };
    // The select loads only enabled assignments. Replayable causes freeze only
    // presently available machines; every Session-lifecycle occurrence is
    // non-replayable and may retain a reversibly replaced machine so undo can
    // make the already-admitted Run claimable. An empty post-policy snapshot
    // is permanently unclaimable.
    // Rejoin above keeps already-admitted Runs on their immutable snapshots.
    if (admissionAutomation.assignments.length === 0) {
        return { kind: "ineligible", reason: params.invocationPlacement && cause.kind === "trigger"
            && cause.triggerKind === "action" ? "machineRequired" : "noEnabledAssignment" };
    }
    const sourceTriggerId = cause.kind === "manual" ? undefined : cause.triggerId;
    if (sourceTriggerId) {
        // Conversation preflight is not admission authority: CRUD may commit
        // while this transaction waits for the trigger's existing row lock.
        const trigger = params.triggersById.get(sourceTriggerId);
        if (!trigger || trigger.automationId !== params.request.automationId) {
            return { kind: "ineligible", reason: "triggerNotFound" };
        }
        if (!trigger.enabled) return { kind: "ineligible", reason: "triggerDisabled" };
        if (cause.kind === "trigger" && trigger.revision !== cause.triggerRevision) {
            return { kind: "ineligible", reason: "triggerRevisionMismatch" };
        }
        if ((cause.kind === "trigger" && trigger.kind !== cause.triggerKind)
            || (cause.kind === "conversation" && !params.scopedConversationMatches)) {
            return { kind: "ineligible", reason: "triggerKindMismatch" };
        }
    }

    const frozen = freezeAutomationRunInput({
        definition: automation,
        cause,
        assignmentMachineIds: admissionAutomation.assignments.map((assignment) => assignment.machineId),
        triggerEvidenceEnvelope: params.request.executionTriggerEvidenceEnvelope ?? params.request.triggerEvidenceEnvelope,
        recipeFeaturePolicy: params.recipeFeaturePolicy,
    });
    if (frozen.kind === "ineligible") return frozen;

    return {
        kind: "prepared",
        admission: {
            request: params.request,
            cause,
            // The queued row must already carry its frozen bytes; the Workflow
            // attachment below changes custody under the same transaction.
            executionInputEnvelope: frozen.executionInputEnvelope,
            workflowDefinitionEnvelope: frozen.workflowDefinitionEnvelope,
            automation: admissionAutomation,
            missedReason: params.request.runTargetMachineId === undefined ? missedReason : null,
        },
    };
}

async function insertPreparedAutomationRunTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    admission: PreparedAutomationRunAdmission;
}>): Promise<AutomationRunAdmissionResult> {
    const { request, cause, executionInputEnvelope, workflowDefinitionEnvelope, automation, missedReason } = params.admission;
    const missed = missedReason !== null;
    const triggerId = cause.kind === "manual" ? undefined : cause.triggerId;
    // Material Action requests and PR feedback are distinct immutable occurrences,
    // including while the Session is busy. Other scoped triggers keep their existing
    // latest-pending policy. The scoped correspondence was admitted above;
    // encrypted event bodies are never inspected to choose this policy.
    if (automation.scopeSessionId !== null && triggerId && !preservesDistinctScopedOccurrences(request, cause)) {
        const pending = await params.tx.automationRun.findMany({
            where: { accountId: params.accountId, triggerId, state: "queued" }, select: { id: true, workflowCustodyState: true },
        });
        for (const previous of pending) {
            await params.tx.automationRun.update({ where: { id: previous.id }, data: {
                state: "skipped", errorCode: "superseded_by_newer_occurrence", finishedAt: request.now,
                workflowCustodyState: previous.workflowCustodyState !== null ? "settled" : null,
                revision: { increment: 1 },
            } });
            await applyAutomationRunTerminalEffectsTx({ tx: params.tx, accountId: params.accountId,
                runId: previous.id, previousState: "queued", state: "skipped", now: request.now });
        }
    }
    const dueAt = cause.kind === "trigger" && cause.triggerKind === "schedule"
        ? new Date(cause.evidence.scheduledFor)
        : request.now;
    const causeFields = encodeAutomationRunCause(cause);
    const runId = request.replyHandoff ? randomUUID() : null;
    const initialExecutionDispatchState = executionInputEnvelope === null
        ? null
        : initialAutomationExecutionDispatchStateForRun(executionInputEnvelope);
    const inserted = await params.tx.automationRun.create({
        data: {
            ...(runId !== null ? { id: runId } : {}),
            automationId: request.automationId,
            automationScopeCaptured: true,
            automationScopeSessionId: automation.scopeSessionId,
            accountId: params.accountId,
            ...(workflowDefinitionEnvelope !== null ? { originKind: "automation" } : {}),
            state: missed ? "missed" : "queued",
            ...(missed ? { finishedAt: request.now, errorCode: missedReason } : {}),
            ...causeFields,
            // One derivation owner for the persisted identity and the rejoin
            // probe: the cause codec cannot see a manual invocation's
            // idempotency key, so it writes null and this overrides it.
            occurrenceKey: admissionOccurrenceKey({
                automationId: request.automationId,
                cause,
                manualIdempotencyKey: request.manualIdempotencyKey,
            }),
            occurrenceEvidenceEqualityTag: request.occurrenceEvidenceEqualityTag ?? null,
            triggerEvidenceEnvelope: request.triggerEvidenceEnvelope ?? null,
            executionInputEnvelope,
            executionDispatchState: initialExecutionDispatchState,
            assignments: {
                // Frozen assignment index also serves retained predecessor
                // inputs, which have no embedded assignmentMachineIds.
                create: automation.assignments.map((assignment) => ({
                    machineId: assignment.machineId,
                    priority: assignment.priority,
                    ...(workflowDefinitionEnvelope !== null
                        ? { admittedMachineInstallationId: assignment.machine.installationId } : {}),
                })),
            },
            scheduledAt: request.now,
            dueAt,
            ...(request.replyHandoff && runId !== null
                ? {
                    replyContextEnvelope: request.replyHandoff.contextEnvelope,
                    replyHandoffActionPluginId: request.replyHandoff.actionPluginId,
                    replyHandoffActionLocalId: request.replyHandoff.actionLocalId,
                    replyHandoffTargetMachineId: request.replyHandoff.targetMachineId,
                    replyHandoffTargetMachineInstallationId: request.replyHandoff.targetMachineInstallationId,
                    replyHandoffTargetMaterializationId: request.replyHandoff.targetMaterializationId,
                    replyHandoffId: automationReplyHandoffIdForRunV1(runId),
                    replyHandoffState: "awaitingResult" as const,
                }
                : {}),
        } satisfies Prisma.AutomationRunUncheckedCreateInput,
        select: automationRunItemSelect,
    });
    let run = projectAutomationOriginRun(inserted);
    if (!run) throw new Error("Admitted Automation Run has invalid origin correspondence");
    if (workflowDefinitionEnvelope !== null) {
        await attachAutomationWorkflowBodyTx(params.tx, {
            accountId: params.accountId,
            runId: run.id,
            automationId: request.automationId,
            definitionEnvelope: workflowDefinitionEnvelope,
        });
        if (missed) await params.tx.automationRun.update({ where: { id: run.id }, data: { workflowCustodyState: "settled" } });
        const attached = await params.tx.automationRun.findUnique({
            where: { id: run.id },
            select: automationRunItemSelect,
        });
        if (!attached) throw new Error("Attached Automation workflow Run is unavailable");
        const projected = projectAutomationOriginRun(attached);
        if (!projected) throw new Error("Attached Automation workflow Run has invalid origin correspondence");
        run = projected;
    }
    await invalidateSessionReviewProjectionForRunInTx(params.tx, run);
    const cursor = await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "automation",
        entityId: request.automationId,
    });
    if (missed) await params.tx.automationRunEvent.create({ data: {
        runId: run.id, ts: request.now, type: "run_missed", payload: { errorCode: missedReason },
    } });
    if (!missed) await publishManagedRunWakeInTx(params.tx, { accountId: params.accountId, runId: run.id, cursor });
    if (!missed && workflowDefinitionEnvelope !== null) await publishWorkflowRunMachineWakeInTx(params.tx,
        { accountId: params.accountId, run, cursor, admittedTargets: automation.assignments.map(assignment => ({
            machineId: assignment.machineId, custodianAccountId: assignment.machine.accountId,
        })) });
    afterTx(params.tx, () => {
        emitAutomationRunTransition({
            accountId: params.accountId,
            run,
            previousState: null,
            cursor: cursor.resolveCursor(),
        });
        for (const assignment of automation.assignments) {
            if (missed) continue;
            if (workflowDefinitionEnvelope !== null) continue;
            emitAutomationRunUpdatedToMachineOnly({
                accountId: params.accountId,
                machineId: assignment.machineId,
                run,
                cursor: cursor.resolveCursor(),
            });
        }
    });
    return { kind: "admitted", run };
}

/**
 * The one admission owner for trigger and direct invocation batches. It
 * rejoins immutable occurrences before mutable checks and freezes the current
 * recipe and assignments for each eligible new occurrence.
 */
export async function admitAutomationRunsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    admissions: readonly AutomationRunAdmissionRequest[];
    recipeFeaturePolicy?: AutomationRecipeFeaturePolicy;
}>): Promise<readonly AutomationRunAdmissionResult[]> {
    if (params.admissions.length === 0) return [];
    const parsedAdmissions = params.admissions.map((request) => ({
        request,
        cause: AutomationRunCauseSchema.parse(request.cause),
    }));
    const supersededTriggerIds = parsedAdmissions.flatMap(({ request, cause }) =>
        cause.kind !== 'manual' && cause.triggerId
            && !preservesDistinctScopedOccurrences(request, cause)
            ? [cause.triggerId] : []);
    await acquireWorkflowPublicationLocksInTx(params.tx, { accountId: params.accountId,
        automationIds: [...new Set(params.admissions.map(request => request.automationId))],
        machineIds: parsedAdmissions.flatMap(({ request, cause }) => {
            const machineId = request.runTargetMachineId
                ?? (cause.kind === "trigger" && cause.triggerKind === "action" ? cause.evidence.machineId : undefined);
            return machineId === undefined ? [] : [machineId];
        }),
        sessionIds: parsedAdmissions.flatMap(({ cause }) => {
            const sourceSessionId = getSessionReviewProjectionIdForRun(encodeAutomationRunCause(cause));
            return sourceSessionId === null ? [] : [sourceSessionId];
        }),
        ...(supersededTriggerIds.length ? { runWhere: automationPortableQueryChunks({
            values: [...new Set(supersededTriggerIds)], bindingsPerValue: 1, fixedBindings: 3,
        }).map(ids => ({
            accountId: params.accountId, triggerId: { in: [...ids] }, state: 'queued',
            automation: { scopeSessionId: { not: null } },
        })) } : {}),
    });
    const recipeFeaturePolicy = params.recipeFeaturePolicy ?? await resolveAutomationRecipeFeaturePolicy({ tx: params.tx });
    // The same trigger row also serializes claims. Lock before mutable reads
    // so concurrent admissions observe the incumbent pending reservation.
    const scopedLockCandidates = [...new Set(parsedAdmissions.flatMap(({ cause }) => (
        cause.kind !== "manual" && cause.triggerId ? [cause.triggerId] : []
    )))].sort();
    const scopedTriggerIds = (await Promise.all(automationPortableQueryChunks({
        values: scopedLockCandidates, bindingsPerValue: 1,
    }).map((ids) => params.tx.automationTrigger.findMany({
        where: { id: { in: [...ids] }, automation: { accountId: params.accountId, scopeSessionId: { not: null } } },
        select: { id: true },
    })))).flat().map((row) => row.id).sort();
    for (const triggerId of scopedTriggerIds) {
        await lockScopedAutomationTriggerInTx(params.tx, params.accountId, triggerId);
    }
    const occurrenceDiscriminators = [...new Map(parsedAdmissions.flatMap(({ request, cause }) => {
        const discriminator = occurrenceDiscriminator({
            automationId: request.automationId,
            cause,
            manualIdempotencyKey: request.manualIdempotencyKey,
        });
        return discriminator === null ? [] : [[JSON.stringify(discriminator), discriminator] as const];
    })).values()];
    // Membership probes fan out with the triggering batch; SQLite's portable
    // bind ceiling is a provider transport fact, never a cap on admitted work.
    const existingRunRows = occurrenceDiscriminators.length === 0
        ? []
        : (await Promise.all(automationPortableQueryChunks({
            values: occurrenceDiscriminators,
            // Each arm binds `(automationId, occurrenceKey)`. Prisma SQLite
            // also binds Account, originKind, LIMIT and OFFSET, even without
            // an authored limit: 497 arms produce 998 parameters; 498 exceed
            // the compiler's 999-parameter boundary.
            bindingsPerValue: 2,
            fixedBindings: 4,
        }).map((chunk) => params.tx.automationRun.findMany({
            where: {
                accountId: params.accountId,
                originKind: "automation",
                automationId: { not: null },
                causeKind: { not: null },
                OR: [...chunk],
            },
            select: automationRunItemSelect,
        })))).flat();
    const existingRuns = existingRunRows.map((row) => {
        const run = projectAutomationOriginRun(row);
        if (!run) throw new Error("Stored Automation Run has invalid origin correspondence");
        return run;
    });
    const automationIds = [...new Set(parsedAdmissions.map(({ request }) => request.automationId))];
    const triggerIds = [...new Set(parsedAdmissions.flatMap(({ cause }) => (
        cause.kind !== "manual" && cause.triggerId ? [cause.triggerId] : []
    )))];
    const automations = (await Promise.all(automationPortableQueryChunks({
        values: automationIds,
        bindingsPerValue: 1,
        fixedBindings: 1,
    }).map((chunk) => params.tx.automation.findMany({
        where: {
            id: { in: [...chunk] },
            accountId: params.accountId,
            deletedAt: null,
        },
        select: automationAdmissionDefinitionSelect,
    })))).flat();
    const triggers = triggerIds.length === 0
        ? []
        : (await Promise.all(automationPortableQueryChunks({
            values: triggerIds,
            bindingsPerValue: 1,
            fixedBindings: 1,
        }).map((chunk) => params.tx.automationTrigger.findMany({
            where: { id: { in: [...chunk] }, deletedAt: null },
            select: automationAdmissionTriggerSelect,
        })))).flat();
    // Definition assignments are mutable configuration and intentionally
    // survive reversible machine replacement. Account ownership and permanent
    // revocation are cause-independent. The preparation owner below applies
    // the cause-specific availability rule: replayable causes freeze only
    // available machines, while every non-replayable Session-lifecycle
    // occurrence preserves reversibly replaced machines for natural claim
    // after undo.
    const newAdmissionAutomationIds = new Set(parsedAdmissions.filter(({ request, cause }) =>
        !findExistingRun({ rows: existingRuns, ...request, cause })).map(({ request }) => request.automationId));
    const workflowRecipes = new Map(automations.flatMap(automation => {
        if (!newAdmissionAutomationIds.has(automation.id)) return [];
        const parsed = parseAutomationStoredWorkflowDefinitionRecipeV2(automation.templateCiphertext);
        return parsed.kind === "available" ? [[automation.id, parsed.recipe] as const] : [];
    }));
    const placedAdmissions = parsedAdmissions.map(({ request, cause }) => {
        const invocationPlacement = workflowRecipes.get(request.automationId)?.placement === "action_invocation";
        const machineId = invocationPlacement && cause.kind === "trigger" && cause.triggerKind === "action"
            ? cause.evidence.machineId : request.runTargetMachineId;
        return { request: { ...request, runTargetMachineId: machineId }, cause, invocationPlacement };
    });
    const machineAdmissions = await resolveMachineAdmissionsInTx(params.tx, { actorAccountId: params.accountId, purpose: 'workflow',
        machineIds: [
            ...automations.filter(row => workflowRecipes.has(row.id))
                .flatMap(row => row.assignments.map(assignment => assignment.machineId)),
            ...placedAdmissions.flatMap(({ request }) => workflowRecipes.has(request.automationId)
                && request.runTargetMachineId !== undefined ? [request.runTargetMachineId] : []),
        ] });
    const automationsById = new Map(automations.map((automation) => [
        automation.id,
        {
            ...automation,
            assignments: automation.assignments.filter((assignment) => (
                (workflowRecipes.has(automation.id)
                    ? machineAdmissions.get(assignment.machineId)?.kind === 'admitted'
                    : assignment.machine.accountId === params.accountId)
                && classifyMachineAvailabilityState(assignment.machine) !== "revoked"
            )).map(assignment => {
                const admission = workflowRecipes.has(automation.id) ? machineAdmissions.get(assignment.machineId) : undefined;
                return admission?.kind === 'admitted'
                    ? { ...assignment, machine: { ...assignment.machine, installationId: admission.installationId,
                        accountId: admission.custodianAccountId } }
                    : assignment;
            }),
        },
    ]));
    const triggersById = new Map(triggers.map((trigger) => [trigger.id, trigger]));
    const scopedConversationMatches = await Promise.all(parsedAdmissions.map(async ({ request, cause }) => {
        if (cause.kind !== "conversation" || !cause.triggerId) return true;
        if (request.scopedConversationTrigger?.triggerId !== cause.triggerId) return false;
        const automation = automationsById.get(request.automationId);
        if (!automation) return false;
        return await matchesScopedAutomationConversationTriggerTx({ tx: params.tx, accountId: params.accountId,
            automationId: automation.id, scopeSessionId: automation.scopeSessionId,
            scopedTrigger: request.scopedConversationTrigger });
    }));
    const prepared = placedAdmissions.map(({ request, cause, invocationPlacement }, index) => prepareAutomationRunAdmission({
        request,
        cause,
        existingRuns,
        automationsById,
        triggersById,
        recipeFeaturePolicy,
        scopedConversationMatches: scopedConversationMatches[index] === true,
        invocationPlacement,
        runTargetAdmission: request.runTargetMachineId === undefined ? undefined : machineAdmissions.get(request.runTargetMachineId),
    }));

    const results: AutomationRunAdmissionResult[] = [];
    for (const result of prepared) {
        if (result.kind !== "prepared") {
            results.push(result);
            continue;
        }
        const admitted = await insertPreparedAutomationRunTx({
            tx: params.tx,
            accountId: params.accountId,
            admission: result.admission,
        });
        results.push(admitted);
    }
    return results;
}

/** The scalar adapter over the canonical admission owner. */
export async function admitAutomationRunTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    recipeFeaturePolicy?: AutomationRecipeFeaturePolicy;
}> & AutomationRunAdmissionRequest): Promise<AutomationRunAdmissionResult> {
    const [result] = await admitAutomationRunsTx({
        tx: params.tx,
        accountId: params.accountId,
        admissions: [params],
        ...(params.recipeFeaturePolicy ? { recipeFeaturePolicy: params.recipeFeaturePolicy } : {}),
    });
    if (!result) throw new Error("Automation admission produced no result");
    return result;
}
