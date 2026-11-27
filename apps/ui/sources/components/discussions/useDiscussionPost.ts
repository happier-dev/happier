import * as React from 'react';
import { readDiscussionMentionedParticipantIdsV1, type DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';

import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { discussionMutationBlocksComposer, type DiscussionRepository, type DiscussionRepositorySnapshot } from '@/sync/ops/discussions/discussionRepository';
import { useDiscussionAttachmentSettlement, type DiscussionAttachmentSendSubmission } from './useDiscussionAttachmentDrafts';
import type { DiscussionDraft, DiscussionDraftAddress } from './useDiscussionDraft';
import type { DiscussionRecipientSelection } from './useDiscussionRecipientSelection';

/** The existing-thread post lifecycle, shared by the Discussion and the selected Doc margin card. */
export function useDiscussionPost(input: Readonly<{
    scope: ServerAccountScope;
    discussionId: string | null;
    repository: DiscussionRepository;
    mutations: DiscussionRepositorySnapshot['mutations'];
    messages: readonly DiscussionOpenedMessageV1[];
    draft: DiscussionDraft;
    draftAddress: DiscussionDraftAddress;
    canPost: boolean;
    /** The person's post was committed and observed in the thread (its draft has been cleared). */
    onObservedSuccess?: () => void;
    recipientSelection: Pick<DiscussionRecipientSelection, 'prepareContent'>;
}>) {
    const { scope, discussionId, repository, mutations, messages, draft, draftAddress, canPost, recipientSelection } = input;
    const [localId, setLocalId] = React.useState<string | null>(null);
    const clearingLocalId = React.useRef<string | null>(null);
    const recoveredPostMutation = Object.values(mutations).find(item => item.kind === 'post' && item.discussionId === discussionId) ?? null;
    const restoredPostAttempt = draft.pendingMutationAttempt?.kind === 'post' && draft.pendingMutationAttempt.discussionId === discussionId
        ? draft.pendingMutationAttempt : null;
    const activePostLocalId = recoveredPostMutation?.localId ?? localId;
    const mutation = activePostLocalId ? mutations[activePostLocalId] ?? null : null;
    const composerBlocked = discussionMutationBlocksComposer(mutation);
    React.useEffect(() => {
        if (!restoredPostAttempt || discussionId === null || mutations[restoredPostAttempt.localId]) return;
        if (draft.submitted?.attemptLocalId !== restoredPostAttempt.localId) return;
        const content = draft.submitted.content;
        repository.adoptPendingIntent({ kind: 'post', discussionId, localId: restoredPostAttempt.localId, content,
            ...readDiscussionMentionedParticipantIdsV1(content),
            ...(restoredPostAttempt.replyTarget ? { replyTarget: restoredPostAttempt.replyTarget } : {}),
            draftSubmission: { scope, address: draftAddress, currentness: restoredPostAttempt.currentness } });
        setLocalId(restoredPostAttempt.localId);
    }, [discussionId, draft.submitted, draftAddress, mutations, repository, restoredPostAttempt, scope]);
    const onObservedSuccessRef = React.useRef(input.onObservedSuccess);
    onObservedSuccessRef.current = input.onObservedSuccess;
    React.useEffect(() => {
        if (!activePostLocalId || mutation?.status !== 'observed_success' || !messages.some(item => item.localId === activePostLocalId)
            || clearingLocalId.current === activePostLocalId) return;
        clearingLocalId.current = activePostLocalId;
        void (async () => {
            try {
                await draft.clearAfterObservedSuccess(mutation.draftSubmission);
                repository.acknowledgeObservedSuccess(activePostLocalId);
                setLocalId(null);
                onObservedSuccessRef.current?.();
            } catch {
                // Retain the accepted mutation so remount can retry draft contraction without resending.
            } finally {
                if (clearingLocalId.current === activePostLocalId) clearingLocalId.current = null;
            }
        })();
    }, [activePostLocalId, draft, messages, mutation, repository]);
    const dismissRefusal = React.useCallback(() => {
        if (mutation?.status !== 'failed') return;
        draft.releaseSubmittedAttempt();
        repository.dismissFailure(mutation.localId);
        setLocalId(null);
    }, [draft, mutation, repository]);
    const trackAttachments = useDiscussionAttachmentSettlement(mutations);
    const send = React.useCallback(async (textContent: DiscussionMessageContentV1, attachments?: DiscussionAttachmentSendSubmission) => {
        if (discussionId === null || !canPost || composerBlocked) { attachments?.settle('failed', 'canceled'); return; }
        const replyTarget = draft.replyTarget ?? undefined;
        const content = recipientSelection.prepareContent(textContent, { replyTarget });
        if (!content) { attachments?.settle('failed', 'canceled'); return; }
        if (mutation) dismissRefusal();
        const id = randomUUID();
        const draftSubmission = draft.captureSubmittedCurrentness({ kind: 'post', discussionId, localId: id,
            ...(replyTarget ? { replyTarget } : {}) }, { content });
        setLocalId(id);
        const posted = repository.post({ discussionId, localId: id, content, ...readDiscussionMentionedParticipantIdsV1(content),
            ...(replyTarget ? { replyTarget } : {}), draftSubmission,
            ...(attachments ? { attachmentSources: attachments.sources } : {}) });
        await (attachments ? trackAttachments(id, attachments, posted) : posted);
    }, [canPost, composerBlocked, discussionId, dismissRefusal, draft, mutation, recipientSelection, repository, trackAttachments]);
    return { mutation, composerBlocked, dismissRefusal, send };
}
