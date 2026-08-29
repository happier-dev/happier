import {
    AutomationRunCauseSchema,
    AutomationSessionLifecycleOccurrenceEvidenceV1Schema,
    deriveAutomationOccurrenceKeyV1,
} from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";

import {
    admitAutomationRunsTx,
    type AutomationRunAdmissionRequest,
    type AutomationRunAdmissionResult,
} from "./automationRunAdmissionService";
import { hasAppliedSessionLifecycleTerminalNoRunReceiptTx } from "./automationSessionLifecycleTerminalTruth";

export type SessionLifecycleAdmissionResult = Readonly<{
    triggerId: string;
    result: AutomationRunAdmissionResult;
}>;

/** Exact Session lifecycle membership and cause construction owner. */
export async function admitCompletedParentTurnAutomationRunsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    sourceSessionId: string;
    sourceTurnId: string;
    occurredAt: number;
}>): Promise<ReadonlyArray<SessionLifecycleAdmissionResult>> {
    const candidates = await params.tx.automationTrigger.findMany({
        where: {
            kind: "sessionLifecycle",
            sessionLifecycleEvent: "parentTurnCompleted",
            sourceSessionId: params.sourceSessionId,
            sourceTurnId: params.sourceTurnId,
            // Matching membership is the enabled, non-deleted Automation and
            // trigger set visible at this transaction's serialization point.
            enabled: true,
            deletedAt: null,
            automation: { enabled: true, deletedAt: null },
        },
        orderBy: { id: "asc" },
        select: { id: true, automationId: true, revision: true },
    });
    if (candidates.length === 0) return [];
    if (await hasAppliedSessionLifecycleTerminalNoRunReceiptTx({
        tx: params.tx,
        sourceSessionId: params.sourceSessionId,
        sourceTurnId: params.sourceTurnId,
    })) return [];

    const evidence = AutomationSessionLifecycleOccurrenceEvidenceV1Schema.parse({
        v: 1,
        kind: "sessionLifecycle",
        event: "parentTurnCompleted",
        sourceSessionId: params.sourceSessionId,
        sourceTurnId: params.sourceTurnId,
        occurredAt: params.occurredAt,
    });
    const admissions: AutomationRunAdmissionRequest[] = candidates.map((candidate) => {
        const cause = AutomationRunCauseSchema.parse({
            kind: "trigger",
            triggerId: candidate.id,
            triggerRevision: candidate.revision,
            triggerKind: "sessionLifecycle",
            occurrenceKey: deriveAutomationOccurrenceKeyV1({
                triggerId: candidate.id,
                evidence,
            }),
            occurredAt: params.occurredAt,
            evidence: {
                event: evidence.event,
                sourceSessionId: evidence.sourceSessionId,
                sourceTurnId: evidence.sourceTurnId,
            },
        });
        return {
            automationId: candidate.automationId,
            now: new Date(params.occurredAt),
            cause,
        };
    });
    const results = await admitAutomationRunsTx({
        tx: params.tx,
        accountId: params.accountId,
        admissions,
    });
    return candidates.map((candidate, index) => ({
        triggerId: candidate.id,
        result: results[index]!,
    }));
}
