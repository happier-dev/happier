export { PROJECT_SOURCE_ACTION_IDS_V1 } from './projectSourcesActionIdsV1.js';
import type { ActionSpecProjectionMetadata, PreNormalizedActionSpec } from '../actionSpecs.js';
import {
  ProjectSourcesListInputV1Schema, ProjectSourcesListOutputV1Schema,
  ProjectSourcesReadInputV1Schema, ProjectSourcesReadOutputV1Schema,
  ProjectSourcesCreateInputV1Schema, ProjectSourcesCreateOutputV1Schema,
  ProjectSourcesUpdateInputV1Schema, ProjectSourcesUpdateOutputV1Schema,
  ProjectSourcesDeleteInputV1Schema, ProjectSourcesDeleteOutputV1Schema,
  ProjectSourcesMoveToTeamInputV1Schema, ProjectSourcesMoveToTeamOutputV1Schema,
} from '../../projects/sources/projectSourceV1.js';
import { ProjectDeploymentDefaultsSetInputV1Schema, ProjectDeploymentDefaultsOutputV1Schema } from '../../projects/projectDeploymentDefaultsV1.js';

const common = {
  executionPlacement: 'account', placements: [],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
} as const;

type ProjectSourceActionSchemas = {
  'projects.sources.list': { inputSchema: typeof ProjectSourcesListInputV1Schema; outputSchema: typeof ProjectSourcesListOutputV1Schema };
  'projects.sources.read': { inputSchema: typeof ProjectSourcesReadInputV1Schema; outputSchema: typeof ProjectSourcesReadOutputV1Schema };
  'projects.sources.create': { inputSchema: typeof ProjectSourcesCreateInputV1Schema; outputSchema: typeof ProjectSourcesCreateOutputV1Schema };
  'projects.sources.update': { inputSchema: typeof ProjectSourcesUpdateInputV1Schema; outputSchema: typeof ProjectSourcesUpdateOutputV1Schema };
  'projects.sources.delete': { inputSchema: typeof ProjectSourcesDeleteInputV1Schema; outputSchema: typeof ProjectSourcesDeleteOutputV1Schema };
  'projects.sources.moveToTeam': { inputSchema: typeof ProjectSourcesMoveToTeamInputV1Schema; outputSchema: typeof ProjectSourcesMoveToTeamOutputV1Schema };
  'projects.deploymentDefaults.set': { inputSchema: typeof ProjectDeploymentDefaultsSetInputV1Schema; outputSchema: typeof ProjectDeploymentDefaultsOutputV1Schema };
};
type ProjectSourceActionSpec = {
  [Id in keyof ProjectSourceActionSchemas]: ActionSpecProjectionMetadata & Omit<typeof common, 'executionPlacement' | 'surfaces'> & Readonly<ProjectSourceActionSchemas[Id]> & Readonly<{
    id: Id;
    requiredAuthority?: PreNormalizedActionSpec['requiredAuthority'];
    originalExecution?: PreNormalizedActionSpec['originalExecution'];
    surfaces: PreNormalizedActionSpec['surfaces'];
    executionPlacement: Id extends 'projects.sources.moveToTeam' ? 'client' : 'account';
    approval: { result: 'required' };
  }>;
}[keyof ProjectSourceActionSchemas];
export const PROJECT_SOURCE_ACTION_SPECS_V1: readonly ProjectSourceActionSpec[] = [
  {
    ...common, id: 'projects.deploymentDefaults.set', approval: { result: 'required' },
    title: 'Set Project deployment defaults',
    description: 'Save or clear one shared Project defaults leaf under Source and content revisions. Existing Environments keep their configured values.',
    safety: 'danger', sideEffectClass: 'write', approvalPolicy: { uiConfirmation: 'direct' },
    requiredAuthority: 'account_automation',
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'projects_deployment_defaults_set' },
    cli: { acceptsServerId: true, commands: [{ path: ['projects', 'deployment-defaults', 'set'], visibility: 'canonical' }] },
    serverTransport: { method: 'PUT', path: '/v1/projects/:projectSourceId/deployment-defaults', preservePathFieldsInBody: true },
    inputSchema: ProjectDeploymentDefaultsSetInputV1Schema, outputSchema: ProjectDeploymentDefaultsOutputV1Schema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'projectSourceId', title: 'Project source', widget: 'text', required: true },
      { path: 'expectedSourceRevision', title: 'Source revision', widget: 'number', required: true },
      { path: 'expectedRevision', title: 'Defaults revision', widget: 'number', required: true },
      { path: 'content', title: 'Prepared defaults content or null to clear', widget: 'json', required: true }] },
  },
  {
    ...common, id: 'projects.sources.moveToTeam', executionPlacement: 'client', approval: { result: 'required' },
    title: 'Move Source to Team',
    description: 'Move a personal Source through one signed-in client review covering Machine access, used secrets, bindings, Source ownership, CI tokens, trigger approvals and previews. Unknown or partial steps must settle before personal access is withdrawn.',
    safety: 'danger', sideEffectClass: 'write', permissionChanging: true,
    bindings: { mcpToolName: 'projects_sources_move_to_team', voiceClientToolName: 'moveProjectSourceToTeam' },
    cli: { acceptsServerId: true, commands: [{ path: ['projects', 'sources', 'move-to-team'], visibility: 'canonical' }] },
    inputSchema: ProjectSourcesMoveToTeamInputV1Schema, outputSchema: ProjectSourcesMoveToTeamOutputV1Schema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'sourceId', title: 'Source id', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Current revision', widget: 'number', required: true },
      { path: 'teamId', title: 'Team id', widget: 'text', required: true },
      { path: 'requestKey', title: 'Move intent key', widget: 'text', required: true }] },
    examples: { voice: { argsExample: '{"serverId":"home","sourceId":"source","expectedRevision":1,"teamId":"team","requestKey":"move-1"}' } },
  },
  {
    ...common, id: 'projects.sources.list', approval: {result: 'required'}, title: 'List repository sources',
    description: 'Search authorized personal and Team repository metadata on the selected Home. Coverage describes the returned catalog page.',
    safety: 'safe', sideEffectClass: 'read',
    bindings: { mcpToolName: 'projects_sources_list', voiceClientToolName: 'listProjectSources' },
    inputSchema: ProjectSourcesListInputV1Schema, outputSchema: ProjectSourcesListOutputV1Schema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'query', title: 'Search', widget: 'text' }, { path: 'audience', title: 'Audience', widget: 'json' },
      { path: 'cursor', title: 'Page cursor', widget: 'text' }, { path: 'limit', title: 'Page size', widget: 'text' }] },
  },
  {
    ...common, id: 'projects.sources.read', approval: {result: 'required'}, title: 'Read repository source',
    description: 'Read a Source’s current metadata, revision and management rights as the authenticated actor. Source visibility does not grant repository or Machine access.',
    safety: 'safe', sideEffectClass: 'read',
    bindings: { mcpToolName: 'projects_sources_read', voiceClientToolName: 'readProjectSource' },
    inputSchema: ProjectSourcesReadInputV1Schema, outputSchema: ProjectSourcesReadOutputV1Schema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'sourceId', title: 'Source id', widget: 'text', required: true }] },
  },
  {
    ...common, id: 'projects.sources.create', approval: {result: 'required'}, title: 'Save repository source',
    description: 'Save credential-free repository metadata for its selected audience. Code, setup commands and credentials remain separate.',
    safety: 'danger', sideEffectClass: 'write',
    bindings: { mcpToolName: 'projects_sources_create', voiceClientToolName: 'createProjectSource' },
    inputSchema: ProjectSourcesCreateInputV1Schema, outputSchema: ProjectSourcesCreateOutputV1Schema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'requestKey', title: 'Create intent key', widget: 'text', required: true },
      { path: 'name', title: 'Name', widget: 'text', required: true },
      { path: 'repository', title: 'Repository selector', widget: 'json', required: true },
      { path: 'defaultRef', title: 'Default revision', widget: 'text' }, { path: 'subdir', title: 'Contained folder', widget: 'text' },
      { path: 'audience', title: 'Audience', widget: 'json' }] },
  },
  {
    ...common, id: 'projects.sources.update', approval: {result: 'required'}, title: 'Update repository source',
    description: 'Edit Source metadata or one exact context/dashboard attachment under the current Source revision. Artifact content and grants are independent.',
    safety: 'danger', sideEffectClass: 'write',
    bindings: { mcpToolName: 'projects_sources_update', voiceClientToolName: 'updateProjectSource' },
    inputSchema: ProjectSourcesUpdateInputV1Schema, outputSchema: ProjectSourcesUpdateOutputV1Schema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'sourceId', title: 'Source id', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Current revision', widget: 'text', required: true },
      { path: 'patch', title: 'Metadata or attachment intent', widget: 'json', required: true }] },
  },
  {
    ...common, id: 'projects.sources.delete', approval: {result: 'required'}, title: 'Delete repository source',
    irreversible: true,
    description: 'Delete the Source metadata for its audience under the current revision. Checkout files, Artifact bytes and Artifact grants stay.',
    safety: 'danger', sideEffectClass: 'write',
    bindings: { mcpToolName: 'projects_sources_delete', voiceClientToolName: 'deleteProjectSource' },
    inputSchema: ProjectSourcesDeleteInputV1Schema, outputSchema: ProjectSourcesDeleteOutputV1Schema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'sourceId', title: 'Source id', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Current revision', widget: 'text', required: true }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
