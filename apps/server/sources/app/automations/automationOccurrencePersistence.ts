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
 * occurrence evidence. Origin-specific construction stays with admission.
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
 * evidence. Callers retain their origin-specific row and handoff checks.
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
 * The composite unique key is the admission concurrency owner. A P2002
 * therefore restarts the caller's complete transaction so it can re-read the
 * winner and apply its own origin-specific correspondence decision.
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
 * Reads the one row governed by AutomationRun's nullable composite occurrence
 * key. Event admission scopes its query to an Account; Conversation admission
 * deliberately reads the row first so it can retain its existing account and
 * result-handoff correspondence rules.
 */
export async function findAutomationOccurrenceTx<TSelect extends Prisma.AutomationRunSelect>(
    params: Readonly<{
        tx: Tx;
        accountId?: string;
        automationId: string;
        occurrenceKey: string;
        select: TSelect;
    }>,
): Promise<Prisma.AutomationRunGetPayload<{ select: TSelect }> | null> {
    return await params.tx.automationRun.findFirst({
        where: {
            automationId: params.automationId,
            occurrenceKey: params.occurrenceKey,
            ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
        },
        select: params.select,
    });
}
