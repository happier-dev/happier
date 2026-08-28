import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageStartEntrySessionResultV1 } from '../../actions/entrySessionProtocol.js';

export type TriageBulkEntryOutcomeV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    session: 'created' | 'rejoined' | 'existing' | 'notCreated' | 'uncertain';
    attachment: 'carried' | 'refused' | 'uncertain' | 'notRequested';
    link: 'created' | 'conflictedOrUnavailable' | 'notAttempted';
    newSessionSeed: 'applied' | 'refused' | 'notRequested';
    directSend: 'applied' | 'refused' | 'uncertain' | 'notRequested';
}>;

export type TriageBulkLinkOutcomeV1 = 'created' | 'conflictedOrUnavailable';
export type TriageBulkComposeOutcomeV1 = 'applied' | 'refused' | 'notRequested';

type TriageBulkSettlementResultV1 =
    | Readonly<{
        status: 'settled';
        outcome: Readonly<{
            start: TriageStartEntrySessionResultV1;
            entries: readonly TriageBulkEntryOutcomeV1[];
        }>;
    }>
    | Readonly<{ status: 'unknownOutcome' }>
    | Readonly<{ status: 'notStarted' }>;

export type TriageBulkSettlementSummaryV1 = Readonly<{
    opened: number;
    unknown: number;
    notStarted: number;
    left: number;
}>;

/** True when this entry did not reach every operation the chosen destination requested. */
export function isTriageBulkEntryOutcomeIncompleteV1(outcome: TriageBulkEntryOutcomeV1): boolean {
    return outcome.session === 'notCreated'
        || outcome.session === 'uncertain'
        || outcome.attachment === 'refused'
        || outcome.attachment === 'uncertain'
        || outcome.link === 'conflictedOrUnavailable'
        || outcome.newSessionSeed === 'refused'
        || outcome.directSend === 'refused'
        || outcome.directSend === 'uncertain';
}

/**
 * Projects the four reader-facing counts without confusing an answered
 * orchestration result with a created Session.
 *
 * The outer `settled` arm means the request answered. Its inner start result
 * still decides whether a Session exists, is uncertain, or never started.
 * Entry-level `left` counts apply only after a Session exists; otherwise the
 * unit-level unknown/not-started count already says what happened and counting
 * the same entries again would double-report one failure.
 */
export function summarizeTriageBulkSettlementV1(input: Readonly<{
    results: readonly TriageBulkSettlementResultV1[];
    unavailableCount: number;
    refusalCount: number;
}>): TriageBulkSettlementSummaryV1 {
    let opened = 0;
    let unknown = 0;
    let notStarted = 0;
    let incompleteEntries = 0;
    for (const result of input.results) {
        if (result.status === 'unknownOutcome') {
            unknown += 1;
            continue;
        }
        if (result.status === 'notStarted') {
            notStarted += 1;
            continue;
        }
        const start = result.outcome.start;
        if (start.type === 'creationPending') {
            unknown += 1;
            continue;
        }
        if (start.type === 'creationFailed'
            || start.type === 'rejected'
            || start.type === 'workspacePreparationFailed') {
            notStarted += 1;
            continue;
        }
        opened += 1;
        incompleteEntries += result.outcome.entries.filter(
            isTriageBulkEntryOutcomeIncompleteV1,
        ).length;
    }
    return Object.freeze({
        opened,
        unknown,
        notStarted,
        left: input.unavailableCount + input.refusalCount + incompleteEntries,
    });
}

function sessionOutcome(result: TriageStartEntrySessionResultV1): TriageBulkEntryOutcomeV1['session'] {
    if (result.type === 'creationPending') return 'uncertain';
    if (result.type === 'creationFailed' || result.type === 'rejected'
        || result.type === 'workspacePreparationFailed') return 'notCreated';
    return result.disposition;
}

function directSendOutcome(
    result: TriageStartEntrySessionResultV1,
): TriageBulkEntryOutcomeV1['directSend'] {
    if (result.type !== 'opened' && result.type !== 'openPending' && result.type !== 'linked') {
        return 'notRequested';
    }
    if (result.delivery === 'accepted' || result.delivery === 'alreadyAccepted') return 'applied';
    if (result.delivery === 'outcomeUnknown') return 'uncertain';
    if (result.delivery === 'rejected' || result.delivery === 'none') return 'refused';
    return 'notRequested';
}

export function projectTriageBulkEntryOutcomesV1(input: Readonly<{
    entries: readonly Readonly<{ entryRef: TriageEntryRefV1 }>[];
    start: TriageStartEntrySessionResultV1;
    secondaryLinks: readonly TriageBulkLinkOutcomeV1[];
    compose: TriageBulkComposeOutcomeV1;
}>): readonly TriageBulkEntryOutcomeV1[] {
    const send = directSendOutcome(input.start);
    return input.entries.map((entry, index) => {
        const link: TriageBulkEntryOutcomeV1['link'] = index === 0
            ? input.start.type === 'opened' || input.start.type === 'openPending' || input.start.type === 'linked'
                ? 'created'
                : input.start.type === 'linkPending'
                    ? 'conflictedOrUnavailable'
                    : 'notAttempted'
            : input.secondaryLinks[index - 1] ?? 'notAttempted';
        const attachment: TriageBulkEntryOutcomeV1['attachment'] = send === 'applied'
            ? 'carried'
            : send === 'uncertain'
                ? 'uncertain'
                : send === 'refused'
                    ? 'refused'
                    : input.compose === 'applied'
                        ? 'carried'
                        : input.compose === 'refused'
                            ? 'refused'
                            : 'notRequested';
        return {
            entryRef: entry.entryRef,
            session: sessionOutcome(input.start),
            attachment,
            link,
            newSessionSeed: 'notRequested',
            directSend: send,
        };
    });
}

export function projectTriageBulkSeedOutcomesV1(
    entries: readonly Readonly<{ entryRef: TriageEntryRefV1 }>[],
    status: 'applied' | 'refused',
): readonly TriageBulkEntryOutcomeV1[] {
    return entries.map((entry) => ({
        entryRef: entry.entryRef,
        session: 'notCreated',
        attachment: status === 'applied' ? 'carried' : 'refused',
        link: 'notAttempted',
        newSessionSeed: status,
        directSend: 'notRequested',
    }));
}
