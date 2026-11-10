import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { DeploymentMoveToRepositoryInputV1, DeploymentMoveToRepositoryResultV1,
  DeploymentMoveToRepositoryContinuationV1, DeploymentArtifactContentReferenceV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentEnvironmentUpdateResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ScmPullRequestGetResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import { ScmFileAtRevisionResponseSchema } from '@happier-dev/protocol/scm/fileAtRevision';
import { ScmRemoteResponseSchema } from '@happier-dev/protocol/scm';
import { readScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { DeploymentEnvironmentContentV1Schema, type DeploymentEnvironmentDetailV1,
  DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { resolveAdmittedRepositoryWorkspace, validateAdmittedRepositoryWorkspace } from '@/workspaces/admittedRepositoryWorkspace';
import type { CliAdmittedProjectRowsReader } from '@/session/actions/cliActionDeps/projectAdmission';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { ScmBackendRegistry } from '@/scm/registry';
import { admitStoredComposeDefinition, parseNativeComposeSource, storedComposeDefinitionDigest } from '@/workspaces/projectSetup/nativeComposeSource';
import { prepareRepositoryFilesPullRequest, openRepositoryFilesPullRequest,
  type RepositoryFilesPullRequestHost } from '@/scm/actions/repositoryFilesPullRequest';

type Host = Readonly<{
  serverId: string; machineId: string;
  assertCurrent(context: ActionExecutorContext): Promise<void>;
  requireDefinitionManage(context: ActionExecutorContext): Promise<void>;
  readEnvironment(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>): Promise<DeploymentEnvironmentDetailV1>;
  readSource: NonNullable<ActionExecutorDeps['projectSourcesRead']>;
  updateSource?: NonNullable<ActionExecutorDeps['projectSourcesUpdate']>;
  acceptWorkspace?(workspace: WorkspaceRefV1, source: ProjectSourceV1, repository: ScmHostingRepositoryIdentityV1,
    context: ActionExecutorContext): Promise<void>;
  readWorkspaceRows: CliAdmittedProjectRowsReader;
  scmRegistry?: ScmBackendRegistry;
  repositoryFiles(cwd: string, context: ActionExecutorContext,
    executeCanonicalAction: Parameters<NonNullable<ActionExecutorDeps['deploymentMoveToRepository']>>[2]): RepositoryFilesPullRequestHost;
  storage: NonNullable<ActionExecutorDeps['deploymentAction']>;
  createContent(content: unknown, kind: string, context: ActionExecutorContext,
    owner: DeploymentEnvironmentDetailV1['environment']['owner'], environmentId: string): Promise<DeploymentArtifactContentReferenceV1>;
}>;
const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
const codeOf = (error: unknown) => error instanceof Error && 'code' in error && typeof error.code === 'string'
  ? error.code : 'deployment_content_unavailable';
const pinOf = (definition: Extract<DeploymentEnvironmentDetailV1['content']['definition'], { kind: 'stored' }>) => ({
  contentRevision: definition.contentRevision, composeDigest: definition.composeDigest,
});
const sidecarPath = (composePath: string, path: string) => posix.join(posix.dirname(composePath.replaceAll('\\', '/')), path.replaceAll('\\', '/'));

/** Finite definition composition. Source, SCM and Environment update keep their existing writes. */
export function createDeploymentMoveToRepositoryForHost(host: Host): NonNullable<ActionExecutorDeps['deploymentMoveToRepository']> {
  return async (input, context, executeCanonicalAction) => {
    try {
      if (input.serverId !== host.serverId) return fail('server_scope_mismatch');
      await host.assertCurrent(context);
      await host.requireDefinitionManage(context);
      const current = await host.readEnvironment({ environmentId: input.environmentId, context });
      if (current.environment.id !== input.environmentId || !current.environment.capabilities.manage) return fail('deployment_access_denied');
      if (current.content.definition.kind !== 'stored') return { kind: 'conflict', reason: 'definition_changed' };
      const definition = current.content.definition;
      if (!input.continuation && !isDeepStrictEqual(pinOf(definition), input.definition)) return { kind: 'conflict', reason: 'definition_changed' };
      await admitStoredComposeDefinition(definition);
      if (!input.repository || !input.workspace || !input.baseCommit || !input.baseBranch)
        return { kind: 'refused', reason: 'repository_provisioning_unavailable' };
      const loaded = await host.readSource({ serverId: input.serverId, sourceId: current.environment.projectSourceId }, context);
      if (!loaded.ok) return fail('errorCode' in loaded ? loaded.errorCode : loaded.error);
      const source = loaded.source;
      if (!source.repository || !sameScmHostingRepositoryIdentity(readScmHostingRepositoryIdentity({ ...source.repository.provider,
        nameWithOwner: source.repository.repository.nameWithOwner }), input.repository)) return { kind: 'conflict', reason: 'source_changed' };
      const placed = await resolveAdmittedRepositoryWorkspace({ workspace: input.workspace, context,
        ...(!input.continuation ? { expected: { projectSourceId: source.id, sourceRevision: source.revision, repository: input.repository } } : {}),
        readWorkspaceRows: host.readWorkspaceRows, fallbackActionId: 'deployments.environments.moveToRepository' });
      if (!('kind' in placed) || placed.kind !== 'resolved') return placed;
      const workspace = placed.workspace;
      if (workspace.machineId !== host.machineId || workspace.source?.sourceId !== source.id) return fail('target_mismatch');
      const filesHost = host.repositoryFiles(workspace.rootPath, context, executeCanonicalAction);
      const validated = await validateAdmittedRepositoryWorkspace({ workspace, projectSourceId: source.id, sourceRevision: source.revision,
        repository: input.repository, ...(!input.continuation ? { baseCommit: input.baseCommit } : {}), context, readSource: host.readSource,
        admittedSource: source, readScmStatus: () => filesHost.executeScm('scm.status.snapshot', { includeWorktreeStatus: false }),
        ...(host.scmRegistry ? { registry: host.scmRegistry } : {}) });
      if (!('kind' in validated) || validated.kind !== 'validated') return validated;
      const selectors = input.selectors ?? input.continuation?.selectors ?? { profiles: definition.profiles, services: definition.services,
        ...(definition.primaryService ? { primaryService: definition.primaryService } : {}) };
      if (input.continuation) return await continueMove(input, input.continuation, current, filesHost, source, selectors, context);
      const files = [{ path: input.path, content: definition.document }, ...(definition.publicFiles ?? [])
        .map(file => ({ path: sidecarPath(input.path, file.path), content: file.content }))];
      const branchName = `happier/move-${createHash('sha256').update(JSON.stringify({ environmentId: input.environmentId,
        definition: input.definition, repository: input.repository, path: input.path, baseCommit: input.baseCommit })).digest('hex')}`;
      const review = await prepareRepositoryFilesPullRequest({ cwd: workspace.rootPath, baseCommit: input.baseCommit,
        baseBranch: input.baseBranch, branchName, title: `Move ${current.content.name} definition to repository`, files }, filesHost);
      if (input.mode === 'preview') return { kind: 'preview', review: { document: definition.document,
        repository: input.repository, path: input.path, baseCommit: input.baseCommit, baseBranch: input.baseBranch,
        workspace: input.workspace, source: { id: source.id, revision: source.revision }, before: review.files[0]!.before,
        selectors, files: review.files.map(({ path, before, content }) => ({ path, before, content })) } };
      const opened = await openRepositoryFilesPullRequest(review, filesHost, input.repositoryWork);
      if (opened.kind === 'partial') return { kind: 'partial', errorCode: opened.errorCode, phase: opened.stage, repositoryWork: opened };
      return { kind: 'pullRequest', continuation: { pullRequest: opened.pullRequest, headCommit: opened.headCommit,
        document: definition.document, definition: input.definition, source: { id: source.id, revision: source.revision },
        path: input.path, selectors, ...(definition.publicFiles ? { publicFiles: definition.publicFiles } : {}) } };
    } catch (error) { return fail(context.signal?.aborted ? 'cancelled' : codeOf(error)); }
  };

  async function continueMove(input: DeploymentMoveToRepositoryInputV1, continuation: DeploymentMoveToRepositoryContinuationV1,
    capturedCurrent: DeploymentEnvironmentDetailV1, scm: RepositoryFilesPullRequestHost,
    source: Readonly<{ id: string; revision: number }>, selectors: NonNullable<DeploymentMoveToRepositoryInputV1['selectors']>,
    context: ActionExecutorContext): Promise<DeploymentMoveToRepositoryResultV1 | ReturnType<typeof fail>> {
    if (!isDeepStrictEqual(continuation.definition, input.definition) || continuation.path !== input.path
      || continuation.source.id !== source.id || continuation.source.revision !== source.revision
      || !isDeepStrictEqual(continuation.selectors, selectors)
      || !sameScmHostingRepositoryIdentity(readScmHostingRepositoryIdentity(continuation.pullRequest.provider), input.repository))
      return { kind: 'conflict', reason: 'source_changed', continuation };
    const readDocument = async (commit: string, path: string) => {
      const read = ScmFileAtRevisionResponseSchema.parse(await scm.executeScm('scm.file.read', {
        path, selector: { commit } }));
      if (!read.success) throw Object.assign(new Error(read.errorCode), { code: read.errorCode });
      return Buffer.from(read.contentBase64, 'base64').toString('utf8');
    };
    // Public continuation bytes are proven against the original exported commit.
    if (await readDocument(continuation.headCommit, input.path) !== continuation.document
      || storedComposeDefinitionDigest(continuation) !== continuation.definition.composeDigest)
      return { kind: 'conflict', reason: 'definition_changed', continuation };
    for (const file of continuation.publicFiles ?? []) if (await readDocument(continuation.headCommit, sidecarPath(input.path, file.path)) !== file.content)
      return { kind: 'conflict', reason: 'definition_changed', continuation };
    const loadedPr = ScmPullRequestGetResponseSchema.parse(await scm.executeScm('scm.pullRequest.get', {
      prReference: { number: continuation.pullRequest.number }, providerId: continuation.pullRequest.provider.id,
    }));
    if (!loadedPr.success) return { kind: 'partial', phase: 'pullRequest', errorCode: loadedPr.errorCode ?? 'COMMAND_FAILED', continuation };
    const pr = loadedPr.pullRequest;
    if (!pr || pr.number !== continuation.pullRequest.number || pr.headBranch !== continuation.pullRequest.headBranch
      || pr.baseBranch !== continuation.pullRequest.baseBranch
      || !sameScmHostingRepositoryIdentity(readScmHostingRepositoryIdentity(pr.provider), input.repository))
      return { kind: 'conflict', reason: 'pull_request_changed', continuation };
    if (pr.state !== 'merged') return { kind: 'pullRequest', continuation: { ...continuation, pullRequest: pr } };
    if (!pr.mergeCommitSha) return { kind: 'partial', phase: 'mergedCommit', errorCode: 'blob_unavailable', continuation };
    const fetched = ScmRemoteResponseSchema.parse(await scm.executeScm('scm.remote.fetch', {
      remote: pr.provider.remoteName ?? 'origin', branch: pr.mergeCommitSha,
    }));
    if (!fetched.success) return { kind: 'partial', phase: 'mergedCommit', errorCode: fetched.errorCode ?? 'COMMAND_FAILED', continuation };
    const mergedDocument = await readDocument(pr.mergeCommitSha, input.path);
    const mergedPublicFiles = continuation.publicFiles === undefined ? undefined : await Promise.all(continuation.publicFiles.map(async file => ({
      path: file.path, content: await readDocument(pr.mergeCommitSha!, sidecarPath(input.path, file.path)),
    })));
    await parseNativeComposeSource(mergedDocument);
    const currentDefinition = capturedCurrent.content.definition;
    if (currentDefinition.kind !== 'stored') return { kind: 'conflict', reason: 'definition_changed', continuation };
    const mergedReview = { currentDefinition: pinOf(currentDefinition), currentDocument: currentDefinition.document,
      mergedCommit: pr.mergeCommitSha, mergedDocument,
      ...(currentDefinition.publicFiles ? { currentPublicFiles: currentDefinition.publicFiles } : {}),
      ...(mergedPublicFiles ? { mergedPublicFiles } : {}) };
    const changed = mergedDocument !== continuation.document || !isDeepStrictEqual(mergedPublicFiles, continuation.publicFiles)
      || !isDeepStrictEqual(pinOf(currentDefinition), continuation.definition);
    if (changed && !isDeepStrictEqual(input.useMergedVersion, mergedReview)) return { kind: 'reviewMerged', review: mergedReview, continuation };
    if (input.mode === 'preview') return { kind: 'reviewMerged', review: mergedReview, continuation };
    const content = DeploymentEnvironmentContentV1Schema.parse({ ...capturedCurrent.content, definition: {
      kind: 'repository', ref: pr.mergeCommitSha, compose: { path: input.path, ...selectors },
    } });
    const created = await host.createContent(content, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, context, capturedCurrent.environment.owner,
      capturedCurrent.environment.id);
    const updated = await host.storage('deployments.environments.update', { serverId: input.serverId,
      environmentId: input.environmentId, expectedRevision: capturedCurrent.environment.revision, ...created }, context);
    if ('errorCode' in updated) return updated;
    const settled = DeploymentEnvironmentUpdateResultV1Schema.parse(updated);
    if (!settled.ok) return { kind: 'conflict', reason: settled.error, continuation };
    return { kind: 'switched', environmentId: input.environmentId, revision: settled.revision, commitSha: pr.mergeCommitSha };
  }
}
