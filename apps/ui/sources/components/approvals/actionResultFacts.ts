import { SessionSectionSetResultV1Schema } from '@happier-dev/protocol/actions/sessionSections';

export type AcknowledgedActionInverse = Readonly<{
    actionId: 'session.section.set';
    input: Readonly<{ sessionId: string; sectionId: string | null }>;
}>;

export type AcknowledgedActionResult = Readonly<{
    kind: 'session_section_changed';
    sessionId: string;
    sectionId: string | null;
    previousSectionId: string | null;
    inverse: AcknowledgedActionInverse | null;
}>;

/** Checked on activation, never while rendering a result card. */
export function resolveAcknowledgedActionInverse(
    fact: AcknowledgedActionResult,
    currentSectionId: string | null,
): AcknowledgedActionInverse | null {
    return currentSectionId === fact.sectionId ? fact.inverse : null;
}

/** Only a known Action's strict committed result supplies host-derived inverse intent. */
export function readAcknowledgedActionResult(input: Readonly<{
    actionId: string;
    result: unknown;
}>): AcknowledgedActionResult | null {
    if (input.actionId !== 'session.section.set') return null;
    const envelope = input.result && typeof input.result === 'object' && 'ok' in input.result
        ? input.result : null;
    const parsed = SessionSectionSetResultV1Schema.safeParse(envelope
        ? envelope.ok === true && 'result' in envelope ? envelope.result : null
        : input.result);
    if (!parsed.success) return null;
    const { sessionId, sectionId, previousSectionId } = parsed.data;
    return {
        kind: 'session_section_changed', sessionId, sectionId, previousSectionId,
        inverse: sectionId === previousSectionId ? null : {
            actionId: 'session.section.set', input: { sessionId, sectionId: previousSectionId },
        },
    };
}
