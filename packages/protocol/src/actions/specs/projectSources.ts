import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import {
  ProjectSourcesListInputV1Schema, ProjectSourcesListOutputV1Schema,
  ProjectSourcesReadInputV1Schema, ProjectSourcesReadOutputV1Schema,
  ProjectSourcesCreateInputV1Schema, ProjectSourcesCreateOutputV1Schema,
  ProjectSourcesUpdateInputV1Schema, ProjectSourcesUpdateOutputV1Schema,
  ProjectSourcesDeleteInputV1Schema, ProjectSourcesDeleteOutputV1Schema,
} from '../../projects/sources/projectSourceV1.js';

export const PROJECT_SOURCE_ACTION_IDS_V1 = [
  'projects.sources.list', 'projects.sources.read', 'projects.sources.create',
  'projects.sources.update', 'projects.sources.delete',
] as const;

const common = {
  executionPlacement: 'account', placements: [],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
} as const;

export const PROJECT_SOURCE_ACTION_SPECS_V1 = [
  {
    ...common, id: 'projects.sources.list', title: 'List repository sources',
    description: 'Search authorized personal and Team repository metadata on the selected Home. Coverage describes the returned catalog page.',
    safety: 'safe', sideEffectClass: 'read',
    bindings: { mcpToolName: 'projects_sources_list', voiceClientToolName: 'listProjectSources' },
    inputSchema: ProjectSourcesListInputV1Schema, outputSchema: ProjectSourcesListOutputV1Schema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'query', title: 'Search', widget: 'text' }, { path: 'audience', title: 'Audience', widget: 'json' },
      { path: 'cursor', title: 'Page cursor', widget: 'text' }, { path: 'limit', title: 'Page size', widget: 'text' }] },
  },
  {
    ...common, id: 'projects.sources.read', title: 'Read repository source',
    description: 'Read a Source’s current metadata, revision and management rights as the authenticated actor. Source visibility does not grant repository or Machine access.',
    safety: 'safe', sideEffectClass: 'read',
    bindings: { mcpToolName: 'projects_sources_read', voiceClientToolName: 'readProjectSource' },
    inputSchema: ProjectSourcesReadInputV1Schema, outputSchema: ProjectSourcesReadOutputV1Schema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'sourceId', title: 'Source id', widget: 'text', required: true }] },
  },
  {
    ...common, id: 'projects.sources.create', title: 'Save repository source',
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
    ...common, id: 'projects.sources.update', title: 'Update repository source',
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
    ...common, id: 'projects.sources.delete', title: 'Delete repository source',
    description: 'Delete the Source metadata for its audience under the current revision. Checkout files, Artifact bytes and Artifact grants stay.',
    safety: 'danger', sideEffectClass: 'write',
    bindings: { mcpToolName: 'projects_sources_delete', voiceClientToolName: 'deleteProjectSource' },
    inputSchema: ProjectSourcesDeleteInputV1Schema, outputSchema: ProjectSourcesDeleteOutputV1Schema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'sourceId', title: 'Source id', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Current revision', widget: 'text', required: true }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
