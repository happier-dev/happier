import { AutomationOccurrenceEvidenceV1Schema, type AutomationOccurrenceEvidenceV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { AutomationStoredContentEnvelopeV1Schema } from '@happier-dev/protocol/automations/automationStoredContentEnvelopeV1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
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

/** Bounded batch form consumed by one Event admission request. */
export async function findAutomationOccurrencesTx<TSelect extends Prisma.AutomationRunSelect>(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        occurrences: readonly Readonly<{ automationId: string; occurrenceKey: string }>[];
        select: TSelect;
    }>,
): Promise<Array<Prisma.AutomationRunGetPayload<{ select: TSelect }>>> {
    if (params.occurrences.length === 0) return [];
    return await params.tx.automationRun.findMany({
        where: {
            accountId: params.accountId,
            OR: params.occurrences.map((occurrence) => ({
                automationId: occurrence.automationId,
                occurrenceKey: occurrence.occurrenceKey,
            })),
        },
        select: params.select,
    });
}
