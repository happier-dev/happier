import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProjectDefinitionDetectionV1Schema, ProjectDefinitionImportCandidateV1Schema, ProjectNativeInvocationPreviewV1Schema, ProjectNativeRefV1Schema, ProjectToolInspectionV1Schema } from '../workspaces/projectSetup/projectManifestV1.js';
import { ProjectManifestFileBasisV1Schema, ProjectManifestFileSnapshotSchema, ProjectManifestUpdateResultSchema } from '../workspaces/projectSetup/projectManifestDocument.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { WorkspaceAddressV1Schema } from '../workspaces/workspaceRefV1.js';

export const PROJECT_DEFINITION_ACTION_IDS = ['projects.inspect', 'projects.manifest.update'] as const;
export type ProjectDefinitionActionId = typeof PROJECT_DEFINITION_ACTION_IDS[number];

// These public Action roots retain Classic composition/JSON Schema projection;
// nested domain schemas remain the single Mini validation owners.
export const ProjectDefinitionWorkspaceSchema = WorkspaceAddressV1Schema;
export type ProjectDefinitionWorkspace = z.infer<typeof ProjectDefinitionWorkspaceSchema>;
export const ProjectDefinitionInspectInputSchema = lazyZodSchema(() => z.object({ workspace: ProjectDefinitionWorkspaceSchema }).strict());
export const ProjectManifestUpdateInputSchema = lazyZodSchema(() => z.object({
  workspace: ProjectDefinitionWorkspaceSchema, expectedBasis: ProjectManifestFileBasisV1Schema, bytes: z.string(),
}).strict());
export const ProjectDefinitionInspectOutputSchema = lazyZodSchema(() => z.object({
  definition: ProjectManifestFileSnapshotSchema, detection: ProjectDefinitionDetectionV1Schema,
  importCandidates: z.array(ProjectDefinitionImportCandidateV1Schema),
  commands: z.array(z.object({
    name: z.string().min(1), usage: z.enum(['script', 'service', 'setup']), source: ProjectNativeRefV1Schema,
    availability: z.enum(['available', 'unavailable', 'unresolved', 'ambiguous']), code: z.string().optional(),
    invocation: z.optional(ProjectNativeInvocationPreviewV1Schema),
  }).strict()).optional(),
  tools: z.array(ProjectToolInspectionV1Schema).optional(),
}).strict());
export const ProjectManifestUpdateOutputSchema = lazyZodSchema(() => z.lazy(() => ProjectManifestUpdateResultSchema));
export const PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS = {
  'projects.inspect': ProjectDefinitionInspectInputSchema,
  'projects.manifest.update': ProjectManifestUpdateInputSchema,
} as const;
export const PROJECT_DEFINITION_ACTION_OUTPUT_SCHEMAS = {
  'projects.inspect': ProjectDefinitionInspectOutputSchema,
  'projects.manifest.update': ProjectManifestUpdateOutputSchema,
} as const;

export const PROJECT_DEFINITION_ACTION_SPECS = [
  {
    id: 'projects.inspect', title: 'Inspect project definitions', description: 'Read the project file and detect native references without evaluating project code.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'projects_inspect', rpcMethod: 'daemon.projects.inspect.v1' },
    cli: { acceptsServerId: true, commands: [{ path: ['project', 'inspect'], visibility: 'canonical' }] },
    inputSchema: ProjectDefinitionInspectInputSchema, outputSchema: ProjectDefinitionInspectOutputSchema,
    inputHints: { fields: [{ path: 'workspace', title: 'Qualified checkout', widget: 'json', required: true }] },
  },
  {
    id: 'projects.manifest.update', title: 'Update project file', description: 'Save reviewed project file bytes against the expected absence or content hash. Form, raw and imports share this writer.',
    safety: 'danger', sideEffectClass: 'write', executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'projects_manifest_update', rpcMethod: 'daemon.projects.manifest.update.v1' },
    cli: { acceptsServerId: true, commands: [{ path: ['project', 'manifest', 'update'], visibility: 'canonical' }] },
    inputSchema: ProjectManifestUpdateInputSchema, outputSchema: ProjectManifestUpdateOutputSchema,
    inputHints: { fields: [
      { path: 'workspace', title: 'Qualified checkout', widget: 'json', required: true },
      { path: 'expectedBasis', title: 'Reviewed file basis', widget: 'json', required: true },
      { path: 'bytes', title: 'Project file contents', widget: 'textarea', required: true },
    ] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];

export function isProjectDefinitionActionId(value: string): value is ProjectDefinitionActionId {
  return (PROJECT_DEFINITION_ACTION_IDS as readonly string[]).includes(value);
}
