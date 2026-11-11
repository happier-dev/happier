import { ScmRepositoryCloneOutputSchema } from '../../../scm/repositoryClone.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '../../../registries/registryActionsV1.js';
import { RegistryItemV1Schema } from '../../../registries/registryItemsV1.js';
import type { ProjectStarterCreateInputV1, ProjectStarterCreateOutputV1 } from '../../../projects/starters/createV1.js';
import { ScmHostingRepositoryDescribePublishTargetsResponseSchema, ScmHostingRepositoryPublishResponseSchema, ScmHostingRepositorySummarySchema } from '../../../scm/repositoryProvisioning.js';
import { ProjectSourcesCreateOutputV1Schema, projectSourceRepositorySelectorFromHostingSummaryV1 } from '../../../projects/sources/projectSourceV1.js';
import { OpenProjectResultV1Schema } from '../../../projects/openProjectV1.js';
import type { ActionId } from '../../actionIds.js';
import type { ActionExecuteResult } from '../types.js';

/** Finite composition only; each child retains its existing transport and state owner. */
export async function createProjectFromStarter(input: ProjectStarterCreateInputV1, execute: (id: ActionId, input: unknown) => Promise<ActionExecuteResult>): Promise<ActionExecuteResult> {
  const listed = await execute('registries.items.list', { kind: 'starter', query: input.starterId });
  if (!listed.ok) return listed;
  const pageResult = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(listed.result);
  const summary = pageResult.pages.flatMap(page => page.items).find(item => item.itemId === input.starterId);
  if (!summary) return { ok: true, result: { kind: 'failed', phase: 'starter', code: 'starter_unavailable' } satisfies ProjectStarterCreateOutputV1 };
  const read = await execute('registries.items.read', { kind: 'starter', sourceId: summary.sourceId, itemId: summary.itemId, ...(summary.version ? { version: summary.version } : {}) });
  if (!read.ok) return read;
  const item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(read.result).item;
  const starter = RegistryItemV1Schema.parse(item).payload.kind === 'starter' ? item.payload.starter : null;
  let phase: Extract<ProjectStarterCreateOutputV1, { kind: 'failed' | 'partial' }>['phase'] = 'starter';
  let checkoutCreated = false;
  let directory: string | undefined;
  let workspace: Extract<ProjectStarterCreateOutputV1, { kind: 'created' }>['workspace'] | undefined;
  let repositoryUrl: string | undefined;
  let sourceId: string | undefined;
  const failed = (code: string, remediation?: Extract<ProjectStarterCreateOutputV1, { kind: 'failed' | 'partial' }>['remediation']): ActionExecuteResult => ({ ok: true, result: {
    kind: checkoutCreated ? 'partial' : 'failed', phase, code,
    ...(directory ? { directory } : {}), ...(repositoryUrl ? { repositoryUrl } : {}), ...(sourceId ? { sourceId } : {}), ...(workspace ? { workspace } : {}), ...(remediation ? { remediation } : {}),
  } satisfies ProjectStarterCreateOutputV1 });
  if (!starter) return failed('starter_unavailable');
  const upstreamUrl = new URL(starter.repository);
  const parts = upstreamUrl.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (upstreamUrl.hostname !== 'github.com' || parts.length < 2) return failed('starter_unavailable');
  const nameWithOwner = parts.slice(0, 2).join('/');
  phase = 'account';
  const described = await execute('scm.hostingRepository.describePublishTargets', { cwd: input.destinationParentPath, providerKind: 'github' });
  if (!described.ok) return described;
  const targets = ScmHostingRepositoryDescribePublishTargetsResponseSchema.parse(described.result);
  if (!targets.success) return failed(targets.errorCode ?? 'scm_account_required', targets.remediation);
  if (targets.auth.state !== 'authenticated') return failed('scm_account_required', targets.auth.remediation);
  phase = 'checkout';
  const cloned = await execute('scm.repository.clone', { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner, cloneUrl: `${upstreamUrl.origin}/${nameWithOwner}.git`, webUrl: `${upstreamUrl.origin}/${nameWithOwner}` }, protocol: 'https',
    destinationParentPath: input.destinationParentPath, destinationDirectoryName: input.destinationDirectoryName,
    confirmed: true, authorizationToken: 'clone-repository' });
  if (!cloned.ok) return cloned;
  const parsedClone = ScmRepositoryCloneOutputSchema.safeParse(cloned.result);
  const clone = parsedClone.success ? parsedClone.data : cloned.result as { success?: unknown; destinationPath?: string; errorCode?: string; remediation?: unknown; snapshot?: { branch?: { headOid?: unknown } } };
  if (!clone.success) return failed(clone.errorCode ?? 'checkout_failed', clone.remediation);
  checkoutCreated = true;
  if (typeof clone.destinationPath !== 'string') return failed('checkout_failed');
  directory = starter.path ? `${clone.destinationPath}/${starter.path}` : clone.destinationPath;
  const resolvedCommit = parsedClone.success ? clone.snapshot?.branch.headOid : (typeof clone.snapshot?.branch?.headOid === 'string' ? clone.snapshot.branch.headOid : undefined);
  if (!resolvedCommit) return failed('checkout_revision_unavailable');
  phase = 'publish';
  const published = await execute('scm.hostingRepository.publish', { cwd: directory, providerKind: 'github',
    owner: input.repository.owner, repositoryName: input.repository.name, visibility: input.repository.visibility,
    remoteName: 'origin', remoteUrlKind: 'https', remoteConflictStrategy: 'set-url', pushCurrentBranch: true });
  if (!published.ok) return failed(published.errorCode);
  const publish = ScmHostingRepositoryPublishResponseSchema.parse(published.result);
  if (!publish.success) {
    // SCM includes the created repository when attaching or pushing later fails.
    const repository = ScmHostingRepositorySummarySchema.safeParse(publish.repository);
    if (repository.success) repositoryUrl = repository.data.webUrl;
    return failed(publish.errorCode ?? 'publish_failed', publish.remediation);
  }
  repositoryUrl = publish.repository.webUrl;
  if (!publish.pushed) return failed('publish_incomplete');
  const selector = projectSourceRepositorySelectorFromHostingSummaryV1(publish.repository, 'https');
  phase = 'source';
  const created = await execute('projects.sources.create', { serverId: input.serverId, requestKey: input.requestKey,
    name: input.repository.name, repository: selector, defaultRef: 'main', audience: [] });
  if (!created.ok) return failed(created.errorCode);
  const source = ProjectSourcesCreateOutputV1Schema.parse(created.result);
  if (!source.ok) return failed(source.error);
  sourceId = source.source.id;
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
    starterId: input.starterId, commit: resolvedCommit, workspace: project.workspace,
    sessionHandoff: { machineId: input.machineId, directory: project.directory, initialMessage: input.description },
  } satisfies ProjectStarterCreateOutputV1 };
}
