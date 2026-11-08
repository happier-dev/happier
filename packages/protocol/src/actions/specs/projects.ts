import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema } from '../../projects/openProjectV1.js';
import { ProjectContextUpdateInputV1Schema, ProjectContextUpdateOutputV1Schema } from '../../projects/projectContextV1.js';
import { ProjectVisibilitySetInputV1Schema, ProjectVisibilitySetOutputV1Schema } from '../../projects/projectVisibilityV1.js';
import { ProjectOrganizationUpdateInputV1Schema, ProjectOrganizationUpdateOutputV1Schema } from '../../projects/projectOrganizationV1.js';
import { ProjectWorkspaceUpdateInputV1Schema, ProjectWorkspaceUpdateOutputV1Schema, ProjectWorkspaceForgetInputV1Schema, ProjectWorkspaceForgetOutputV1Schema } from '../../projects/projectWorkspaceActionsV1.js';
import { z } from 'zod/mini';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import type { PreNormalizedActionSpec } from './definition.js';
import { actionInputServerId } from './definition.js';


export const PathsListRecentInputSchema = lazyZodSchema(() => z.looseObject({
  machineId: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(50))),
}));

/**
 * The persisted project registry read.
 *
 * It narrows by Home, machine, visibility and an explicit count. It does not filter by
 * hosting provider or repository name: matching a repository to a checkout is
 * one decision with one owner, and a filter here would make this a second place
 * that rule lives — silently disagreeing with the caller's own matcher the day
 * either one changes. Registry coverage accompanies the result so callers
 * cannot infer uniqueness from a partial answer.
 */
export const ProjectsListInputSchema = lazyZodSchema(() => z.strictObject({
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  machineId: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  includeHidden: z.optional(z.boolean()),
  /** Also list folders only a Session brought, not yet added by the person ("From your sessions"). */
  includeUnlisted: z.optional(z.boolean()),
}));

function createProjectContextActionSpecs() {
  return Object.freeze([
  {
    id: 'paths.list_recent', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'List recent paths',
    sideEffectClass: 'read',
    description: 'List recent workspace directory handles (optionally filtered to a machine).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listRecentPaths', mcpToolName: 'paths_list_recent' },
    examples: {
      voice: { argsExample: '{"limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List recent paths',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PathsListRecentInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'projects.context.update', approval: {result: 'required'},
    title: 'Update Project context',
    description: 'Attach, detach, reorder or adjust one personal Project context entry at the reviewed organization row revision.',
    sideEffectClass: 'write',
    safety: 'safe',
    executionPlacement: 'account',
    placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'projects_context_update' },
    cli: { commands: [{ path: ['projects', 'context', 'update'], visibility: 'canonical' }] },
    // Project owners and the catalog share an import cycle.
    // Publish deferred carriers, not values captured during that import cycle.
    inputSchema: lazyZodSchema(() => ProjectContextUpdateInputV1Schema),
    invocationServerIdForInput: actionInputServerId(lazyZodSchema(() => ProjectContextUpdateInputV1Schema), input => input.target.serverId),
    outputSchema: lazyZodSchema(() => ProjectContextUpdateOutputV1Schema),
    inputHints: { fields: [
      { path: 'target', title: 'Qualified Project', prompt: 'Which project?', widget: 'json', required: true },
      { path: 'expectedRevision', title: 'Reviewed organization revision', widget: 'json', required: true },
      { path: 'intent', title: 'Personal context edit', widget: 'json', required: true },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'projects.organization.update', approval: {result: 'required'}, title: 'Update Project organization',
    description: 'Set or reset the private Project label or one Saved Secret reference binding at the reviewed organization row revision. A null label restores its baseline title; a null binding reference removes that name. Secret values are never accepted, and other organization fields are preserved.',
    sideEffectClass: 'write', safety: 'safe', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'projects_organization_update', voiceClientToolName: 'projects_organization_update' },
    cli: { commands: [{ path: ['projects', 'organization', 'update'], visibility: 'canonical' }] },
    inputSchema: lazyZodSchema(() => ProjectOrganizationUpdateInputV1Schema),
    outputSchema: lazyZodSchema(() => ProjectOrganizationUpdateOutputV1Schema),
    inputHints: { fields: [
      { path: 'projectRef', title: 'Qualified Project', prompt: 'Which project?', widget: 'json', required: true },
      { path: 'expectedRevision', title: 'Reviewed organization revision', widget: 'json', required: true },
      { path: 'label', title: 'Project label (null to reset)', widget: 'text' },
      { path: 'environmentBinding', title: 'Environment binding name and Saved Secret reference (null to remove)', widget: 'json' },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'projects.visibility.set', approval: {result: 'required'}, title: 'Hide or show a Project',
    description: 'Change visibility for one Home-qualified private Project at the observed organization row revision. Sessions and files remain unchanged.',
    sideEffectClass: 'write', safety: 'safe', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'projects_visibility_set', voiceClientToolName: 'projects_visibility_set' },
    cli: { commands: [{ path: ['projects', 'visibility', 'set'], visibility: 'canonical' }] },
    inputSchema: lazyZodSchema(() => ProjectVisibilitySetInputV1Schema),
    outputSchema: lazyZodSchema(() => ProjectVisibilitySetOutputV1Schema),
    inputHints: { fields: [
      { path: 'target', title: 'Qualified Project', prompt: 'Which project?', widget: 'json', required: true },
      { path: 'expectedRevision', title: 'Reviewed organization revision', widget: 'json', required: true },
      { path: 'hidden', title: 'Hidden', widget: 'boolean', required: true },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'projects.workspace.update', approval: {result: 'required'}, title: 'Update workspace label, pin or Project',
    description: 'Update the label, personal pin, or Project grouping of an accepted Home-qualified workspace. projectKey groups it with that Project; "self" separates it into its own Project. Checkout roots, files and Sessions remain unchanged.',
    sideEffectClass: 'write', safety: 'safe', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'projects_workspace_update', voiceClientToolName: 'projects_workspace_update' },
    cli: { acceptsServerId: true, requiresServerId: true, commands: [{ path: ['projects', 'workspace', 'update'], visibility: 'canonical' }] },
    inputSchema: ProjectWorkspaceUpdateInputV1Schema, outputSchema: ProjectWorkspaceUpdateOutputV1Schema,
    inputHints: { fields: [
      { path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'workspaceId', title: 'Workspace id', prompt: 'Which workspace?', widget: 'text', required: true },
      { path: 'label', title: 'Label', widget: 'text' },
      { path: 'pinned', title: 'Pinned', widget: 'boolean' },
      { path: 'projectKey', title: 'Group with Project (key), or "self" to separate', widget: 'text' },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'projects.workspace.forget', approval: {result: 'required'}, title: 'Forget a workspace',
    irreversible: true,
    description: 'Forget one accepted Home-qualified private workspace after approval. Linked workspaces are protected; no files, Sessions or Sources are deleted.',
    sideEffectClass: 'danger', safety: 'danger', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'projects_workspace_forget', voiceClientToolName: 'projects_workspace_forget' },
    cli: { acceptsServerId: true, requiresServerId: true, commands: [{ path: ['projects', 'workspace', 'forget'], visibility: 'canonical' }] },
    inputSchema: ProjectWorkspaceForgetInputV1Schema, outputSchema: ProjectWorkspaceForgetOutputV1Schema,
    inputHints: { fields: [
      { path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'workspaceId', title: 'Workspace id', prompt: 'Which workspace?', widget: 'text', required: true },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'projects.list', approval: {result: 'required'},
    bindings: { mcpToolName: 'projects_list', voiceClientToolName: 'projects_list' },
    title: 'List projects',
    sideEffectClass: 'read',
    description:
      'List the projects the person added, with each one\'s resolved hosting provider and worktrees. Folders only a Session brought are listed with includeUnlisted (listed: false); add one with projects.visibility.set hidden:false.',
    safety: 'safe',
    executionPlacement: 'account',
    placements: [],
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List projects',
      fields: [
        { path: 'serverId', title: 'Home id', widget: 'text' },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'includeHidden', title: 'Include hidden projects', widget: 'boolean' },
        { path: 'includeUnlisted', title: 'Include folders from your sessions', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ProjectsListInputSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['projects', 'list'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'projects.open', approval: {result: 'required'},
    originalExecution: { daemonIngressSurfaces: ['ui'] },
    operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'current' } },
    title: 'Open a project',
    description: 'Prepare the selected checkout on the exact Machine and return its browse address without starting an Agent. Setup requires separate approval; client focus is optional and requires a mounted client.',
    safety: 'danger',
    sideEffectClass: 'danger',
    executionPlacement: 'machine',
    placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'projects_open', voiceClientToolName: 'projects_open' },
    cli: { commands: [{ path: ['projects', 'open'], visibility: 'canonical' }], acceptsServerId: true, requiresServerId: true },
    inputSchema: OpenProjectInputV1Schema,
    outputSchema: OpenProjectResultV1Schema,
    inputHints: {
      title: 'Open a project',
      fields: [
        { path: 'serverId', title: 'Home id', widget: 'text', required: true },
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'source', title: 'Source', widget: 'json', required: true },
        { path: 'ref', title: 'Branch or ref', widget: 'text' },
        { path: 'subdir', title: 'Project subdirectory', widget: 'text' },
        { path: 'materialization', title: 'Checkout choice', widget: 'json', required: true },
      ],
    },
    examples: { voice: { argsExample: '{"serverId":"{{serverId}}","machineId":"{{machineId}}","source":{"kind":"folder","path":"/workspace/project"},"materialization":{"kind":"attach"}}' } },
  } satisfies PreNormalizedActionSpec,
] as const);
}

export const PROJECT_CONTEXT_ACTION_SPECS: ReturnType<typeof createProjectContextActionSpecs> = lazyActionSpecArray(createProjectContextActionSpecs);

