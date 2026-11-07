import * as React from 'react';
import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions';
import type { DetailsSurfaceRenderInputV1 } from '@/components/appShell/panes/details/surfaces';
import { DetailsSurfaceFallback } from '@/components/appShell/panes/details/surfaces/DetailsSurfaceFallback';
import { WorkflowProjectTargetControl } from '@/components/workflows/editor/WorkflowProjectTargetControl';
import { WorkflowStartDetailsBody, isWorkflowStartResource,
    type WorkflowStartResource } from '@/components/workflows/run/WorkflowStartDetails';
import { createWorkflowRunPeekDetailsTab } from '@/components/sessions/work/createWorkflowRunPeekDetailsTab';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import type { DiscussionRepository } from '@/sync/ops/discussions/discussionRepository';
import { discussionMutationBlocksComposer } from '@/sync/ops/discussions/discussionRepository';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDiscussionRepositorySnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { getSessionComposerDraftSnapshot } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { buildDiscussionContent } from './discussionComposerDocument';
import { useDiscussionDraft } from './useDiscussionDraft';
import { useDiscussionWorkflowRunStarted } from './useDiscussionManagedWorkflowRuns';
import { useDiscussionWorkflowProject } from './useDiscussionWorkflowProject';
import { buildDiscussionWorkflowQuestionLocalId } from './discussionWorkflowQuestionReference';

type DiscussionWorkflowStartResource = WorkflowStartResource & Readonly<{
    origin: Readonly<{ kind: 'discussion'; discussion: DiscussionAddressV1 }>;
}>;

export function isDiscussionWorkflowStartResource(value: unknown): value is DiscussionWorkflowStartResource {
    return isWorkflowStartResource(value) && value.origin?.kind === 'discussion';
}

/** IDs are retained in Details; the mounted body acquires its own Account, draft and post owner. */
export function DiscussionWorkflowStartDetails(props: Readonly<{ input: DetailsSurfaceRenderInputV1 }>) {
    const resource = props.input.tab.resource;
    if (!isDiscussionWorkflowStartResource(resource)) return null;
    return <DiscussionWorkflowStartAccount input={props.input} resource={resource} />;
}

function DiscussionWorkflowStartAccount(props: Readonly<{
    input: DetailsSurfaceRenderInputV1;
    resource: DiscussionWorkflowStartResource;
}>) {
    const serverIds = React.useMemo(() => [props.resource.origin.discussion.serverId], [props.resource.origin.discussion.serverId]);
    const bindings = useServerCredentialAccountScopeBindings(serverIds);
    const binding = [...bindings.values()][0];
    return binding ? <DiscussionWorkflowStartBody
        key={JSON.stringify([binding.scope.serverId, binding.scope.accountId, props.resource.origin.discussion.discussionId])}
        {...props} accountLifetime={binding} />
        : <DetailsSurfaceFallback status="missing" />;
}

function DiscussionWorkflowStartBody(props: Readonly<{
    input: DetailsSurfaceRenderInputV1;
    resource: DiscussionWorkflowStartResource;
    accountLifetime: ServerCredentialAccountScopeBinding;
}>) {
    const { accountLifetime } = props;
    const discussionId = props.resource.origin.discussion.discussionId;
    const discussion = React.useMemo(() => ({ serverId: accountLifetime.scope.serverId, discussionId }), [accountLifetime.scope.serverId, discussionId]);
    const address = React.useMemo(() => ({ serverId: discussion.serverId }), [discussion.serverId]);
    const client = React.useMemo(() => createDiscussionClient({ scope: accountLifetime.scope, availability: 'available' }), [accountLifetime.scope]);
    const repository = React.useMemo(() => getDiscussionRepository({ scope: accountLifetime.scope, address, client, accountLifetime }),
        [accountLifetime, address, client]);
    React.useEffect(() => {
        const unmount = repository.mount({ discussionId, projection: 'summary' });
        if (!repository.getSnapshot().threads[discussionId]?.summary) void repository.refreshSummary(discussionId);
        return unmount;
    }, [discussionId, repository]);
    const snapshot = useDiscussionRepositorySnapshot(repository);
    const thread = snapshot.threads[discussionId];
    const draftAddress = React.useMemo(() => ({ kind: 'discussion' as const, discussionId }), [discussionId]);
    const draft = useDiscussionDraft({ scope: accountLifetime.scope, address: draftAddress });
    const [retained] = React.useState(() => ({ text: draft.text, currentness: draft.captureSubmittedCurrentness().currentness }));
    const placement = useDiscussionWorkflowProject(accountLifetime);
    const publishStarted = useDiscussionWorkflowRunStarted({ discussion, accountLifetime });
    const onComplete = React.useMemo(() => ({ kind: 'originating_discussion' as const }), []);
    const prepareOrigin = React.useCallback<NonNullable<React.ComponentProps<typeof WorkflowStartDetailsBody>['prepareOrigin']>>(async request => {
        if (!accountLifetime.isCurrent()) throw new WorkflowActionError({ message: 'action_account_scope_changed', rawCode: 'action_account_scope_changed' });
        const localId = buildDiscussionWorkflowQuestionLocalId(request.runId);
        const snapshot = repository.getSnapshot();
        const thread = snapshot.threads[discussionId];
        const otherPosts = Object.values(snapshot.mutations).filter(mutation => mutation.kind === 'post'
            && mutation.discussionId === discussionId && mutation.localId !== localId);
        const occupied = otherPosts.some(discussionMutationBlocksComposer);
        if (occupied || !thread?.summary?.capabilities.postMessages || thread.summary.archivedAt !== null) throw new Error('discussion_post_unavailable');
        if (otherPosts.length > 0) {
            draft.releaseSubmittedAttempt();
            for (const refusal of otherPosts) repository.dismissFailure(refusal.localId);
        }
        // This is ordinary unaddressed content. Workflow admission owns execution; ordinary Ask must not fan out too.
        const composerText = request.submittedDraft === null
            ? getSessionComposerDraftSnapshot(accountLifetime.scope, draftAddress)?.composer.text.value : undefined;
        const submittedDraft = request.submittedDraft ?? (typeof composerText === 'string' ? composerText : '');
        let content: ReturnType<typeof buildDiscussionContent>;
        try { content = buildDiscussionContent(submittedDraft, []); }
        catch { throw new WorkflowActionError({ message: 'discussion_invalid_content', rawCode: 'discussion_invalid_content' }); }
        const draftSubmission = draft.captureSubmittedCurrentness({ kind: 'post', discussionId, localId },
            { content, ...(request.submittedDraft === null ? {} : { retainedCurrentness: retained.currentness }) });
        const outcome = await repository.post({ discussionId, localId, content, draftSubmission });
        const messageId = outcome.kind === 'succeeded' ? outcome.value.message.id
            : outcome.kind === 'checking' ? await observeCommittedPost(repository, discussionId, localId)
                : null;
        if (messageId === null) {
            const code = outcome.kind === 'failed' ? outcome.errorCode : 'approval_required';
            throw new WorkflowActionError({ message: code, rawCode: code });
        }
        if (!accountLifetime.isCurrent()) throw new WorkflowActionError({ message: 'action_account_scope_changed', rawCode: 'action_account_scope_changed' });
        return { kind: 'discussion', discussion, addressingMessageId: messageId };
    }, [accountLifetime, discussion, discussionId, draft, draftAddress, repository, retained.currentness]);
    const onStarted = React.useCallback<React.ComponentProps<typeof WorkflowStartDetailsBody>['onStarted']>((result, serverId) => {
        publishStarted(result);
        props.input.callbacks.replaceTab?.(props.input.tab.key,
            createWorkflowRunPeekDetailsTab({ runId: result.run.id, serverId, title: props.input.tab.title }), { intent: 'pinned' });
    }, [props.input.callbacks, props.input.tab.key, props.input.tab.title, publishStarted]);
    if (!thread?.summary) return <DetailsSurfaceFallback
        status={!thread || thread.status === 'idle' || thread.status === 'loading' ? 'pending' : 'stale'}
        reason={thread?.errorCode} onRetry={() => { void repository.refreshSummary(discussionId); }} />;
    return <WorkflowStartDetailsBody source={props.resource.source} accountLifetime={accountLifetime} intentKey={props.input.tab.key}
        retainedDraft={retained.text} project={placement.project} prepareOrigin={prepareOrigin} onComplete={onComplete} onStarted={onStarted}>
        <WorkflowProjectTargetControl purpose="workflow" accountLifetime={accountLifetime} target={placement.target} machines={placement.machines}
            machineName={placement.machineName} onChange={placement.choose} testIDPrefix="discussion-workflow-start" />
    </WorkflowStartDetailsBody>;
}

/** Rejoin the repository's existing reconciliation, using the same Run/post local identity. */
function observeCommittedPost(repository: DiscussionRepository, discussionId: string, localId: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const check = (): boolean => {
            const snapshot = repository.getSnapshot();
            const committed = snapshot.threads[discussionId]?.messages.find(message => message.localId === localId);
            if (committed) { resolve(committed.id); return true; }
            const status = snapshot.mutations[localId]?.status;
            if (status === 'failed' || status === 'approval_pending' || status === undefined) {
                const code = snapshot.mutations[localId]?.errorCode ?? 'discussion_post_unresolved';
                reject(new WorkflowActionError({ message: code, rawCode: code }));
                return true;
            }
            return false;
        };
        if (check()) return;
        const unsubscribe = repository.subscribe(() => { if (check()) unsubscribe(); });
    });
}
