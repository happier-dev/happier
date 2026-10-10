import {
    AutomationRunCauseSchema,
    AutomationSessionLifecycleOccurrenceEvidenceV1Schema,
    deriveAutomationOccurrenceKeyV1,
    snapshotAutomationSessionLifecyclePolicy,
    type AutomationSessionLifecycleOccurrenceEvidenceV1,
    type SessionTurnFactsV1,
} from "@happier-dev/protocol";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { afterTx, type Tx } from "@/storage/inTx";

import { emitAutomationSourceStatusUpdated } from "./automationChangePublisher";
import {
    admitAutomationRunsTx,
    type AutomationRunAdmissionRequest,
    type AutomationRunAdmissionResult,
} from "./automationRunAdmissionService";
import { decodeAutomationSessionLifecycleConfiguration } from "./automationSessionLifecycleConfigurationCodec";
import { automationPortableQueryChunks } from "./automationPortableQueryChunks";
import { lockScopedAutomationTriggerInTx } from "./automationScopedTrigger";
import { readAutomationLifecycleOriginRunIdTx, readAutomationOriginTriggerIdsTx } from "./automationTriggerCauseChain";

export type SessionLifecycleAdmissionResult = Readonly<{
    triggerId: string;
    result: AutomationRunAdmissionResult;
}>;

type SessionLifecycleOccurrence = AutomationSessionLifecycleOccurrenceEvidenceV1;

function buildLifecycleCause(params: Readonly<{
    triggerId: string;
    triggerRevision: number;
    definition: ReturnType<typeof decodeAutomationSessionLifecycleConfiguration>["definition"];
    occurrence: SessionLifecycleOccurrence;
}>) {
    const { occurrence } = params;
    const cause = AutomationRunCauseSchema.parse({
        kind: "trigger",
        triggerId: params.triggerId,
        triggerRevision: params.triggerRevision,
        triggerKind: "sessionLifecycle",
        occurrenceKey: deriveAutomationOccurrenceKeyV1({
            triggerId: params.triggerId,
            evidence: occurrence,
        }),
        occurredAt: occurrence.occurredAt,
        evidence: {
            event: occurrence.event,
            sourceSessionId: occurrence.sourceSessionId,
            ...("sourceTurnId" in occurrence ? { sourceTurnId: occurrence.sourceTurnId } : {}),
            ...(occurrence.event === "userActionRequired"
                ? { requestId: occurrence.requestId, requestKind: occurrence.requestKind }
                : {}),
            policy: snapshotAutomationSessionLifecyclePolicy(params.definition.policy),
        },
    });
    if (cause.kind !== "trigger" || cause.triggerKind !== "sessionLifecycle") {
        throw new Error("Session lifecycle cause codec returned the wrong cause arm");
    }
    return cause;
}

function isTerminalLifecycleEvent(event: SessionLifecycleOccurrence["event"]): boolean {
    return event === "parentTurnCompleted" || event === "parentTurnFailed" || event === "parentTurnCancelled";
}

/**
 * A consumed occurrence that produced no Run still changes the trigger status
 * every Automation reader projects, and admission's own publication cannot
 * carry it because there is no Run. Reuse the incumbent Automation change and
 * content-free invalidation rather than inventing a budget event: the
 * authenticated Automation query stays the only reader of what changed.
 */
async function publishNoRunBudgetConsumptionTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    automationIds: ReadonlySet<string>;
}>): Promise<void> {
    for (const automationId of params.automationIds) {
        const cursor = await markAccountChanged(params.tx, {
            accountId: params.accountId,
            kind: "automation",
            entityId: automationId,
        });
        afterTx(params.tx, () => {
            emitAutomationSourceStatusUpdated({ accountId: params.accountId, cursor });
        });
    }
}

/**
 * Canonical Session lifecycle membership, bounded-consumption, and cause owner.
 * The caller composes this inside the Session fact's incumbent transaction.
 */
export async function admitSessionLifecycleAutomationRunsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    occurrence: SessionLifecycleOccurrence;
    sourceTurnFacts?: SessionTurnFactsV1;
    /** Authenticated write actor, distinct from immutable turn admission facts. */
}>): Promise<ReadonlyArray<SessionLifecycleAdmissionResult>> {
    const occurrence = AutomationSessionLifecycleOccurrenceEvidenceV1Schema.parse(
        params.occurrence,
    );
    if (occurrence.event === "parentTurnCompleted" || occurrence.event === "parentTurnFailed"
        || occurrence.event === "parentTurnCancelled") {
        const turn = await params.tx.sessionTurn.findUnique({
            where: { sessionId_turnId: { sessionId: occurrence.sourceSessionId, turnId: occurrence.sourceTurnId } },
            select: { initiator: true },
        });
        if (turn?.initiator !== "user" && turn?.initiator !== "agent_session") return [];
    }
    if (occurrence.event === "userActionRequired") {
        // A pending main-turn request can only be awaiting the user while its
        // exact host-stamped parent turn is still the Session's live turn. A
        // missing, already terminalized, or superseded turn is stale publisher
        // truth arriving late, not a new occurrence: it must bind to no turn,
        // admit no Run, and consume no trigger budget.
        const sourceTurn = await params.tx.sessionTurn.findUnique({
            where: {
                sessionId_turnId: {
                    sessionId: occurrence.sourceSessionId,
                    turnId: occurrence.sourceTurnId,
                },
            },
            select: { status: true },
        });
        if (sourceTurn?.status !== "in_progress") return [];
        const sourceSession = await params.tx.session.findUnique({
            where: { id: occurrence.sourceSessionId },
            select: { latestTurnId: true },
        });
        if (sourceSession?.latestTurnId !== occurrence.sourceTurnId) return [];
    }
    const rows = await params.tx.automationTrigger.findMany({
        where: {
            kind: "sessionLifecycle",
            sourceSessionId: occurrence.sourceSessionId,
            deletedAt: null,
            automation: {
                accountId: params.accountId,
                deletedAt: null,
            },
        },
        orderBy: { id: "asc" },
        select: {
            id: true,
            automationId: true,
            enabled: true,
            revision: true,
            sessionLifecycleEventsJson: true,
            sessionLifecyclePolicyKind: true,
            sessionLifecycleMatchCount: true,
            remainingOccurrences: true,
            sourceSessionId: true,
            sourceTurnId: true,
            automation: { select: { enabled: true, scopeSessionId: true } },
        },
    });

    const originRunId = rows.length > 0 ? await readAutomationLifecycleOriginRunIdTx(params.tx, occurrence) : null;
    const originTriggerIds = rows.length > 0
        ? await readAutomationOriginTriggerIdsTx(params.tx, occurrence, originRunId ?? undefined) : new Set<string>();
    const candidates: Array<{
        row: typeof rows[number];
        cause: ReturnType<typeof buildLifecycleCause>;
        reserved: boolean;
    }> = [];
    const exhausted: Array<{
        row: typeof rows[number];
        cause: ReturnType<typeof buildLifecycleCause>;
    }> = [];
    const budgetConsumedWithoutRun = new Set<string>();
    for (const listedRow of rows) {
        if (originTriggerIds.has(listedRow.id)) continue;
        const scoped = listedRow.automation.scopeSessionId !== null
            ? await lockScopedAutomationTriggerInTx(params.tx, params.accountId, listedRow.id) : null;
        const row = scoped ? { ...listedRow, ...scoped } : listedRow;
        const stored = decodeAutomationSessionLifecycleConfiguration(row);
        const definition = stored.definition;
        const isCurrentTurn = definition.policy.kind === "currentTurn";
        if (
            definition.policy.kind === "currentTurn"
            && (!("sourceTurnId" in occurrence) || definition.policy.sourceTurnId !== occurrence.sourceTurnId)
        ) continue;

        const selected = definition.events.includes(occurrence.event);
        const enabled = row.enabled && row.automation.enabled;
        if (isCurrentTurn && isTerminalLifecycleEvent(occurrence.event) && (!selected || !enabled)) {
            const consumed = await params.tx.automationTrigger.updateMany({
                where: { id: row.id, remainingOccurrences: { gt: 0 } },
                data: { remainingOccurrences: 0 },
            });
            if (consumed.count === 1) budgetConsumedWithoutRun.add(row.automationId);
            continue;
        }
        if (!selected || !enabled) continue;
        const cause = buildLifecycleCause({
            triggerId: row.id,
            triggerRevision: row.revision,
            definition,
            occurrence,
        });
        const replacesPending = scoped !== null && await params.tx.automationRun.findFirst({
            where: { accountId: params.accountId, triggerId: row.id, state: "queued" }, select: { id: true },
        }) !== null;
        if (stored.remainingOccurrences === 0 && !replacesPending) {
            exhausted.push({ row, cause });
            continue;
        }

        const bounded = stored.remainingOccurrences !== null && !replacesPending;
        if (bounded) {
            const reserved = await params.tx.automationTrigger.updateMany({
                where: {
                    id: row.id,
                    revision: row.revision,
                    remainingOccurrences: stored.remainingOccurrences,
                },
                data: { remainingOccurrences: { decrement: 1 } },
            });
            if (reserved.count !== 1) continue;
        }
        candidates.push({ row, cause, reserved: bounded });
    }
    if (exhausted.length > 0) {
        const existingPages = await Promise.all(automationPortableQueryChunks({
            values: exhausted,
            bindingsPerValue: 2,
        }).map((page) => params.tx.automationRun.findMany({
            where: {
                OR: page.map(({ row, cause }) => ({
                    triggerId: row.id,
                    occurrenceKey: cause.occurrenceKey,
                })),
            },
            select: { triggerId: true, occurrenceKey: true },
        })));
        const existingKeys = new Set(existingPages.flat().map((run) => (
            JSON.stringify([run.triggerId, run.occurrenceKey])
        )));
        for (const candidate of exhausted) {
            if (existingKeys.has(JSON.stringify([candidate.row.id, candidate.cause.occurrenceKey]))) {
                candidates.push({ ...candidate, reserved: false });
            }
        }
    }
    if (candidates.length === 0) {
        await publishNoRunBudgetConsumptionTx({
            tx: params.tx,
            accountId: params.accountId,
            automationIds: budgetConsumedWithoutRun,
        });
        return [];
    }

    const admissions: AutomationRunAdmissionRequest[] = candidates.map(({ row, cause }) => {
        return {
            automationId: row.automationId,
            now: new Date(occurrence.occurredAt),
            cause,
        };
    });
    const results = await admitAutomationRunsTx({
        tx: params.tx,
        accountId: params.accountId,
        admissions,
    });

    for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        const result = results[index]!;
        if (!candidate.reserved || result.kind === "admitted") continue;
        // An exact-turn trigger is consumed by its first selected occurrence.
        // When an invariant leaves that occurrence without a Run, returning
        // the reserved occurrence would restore a repeatability this policy
        // never has, so the trigger stays inert and the settlement caller's
        // typed ineligibility diagnostic carries the outcome. A rejoin is a
        // replay of one occurrence and still returns its reservation.
        if (
            result.kind === "ineligible"
            && candidate.cause.evidence.policy.kind === "currentTurn"
        ) {
            budgetConsumedWithoutRun.add(candidate.row.automationId);
            continue;
        }
        await params.tx.automationTrigger.update({
            where: { id: candidate.row.id },
            data: { remainingOccurrences: { increment: 1 } },
        });
    }
    await publishNoRunBudgetConsumptionTx({
        tx: params.tx,
        accountId: params.accountId,
        automationIds: budgetConsumedWithoutRun,
    });
    return candidates.map((candidate, index) => ({
        triggerId: candidate.row.id,
        result: results[index]!,
    }));
}
