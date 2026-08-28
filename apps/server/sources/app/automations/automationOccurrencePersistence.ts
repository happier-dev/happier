import {
    AutomationOccurrenceEvidenceV1Schema,
    AutomationStoredContentEnvelopeV1Schema,
    createCanonicalJsonSigningInput,
    type AutomationOccurrenceEvidenceV1,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import type { Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";

import { validateAutomationStoredContentEnvelopeOuterForMode } from "./automationStoredContentRead";

export type PlainAutomationOccurrenceEvidenceDisposition =
    | "match"
    | "mismatch"
    | "unavailable";

/**
 * Canonical plain persistence encoding for immutable Event/Conversation
 * occurrence evidence. Cause-kind-specific construction stays with admission.
 */
export function encodePlainAutomationOccurrenceEvidence(
    evidence: AutomationOccurrenceEvidenceV1,
): string {
    return JSON.stringify(AutomationStoredContentEnvelopeV1Schema.parse({
        t: "plain",
        v: evidence,
    }));
}

/**
 * Decodes one retained plain occurrence envelope and compares its immutable
 * evidence. Callers retain their cause-specific row and handoff checks.
 */
export function classifyPlainAutomationOccurrenceEvidence(params: Readonly<{
    triggerEvidenceEnvelope: string | null;
    expectedEvidence: AutomationOccurrenceEvidenceV1;
}>): PlainAutomationOccurrenceEvidenceDisposition {
    if (params.triggerEvidenceEnvelope === null) return "mismatch";

    const outer = validateAutomationStoredContentEnvelopeOuterForMode({
        raw: params.triggerEvidenceEnvelope,
        mode: "plain",
    });
    if (outer.kind !== "available" || outer.envelope.t !== "plain") return "unavailable";

    const retained = AutomationOccurrenceEvidenceV1Schema.safeParse(outer.envelope.v);
    if (!retained.success) return "unavailable";

    return createCanonicalJsonSigningInput(retained.data)
        === createCanonicalJsonSigningInput(params.expectedEvidence)
        ? "match"
        : "mismatch";
}

/**
 * The database occurrence uniqueness constraint is the admission concurrency
 * owner. A P2002 therefore restarts the caller's complete transaction so it
 * can re-read the winner and apply its own cause-specific correspondence
 * decision.
 */
export async function rejoinAutomationOccurrenceInsertRace<T>(
    operation: () => Promise<T>,
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        return await operation();
    }
}

/**
 * Reads the one immutable plugin-Event occurrence for an exact Trigger.
 *
 * The persisted occurrence key is derived from Trigger identity, but querying
 * by Trigger explicitly keeps the runtime authority aligned with the
 * AutomationTrigger row rather than recreating the retired
 * Automation+occurrence semantic identity.
 */
export async function findAutomationTriggerOccurrenceTx<TSelect extends Prisma.AutomationRunSelect>(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        triggerId: string;
        occurrenceKey: string;
        select: TSelect;
    }>,
): Promise<Prisma.AutomationRunGetPayload<{ select: TSelect }> | null> {
    const [row] = await findAutomationTriggerOccurrencesTx({
        tx: params.tx,
        accountId: params.accountId,
        occurrences: [{ triggerId: params.triggerId, occurrenceKey: params.occurrenceKey }],
        select: params.select,
    });
    return row ?? null;
}

/** Bounded batch form consumed by one Event admission request. */
export async function findAutomationTriggerOccurrencesTx<TSelect extends Prisma.AutomationRunSelect>(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        occurrences: readonly Readonly<{ triggerId: string; occurrenceKey: string }>[];
        select: TSelect;
    }>,
): Promise<Array<Prisma.AutomationRunGetPayload<{ select: TSelect }>>> {
    if (params.occurrences.length === 0) return [];
    return await params.tx.automationRun.findMany({
        where: {
            accountId: params.accountId,
            OR: params.occurrences.map((occurrence) => ({
                triggerId: occurrence.triggerId,
                occurrenceKey: occurrence.occurrenceKey,
            })),
        },
        select: params.select,
    });
}
