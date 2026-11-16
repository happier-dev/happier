import { ScmHostingRepositoryResolveAddressResponseV1Schema, ScmRepositoryCloneOutputSchema } from '../../../scm/repositoryClone.js';
import { SCM_OPERATION_ERROR_CODES } from '../../../scm/operationError.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '../../../registries/registryActionsV1.js';
import type { ProjectStarterCreateInputV1, ProjectStarterCreateOutputV1 } from '../../../projects/starters/createV1.js';
import { ScmHostingRepositoryDescribePublishTargetsResponseSchema, ScmHostingRepositoryPublishResponseSchema, ScmHostingRepositorySummarySchema, ScmRepositoryInitResponseSchema } from '../../../scm/repositoryProvisioning.js';
import { ProjectSourcesCreateOutputV1Schema, projectSourceRepositorySelectorFromHostingSummaryV1, type ProjectSourceRepositorySelectorV1 } from '../../../projects/sources/projectSourceV1.js';
import { OpenProjectResultV1Schema } from '../../../projects/openProjectV1.js';
import { DaemonFilesystemListDirectoryResponseSchema } from '../../../machines/fileBrowser.js';
import { FILESYSTEM_BROWSER_ACTION_IDS_V1, FilesystemMutationOutputSchema } from '../../filesystemActionFamily.js';
import type { ActionId } from '../../actionIds.js';
import type { ActionExecuteResult } from '../types.js';

/** Finite composition only; each child retains its existing transport and state owner. */
export async function createProjectFromStarter(input: ProjectStarterCreateInputV1, execute: (id: ActionId, input: unknown) => Promise<ActionExecuteResult>): Promise<ActionExecuteResult> {
  const scratch = input.source?.kind === 'scratch';
  const starterId = input.source?.kind === 'starter' ? input.source.starterId : input.starterId;
  const starterSourceId = input.source?.kind === 'starter' ? input.source.sourceId : input.starterSourceId;
  let phase: Extract<ProjectStarterCreateOutputV1, { kind: 'failed' | 'partial' }>['phase'] = 'starter';
  let resume = input.resume;
  let checkoutCreated = Boolean(resume);
  let directory = resume?.directory;
  let workspace: Extract<ProjectStarterCreateOutputV1, { kind: 'created' }>['workspace'] | undefined;
  let repositoryUrl = resume?.repositoryUrl;
  let sourceId = resume?.sourceId;
  const failed = (code: string, remediation?: Extract<ProjectStarterCreateOutputV1, { kind: 'failed' | 'partial' }>['remediation']): ActionExecuteResult => ({ ok: true, result: {
    kind: checkoutCreated ? 'partial' : 'failed', phase, code,
    ...(directory ? { directory } : {}), ...(repositoryUrl ? { repositoryUrl } : {}), ...(sourceId ? { sourceId } : {}), ...(workspace ? { workspace } : {}), ...(resume ? { resume } : {}), ...(remediation ? { remediation } : {}),
  } satisfies ProjectStarterCreateOutputV1 });
  if (!resume) {
    let starterSelector: ProjectSourceRepositorySelectorV1 | undefined;
    if (!scratch) {
      const listed = await execute('registries.items.list', { kind: 'starter', query: starterId,
        ...(starterSourceId ? { sourceIds: [starterSourceId] } : {}) });
      if (!listed.ok) return listed;
      const pageResult = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(listed.result);
      const summary = pageResult.pages.flatMap(page => page.items).find(item => item.itemId === starterId
        && (!starterSourceId || item.sourceId === starterSourceId));
      if (!summary) return failed('starter_unavailable');
      const read = await execute('registries.items.read', { kind: 'starter', sourceId: summary.sourceId, itemId: summary.itemId, ...(summary.version ? { version: summary.version } : {}) });
      if (!read.ok) return read;
      const item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(read.result).item;
      const starter = item.payload.kind === 'starter' ? item.payload.starter : null;
      if (!starter) return failed('starter_unavailable');
      const resolved = await execute('scm.hostingRepository.resolveAddress', { address: starter.repository });
      if (!resolved.ok) return resolved;
      const address = ScmHostingRepositoryResolveAddressResponseV1Schema.parse(resolved.result);
      if (address.kind !== 'resolved' || address.selector.provider.kind !== 'github' || address.selector.provider.baseUrl !== 'https://github.com') return failed('starter_unavailable');
      starterSelector = address.selector;
    }
    phase = 'account';
    const described = await execute('scm.hostingRepository.describePublishTargets', { cwd: input.destinationParentPath, providerKind: input.repository.providerKind });
    if (!described.ok) return described;
    const targets = ScmHostingRepositoryDescribePublishTargetsResponseSchema.parse(described.result);
    if (!targets.success) return failed(targets.errorCode ?? 'scm_account_required', targets.remediation);
    if (targets.auth.state !== 'authenticated') return failed('scm_account_required', targets.auth.remediation);
    phase = 'checkout';
    let resolvedCommit: string | undefined;
    if (starterSelector) {
      const cloned = await execute('scm.repository.clone', { ...starterSelector,
        destinationParentPath: input.destinationParentPath, destinationDirectoryName: input.destinationDirectoryName,
        initialCheckout: { branch: 'main', revision: 'latest-stable' },
        confirmed: true, authorizationToken: 'clone-repository' });
      if (!cloned.ok) return cloned.errorCode === 'invalid_action_output' ? failed('checkout_failed') : cloned;
      const parsedClone = ScmRepositoryCloneOutputSchema.safeParse(cloned.result);
      if (!parsedClone.success) return failed('checkout_failed');
      const clone = parsedClone.data;
      if (!clone.success) return failed(clone.errorCode ?? 'checkout_failed', clone.remediation);
      checkoutCreated = true;
      directory = clone.destinationPath;
      resolvedCommit = clone.snapshot?.branch.headOid ?? undefined;
      if (!resolvedCommit) return failed('checkout_revision_unavailable');
    } else {
      // The clone path schema admits the single safe destination segment.
      // Preserve the selected Machine's path spelling instead of using this host's OS.
      const separator = !input.destinationParentPath.startsWith('/') && input.destinationParentPath.includes('\\') ? '\\' : '/';
      const parent = input.destinationParentPath.replace(separator === '\\' ? /[\\/]+$/ : /\/+$/, '');
      const destination = `${parent}${separator}${input.destinationDirectoryName}`;
      const inspected = await execute(FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory, { path: destination });
      if (!inspected.ok) {
        if (inspected.errorCode !== 'ENOENT') return failed(inspected.errorCode);
      } else {
        const location = DaemonFilesystemListDirectoryResponseSchema.parse(inspected.result);
        if (location.ok) return failed(SCM_OPERATION_ERROR_CODES.INVALID_PATH);
        if (location.errorCode !== 'ENOENT') return failed(location.errorCode ?? 'checkout_failed');
      }
      const created = await execute('daemon.filesystem.createDirectory', { rootPath: input.destinationParentPath, path: input.destinationDirectoryName });
      if (!created.ok) return failed(created.errorCode);
      const folder = FilesystemMutationOutputSchema.parse(created.result);
      if (!folder.success) return failed(folder.errorCode ?? 'checkout_failed');
      directory = destination;
      checkoutCreated = true;
      const initialized = await execute('scm.repository.init', { cwd: directory, initialBranch: 'main' });
      if (!initialized.ok) return failed(initialized.errorCode);
      const repository = ScmRepositoryInitResponseSchema.parse(initialized.result);
      if (!repository.success) return failed(repository.errorCode ?? 'checkout_failed', repository.remediation);
    }
    phase = 'publish';
    const published = await execute('scm.hostingRepository.publish', { cwd: directory, providerKind: input.repository.providerKind,
      owner: input.repository.owner, repositoryName: input.repository.name, visibility: input.repository.visibility,
      remoteName: 'origin', remoteUrlKind: 'https', remoteConflictStrategy: 'set-url', pushCurrentBranch: !scratch });
    if (!published.ok) return failed(published.errorCode);
    const publish = ScmHostingRepositoryPublishResponseSchema.parse(published.result);
    if (!publish.success) {
      // SCM includes the created repository when attaching or pushing later fails.
      const repository = ScmHostingRepositorySummarySchema.safeParse(publish.repository);
      if (repository.success) repositoryUrl = repository.data.webUrl;
      return failed(publish.errorCode ?? 'publish_failed', publish.remediation);
    }
    repositoryUrl = publish.repository.webUrl;
    if (!scratch && !publish.pushed) return failed('publish_incomplete');
    const selector = projectSourceRepositorySelectorFromHostingSummaryV1(publish.repository, 'https');
    resume = { directory: directory!, repositoryUrl, repository: selector, ...(resolvedCommit ? { commit: resolvedCommit } : {}) };
  }
  directory = resume.directory;
  repositoryUrl = resume.repositoryUrl;
  const selector = resume.repository;
  const resolvedCommit = resume.commit;
  phase = resume.sourceId ? 'project' : 'source';
  const created = resume.sourceId ? await execute('projects.sources.read', { serverId: input.serverId, sourceId: resume.sourceId })
    : await execute('projects.sources.create', { serverId: input.serverId, requestKey: input.requestKey,
    name: input.repository.name, repository: selector, defaultRef: 'main', audience: [] });
  if (!created.ok) return failed(created.errorCode);
  const source = ProjectSourcesCreateOutputV1Schema.parse(created.result);
  if (!source.ok) return failed(source.error);
  sourceId = source.source.id;
  resume = { ...resume, sourceId };
  phase = 'project';
  // Register the newly published checkout, never the upstream starter's identity.
  const attached = await execute('projects.open', { serverId: input.serverId, machineId: input.machineId,
    source: { kind: 'folder', path: directory }, materialization: { kind: 'attach' } });
  if (!attached.ok) return failed(attached.errorCode);
  const accepted = OpenProjectResultV1Schema.parse(attached.result);
  if (accepted.kind !== 'opened') return failed(accepted.kind === 'refused' ? accepted.code : accepted.kind);
  workspace = accepted.workspace;
  const opened = await execute('projects.open', { serverId: input.serverId, machineId: input.machineId,
    source: { kind: 'source', id: sourceId, revision: source.source.revision, selector, defaultRef: 'main', checkout: workspace },
    materialization: { kind: 'attach' } });
  if (!opened.ok) return failed(opened.errorCode);
  const project = OpenProjectResultV1Schema.parse(opened.result);
  if (project.kind !== 'opened') return failed(project.kind === 'refused' ? project.code : project.kind);
  if (!project.facts?.projectKey) return failed('invalid_action_output');
  return { ok: true, result: { kind: 'created', projectId: project.facts.projectKey, sourceId, repositoryUrl,
    ...(!scratch && starterId ? { starterId } : {}), ...(resolvedCommit ? { commit: resolvedCommit } : {}), workspace: project.workspace,
    sessionHandoff: { machineId: input.machineId, directory: project.directory, initialMessage: input.description },
  } satisfies ProjectStarterCreateOutputV1 };
}
