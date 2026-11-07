import { AppShellActionInputSchemas, AppShellActionOutputSchemas, projectInboxReadItemV1 } from '@happier-dev/protocol/actions/appShellActionFamily';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { resolveWorkReadPresentation, type WorkItem, type WorkProjection } from '@/components/sessions/work/workProjection';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import type { InboxWorkItem } from '@/activity/presentation/buildInboxWorkGroups';
import type { InboxItem } from '@/components/inbox/inboxItems';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type MountedOwner = Readonly<{ scope: ServerAccountScope; isCurrent: () => boolean }>;
type WorkReadOwner = MountedOwner & Readonly<{
    sessionId: string;
    read: () => Readonly<{ projection: WorkProjection; transcriptLoaded: boolean;
        managedRuns: Readonly<{ phase: 'idle' | 'loading' | 'loaded' | 'failed'; refreshFailed: boolean }> }>;
}>;
type InboxReadOwner = MountedOwner & Readonly<{ read: () => InboxModel }>;
type MountedReadAddress = Readonly<{ scope: ServerAccountScope; actionId: 'session.work.get' | 'inbox.get'; sessionId?: string }>;

// Answering-client addresses only: these retain neither another projection nor another source.
const workOwners = new Set<WorkReadOwner>();
const inboxOwners = new Set<InboxReadOwner>();
const addressListeners = new Set<() => void>();
let mountedReadAddresses: readonly MountedReadAddress[] = [];
function publishMountedReadAddresses(): void {
    const next: MountedReadAddress[] = [];
    for (const owner of workOwners) if (!next.some(address => address.actionId === 'session.work.get'
        && address.sessionId === owner.sessionId && areServerAccountScopesEqual(address.scope, owner.scope))) {
        next.push({ scope: owner.scope, actionId: 'session.work.get', sessionId: owner.sessionId });
    }
    for (const owner of inboxOwners) if (!next.some(address => address.actionId === 'inbox.get'
        && areServerAccountScopesEqual(address.scope, owner.scope))) next.push({ scope: owner.scope, actionId: 'inbox.get' });
    if (next.length === mountedReadAddresses.length && next.every((address, index) => {
        const previous = mountedReadAddresses[index];
        return previous?.actionId === address.actionId && previous.sessionId === address.sessionId
            && areServerAccountScopesEqual(previous.scope, address.scope);
    })) return;
    mountedReadAddresses = next;
    for (const listener of addressListeners) listener();
}
export const getMountedWorkReadAddresses = (): readonly MountedReadAddress[] => mountedReadAddresses;
export function subscribeMountedWorkReadOwners(listener: () => void): () => void {
    addressListeners.add(listener);
    return () => { addressListeners.delete(listener); };
}
export function registerMountedWorkReadOwner(owner: WorkReadOwner): () => void {
    workOwners.add(owner);
    publishMountedReadAddresses();
    return () => { workOwners.delete(owner); publishMountedReadAddresses(); };
}
export function registerMountedInboxReadOwner(owner: InboxReadOwner): () => void {
    inboxOwners.add(owner);
    publishMountedReadAddresses();
    return () => { inboxOwners.delete(owner); publishMountedReadAddresses(); };
}

function workItem(item: WorkItem) {
    return { key: item.key, kind: item.kind, title: item.title, agentId: item.agentId,
        facts: [...item.facts], parentKey: item.parentKey, level: item.level,
        status: { bucket: item.status.bucket, tone: item.status.tone, word: item.status.word },
        progress: item.progress ? { completed: item.progress.completed, total: item.progress.total } : null,
        open: item.open };
}

function inboxItem(item: InboxWorkItem) {
    if (item.kind === 'workflow_run') return { kind: item.kind, key: item.key, runId: item.runId };
    if (item.kind === 'automation_run') return { kind: item.kind, key: item.key, runId: item.row.id };
    if (item.kind === 'approval') return { kind: item.kind, key: item.key, artifactId: item.artifact.id };
    const serverId = item.kind === 'session'
        ? item.entry.candidate.address?.serverId ?? item.entry.candidate.serverId : item.session.serverId;
    if (!serverId) return null;
    if (item.kind === 'session') {
        const { candidate } = item.entry;
        return { kind: item.kind, key: item.key, serverId, sessionId: candidate.sessionId, title: candidate.title,
            attentionState: candidate.attentionState, pendingPermissionCount: item.entry.pendingPermissions.length,
            pendingQuestionCount: item.entry.pendingUserActions.length, foldedUnderRunId: item.foldedUnderRunId };
    }
    const address = { key: item.key, serverId, sessionId: item.session.id };
    if (item.kind === 'landing') return { kind: item.kind, ...address, pullRequestNumber: item.link.number, pullRequestUrl: item.link.url,
        ...(item.link.state === undefined ? {} : { pullRequestState: item.link.state }),
        ...(item.link.observedAt === undefined ? {} : { pullRequestObservedAt: item.link.observedAt }) };
    if (item.kind === 'snoozed') return { kind: item.kind, ...address, remindAt: item.remindAt };
    return { kind: item.kind, ...address };
}

function canonicalInboxItem(item: InboxItem, scope: ServerAccountScope) {
    if (!areServerProfileIdentifiersEquivalent(item.source.serverId, item.focus.serverId)) return null;
    if (item.discussion && (item.discussion.accountId !== scope.accountId
        || item.focus.kind !== 'discussion'
        || item.discussion.messageRef.messageId !== item.focus.messageId
        || item.discussion.messageRef.discussion.discussionId !== item.source.id
        || !areServerProfileIdentifiersEquivalent(item.discussion.messageRef.discussion.serverId, item.source.serverId))) return null;
    return projectInboxReadItemV1(item);
}

export const invokeMountedWorkRead: NonNullable<ActionExecutorDeps['appShellAction']> = async ({ actionId, input, context }) => {
    context.signal?.throwIfAborted();
    if (actionId !== 'session.work.get' && actionId !== 'inbox.get') throw new Error('unsupported_mounted_read');
    if (!context.serverId || !context.runtimeAccountId) return { status: 'unavailable' };
    const scope = { serverId: context.serverId, accountId: context.runtimeAccountId };
    if (actionId === 'session.work.get') {
        const { sessionId } = AppShellActionInputSchemas[actionId].parse(input);
        // Retained routes and opened panes may mount the same canonical semantic producer.
        // Any current source at its exact address answers; mounts never merge or own new state.
        const owner = [...workOwners].find(owner => owner.sessionId === sessionId
            && areServerAccountScopesEqual(owner.scope, scope) && owner.isCurrent());
        if (!owner) return { status: 'unavailable' };
        const snapshot = owner.read();
        if (!owner.isCurrent()) return { status: 'unavailable' };
        const { projection, managedRuns } = snapshot;
        const items = [...projection.sessions, ...projection.workflows, ...projection.backgroundRuns,
            ...projection.agents, ...projection.projectCommands]
            .flatMap(item => [workItem(item), ...(item.projectCommands ?? []).map(workItem)]);
        const presentation = resolveWorkReadPresentation(snapshot);
        if (items.length === 0 && !presentation.nothingYet) {
            return { status: presentation.managedUnavailable || managedRuns.refreshFailed ? 'unavailable' : 'loading' };
        }
        const result = AppShellActionOutputSchemas[actionId].parse({ status: 'ready', sessionId,
            summary: { ...projection.summary }, items, managedRuns: { phase: managedRuns.phase, refreshFailed: managedRuns.refreshFailed } });
        context.signal?.throwIfAborted();
        return owner.isCurrent() ? result : { status: 'unavailable' };
    }
    AppShellActionInputSchemas[actionId].parse(input);
    const owner = [...inboxOwners].find(owner => areServerAccountScopesEqual(owner.scope, scope) && owner.isCurrent());
    if (!owner) return { status: 'unavailable' };
    const model = owner.read();
    if (!owner.isCurrent()) return { status: 'unavailable' };
    // Each source admits its own rows. Incomplete Artifact coverage must not hide
    // current work from the other owners, or certify an empty Inbox as caught up.
    if (!model.hasContent && !model.showCaughtUp) return { status: model.isLoading ? 'loading' : 'unavailable' };
    // The captured Home/Account addresses this mounted owner, not every row's source.
    // Preserve the owner's admitted multi-Home rows and their exact navigation addresses.
    const audienceScope = model.source.audienceScopes?.get(scope.serverId);
    if (audienceScope && !areServerAccountScopesEqual(audienceScope, scope)) return { status: 'unavailable' };
    if (model.discussionAttention.source && !areServerAccountScopesEqual(model.discussionAttention.source.scope, scope)) {
        return { status: 'unavailable' };
    }
    const items = model.items.map(item => canonicalInboxItem(item, scope));
    if (items.some(item => item === null)) return { status: 'unavailable' };
    if (model.workGroups.some(group => group.items.some(item => item.kind === 'workflow_run'))
        && (!model.workflowAttention.serverId
            || !areServerProfileIdentifiersEquivalent(model.workflowAttention.serverId, scope.serverId))) return { status: 'unavailable' };
    if (model.automationAttentionItems.length > 0 && (!model.automationAttention.serverId
        || !areServerProfileIdentifiersEquivalent(model.automationAttention.serverId, scope.serverId))) return { status: 'unavailable' };
    const readySessions = model.sessionPresentation.readySessions.map(candidate => {
        const serverId = candidate.address?.serverId ?? candidate.serverId;
        return serverId ? { serverId, sessionId: candidate.sessionId } : null;
    });
    if (readySessions.some(value => value === null)) return { status: 'unavailable' };
    // Preserve the mounted owner's grouping, membership and order; only serialize selected fields.
    const groups = model.workGroups.map(group => {
        if (group.root.kind === 'lead' && !group.root.serverId) return null;
        const items = group.items.map(inboxItem);
        if (items.some(value => value === null)) return null;
        const root = group.root.kind === 'lead' ? { kind: group.root.kind, serverId: group.root.serverId, sessionId: group.root.sessionId }
            : group.root.kind === 'run' ? { kind: group.root.kind, runId: group.root.runId }
            : group.root.kind === 'automation' ? { kind: group.root.kind, automationId: group.root.automationId,
                serverId: group.root.serverId, runId: group.root.runId } : { kind: group.root.kind };
        return { key: group.key, root, items };
    });
    if (groups.some(value => value === null)) return { status: 'unavailable' };
    const artifactCurrent = model.artifactSource.phase === 'current';
    const artifactFailed = model.artifactSource.phase === 'partial' || model.artifactSource.phase === 'failed';
    const runSourceFailed = model.executionRunAttention.failed;
    const result = AppShellActionOutputSchemas[actionId].parse({ status: artifactCurrent && !runSourceFailed ? 'ready' : 'partial', groups, items,
        coverage: { discussions: model.discussionAttention.coverage,
            sources: [{ source: 'notices', status: artifactCurrent ? 'complete' : 'partial',
                ...(artifactFailed ? { reason: 'content_unavailable' } : {}) },
                ...(runSourceFailed ? [{ source: 'live_items', status: 'partial', reason: 'content_unavailable' }] : [])] },
        approvalIds: model.openApprovals.map(artifact => artifact.id),
        usageNoticeIds: model.openUsageNotices.map(entry => entry.artifact.id),
        accountNoticeIds: model.openAccountNotices.map(entry => entry.artifact.id),
        friendRequestIds: model.friendRequests.map(request => request.id),
        automationRunIds: model.automationAttentionItems.map(item => item.run.id),
        readySessions,
        actionOperations: model.actionOperationEntries.flatMap(({ operation, reason }) =>
            operation.snapshot.scope.accountId === scope.accountId
                && areServerProfileIdentifiersEquivalent(operation.serverId, scope.serverId)
                ? [{ serverId: operation.serverId, operationId: operation.snapshot.operationId, reason }] : []),
        isLoading: model.isLoading,
        refreshFailed: artifactFailed || model.workflowAttention.refreshFailed || model.automationAttention.refreshFailed || model.executionRunAttention.failed,
    });
    context.signal?.throwIfAborted();
    return owner.isCurrent() ? result : { status: 'unavailable' };
};
