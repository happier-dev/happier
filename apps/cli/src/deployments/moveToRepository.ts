import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { DeploymentMoveToRepositoryInputV1, DeploymentMoveToRepositoryResultV1,
  DeploymentMoveToRepositoryContinuationV1, DeploymentArtifactContentReferenceV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentEnvironmentUpdateResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ScmPullRequestGetResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import { ScmFileAtRevisionResponseSchema } from '@happier-dev/protocol/scm/fileAtRevision';
import { ScmRemoteResponseSchema, ScmStatusSnapshotResponseSchema } from '@happier-dev/protocol/scm';
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
import { previewRepositoryForDefinition, provisionRepositoryForDefinition } from '@/scm/actions/provisionRepositoryForDefinition';
import { ADMITTED_CHECKOUT_OWNER_REQUIRED } from './admittedCheckoutRepositoryFiles';

/** A definition Move reads Environment content only, never runtime target-link content. */
type MoveEnvironment = Pick<DeploymentEnvironmentDetailV1, 'environment' | 'content'>;
type Host = Readonly<{
  serverId: string; machineId: string;
  assertCurrent(context: ActionExecutorContext): Promise<void>;
  requireDefinitionManage(context: ActionExecutorContext): Promise<void>;
  readEnvironment(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>): Promise<MoveEnvironment>;
  readSource: NonNullable<ActionExecutorDeps['projectSourcesRead']>;
  updateSource?: NonNullable<ActionExecutorDeps['projectSourcesUpdate']>;
  acceptWorkspace?(workspace: WorkspaceRefV1, source: ProjectSourceV1, repository: ScmHostingRepositoryIdentityV1,
    context: ActionExecutorContext): Promise<void>;
  readWorkspaceRows: CliAdmittedProjectRowsReader;
  scmRegistry?: ScmBackendRegistry;
  repositoryFiles(cwd: string, context: ActionExecutorContext): RepositoryFilesPullRequestHost;
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
  return async (requested, context, executeCanonicalAction) => {
    let input = requested;
    try {
      if (input.serverId !== host.serverId) return fail('server_scope_mismatch');
      await host.assertCurrent(context);
      await host.requireDefinitionManage(context);
      const current = await host.readEnvironment({ environmentId: input.environmentId, context });
      if (current.environment.id !== input.environmentId || !current.environment.capabilities.manage) return fail('deployment_access_denied');
      if (current.content.definition.kind !== 'stored') return { kind: 'conflict', reason: 'definition_changed' };
      const definition = current.content.definition;
      const coldContinuation = input.pullRequestReference !== undefined;
      if (!input.continuation && !coldContinuation && !isDeepStrictEqual(pinOf(definition), input.definition)) return { kind: 'conflict', reason: 'definition_changed' };
      await admitStoredComposeDefinition(definition);
      const files = [{ path: input.path, content: definition.document }, ...(definition.publicFiles ?? [])
        .map(file => ({ path: sidecarPath(input.path, file.path), content: file.content }))];
      if (input.mode === 'preview' && input.createRepository) {
        const placed = await resolveAdmittedRepositoryWorkspace({ workspace: input.workspace, context,
          readWorkspaceRows: host.readWorkspaceRows, fallbackActionId: 'deployments.environments.moveToRepository' });
        if (!('kind' in placed) || placed.kind !== 'resolved') return placed;
        if (placed.workspace.machineId !== host.machineId) return fail('target_mismatch');
        const filesHost = host.repositoryFiles(placed.workspace.rootPath, context);
        const status = ScmStatusSnapshotResponseSchema.parse(await filesHost.executeScm('scm.status.snapshot', { includeWorktreeStatus: false }));
        if (!status.success) return fail(status.errorCode ?? 'COMMAND_FAILED');
        const branch = status.snapshot?.branch;
        const existingBase = branch?.headOid && branch.head ? { baseCommit: branch.headOid, baseBranch: branch.head } : undefined;
        const publication = previewRepositoryForDefinition(input.createRepository, existingBase);
        const existingReview = existingBase ? await prepareRepositoryFilesPullRequest({ cwd: placed.workspace.rootPath,
          ...existingBase, branchName: publication.initialBranch, title: `Move ${current.content.name} definition to repository`, files }, filesHost) : undefined;
        return { kind: 'previewCreate', review: { document: definition.document, path: input.path, workspace: input.workspace,
          createRepository: input.createRepository, selectors: input.selectors ?? { profiles: definition.profiles,
            services: definition.services, ...(definition.primaryService ? { primaryService: definition.primaryService } : {}) },
          files: [...publication.files.map(file => ({ ...file, before: null })),
            ...files.map((file, index) => ({ ...file, before: existingReview?.files[index]?.before ?? null }))],
        } };
      }
      const loaded = await host.readSource({ serverId: input.serverId, sourceId: current.environment.projectSourceId }, context);
      if (!loaded.ok) return fail('errorCode' in loaded ? loaded.errorCode : loaded.error);
      let created: Extract<Awaited<ReturnType<typeof provisionRepositoryForDefinition>>, { kind: 'provisioned' }> | undefined;
      let createdWorkspace: WorkspaceRefV1 | undefined;
      if (input.createRepository) {
        const placed = await resolveAdmittedRepositoryWorkspace({ workspace: input.workspace, context,
          readWorkspaceRows: host.readWorkspaceRows, fallbackActionId: 'deployments.environments.moveToRepository' });
        if (!('kind' in placed) || placed.kind !== 'resolved') return placed;
        if (placed.workspace.machineId !== host.machineId) return fail('target_mismatch');
        const provisioned = await provisionRepositoryForDefinition({ checkout: placed.workspace,
          createRepository: input.createRepository }, host.repositoryFiles(placed.workspace.rootPath, context), context.signal);
        if (provisioned.kind === 'partial') return { kind: 'partial', phase: provisioned.phase, errorCode: provisioned.errorCode };
        created = provisioned;
        createdWorkspace = placed.workspace;
        input = { ...input, repository: created.repository, baseCommit: created.baseCommit,
          baseBranch: created.baseBranch, sourceRepository: created.sourceRepository };
      }
      if (!input.repository || !input.workspace || !input.baseCommit || !input.baseBranch)
        return { kind: 'refused', reason: 'repository_provisioning_unavailable' };
      let source = !loaded.source.repository && input.sourceRepository
        ? { ...loaded.source, repository: input.sourceRepository } : loaded.source;
      if (!source.repository || !sameScmHostingRepositoryIdentity(readScmHostingRepositoryIdentity({ ...source.repository.provider,
        nameWithOwner: source.repository.repository.nameWithOwner }), input.repository)) return { kind: 'conflict', reason: 'source_changed' };
      const placed = createdWorkspace ? { kind: 'resolved' as const, workspace: createdWorkspace }
        : await resolveAdmittedRepositoryWorkspace({ workspace: input.workspace, context,
        ...(!input.continuation && !coldContinuation ? { expected: { projectSourceId: source.id, sourceRevision: source.revision, repository: input.repository } } : {}),
        readWorkspaceRows: host.readWorkspaceRows, fallbackActionId: 'deployments.environments.moveToRepository' });
      if (!('kind' in placed) || placed.kind !== 'resolved') return placed;
      const workspace = placed.workspace;
      if (workspace.machineId !== host.machineId || (!created && workspace.source?.sourceId !== source.id)) return fail('target_mismatch');
      const filesHost = host.repositoryFiles(workspace.rootPath, context);
      const validated = created ? { kind: 'validated' as const, source } : await validateAdmittedRepositoryWorkspace({ workspace, projectSourceId: source.id, sourceRevision: source.revision,
        repository: input.repository, ...(!input.continuation && !coldContinuation ? { baseCommit: input.baseCommit } : {}), context, readSource: host.readSource,
        admittedSource: source, readScmStatus: () => filesHost.executeScm('scm.status.snapshot', { includeWorktreeStatus: false }),
        ...(host.scmRegistry ? { registry: host.scmRegistry } : {}) });
      if (!('kind' in validated) || validated.kind !== 'validated') return validated;
      const selectors = input.selectors ?? input.continuation?.selectors ?? { profiles: definition.profiles, services: definition.services,
        ...(definition.primaryService ? { primaryService: definition.primaryService } : {}) };
      if (input.continuation || coldContinuation) return await continueMove(input, input.continuation, current, filesHost, source,
        selectors, context, executeCanonicalAction);
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
      const continuation = () => ({ pullRequest: opened.pullRequest, headCommit: opened.headCommit,
        document: definition.document, definition: input.definition, source: { id: source.id, revision: source.revision },
        path: input.path, selectors, ...(definition.publicFiles ? { publicFiles: definition.publicFiles } : {}) });
      if (!loaded.source.repository) {
        try {
          if (!host.updateSource || !host.acceptWorkspace) return { kind: 'partial', phase: 'source',
            errorCode: 'project_requester_authority_unavailable', continuation: continuation() };
          const attached = await host.updateSource({ serverId: input.serverId, sourceId: source.id,
            expectedRevision: loaded.source.revision, patch: { repository: source.repository } }, context);
          if (!attached.ok) return { kind: 'partial', phase: 'source',
            errorCode: 'errorCode' in attached ? attached.errorCode : attached.error, continuation: continuation() };
          source = attached.source;
          await host.acceptWorkspace(workspace, source, input.repository, context);
        } catch (error) { return { kind: 'partial', phase: 'source', errorCode: codeOf(error), continuation: continuation() }; }
      }
      return { kind: 'pullRequest', continuation: continuation(), ...(created ? { repository: {
        repository: created.repository, baseCommit: created.baseCommit, baseBranch: created.baseBranch, workspace: input.workspace,
      } } : {}) };
    } catch (error) {
      if (context.signal?.aborted) return fail('cancelled');
      const code = codeOf(error);
      // The reviewed checkout belongs to another Account's Machine: a typed refusal, before any repository effect.
      return code === ADMITTED_CHECKOUT_OWNER_REQUIRED ? { kind: 'refused', reason: code } : fail(code);
    }
  };

  async function continueMove(input: DeploymentMoveToRepositoryInputV1, continuation: DeploymentMoveToRepositoryContinuationV1 | undefined,
    capturedCurrent: MoveEnvironment, scm: RepositoryFilesPullRequestHost,
    source: Readonly<{ id: string; revision: number }>, selectors: NonNullable<DeploymentMoveToRepositoryInputV1['selectors']>,
    context: ActionExecutorContext,
    executeCanonicalAction: Parameters<NonNullable<ActionExecutorDeps['deploymentMoveToRepository']>>[2],
  ): Promise<DeploymentMoveToRepositoryResultV1 | ReturnType<typeof fail>> {
    if (continuation && (!isDeepStrictEqual(continuation.definition, input.definition) || continuation.path !== input.path
      || continuation.source.id !== source.id || continuation.source.revision !== source.revision
      || !isDeepStrictEqual(continuation.selectors, selectors)
      || !sameScmHostingRepositoryIdentity(readScmHostingRepositoryIdentity(continuation.pullRequest.provider), input.repository)))
      return { kind: 'conflict', reason: 'source_changed', continuation };
    const readDocument = async (commit: string, path: string) => {
      const read = ScmFileAtRevisionResponseSchema.parse(await scm.executeScm('scm.file.read', {
        path, selector: { commit } }));
      if (!read.success) throw Object.assign(new Error(read.errorCode), { code: read.errorCode });
      return Buffer.from(read.contentBase64, 'base64').toString('utf8');
    };
    // Public continuation bytes are proven against the original exported commit.
    if (continuation && (await readDocument(continuation.headCommit, input.path) !== continuation.document
      || storedComposeDefinitionDigest(continuation) !== continuation.definition.composeDigest))
      return { kind: 'conflict', reason: 'definition_changed', continuation };
    if (continuation) for (const file of continuation.publicFiles ?? [])
      if (await readDocument(continuation.headCommit, sidecarPath(input.path, file.path)) !== file.content)
        return { kind: 'conflict', reason: 'definition_changed', continuation };
    const loadedPr = ScmPullRequestGetResponseSchema.parse(await scm.executeScm('scm.pullRequest.get', {
      ...(continuation ? { prReference: { number: continuation.pullRequest.number }, providerId: continuation.pullRequest.provider.id }
        : { prReference: input.pullRequestReference }),
    }));
    if (!loadedPr.success) return { kind: 'partial', phase: 'pullRequest', errorCode: loadedPr.errorCode ?? 'COMMAND_FAILED', continuation };
    const pr = loadedPr.pullRequest;
    if (!pr || (continuation && (pr.number !== continuation.pullRequest.number || pr.headBranch !== continuation.pullRequest.headBranch
      || pr.baseBranch !== continuation.pullRequest.baseBranch))
      || !sameScmHostingRepositoryIdentity(readScmHostingRepositoryIdentity(pr.provider), input.repository))
      return { kind: 'conflict', reason: 'pull_request_changed', continuation };
    if (pr.state !== 'merged') return continuation
      ? { kind: 'pullRequest', continuation: { ...continuation, pullRequest: pr } }
      : { kind: 'pullRequestStatus', pullRequest: pr };
    if (!pr.mergeCommitSha) return { kind: 'partial', phase: 'mergedCommit', errorCode: 'blob_unavailable', continuation };
    const fetched = ScmRemoteResponseSchema.parse(await scm.executeScm('scm.remote.fetch', {
      remote: pr.provider.remoteName ?? 'origin', branch: pr.mergeCommitSha,
    }));
    if (!fetched.success) return { kind: 'partial', phase: 'mergedCommit', errorCode: fetched.errorCode ?? 'COMMAND_FAILED', continuation };
    const mergedDocument = await readDocument(pr.mergeCommitSha, input.path);
    const currentDefinition = capturedCurrent.content.definition;
    if (currentDefinition.kind !== 'stored') return { kind: 'conflict', reason: 'definition_changed', continuation };
    const publicFiles = continuation ? continuation.publicFiles : currentDefinition.publicFiles;
    const mergedPublicFiles = publicFiles === undefined ? undefined : await Promise.all(publicFiles.map(async file => ({
      path: file.path, content: await readDocument(pr.mergeCommitSha!, sidecarPath(input.path, file.path)),
    })));
    await parseNativeComposeSource(mergedDocument);
    const mergedReview = { currentDefinition: pinOf(currentDefinition), currentDocument: currentDefinition.document,
      mergedCommit: pr.mergeCommitSha, mergedDocument,
      ...(currentDefinition.publicFiles ? { currentPublicFiles: currentDefinition.publicFiles } : {}),
      ...(mergedPublicFiles ? { mergedPublicFiles } : {}) };
    const changed = !continuation || mergedDocument !== continuation.document || !isDeepStrictEqual(mergedPublicFiles, continuation.publicFiles)
      || !isDeepStrictEqual(pinOf(currentDefinition), continuation.definition);
    if (changed && !isDeepStrictEqual(input.useMergedVersion, mergedReview) || input.mode === 'preview')
      return { kind: 'reviewMerged', review: mergedReview, ...(continuation ? { continuation } : { pullRequest: pr }) };
    const content = DeploymentEnvironmentContentV1Schema.parse({ ...capturedCurrent.content, definition: {
      kind: 'repository', ref: pr.mergeCommitSha, compose: { path: input.path, ...selectors },
    } });
    const created = await host.createContent(content, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, context, capturedCurrent.environment.owner,
      capturedCurrent.environment.id);
    const updated = await executeCanonicalAction('deployments.environments.update', { serverId: input.serverId,
      environmentId: input.environmentId, expectedRevision: capturedCurrent.environment.revision, ...created });
    if (!updated.ok) return updated;
    const settled = DeploymentEnvironmentUpdateResultV1Schema.parse(updated.result);
    if (!settled.ok) return { kind: 'conflict', reason: settled.error, continuation };
    return { kind: 'switched', environmentId: input.environmentId, revision: settled.revision, commitSha: pr.mergeCommitSha };
  }
}
