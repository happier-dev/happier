import type { DiscussionParticipantRoster } from './useDiscussionParticipantManagement';
import * as React from 'react';
import type { DiscussionParticipantRefV1 } from '@happier-dev/protocol/discussions/references';
import { buildRecipientMultiSelectModel, type RecipientMultiSelectModel } from '@/components/sessions/agentInput/routing/recipientMultiSelectModel';
import type { DiscussionDraft, DiscussionDraftContentOptions } from './useDiscussionDraft';
import type { DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';
import { prepareDiscussionContentForRecipients } from './discussionComposerDocument';

export function discussionRecipientKey(participant: DiscussionParticipantRefV1): string {
    return participant.kind === 'account' ? `account:${participant.accountId}` : `session:${participant.sessionId}`;
}

export type DiscussionRecipientSelection = RecipientMultiSelectModel<DiscussionParticipantRefV1> & Readonly<{
    /** Null retains the draft while the admitted roster needed by its defaults is unavailable. */
    prepareContent(content: DiscussionMessageContentV1, options?: DiscussionDraftContentOptions): DiscussionMessageContentV1 | null;
}>;

/** A demanded, admitted roster supplies choices; display labels never admit a recipient. */
export function useDiscussionRecipientSelection(input: Readonly<{
    draft: Pick<DiscussionDraft, 'recipients' | 'setRecipients' | 'replyTarget' | 'prepareContent'>;
    roster: DiscussionParticipantRoster | null;
    label(participant: DiscussionParticipantRefV1): string;
}>): DiscussionRecipientSelection {
    return React.useMemo<DiscussionRecipientSelection>(() => {
        const participants = new Map<string, DiscussionParticipantRefV1>();
        const add = (participant: DiscussionParticipantRefV1) => participants.set(discussionRecipientKey(participant), participant);
        if (input.roster) {
            add({ kind: 'account', accountId: input.roster.ownerAccountId });
            for (const grant of input.roster.grants) if (grant.principal.kind === 'account') add(grant.principal);
            for (const row of input.roster.participants) {
                if (row.participant.kind === 'session') add(row.participant);
                else if ('sessionId' in row && row.sessionId) add({ kind: 'session', sessionId: row.sessionId });
            }
        }
        const selection = buildRecipientMultiSelectModel({
            targets: [...participants].map(([id, recipient]) => ({ id, recipient, label: input.label(recipient) })),
            recipients: input.draft.recipients, key: discussionRecipientKey, onChange: input.draft.setRecipients,
        });
        return {
            ...selection,
            // An unavailable roster is not evidence that participants were removed.
            removedRecipients: input.roster ? selection.removedRecipients : [],
            prepareContent(content, options) {
                if (!input.roster && prepareDiscussionContentForRecipients({ content, recipients: input.draft.recipients,
                    replyTarget: options?.replyTarget ?? input.draft.replyTarget ?? undefined }) !== content) return null;
                return input.draft.prepareContent(content, { ...options, recipients: selection.selectedRecipients });
            },
        };
    }, [input.roster, input.label, input.draft.recipients, input.draft.setRecipients, input.draft.replyTarget, input.draft.prepareContent]);
}
