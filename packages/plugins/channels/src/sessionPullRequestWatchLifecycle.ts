import { isPluginActionApprovalRequestCreated, type PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { resolveSessionPullRequestLinksV1 } from '@happier-dev/channels-protocol/v1';
import { CHANNEL_STATE_COLLECTION } from './collections.js';
import { readConversationBindingUpdateRow, readConversationSessionBindingRows } from './accountLocalBindingPolicy.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import type { PluginAccountStorageConsumerContext } from '@happier-dev/plugin-sdk/storage';
import type { SessionPullRequestProvider } from './sessionPullRequestProvider.js';

export type SessionPullRequestWatchTerminalResult = Readonly<{ kind: 'notEligible' | 'archived' | 'approval' }>;

/** A one-shot consequence of a committed merge observation, never an archive waiter. */
export async function archiveSessionPullRequestWatchAfterMerge(input: Readonly<{
    sessionId: string; bindingId: string; provider: SessionPullRequestProvider;
}>, context: PluginAccountStorageConsumerContext & Readonly<{ services: Pick<PluginAccountActionContext['services'], 'actions'>; signal: AbortSignal }>): Promise<SessionPullRequestWatchTerminalResult> {
    const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
    const observed = await collection.get(input.bindingId, { signal: context.signal });
    if (!observed) return { kind: 'notEligible' };
    const { binding } = readConversationBindingUpdateRow({ row: observed, bindingId: input.bindingId });
    if (binding.deletionState !== 'none' || binding.target.kind !== 'session' || binding.target.sessionId !== input.sessionId
        || binding.target.pullRequestWatch?.policy.archiveAfterMerge !== true || binding.target.pullRequestWatch.policy.mode === 'off'
        || binding.endpoint.kind !== 'githubPullRequest'
        || binding.endpoint.pullRequestState?.state !== 'merged') return { kind: 'notEligible' };
    const rows = await readConversationSessionBindingRows({ collection, sessionId: input.sessionId, signal: context.signal });
    const links = resolveSessionPullRequestLinksV1(rows.map(row => readConversationBindingUpdateRow({ row, bindingId: row.rowId }).binding), input.provider)
        .find(group => group.sessionId === input.sessionId)?.pullRequestLinks;
    if (!links?.length || links.some(link => link.state !== 'merged' && link.state !== 'closed')) return { kind: 'notEligible' };
    const status = await context.services.actions.execute('session.status.get', { sessionId: input.sessionId, live: true }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(status)) return { kind: 'approval' };
    // Status owns the combined native-question/permission/Action-confirmation
    // projection. Missing or locked request content never means an empty list.
    if (!('session' in status) || status.session.id !== input.sessionId || status.session.archivedAt
        || status.session.pendingCount !== 0 || status.session.pendingBlockedCount !== 0
        || !Array.isArray(status.pendingRequests) || status.pendingRequests.length !== 0
        || status.agentState?.pendingRequestsCount !== 0 || status.awareness?.runtime !== 'idle'
        || status.awareness.freshness !== 'live' || status.awareness.availability !== 'complete') return { kind: 'notEligible' };
    const current = await readConversationSessionBindingRows({ collection, sessionId: input.sessionId, signal: context.signal });
    const revisions = new Map(rows.map(row => [row.rowId, row.revision]));
    if (current.length !== rows.length || current.some(row => revisions.get(row.rowId) !== row.revision)) return { kind: 'notEligible' };
    const archived = await context.services.actions.execute('session.archive', { sessionId: input.sessionId }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(archived)) return { kind: 'approval' };
    return { kind: archived.success && archived.sessionId === input.sessionId ? 'archived' : 'notEligible' };
}
