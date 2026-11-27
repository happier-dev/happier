import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { PROJECT_STARTER_CREATE_ACTION_ID_V1, PROJECT_STARTER_CHILD_ACTION_IDS_V1 as CHILD } from './projectStartersActionIdsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { actionInputServerId } from './definition.js';
import { ProjectStarterCreateInputV1Schema, ProjectStarterCreateOutputV1Schema, projectStarterDestinationPathV1 } from '../../projects/starters/createV1.js';
import type { HostReviewedChildrenPlanV1 } from '../executor/types.js';

function describeStarterChildren(input: unknown): HostReviewedChildrenPlanV1['children'] {
  const { serverId, machineId, requestKey, starterId, starterSourceId, source, resume, destinationParentPath, destinationDirectoryName, repository } =
    ProjectStarterCreateInputV1Schema.parse(input);
  const scratch = source?.kind === 'scratch';
  const children: HostReviewedChildrenPlanV1['children'][number][] = [];
  if (!resume) {
    if (scratch) {
      const destination = projectStarterDestinationPathV1(destinationParentPath, destinationDirectoryName);
      children.push(
        { action: CHILD.browseDirectory, role: CHILD.browseDirectory, scopeInput: { path: destination } },
        { action: CHILD.createDirectory, role: CHILD.createDirectory, scopeInput: { rootPath: destinationParentPath, path: destinationDirectoryName } },
        { action: CHILD.init, role: CHILD.init, scopeInput: { cwd: destination, initialBranch: 'main' } },
      );
    } else {
      const itemId = source?.kind === 'starter' ? source.starterId : starterId!;
      const sourceId = source?.kind === 'starter' ? source.sourceId : starterSourceId;
      children.push(
        { action: CHILD.listStarters, role: CHILD.listStarters, scopeInput: { kind: 'starter', query: itemId, ...(sourceId ? { sourceIds: [sourceId] } : {}) } },
        { action: CHILD.readStarter, role: CHILD.readStarter, scopeInput: { kind: 'starter', itemId, ...(sourceId ? { sourceId } : {}) } },
        { action: CHILD.resolveAddress, role: CHILD.resolveAddress },
        { action: CHILD.clone, role: CHILD.clone, scopeInput: { destinationParentPath, destinationDirectoryName } },
      );
    }
    children.push({ action: CHILD.describePublishTargets, role: CHILD.describePublishTargets, scopeInput: { cwd: destinationParentPath,
      providerKind: repository.providerKind, ...(repository.providerId ? { providerId: repository.providerId } : {}) } });
    children.push({ action: CHILD.publish, role: CHILD.publish, scopeInput: { providerKind: repository.providerKind,
      ...(repository.providerId ? { providerId: repository.providerId } : {}),
      ...(repository.providerBaseUrl ? { providerBaseUrl: repository.providerBaseUrl } : {}),
      owner: repository.owner, repositoryName: repository.name, visibility: repository.visibility, pushCurrentBranch: !scratch } });
  }
  if (resume?.sourceId) children.push({ action: CHILD.readSource, role: CHILD.readSource, scopeInput: { serverId, sourceId: resume.sourceId } });
  else children.push({ action: CHILD.saveSource, role: CHILD.saveSource,
    scopeInput: { serverId, requestKey, name: repository.name, defaultRef: 'main', audience: [] } });
  children.push({ action: CHILD.openProject, role: CHILD.openProject, scopeInput: { serverId, machineId, materialization: { kind: 'attach' } } });
  return children;
}

export const PROJECT_STARTER_ACTION_SPECS_V1 = lazyActionSpecArray(() => [{
  id: PROJECT_STARTER_CREATE_ACTION_ID_V1, executionPlacement: 'account', originalExecution: { accountRoot: 'allowed', terminalRoot: 'host' },
  approval: { result: 'optional', flow: 'deferred' }, approvalPolicy: { uiConfirmation: 'direct' },
  hostReviewedChildren: describeStarterChildren,
  title: 'Create a Project from a starter or scratch',
  description: 'Create an empty repository or resolve the current starter release or default branch, publish on the selected forge, save its Source and open the Project. Return the description for a new Session.',
  safety: 'danger', sideEffectClass: 'external', workspaceWrite: true, placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: 'projects_starters_create' },
  inputSchema: ProjectStarterCreateInputV1Schema, outputSchema: ProjectStarterCreateOutputV1Schema,
  invocationServerIdForInput: actionInputServerId(ProjectStarterCreateInputV1Schema, input => input.serverId),
  inputHints: { fields: [
    { path: 'source', title: 'Starter or scratch source', widget: 'json', required: false },
    { path: 'starterId', title: 'Starter', widget: 'text', required: false },
    { path: 'description', title: 'What should the agent build?', widget: 'textarea', required: true },
    { path: 'serverId', title: 'Home', widget: 'text', required: true },
    { path: 'machineId', title: 'Machine', widget: 'text', required: true },
    { path: 'requestKey', title: 'Create intent', widget: 'text', required: true },
    { path: 'destinationParentPath', title: 'Parent folder', widget: 'text', required: true },
    { path: 'destinationDirectoryName', title: 'Folder name', widget: 'text', required: true },
    { path: 'repository', title: 'New repository', widget: 'json', required: true },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[]);
