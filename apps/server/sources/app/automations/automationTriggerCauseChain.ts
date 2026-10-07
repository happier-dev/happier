import type {
    AutomationRunLifecycleOccurrenceEvidenceV1,
    AutomationSessionLifecycleOccurrenceEvidenceV1,
} from "@happier-dev/protocol";

import { parseStoredSessionTurnFacts } from "@/app/session/turns/parseSessionTurnState";
import { resolveWorkflowRunAccessInTx } from "@/app/workflows/workflowRunAccess";
import type { Tx } from "@/storage/inTx";

import { automationRunCauseSelect } from "./automationPersistenceSelect";
import { decodeAutomationRunCause } from "./automationRunCauseCodec";

/** A signed Machine publisher can report only its own admitted Run origin. */
export async function isAutomationOriginRunPublisherTx(tx: Tx, params: Readonly<{
    accountId: string; machineId: string; runId: string;
}>): Promise<boolean> {
    if (!await resolveWorkflowRunAccessInTx(tx, { actorAccountId: params.accountId, runId: params.runId })) return false;
    return await tx.automationRun.findFirst({ where: { id: params.runId,
        assignments: { some: { machineId: params.machineId } } }, select: { id: true } }) !== null;
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
export async function readAutomationOriginTriggerIdsTx(tx: Tx, occurrence:
    AutomationSessionLifecycleOccurrenceEvidenceV1 | AutomationRunLifecycleOccurrenceEvidenceV1,
): Promise<ReadonlySet<string>> {
    let runId = occurrence.kind === "sessionLifecycle"
        ? await sessionOriginRunIdTx(tx, occurrence)
        : occurrence.source.kind === "workflow_run" ? occurrence.source.runId : null;
    const triggerIds = new Set<string>();
    const visitedRunIds = new Set<string>();
    while (runId !== null && !visitedRunIds.has(runId)) {
        visitedRunIds.add(runId);
        const run = await tx.automationRun.findUnique({ where: { id: runId }, select: automationRunCauseSelect });
        if (!run) break;
        const cause = decodeAutomationRunCause(run);
        if (cause === null || cause.kind === "manual") break;
        if (cause.triggerId !== undefined) triggerIds.add(cause.triggerId);
        if (cause.kind === "trigger" && cause.triggerKind === "sessionLifecycle") {
            runId = await sessionOriginRunIdTx(tx, cause.evidence);
        } else if (cause.kind === "trigger" && cause.triggerKind === "runLifecycle"
            && cause.evidence.source.kind === "workflow_run") {
            runId = cause.evidence.source.runId;
        } else {
            break;
        }
    }
    return triggerIds;
}
