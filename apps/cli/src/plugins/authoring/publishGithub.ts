import { PLUGIN_PUBLICATION_GITHUB_CHILD_ROLES, PLUGIN_PUBLICATION_GITHUB_PLUGIN_ID, pluginPublicationReviewedChildren, type PluginPublicationGithubInput, type PluginPublicationGithubResult, type PluginPublicationGithubInspection } from '@happier-dev/protocol/actions/actionSpecs';
import type { HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { ScmCommitCreateResponseSchema, ScmRemoteResponseSchema, ScmStatusSnapshotResponseSchema, ScmHostingRepositoryDescribePublishTargetsResponseSchema, ScmHostingRepositoryPublishResponseSchema, ScmHostingRepositorySummarySchema } from '@happier-dev/protocol/scm';
import { readScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeScmOperationOutcome } from '@happier-dev/protocol/scm/operationOutcome';
import type { ExecuteScmActionOperationParams } from '@/scm/actions/executeScmActionOperation';

// The plugin Action invocation owner validates its declared result before the
// reviewed-child port returns it. These consumer views name only publication
// facts; the complete release remains opaque and is passed back to its owner.
type PublicationRelease = Readonly<Record<string, unknown> & {
    repositoryId: string; releaseId: string; webUrl: string;
}>;
type PublicationReleaseReply = Readonly<{
    kind: string;
    release?: PublicationRelease;
    value?: PublicationRelease;
    failure?: Readonly<{ code: string }>;
    releaseId?: string;
    webUrl?: string;
}>;

export async function inspectPluginPublicationGithub(params: Readonly<{ directory: string }> &
    Pick<ExecuteScmActionOperationParams, 'signal' | 'registry' | 'hostingProviderRegistry'>): Promise<PluginPublicationGithubInspection> {
    try {
        if (params.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
        const { executeScmActionOperation } = await import('@/scm/actions/executeScmActionOperation');
        const context = { workingDirectory: params.directory, signal: params.signal,
            registry: params.registry, hostingProviderRegistry: params.hostingProviderRegistry };
        const status = ScmStatusSnapshotResponseSchema.parse(await executeScmActionOperation({ ...context,
            actionId: 'scm.status.snapshot', input: { cwd: params.directory } }));
        if (!status.success || !status.snapshot) return { status: 'unavailable', reason: status.errorCode ?? 'COMMAND_FAILED' };
        const { snapshot } = status;
        if (!snapshot.repo.isRepo) return { status: 'unavailable', reason: 'NOT_REPOSITORY' };
        const provider = snapshot.hostingProvider?.kind === 'github' ? snapshot.hostingProvider : undefined;
        const repository = readScmHostingRepositoryIdentity(provider);
        const result: PluginPublicationGithubInspection = { status: 'ready',
            ...(snapshot.branch.head ? { branch: snapshot.branch.head } : {}),
            ...(provider?.remoteName ? { remote: provider.remoteName } : {}),
            ...(repository ? { repository } : {}) };
        if (params.signal?.aborted) return { ...result, reason: 'cancelled' };
        const targets = ScmHostingRepositoryDescribePublishTargetsResponseSchema.parse(await executeScmActionOperation({ ...context,
            actionId: 'scm.hostingRepository.describePublishTargets', input: { cwd: params.directory,
                providerKind: 'github', ...(provider?.id ? { providerId: provider.id } : {}) } }));
        return targets.success ? { ...result, publishTargets: { success: true, auth: targets.auth,
            defaultRepositoryName: targets.defaultRepositoryName, targets: targets.targets } }
            : { ...result, reason: targets.errorCode ?? 'COMMAND_FAILED' };
    } catch {
        return { status: 'unavailable', reason: params.signal?.aborted ? 'cancelled' : 'COMMAND_FAILED' };
    }
}

/** These callbacks consume the parent Action's admitted effects, never a fresh child approval. */
export type PluginGithubActionDependencies = Readonly<{
    executeScm: (request: Readonly<{ actionId: 'scm.hostingRepository.describePublishTargets' | 'scm.hostingRepository.publish' | 'scm.commit.create' | 'scm.remote.push'; input: unknown }>) => Promise<unknown>;
    invokeGithub: (request: Readonly<{ actionId: 'github/releases/draft-create' | 'github/releases/release-read' | 'github/releases/draft-publish'; input: unknown }>) => Promise<unknown>;
}>;

class ChildActionFailure extends Error {
    constructor(readonly code: string) { super(code); }
}

export function createPluginGithubActionDependencies(port: HostReviewedChildPortV1): PluginGithubActionDependencies {
    const invoke = async (request: Parameters<PluginGithubActionDependencies['executeScm']>[0] | Parameters<PluginGithubActionDependencies['invokeGithub']>[0]) => {
        const action = request.actionId.startsWith('scm.') ? request.actionId as Parameters<HostReviewedChildPortV1['invoke']>[0]['action']
            : { pluginId: PLUGIN_PUBLICATION_GITHUB_PLUGIN_ID, localId: request.actionId };
        const response = await port.invoke({ action, role: PLUGIN_PUBLICATION_GITHUB_CHILD_ROLES[request.actionId],
            input: projectNativeJsonValueForTransport(request.input) });
        if (!response.ok) throw new ChildActionFailure(response.errorCode);
        return response.result;
    };
    return { executeScm: invoke, invokeGithub: invoke };
}

export async function publishPluginGithub(params: PluginGithubActionDependencies & Readonly<{
    directory?: string; selection: PluginPublicationGithubInput; signal?: AbortSignal;
}>): Promise<PluginPublicationGithubResult> {
    const { selection, directory } = params;
    const children = pluginPublicationReviewedChildren({ projectRoot: directory, github: selection });
    const selectedInput = (actionId: keyof typeof PLUGIN_PUBLICATION_GITHUB_CHILD_ROLES) =>
        children.find(child => child.role === PLUGIN_PUBLICATION_GITHUB_CHILD_ROLES[actionId])!.input;
    let result: PluginPublicationGithubResult = { status: 'published', phase: 'repository', pushed: false };
    let applied = false;
    const failure = (errorCode: string, status?: PluginPublicationGithubResult['status']): PluginPublicationGithubResult => ({
        ...result, status: status ?? (applied ? 'partial' : 'failed'), errorCode,
    });
    const cancelled = (): PluginPublicationGithubResult | null => params.signal?.aborted
        ? { ...result, status: applied ? 'partial' : 'cancelled' } : null;
    const mutationResult = (mutation: PublicationReleaseReply): PluginPublicationGithubResult | null => {
        if (mutation.release) {
            result = { ...result, releaseId: mutation.release.releaseId, releaseUrl: mutation.release.webUrl };
        }
        switch (mutation.kind) {
            case 'confirmed': return null;
            case 'conflict': return failure('changedSinceReview', 'conflict');
            case 'rejected': return failure(mutation.failure!.code);
            case 'outcome_unknown': return { ...failure(mutation.failure?.code ?? 'COMMAND_OUTCOME_UNKNOWN', 'outcome_unknown'),
                ...(mutation.releaseId ? { releaseId: mutation.releaseId } : {}),
                ...(mutation.webUrl ? { releaseUrl: mutation.webUrl } : {}) };
            default: return failure('COMMAND_OUTCOME_UNKNOWN', 'outcome_unknown');
        }
    };
    try {
        if (cancelled()) return cancelled()!;
        if (selection.createRepository) {
            const described = ScmHostingRepositoryDescribePublishTargetsResponseSchema.parse(await params.executeScm({
                actionId: 'scm.hostingRepository.describePublishTargets', input: selectedInput('scm.hostingRepository.describePublishTargets'),
            }));
            if (!described.success) return failure(described.errorCode ?? 'COMMAND_FAILED');
            if (cancelled()) return cancelled()!;
            const repository = ScmHostingRepositoryPublishResponseSchema.parse(await params.executeScm({
                actionId: 'scm.hostingRepository.publish', input: selectedInput('scm.hostingRepository.publish'),
            }));
            if (!repository.success) {
                // SCM can finish repository creation before attaching its remote fails.
                const retained = ScmHostingRepositorySummarySchema.safeParse(repository.repository);
                if (retained.success) {
                    applied = true;
                    result = { ...result, repositoryUrl: retained.data.webUrl };
                }
                const outcome = normalizeScmOperationOutcome(repository);
                return failure(repository.errorCode ?? ('errorCode' in outcome ? outcome.errorCode : undefined) ?? 'COMMAND_FAILED',
                    outcome.kind === 'outcome_unknown' ? 'outcome_unknown' : undefined);
            }
            applied = true;
            result = { ...result, repositoryUrl: repository.repository.webUrl };
        }
        if (selection.source?.commit) {
            result = { ...result, phase: 'commit' };
            if (cancelled()) return cancelled()!;
            const commit = ScmCommitCreateResponseSchema.parse(await params.executeScm({ actionId: 'scm.commit.create',
                input: selectedInput('scm.commit.create'),
            }));
            const outcome = normalizeScmOperationOutcome(commit);
            if (outcome.kind === 'effect_applied_with_warning') {
                applied = true;
                result = { ...result, ...(outcome.effect.kind === 'commit' ? { commitSha: outcome.effect.commitSha } : {}) };
                return failure(outcome.errorCode);
            }
            if (outcome.kind !== 'succeeded') return failure(commit.errorCode ?? ('errorCode' in outcome ? outcome.errorCode : undefined) ?? 'COMMAND_FAILED',
                outcome.kind === 'outcome_unknown' ? 'outcome_unknown' : undefined);
            applied = true;
            result = { ...result, ...(commit.commitSha ? { commitSha: commit.commitSha } : {}) };
        }
        if (selection.source) {
            result = { ...result, phase: 'push' };
            if (cancelled()) return cancelled()!;
            const push = ScmRemoteResponseSchema.parse(await params.executeScm({ actionId: 'scm.remote.push',
                input: selectedInput('scm.remote.push'),
            }));
            const outcome = normalizeScmOperationOutcome(push);
            if (outcome.kind === 'effect_applied_with_warning') {
                applied = true;
                result = { ...result, pushed: true };
                return failure(outcome.errorCode);
            }
            if (outcome.kind !== 'succeeded') return failure(push.errorCode ?? ('errorCode' in outcome ? outcome.errorCode : undefined) ?? 'COMMAND_FAILED',
                outcome.kind === 'outcome_unknown' ? 'outcome_unknown' : undefined);
            applied = true;
            result = { ...result, pushed: true };
        }
        if (selection.release) {
            result = { ...result, phase: 'release' };
            if (cancelled()) return cancelled()!;
            const { releaseId, makeLatest, ...fields } = selection.release;
            let draft: PublicationRelease;
            if (releaseId) {
                const read = await params.invokeGithub({
                    actionId: 'github/releases/release-read', input: selectedInput('github/releases/release-read'),
                }) as PublicationReleaseReply;
                if (read.kind !== 'value') return failure(read.kind === 'unavailable' ? read.failure!.code : 'COMMAND_OUTCOME_UNKNOWN');
                draft = read.value!;
            } else {
                const created = await params.invokeGithub({
                    actionId: 'github/releases/draft-create', input: selectedInput('github/releases/draft-create'),
                }) as PublicationReleaseReply;
                const stopped = mutationResult(created);
                if (stopped) return stopped;
                if (created.kind !== 'confirmed') return failure('COMMAND_OUTCOME_UNKNOWN', 'outcome_unknown');
                applied = true;
                draft = created.release!;
            }
            result = { ...result, releaseId: draft.releaseId, releaseUrl: draft.webUrl };
            if (cancelled()) return cancelled()!;
            // Review intent is the selected fields and no uploaded assets. The release owner
            // alone compares this with fresh provider fields/assets and decides conflicts.
            const reviewed = { ...draft, ...fields,
                assets: { rows: [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null } };
            const published = await params.invokeGithub({
                actionId: 'github/releases/draft-publish', input: { repository: selection.repository, repositoryId: draft.repositoryId,
                    releaseId: draft.releaseId, reviewed, makeLatest },
            }) as PublicationReleaseReply;
            const stopped = mutationResult(published);
            if (stopped) return stopped;
        }
        return result;
    } catch (error) {
        if (error instanceof ChildActionFailure) return failure(error.code,
            isActionOutcomeUnknownErrorCodeV1(error.code) ? 'outcome_unknown' : undefined);
        // A transport may fail after its effect. Never disclose its exception or claim rollback.
        return failure('COMMAND_OUTCOME_UNKNOWN', 'outcome_unknown');
    }
}
