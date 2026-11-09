import type { DiscussionCreateResultV1 } from '@happier-dev/protocol/discussions/actions';
import { DiscussionSecondOpinionStartInputV1Schema, type DiscussionSecondOpinionStartInputV1, type DiscussionSecondOpinionStartResultV1 } from '@happier-dev/protocol/discussions/secondOpinionActions';
import { prepareAnchoredDiscussionCreateV1 } from '@happier-dev/protocol/actions/executor/discussionSecondOpinion';
import { createDiscussionClient, type DiscussionClientOutcome } from '@/sync/api/discussions/discussionActions';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { randomUUID } from '@/platform/randomUUID';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';

type Draft = Pick<DiscussionSecondOpinionStartInputV1, 'title' | 'question' | 'reviewers' | 'participants'>;
type Preview = Extract<DiscussionSecondOpinionStartResultV1, { status: 'preview' }>;
type Result = Readonly<{ operation: 'second_opinion'; outcome: DiscussionClientOutcome<DiscussionSecondOpinionStartResultV1> }>
    | Readonly<{ operation: 'discuss'; outcome: DiscussionClientOutcome<DiscussionCreateResultV1> }>;
export type DiscussionSecondOpinionSnapshot = Readonly<{
    source: DiscussionSecondOpinionStartInputV1['source'];
    draft: Draft;
    retry: DiscussionSecondOpinionStartInputV1['retry'];
    preview: Preview | null;
    result: Result | null;
    working: boolean;
    submitted: boolean;
    discussionMessage: DiscussionMessageRefV1 | null;
    approval: ActionApprovalContinuation | null;
}>;

/** L7's retained draft only; every effect stays at the captured-Home Action owner. */
export function createDiscussionSecondOpinionController(options: Readonly<{
    scope: ServerAccountScope;
    availability: SessionCollaborationAvailability;
    source: DiscussionSecondOpinionStartInputV1['source'];
    draft: Draft;
}>) {
    let availability = options.availability;
    const client = createDiscussionClient({ scope: options.scope, get availability() { return availability; } });
    let snapshot: DiscussionSecondOpinionSnapshot = {
        source: options.source, draft: options.draft,
        retry: { creationLocalId: randomUUID(), quoteLocalId: randomUUID(), questionLocalId: randomUUID() },
        preview: null, result: null, working: false, submitted: false, discussionMessage: null, approval: null,
    };
    const listeners = new Set<() => void>();
    const publish = (patch: Partial<DiscussionSecondOpinionSnapshot>) => {
        snapshot = { ...snapshot, ...patch };
        for (const listener of listeners) listener();
    };
    let retainedAsk: DiscussionSecondOpinionStartInputV1 | null = null;
    let retainedDiscuss: Parameters<typeof client.create>[0] | null = null;
    const settleApproval = (outcome: DiscussionClientOutcome<unknown>) => {
        if (outcome.kind === 'approval_request_created') return {};
        const rejected = outcome.kind === 'failed' && (outcome.errorCode === 'approval_rejected' || outcome.errorCode === 'approval_canceled');
        if (rejected) { retainedAsk = null; retainedDiscuss = null; }
        return { approval: null, ...(rejected ? { submitted: false } : {}) };
    };
    const applyAsk = (outcome: DiscussionClientOutcome<DiscussionSecondOpinionStartResultV1>) => {
        const value = outcome.kind === 'succeeded' ? outcome.value : null;
        publish({ ...settleApproval(outcome), working: false, result: { operation: 'second_opinion', outcome },
            ...(value?.status === 'preview' ? { preview: value } : {}),
            ...(value?.status === 'preview_changed' && snapshot.preview
                ? { preview: { ...snapshot.preview, preview: value.preview } } : {}),
            ...(value?.status === 'asked' ? { discussionMessage: value.messageRef } : {}),
        });
        return outcome;
    };
    const runAsk = async (input: DiscussionSecondOpinionStartInputV1, signal?: AbortSignal) => {
        publish({ working: true });
        return applyAsk(await client.secondOpinion(input, signal, {
            onPending: approval => publish({ approval }), onSettled: applyAsk,
        }));
    };
    const applyDiscuss = (outcome: DiscussionClientOutcome<DiscussionCreateResultV1>) => {
        publish({ ...settleApproval(outcome), working: false, result: { operation: 'discuss', outcome },
            ...(outcome.kind === 'succeeded' ? { discussionMessage: outcome.value.firstMessage.messageRef } : {}) });
        return outcome;
    };
    const runDiscuss = async (input: Parameters<typeof client.create>[0], signal?: AbortSignal) => {
        publish({ working: true });
        return applyDiscuss(await client.create(input, signal, {
            onPending: approval => publish({ approval }), onSettled: applyDiscuss,
        }));
    };
    return {
        scope: options.scope,
        setAvailability(value: SessionCollaborationAvailability) { availability = value; },
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        updateDraft(draft: Draft): boolean {
            if (snapshot.submitted) return false;
            if (sameStrictJsonValue(snapshot.draft, draft)) return true;
            const preview = sameStrictJsonValue(snapshot.draft.reviewers, draft.reviewers)
                && sameStrictJsonValue(snapshot.draft.participants ?? null, draft.participants ?? null) ? snapshot.preview : null;
            publish({ draft, preview, result: null });
            return true;
        },
        toggleReviewer(selection: ExecutableParticipantSelectionV1, question: string): boolean {
            if (snapshot.working || snapshot.submitted) return false;
            const selected = snapshot.draft.reviewers.some(reviewer => sameStrictJsonValue(reviewer.selection, selection));
            const reviewers = selected
                ? snapshot.draft.reviewers.filter(reviewer => !sameStrictJsonValue(reviewer.selection, selection))
                : [...snapshot.draft.reviewers, { selection,
                    ...(selection.kind === 'model' ? { participantSlotId: randomUUID() } : {}) }];
            publish({ draft: { ...snapshot.draft, question, reviewers }, preview: null, result: null });
            return true;
        },
        async preview(signal?: AbortSignal) {
            if (snapshot.working || snapshot.submitted || snapshot.approval) return;
            const draft = snapshot.draft;
            publish({ working: true });
            const outcome = await client.secondOpinion({ ...draft, source: snapshot.source, retry: snapshot.retry, intent: 'preview' }, signal, {
                onPending: approval => publish({ approval }), onSettled: applyAsk,
            });
            if (snapshot.draft !== draft) { publish({ working: false }); return outcome; }
            return applyAsk(outcome);
        },
        /** Asking several starts Fresh opinions, which runs where `project` says; one reviewer needs no placement. */
        async ask(options: Readonly<{ project?: WorkflowProjectTargetV1 | null; signal?: AbortSignal }> = {}) {
            if (snapshot.working || !snapshot.preview || retainedDiscuss) return;
            const project = snapshot.draft.reviewers.length > 1 ? options.project ?? undefined : undefined;
            retainedAsk = DiscussionSecondOpinionStartInputV1Schema.parse({ ...snapshot.draft, source: snapshot.source, retry: snapshot.retry,
                intent: 'ask', confirmedPreview: snapshot.preview.preview, ...(project ? { project } : {}) });
            publish({ submitted: true });
            return runAsk(retainedAsk, options.signal);
        },
        async discuss(signal?: AbortSignal) {
            if (snapshot.working || !snapshot.preview || retainedAsk || snapshot.draft.reviewers.length !== 0) return;
            const prepared = prepareAnchoredDiscussionCreateV1({ source: snapshot.source, title: snapshot.draft.title,
                quote: snapshot.preview.sourceText, creationLocalId: snapshot.retry.creationLocalId,
                quoteLocalId: snapshot.retry.quoteLocalId, participants: snapshot.draft.participants });
            const { firstMessage, ...creation } = prepared;
            const question = snapshot.draft.question.trim();
            const content = firstMessage.content;
            const authored = !question ? content : 'parts' in content
                ? { ...content, parts: [...content.parts, { t: 'text' as const, text: question }] }
                : content.kind === 'doc_passage_comment'
                    ? { ...content, content: { ...content.content, parts: [...content.content.parts, { t: 'text' as const, text: question }] } }
                    : content;
            retainedDiscuss = { ...creation, messageLocalId: snapshot.retry.quoteLocalId,
                content: authored,
                replyTarget: prepared.firstMessage.replyTarget };
            publish({ submitted: true });
            return runDiscuss(retainedDiscuss, signal);
        },
        async retry(signal?: AbortSignal) {
            if (snapshot.working) return;
            if (snapshot.result?.operation === 'second_opinion' && snapshot.result.outcome.kind === 'succeeded'
                && snapshot.result.outcome.value.status === 'preview_changed') return;
            if (retainedAsk) return runAsk(retainedAsk, signal);
            if (retainedDiscuss) return runDiscuss(retainedDiscuss, signal);
        },
    };
}
