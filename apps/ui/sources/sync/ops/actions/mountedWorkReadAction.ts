import { AppShellActionInputSchemas, AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { resolveWorkReadPresentation, type WorkItem, type WorkProjection } from '@/components/sessions/work/workProjection';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import type { InboxWorkItem } from '@/activity/presentation/buildInboxWorkGroups';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type MountedOwner = Readonly<{ scope: ServerAccountScope; isCurrent: () => boolean }>;
type WorkReadOwner = MountedOwner & Readonly<{
    sessionId: string;
    read: () => Readonly<{ projection: WorkProjection; transcriptLoaded: boolean;
        managedRuns: Readonly<{ phase: 'idle' | 'loading' | 'loaded' | 'failed'; refreshFailed: boolean }> }>;
}>;
type InboxReadOwner = MountedOwner & Readonly<{ read: () => InboxModel }>;

// Answering-client addresses only: these retain neither another projection nor another source.
const workOwners = new Set<WorkReadOwner>();
const inboxOwners = new Set<InboxReadOwner>();
export function registerMountedWorkReadOwner(owner: WorkReadOwner): () => void {
    workOwners.add(owner);
    return () => { workOwners.delete(owner); };
}
export function registerMountedInboxReadOwner(owner: InboxReadOwner): () => void {
    inboxOwners.add(owner);
    return () => { inboxOwners.delete(owner); };
}

function workItem(item: WorkItem) {
    return { key: item.key, kind: item.kind, title: item.title, agentId: item.agentId,
        facts: [...item.facts], parentKey: item.parentKey, level: item.level,
        status: { bucket: item.status.bucket, tone: item.status.tone, word: item.status.word },
        progress: item.progress ? { completed: item.progress.completed, total: item.progress.total } : null,
        open: item.open };
}

function inboxItem(item: InboxWorkItem, scope: ServerAccountScope) {
    if (item.kind === 'workflow_run') return { kind: item.kind, key: item.key, runId: item.runId };
    const serverId = item.kind === 'session'
        ? item.entry.candidate.address?.serverId ?? item.entry.candidate.serverId : item.session.serverId;
    if (!serverId || !areServerProfileIdentifiersEquivalent(serverId, scope.serverId)) return null;
    if (item.kind === 'session') {
        const { candidate } = item.entry;
        return { kind: item.kind, key: item.key, serverId, sessionId: candidate.sessionId, title: candidate.title,
            attentionState: candidate.attentionState, pendingPermissionCount: item.entry.pendingPermissions.length,
            pendingQuestionCount: item.entry.pendingUserActions.length, foldedUnderRunId: item.foldedUnderRunId };
    }
    const address = { key: item.key, serverId, sessionId: item.session.id };
    if (item.kind === 'landing') return { kind: item.kind, ...address, pullRequestNumber: item.link.number };
    if (item.kind === 'snoozed') return { kind: item.kind, ...address, remindAt: item.remindAt };
    return { kind: item.kind, ...address };
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
    if (!model.hasContent && !model.showCaughtUp) return { status: model.isLoading ? 'loading' : 'unavailable' };
    // A mixed-Home model is not an exact-Home projection. Do not manufacture another grouping or
    // quietly describe filtered foreign content as an empty Inbox. A missing lead is valid on one Home.
    if (model.spansHomes) return { status: 'unavailable' };
    const audienceScope = model.source.audienceScopes?.get(scope.serverId);
    if (audienceScope && !areServerAccountScopesEqual(audienceScope, scope)) return { status: 'unavailable' };
    if (model.workGroups.some(group => group.items.some(item => item.kind === 'workflow_run'))
        && (!model.workflowAttention.serverId
            || !areServerProfileIdentifiersEquivalent(model.workflowAttention.serverId, scope.serverId))) return { status: 'unavailable' };
    if (model.automationAttentionItems.length > 0 && (!model.automationAttention.serverId
        || !areServerProfileIdentifiersEquivalent(model.automationAttention.serverId, scope.serverId))) return { status: 'unavailable' };
    const readySessions = model.sessionPresentation.readySessions.map(candidate => {
        const serverId = candidate.address?.serverId ?? candidate.serverId;
        return serverId && areServerProfileIdentifiersEquivalent(serverId, scope.serverId)
            ? { serverId, sessionId: candidate.sessionId } : null;
    });
    if (readySessions.some(value => value === null)) return { status: 'unavailable' };
    // Preserve the mounted owner's grouping, membership and order; only serialize selected fields.
    const groups = model.workGroups.map(group => {
        if (group.root.kind === 'lead' && group.root.session?.serverId
            && !areServerProfileIdentifiersEquivalent(group.root.session.serverId, scope.serverId)) return null;
        const items = group.items.map(item => inboxItem(item, scope));
        if (items.some(value => value === null)) return null;
        const root = group.root.kind === 'lead' ? { kind: group.root.kind, sessionId: group.root.sessionId }
            : group.root.kind === 'run' ? { kind: group.root.kind, runId: group.root.runId } : { kind: group.root.kind };
        return { key: group.key, root, items };
    });
    if (groups.some(value => value === null)) return { status: 'unavailable' };
    const result = AppShellActionOutputSchemas[actionId].parse({ status: 'ready', groups,
        approvalIds: model.openApprovals.map(artifact => artifact.id),
        usageNoticeIds: model.openUsageNotices.map(entry => entry.artifact.id),
        friendRequestIds: model.friendRequests.map(request => request.id),
        automationRunIds: model.automationAttentionItems.map(item => item.run.id),
        readySessions,
        actionOperations: model.actionOperationEntries.flatMap(({ operation, reason }) =>
            operation.snapshot.scope.accountId === scope.accountId
                && areServerProfileIdentifiersEquivalent(operation.serverId, scope.serverId)
                ? [{ serverId: operation.serverId, operationId: operation.snapshot.operationId, reason }] : []),
        isLoading: model.isLoading,
        refreshFailed: model.workflowAttention.refreshFailed || model.automationAttention.refreshFailed,
    });
    context.signal?.throwIfAborted();
    return owner.isCurrent() ? result : { status: 'unavailable' };
};
