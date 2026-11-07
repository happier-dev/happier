import { isPluginActionApprovalRequestCreated, type PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { SessionAcceptedWorkspaceV1Schema } from '@happier-dev/plugin-sdk/sessions';
import { normalizeScmHostingRepositoryIdentity, parseScmRemoteUrl, sameScmHostingRepositoryIdentity,
    ScmWorkingSnapshotSchema } from '@happier-dev/plugin-sdk/scm';
import { type ConversationBindingV1, type SessionPullRequestUpdateV1 } from '@happier-dev/channels-protocol/v1';
import { parseSessionPullRequestUrl, sessionPullRequestUrl, type SessionPullRequestProvider } from './sessionPullRequestProvider.js';

export type SessionPullRequestWatchRoundPreparation = Readonly<{ kind: 'ready' }>
    | Readonly<{ kind: 'held'; reason: 'scope' | 'workspace' | 'branch' | 'remote' | 'dirty' | 'approval' | 'pull' | 'stale' }>;
type PreparationContext = Readonly<{ services: Pick<PluginAccountActionContext['services'], 'actions'>; signal: AbortSignal }>;

/** Historical feedback is not current execution authority; read the exact native PR before preparation and edits. */
export async function readCurrentSessionPullRequestWatchHead(input: Readonly<{
    update: Pick<SessionPullRequestUpdateV1, 'sessionId' | 'pullRequest'> & Partial<Pick<SessionPullRequestUpdateV1, 'head'>>; cwd: string; provider: SessionPullRequestProvider;
}>, context: PreparationContext): Promise<
    Readonly<{ kind: 'head'; head: SessionPullRequestUpdateV1['head'] }> | Extract<SessionPullRequestWatchRoundPreparation, { kind: 'held' }>> {
    const url = sessionPullRequestUrl(input.provider, input.update.pullRequest);
    const result = await context.services.actions.execute('scm.pullRequest.get', { sessionId: input.update.sessionId,
        cwd: input.cwd, prReference: { url } }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result)) return { kind: 'held', reason: 'approval' };
    const pullRequest = result.success ? result.pullRequest : null;
    const identity = pullRequest ? parseSessionPullRequestUrl(input.provider, pullRequest.url) : null;
    if (!pullRequest || !identity || identity.number !== input.update.pullRequest.number
        || !sameScmHostingRepositoryIdentity(
            normalizeScmHostingRepositoryIdentity({ kind: input.provider.repositoryKind, deployment: input.provider.deployment, repository: identity.repository }),
            normalizeScmHostingRepositoryIdentity({ kind: input.provider.repositoryKind, deployment: input.provider.deployment, repository: input.update.pullRequest.repository }))
        || pullRequest.number !== input.update.pullRequest.number
        || (pullRequest.state !== 'open' && pullRequest.state !== 'draft') || !pullRequest.headSha) return { kind: 'held', reason: 'scope' };
    if (input.update.head && pullRequest.headBranch !== input.update.head.ref) return { kind: 'held', reason: 'branch' };
    const repository = normalizeScmHostingRepositoryIdentity({ kind: input.provider.repositoryKind, deployment: input.provider.deployment,
        repository: pullRequest.headRepositoryNameWithOwner });
    if (!repository) return { kind: 'held', reason: 'remote' };
    return { kind: 'head', head: { sha: pullRequest.headSha, ref: pullRequest.headBranch, repository } };
}

/** Uses only existing exact-target host SCM Actions; no shell or separate workspace authority. */
export async function prepareSessionPullRequestWatchRound(input: Readonly<{
    binding: ConversationBindingV1; update: SessionPullRequestUpdateV1; provider: SessionPullRequestProvider;
}>, context: PreparationContext): Promise<SessionPullRequestWatchRoundPreparation> {
    const { binding, update } = input;
    if (binding.target.kind !== 'session' || binding.id !== update.bindingId || binding.target.sessionId !== update.sessionId
        || binding.target.pullRequestLink?.repository !== update.pullRequest.repository
        || binding.target.pullRequestLink.number !== update.pullRequest.number) return { kind: 'held', reason: 'scope' };
    const status = await context.services.actions.execute('session.status.get', {
        sessionId: update.sessionId, includeAcceptedWorkspace: true,
    }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(status)) return { kind: 'held', reason: 'approval' };
    if (!('session' in status) || status.session.id !== update.sessionId) return { kind: 'held', reason: 'workspace' };
    const workspace = SessionAcceptedWorkspaceV1Schema.safeParse(status.acceptedWorkspace);
    if (!workspace.success) return { kind: 'held', reason: 'workspace' };
    const target = { sessionId: update.sessionId, cwd: workspace.data.checkout.rootPath };
    const admitted = await readCurrentSessionPullRequestWatchHead({ update, cwd: target.cwd, provider: input.provider }, context);
    if (admitted.kind === 'held') return admitted;
    const repository = normalizeScmHostingRepositoryIdentity(admitted.head.repository);
    if (!repository) return { kind: 'held', reason: 'remote' };
    const before = await context.services.actions.execute('scm.status.snapshot', target, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(before)) return { kind: 'held', reason: 'approval' };
    const parsed = before.success ? ScmWorkingSnapshotSchema.safeParse(before.snapshot) : undefined;
    if (!parsed?.success || !parsed.data.repo.isRepo || parsed.data.repo.rootPath !== target.cwd) return { kind: 'held', reason: 'workspace' };
    const snapshot = parsed.data;
    if (snapshot.branch.detached || snapshot.branch.head !== admitted.head.ref) return { kind: 'held', reason: 'branch' };
    if (snapshot.hasConflicts || snapshot.operationState) return { kind: 'held', reason: 'dirty' };
    const remotes = snapshot.repo.remotes.filter(remote => {
        const transport = remote.fetchUrl ? parseScmRemoteUrl(remote.fetchUrl) : null;
        if (!transport || transport.host !== new URL(repository.deployment).hostname || (transport.syntax === 'url' && transport.port !== null
            && !(transport.protocol === 'ssh:' && transport.port === 22))) return false;
        // The forge identity comes from measured provider evidence. The parser
        // only compares the configured transport path against that identity.
        return sameScmHostingRepositoryIdentity(repository, normalizeScmHostingRepositoryIdentity({
            kind: repository.kind, deployment: repository.deployment, repository: transport.path,
        }));
    });
    const upstream = remotes.find(remote => snapshot.branch.upstream === `${remote.name}/${admitted.head.ref}`);
    const remote = upstream ?? (remotes.length === 1 ? remotes[0] : undefined);
    if (!remote) return { kind: 'held', reason: 'remote' };
    const pull = await context.services.actions.execute('scm.remote.pull', {
        ...target, remote: remote.name, branch: admitted.head.ref, dirtyPolicy: 'allow_git',
    }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(pull)) return { kind: 'held', reason: 'approval' };
    if (!pull.success) return { kind: 'held', reason: 'pull' };
    const after = await context.services.actions.execute('scm.status.snapshot', target, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(after)) return { kind: 'held', reason: 'approval' };
    const current = after.success ? ScmWorkingSnapshotSchema.safeParse(after.snapshot) : undefined;
    const refreshed = await readCurrentSessionPullRequestWatchHead({ update, cwd: target.cwd, provider: input.provider }, context);
    if (refreshed.kind === 'held') return refreshed;
    if (!current?.success || current.data.repo.rootPath !== target.cwd || current.data.branch.detached
        || !sameScmHostingRepositoryIdentity(repository, normalizeScmHostingRepositoryIdentity(refreshed.head.repository))
        || current.data.branch.head !== refreshed.head.ref || current.data.branch.headOid !== refreshed.head.sha) return { kind: 'held', reason: 'stale' };
    return { kind: 'ready' };
}
