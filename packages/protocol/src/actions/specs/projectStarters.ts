import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { PROJECT_STARTER_CREATE_ACTION_ID_V1 } from './projectStartersActionIdsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { actionInputServerId } from './definition.js';
import { ProjectStarterCreateInputV1Schema, ProjectStarterCreateOutputV1Schema } from '../../projects/starters/createV1.js';

export const PROJECT_STARTER_ACTION_SPECS_V1 = lazyActionSpecArray(() => [{
  id: PROJECT_STARTER_CREATE_ACTION_ID_V1, executionPlacement: 'account', originalExecution: { accountRoot: 'allowed', terminalRoot: 'host' },
  approval: { result: 'optional', flow: 'deferred' }, approvalPolicy: { uiConfirmation: 'direct' },
  title: 'Create a Project from a starter',
  description: 'Create main at the curated starter commit, publish a new hosted repository, save its Source and open the Project. Return the description for a new Session.',
  safety: 'danger', sideEffectClass: 'external', workspaceWrite: true, placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
  bindings: { mcpToolName: 'projects_starters_create' },
  inputSchema: ProjectStarterCreateInputV1Schema, outputSchema: ProjectStarterCreateOutputV1Schema,
  invocationServerIdForInput: actionInputServerId(ProjectStarterCreateInputV1Schema, input => input.serverId),
  inputHints: { fields: [
    { path: 'starterId', title: 'Starter', widget: 'text', required: true },
    { path: 'description', title: 'What should the agent build?', widget: 'textarea', required: true },
    { path: 'serverId', title: 'Home', widget: 'text', required: true },
    { path: 'machineId', title: 'Machine', widget: 'text', required: true },
    { path: 'requestKey', title: 'Create intent', widget: 'text', required: true },
    { path: 'destinationParentPath', title: 'Parent folder', widget: 'text', required: true },
    { path: 'destinationDirectoryName', title: 'Folder name', widget: 'text', required: true },
    { path: 'repository', title: 'New repository', widget: 'json', required: true },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[]);
