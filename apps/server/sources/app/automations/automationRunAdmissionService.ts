import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
    MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT,
    AutomationRunCauseSchema,
    AutomationRunExecutionInputV1Schema,
    createCanonicalJsonSigningInput,
    deriveAutomationManualOccurrenceKeyV1,
    normalizeAutomationTemplateEnvelopeStoredRead,
    parseAutomationStoredDefinitionExecutionRecipeV1,
    parseAutomationStoredWorkflowDefinitionRecipeV2,
    serializeAutomationRunExecutionRecipeV1,
    toAutomationRunExecutionInputV1Origin,
    automationReplyHandoffIdForRunV1,
    type AutomationRunCause,
    type AutomationConversationScopedTriggerRefV1,
} from "@happier-dev/protocol";

import { afterTx, type Tx } from "@/storage/inTx";
import { publishManagedRunWakeInTx } from '@/app/machines/managed/managedWake';
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { invalidateSessionReviewProjectionsForAutomationInTx } from './sessionReviewProjectionInvalidation';
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { attachAutomationWorkflowBodyTx } from "@/app/workflows/workflowRunService";
import {
    resolveAutomationRecipeFeaturePolicy,
    type AutomationRecipeFeaturePolicy,
} from "./automationRecipeFeaturePolicy";

import { automationRunItemSelect } from "./automationPersistenceSelect";
import { automationPortableQueryChunks } from "./automationPortableQueryChunks";
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
    | "noEnabledAssignment"
    | "triggerNotFound"
    | "triggerDisabled"
    | "triggerRevisionMismatch"
    | "triggerKindMismatch"
    | "capacity"
    | "idempotencyKeyInvalid"
    | "featureDisabled"
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
    /** Current V3 manual retry identity, projected to the canonical occurrence key. */
    manualIdempotencyKey?: string;
    replyHandoff?: AutomationRunReplyHandoffAdmission;
    /** Host-authenticated PR correspondence, revalidated after the existing scoped lock. */
    scopedConversationTrigger?: AutomationConversationScopedTriggerRefV1 | Omit<AutomationConversationScopedTriggerRefV1, 'pullRequest'>;
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
                select: { accountId: true, revokedAt: true, replacedByMachineId: true },
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
} satisfies Prisma.AutomationTriggerSelect;

type AutomationAdmissionTrigger = Prisma.AutomationTriggerGetPayload<{
    select: typeof automationAdmissionTriggerSelect;
}>;

type PreparedAutomationRunAdmission = Readonly<{
    request: AutomationRunAdmissionRequest;
    cause: AutomationRunCause;
    executionInputEnvelope: string | null;
    workflowDefinitionEnvelope: string | null;
    automation: AutomationAdmissionDefinition;
}>;

type PreparedAutomationRunAdmissionResult =
    | AutomationRunAdmissionResult
    | Readonly<{ kind: "prepared"; admission: PreparedAutomationRunAdmission }>;

function consumesEventConversationCapacity(admission: PreparedAutomationRunAdmission): boolean {
    // Session-scoped work uses the trigger's existing active/pending owner,
    // not the Account-wide Event/Conversation capacity pool.
    if (admission.automation.scopeSessionId !== null) return false;
    return admission.cause.kind === "conversation"
        || (admission.cause.kind === "trigger" && admission.cause.triggerKind === "pluginEvent");
}

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
            || targetTypeForRecipe(definition.recipe) !== automation.targetType
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
    const assignmentMayBeFrozen = (assignment: AutomationAdmissionDefinition["assignments"][number]): boolean => {
        const availability = classifyMachineAvailabilityState(assignment.machine);
        return availability === "available"
            || (availability === "replaced" && isSessionLifecycleCause(cause));
    };
    const admissionAutomation: AutomationAdmissionDefinition = {
        ...automation,
        assignments: automation.assignments.filter(assignmentMayBeFrozen),
    };
    // The select loads only enabled assignments. Replayable causes freeze only
    // presently available machines; every Session-lifecycle occurrence is
    // non-replayable and may retain a reversibly replaced machine so undo can
    // make the already-admitted Run claimable. An empty post-policy snapshot
    // is permanently unclaimable.
    // Rejoin above keeps already-admitted Runs on their immutable snapshots.
    if (admissionAutomation.assignments.length === 0) {
        return { kind: "ineligible", reason: "noEnabledAssignment" };
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
        },
    };
}

async function insertPreparedAutomationRunTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    admission: PreparedAutomationRunAdmission;
}>): Promise<AutomationRunAdmissionResult> {
    const { request, cause, executionInputEnvelope, workflowDefinitionEnvelope, automation } = params.admission;
    const triggerId = cause.kind === "manual" ? undefined : cause.triggerId;
    if (automation.scopeSessionId !== null && triggerId) {
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
            accountId: params.accountId,
            ...(workflowDefinitionEnvelope !== null ? { originKind: "automation" } : {}),
            state: "queued",
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
        const attached = await params.tx.automationRun.findUnique({
            where: { id: run.id },
            select: automationRunItemSelect,
        });
        if (!attached) throw new Error("Attached Automation workflow Run is unavailable");
        const projected = projectAutomationOriginRun(attached);
        if (!projected) throw new Error("Attached Automation workflow Run has invalid origin correspondence");
        run = projected;
    }
    await params.tx.automation.update({
        where: { id: request.automationId },
        data: { lastRunAt: request.now },
    });
    await invalidateSessionReviewProjectionsForAutomationInTx(params.tx, automation.id);
    const cursor = await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "automation",
        entityId: request.automationId,
    });
    await publishManagedRunWakeInTx(params.tx, { accountId: params.accountId, runId: run.id, cursor });
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
 * and assignments, and applies Event/Conversation capacity as deterministic
 * prefix admission across the net-new capacity-consuming candidates of this
 * bounded request.
 */
export async function admitAutomationRunsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    admissions: readonly AutomationRunAdmissionRequest[];
    recipeFeaturePolicy?: AutomationRecipeFeaturePolicy;
}>): Promise<readonly AutomationRunAdmissionResult[]> {
    if (params.admissions.length === 0) return [];
    const recipeFeaturePolicy = params.recipeFeaturePolicy ?? await resolveAutomationRecipeFeaturePolicy({ tx: params.tx });
    const parsedAdmissions = params.admissions.map((request) => ({
        request,
        cause: AutomationRunCauseSchema.parse(request.cause),
    }));
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
            // Every arm binds two columns: the canonical
            // `(automationId, occurrenceKey)` identity, or the retained V2
            // `(automationId, legacyManualIdempotencyKey)` seam. Account
            // ownership adds one fixed predicate.
            bindingsPerValue: 2,
            fixedBindings: 1,
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
    const automationsById = new Map(automations.map((automation) => [
        automation.id,
        {
            ...automation,
            assignments: automation.assignments.filter((assignment) => (
                assignment.machine.accountId === params.accountId
                && classifyMachineAvailabilityState(assignment.machine) !== "revoked"
            )),
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
    const prepared = parsedAdmissions.map(({ request, cause }, index) => prepareAutomationRunAdmission({
        request,
        cause,
        existingRuns,
        automationsById,
        triggersById,
        recipeFeaturePolicy,
        scopedConversationMatches: scopedConversationMatches[index] === true,
    }));

    // Capacity is deterministic prefix admission in request order. Exact
    // rejoins are already decided above and consume nothing; every genuinely
    // new capacity-consuming row decrements the single remaining-capacity
    // count, and ordered positions beyond it return typed `capacity` as the
    // request's retryable, checkpoint-unsafe remainder. A caller retries the
    // same request, rejoins the committed prefix through the canonical
    // occurrence owner, and admits the suffix once ordinary terminal recovery
    // frees capacity. No reservation, rollback, staging, fairness, progress
    // cursor, or second capacity counter exists; the count below stays the one
    // capacity owner, evaluated inside this request's fence/transaction.
    let remainingEventConversationCapacity = 0;
    if (prepared.some((result) => (
        result.kind === "prepared" && consumesEventConversationCapacity(result.admission)
    ))) {
        const occupied = await params.tx.automationRun.count({
            where: {
                accountId: params.accountId,
                automation: { is: { scopeSessionId: null } },
                OR: [
                    { causeKind: "conversation" },
                    { causeKind: "trigger", causeTriggerKind: "pluginEvent" },
                ],
                state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] },
            },
        });
        remainingEventConversationCapacity = Math.max(
            0,
            MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT - occupied,
        );
    }
    const results: AutomationRunAdmissionResult[] = [];
    for (const result of prepared) {
        if (result.kind !== "prepared") {
            results.push(result);
            continue;
        }
        const consumesCapacity = consumesEventConversationCapacity(result.admission);
        if (consumesCapacity && remainingEventConversationCapacity <= 0) {
            results.push({ kind: "ineligible", reason: "capacity" });
            continue;
        }
        const admitted = await insertPreparedAutomationRunTx({
            tx: params.tx,
            accountId: params.accountId,
            admission: result.admission,
        });
        // Only a genuinely inserted row consumes capacity; rejoins never
        // reach this loop and blocked positions decrement nothing.
        if (consumesCapacity) remainingEventConversationCapacity -= 1;
        results.push(admitted);
    }
    return results;
}

/** The scalar adapter over the canonical bounded admission owner. */
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
