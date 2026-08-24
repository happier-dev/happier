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

function sessionOutcome(result: TriageStartEntrySessionResultV1): TriageBulkEntryOutcomeV1['session'] {
    if (result.type === 'creationPending') return 'uncertain';
    if (result.type === 'creationFailed' || result.type === 'rejected'
        || result.type === 'workspacePreparationFailed') return 'notCreated';
    return result.disposition;
}

function directSendOutcome(
    result: TriageStartEntrySessionResultV1,
): TriageBulkEntryOutcomeV1['directSend'] {
    if (result.type !== 'opened' && result.type !== 'openPending') return 'notRequested';
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
            ? input.start.type === 'opened' || input.start.type === 'openPending'
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
