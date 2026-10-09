import type {
    AutomationRunLifecycleOccurrenceEvidenceV1,
    AutomationSessionLifecycleOccurrenceEvidenceV1,
} from "@happier-dev/protocol";
import { createCanonicalJsonSigningInput, parseAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol';

import { parseStoredSessionTurnFacts } from "@/app/session/turns/parseSessionTurnState";
import { resolveWorkflowRunAccessInTx } from "@/app/workflows/workflowRunAccess";
import type { Tx } from "@/storage/inTx";

import { automationRunCauseSelect } from "./automationPersistenceSelect";
import { decodeAutomationRunCause } from "./automationRunCauseCodec";

/** A signed Machine publisher can report only its own admitted Run origin. */
export async function isAutomationOriginRunPublisherTx(tx: Tx, params: Readonly<{
    accountId: string; machineId: string; runId: string;
    requireCurrentScopeEnd?: boolean;
}>): Promise<boolean> {
    if (!await resolveWorkflowRunAccessInTx(tx, { actorAccountId: params.accountId, runId: params.runId })) return false;
    const run = await tx.automationRun.findFirst({ where: { id: params.runId,
        assignments: { some: { machineId: params.machineId } } }, select: { id: true, automationId: true, state: true, executionInputEnvelope: true,
            ...automationRunCauseSelect } });
    if (!run) return false;
    if (!params.requireCurrentScopeEnd) return true;
    if (run.state === 'cancelled' || run.state === 'interrupted' || run.state === 'failed') return false;
    const cause = decodeAutomationRunCause(run);
    // Other FIN Actions retain their existing semantics. Only persisted
    // archive/terminal sources carry the scope-end effect obligation.
    if (cause?.kind !== 'trigger' || (cause.triggerKind !== 'sessionLifecycle' && cause.triggerKind !== 'runLifecycle')) return true;
    if (cause.triggerKind === 'sessionLifecycle' && cause.evidence.event !== 'sessionArchived'
        || cause.triggerKind === 'runLifecycle' && cause.evidence.condition !== 'terminal') return true;
    const trigger = await tx.automationTrigger.findFirst({ where: { id: cause.triggerId, automationId: run.automationId,
        revision: cause.triggerRevision, kind: cause.triggerKind, enabled: true, deletedAt: null,
        automation: { accountId: params.accountId, enabled: true, deletedAt: null } },
        select: { sourceSessionId: true, sourceRunId: true, sourceRunMachineId: true,
            automation: { select: { templateCiphertext: true } } } });
    if (!trigger) return false;
    const recipe = parseAutomationStoredWorkflowDefinitionRecipeV2(trigger.automation.templateCiphertext);
    // Admission copies this exact stored receipt, including opaque ciphertext.
    // Replacing it retires the old effect; Home never decrypts or infers content
    // equivalence from independently resealed envelopes.
    if (recipe.kind !== 'available'
        || run.executionInputEnvelope !== createCanonicalJsonSigningInput(recipe.recipe.workflow)) return false;
    // Accepted intent settles the FIN leaf, not the pending native operation.
    // The immutable occurrence remains authoritative even after budget use.
    if (cause.triggerKind === 'sessionLifecycle') {
        if (cause.evidence.event !== 'sessionArchived' || trigger.sourceSessionId !== cause.evidence.sourceSessionId) return false;
        const source = await tx.session.findFirst({ where: { id: cause.evidence.sourceSessionId, accountId: params.accountId },
            select: { archivedAt: true } });
        return source?.archivedAt?.getTime() === cause.occurredAt;
    }
    if (cause.evidence.condition !== 'terminal' || trigger.sourceRunId !== cause.evidence.source.runId) return false;
    if (cause.evidence.source.kind === 'workflow_run') {
        return trigger.sourceRunMachineId === null
            && await resolveWorkflowRunAccessInTx(tx, { actorAccountId: params.accountId, runId: cause.evidence.source.runId }) !== null;
    }
    if (trigger.sourceRunMachineId !== cause.evidence.source.machineId) return false;
    if (!await tx.machine.findFirst({ where: { id: cause.evidence.source.machineId, accountId: params.accountId,
        revokedAt: null, replacedByMachineId: null }, select: { id: true } })) return false;
    return !cause.evidence.source.sessionId || await tx.session.findFirst({ where: {
        id: cause.evidence.source.sessionId, accountId: params.accountId }, select: { id: true } }) !== null;
}

async function sessionOriginRunIdTx(tx: Tx, source: Readonly<{
    sourceSessionId: string;
    sourceTurnId?: string;
    event: AutomationSessionLifecycleOccurrenceEvidenceV1["event"];
}>): Promise<string | null> {
    if (source.sourceTurnId !== undefined) {
        const turn = await tx.sessionTurn.findUnique({
            where: { sessionId_turnId: { sessionId: source.sourceSessionId, turnId: source.sourceTurnId } },
            select: { initiator: true, workDepth: true, workflowInvocationJson: true },
        });
        // A later user turn is an independent cause, even in a Run-created Session.
        if (!turn || turn.initiator !== "workflow") return null;
        return parseStoredSessionTurnFacts(turn).workflowInvocation?.runId ?? null;
    }
    // Creation origin proves Session birth, not who caused a later archive.
    if (source.event !== "sessionStarted") return null;
    const session = await tx.session.findUnique({
        where: { id: source.sourceSessionId }, select: { originRunId: true },
    });
    return session?.originRunId ?? null;
}

/**
 * Reads causality from immutable Run causes and exact host-stamped turn facts.
 * Both lifecycle admission owners use this before reserving an occurrence.
 * Nothing is copied to another registry or persisted as a parallel chain.
 */
export async function readAutomationRunCauseChainTx(tx: Tx, originRunId: string | null): Promise<Readonly<{
    triggerIds: ReadonlySet<string>;
    runIds: ReadonlySet<string>;
}>> {
    let runId = originRunId;
    const triggerIds = new Set<string>();
    const visitedRunIds = new Set<string>();
    while (runId !== null && !visitedRunIds.has(runId)) {
        visitedRunIds.add(runId);
        const run = await tx.automationRun.findUnique({ where: { id: runId },
            select: automationRunCauseSelect });
        if (!run) break;
        const cause = decodeAutomationRunCause(run);
        if (cause !== null && cause.kind !== "manual" && cause.triggerId !== undefined) triggerIds.add(cause.triggerId);
        if (cause?.kind === "trigger" && cause.triggerKind === "sessionLifecycle") {
            runId = await sessionOriginRunIdTx(tx, cause.evidence);
        } else if (cause?.kind === "trigger" && cause.triggerKind === "runLifecycle") {
            runId = cause.evidence.originRunId
                ?? (cause.evidence.source.kind === "workflow_run" ? cause.evidence.source.runId : null);
        } else {
            break;
        }
    }
    return { triggerIds, runIds: visitedRunIds };
}

export async function readAutomationLifecycleOriginRunIdTx(tx: Tx, occurrence:
    AutomationSessionLifecycleOccurrenceEvidenceV1 | AutomationRunLifecycleOccurrenceEvidenceV1,
    originRunId?: string,
): Promise<string | null> {
    return originRunId ?? (occurrence.kind === "sessionLifecycle"
        ? await sessionOriginRunIdTx(tx, occurrence)
        : occurrence.originRunId ?? (occurrence.source.kind === "workflow_run" ? occurrence.source.runId : null));
}

export async function readAutomationOriginTriggerIdsTx(tx: Tx, occurrence:
    AutomationSessionLifecycleOccurrenceEvidenceV1 | AutomationRunLifecycleOccurrenceEvidenceV1,
    originRunId?: string,
): Promise<ReadonlySet<string>> {
    const runId = await readAutomationLifecycleOriginRunIdTx(tx, occurrence, originRunId);
    return (await readAutomationRunCauseChainTx(tx, runId)).triggerIds;
}
