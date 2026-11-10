import { ScmRepositoryCloneOutputSchema } from '../../../scm/repositoryClone.js';
import { resolveBundledProjectStarterV1 } from '../../../projects/starters/bundledProjectStartersV1.js';
import type { ProjectStarterCreateInputV1, ProjectStarterCreateOutputV1 } from '../../../projects/starters/createV1.js';
import { ScmHostingRepositoryDescribePublishTargetsResponseSchema, ScmHostingRepositoryPublishResponseSchema, ScmHostingRepositorySummarySchema } from '../../../scm/repositoryProvisioning.js';
import { ProjectSourcesCreateOutputV1Schema, projectSourceRepositorySelectorFromHostingSummaryV1 } from '../../../projects/sources/projectSourceV1.js';
import { OpenProjectResultV1Schema } from '../../../projects/openProjectV1.js';
import type { ActionId } from '../../actionIds.js';
import type { ActionExecuteResult } from '../types.js';

/** Finite composition only; each child retains its existing transport and state owner. */
export async function createProjectFromStarter(input: ProjectStarterCreateInputV1, execute: (id: ActionId, input: unknown) => Promise<ActionExecuteResult>): Promise<ActionExecuteResult> {
  const starter = resolveBundledProjectStarterV1(input.starterId);
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
  phase = 'account';
  const described = await execute('scm.hostingRepository.describePublishTargets', { cwd: input.destinationParentPath, providerKind: 'github' });
  if (!described.ok) return described;
  const targets = ScmHostingRepositoryDescribePublishTargetsResponseSchema.parse(described.result);
  if (!targets.success) return failed(targets.errorCode ?? 'scm_account_required', targets.remediation);
  if (targets.auth.state !== 'authenticated') return failed('scm_account_required', targets.auth.remediation);
  phase = 'checkout';
  const cloned = await execute('scm.repository.clone', { ...starter.repository.selector,
    destinationParentPath: input.destinationParentPath, destinationDirectoryName: input.destinationDirectoryName,
    initialCheckout: { branch: 'main', commit: starter.repository.ref }, confirmed: true, authorizationToken: 'clone-repository' });
  if (!cloned.ok) return cloned;
  const clone = ScmRepositoryCloneOutputSchema.parse(cloned.result);
  if (!clone.success) return failed(clone.errorCode ?? 'checkout_failed', clone.remediation);
  checkoutCreated = true;
  directory = clone.destinationPath;
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
    starterId: starter.id, commit: starter.repository.ref, workspace: project.workspace,
    sessionHandoff: { machineId: input.machineId, directory: project.directory, initialMessage: input.description },
  } satisfies ProjectStarterCreateOutputV1 };
}
