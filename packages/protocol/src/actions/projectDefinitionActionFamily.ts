import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PROJECT_DEFINITION_ACTION_IDS } from './projectDefinitionActionIdsV1.js';
export { PROJECT_DEFINITION_ACTION_IDS } from './projectDefinitionActionIdsV1.js';
import { z } from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { ProjectDefinitionDetectionV1Schema, ProjectDefinitionImportCandidateV1Schema, ProjectExecutionInputV1Schema, ProjectNativeInvocationPreviewV1Schema, ProjectNativeRefV1Schema, ProjectToolInspectionV1Schema } from '../workspaces/projectSetup/projectManifestV1.js';
import { ProjectManifestFileBasisV1Schema, ProjectManifestFileSnapshotSchema, ProjectManifestUpdateResultSchema } from '../workspaces/projectSetup/projectManifestDocument.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { WorkspaceAddressV1Schema } from '../workspaces/workspaceRefV1.js';
import { ProjectSetupReviewV1Schema } from './projectSetupConsentFailure.js';


export type ProjectDefinitionActionId = typeof PROJECT_DEFINITION_ACTION_IDS[number];

// These public Action roots retain Classic composition/JSON Schema projection;
// nested domain schemas remain the single Mini validation owners.
export const ProjectDefinitionWorkspaceSchema = WorkspaceAddressV1Schema;
export type ProjectDefinitionWorkspace = z.infer<typeof ProjectDefinitionWorkspaceSchema>;
export const ProjectDefinitionInspectInputSchema = lazyZodSchema(() => z.strictObject({ workspace: ProjectDefinitionWorkspaceSchema,
  /** Passive consent check for compound operations before disruptive effects. */
  reviewSetupConsent: z.optional(z.literal(true)),
}));
export const ProjectManifestUpdateInputSchema = lazyZodSchema(() => z.strictObject({
  workspace: ProjectDefinitionWorkspaceSchema, expectedBasis: ProjectManifestFileBasisV1Schema, bytes: z.string(),
}));
/** Current reviewed target facts; retained operation completion is never a readiness input. */
export const ProjectSetupReadinessV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('current'), reviewedEffectDigest: z.string().check(z.minLength(1)), completedAtMs: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ kind: z.literal('unprepared'), reviewedEffectDigest: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('notRequired'), reviewedEffectDigest: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('needsReview'), code: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('unknown'), code: z.string().check(z.minLength(1)) }),
]));
export type ProjectSetupReadinessV1 = z.infer<typeof ProjectSetupReadinessV1Schema>;
export const ProjectDefinitionInspectOutputSchema = lazyZodSchema(() => z.strictObject({
  definition: ProjectManifestFileSnapshotSchema, detection: ProjectDefinitionDetectionV1Schema,
  importCandidates: z.array(ProjectDefinitionImportCandidateV1Schema),
  commands: z.optional(z.array(z.strictObject({
    name: z.string().check(z.minLength(1)), usage: z.enum(['script', 'service', 'setup']), source: ProjectNativeRefV1Schema,
    availability: z.enum(['available', 'unavailable', 'unresolved', 'ambiguous']), code: z.optional(z.string()),
    invocation: z.optional(ProjectNativeInvocationPreviewV1Schema),
    executionInputs: z.optional(z.array(ProjectExecutionInputV1Schema)),
  }))),
  environmentExecutionInputs: z.optional(z.array(ProjectExecutionInputV1Schema)),
  tools: z.optional(z.array(ProjectToolInspectionV1Schema)),
  setupReadiness: z.optional(ProjectSetupReadinessV1Schema),
  setupReview: z.optional(ProjectSetupReviewV1Schema),
  /** Passive decision from the same setup admission owner used by execution. */
  setupConsent: z.optional(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('admitted') }),
    z.strictObject({ kind: z.literal('required'), code: z.enum(['project_setup_consent_required', 'project_setup_effect_changed']) }),
    z.strictObject({ kind: z.literal('unavailable'), code: z.string().check(z.minLength(1)) }),
  ])),
}));
export type ProjectDefinitionInspectOutput = z.infer<typeof ProjectDefinitionInspectOutputSchema>;
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
    id: 'projects.inspect', approval: {result: 'required'}, title: 'Inspect project definitions', description: 'Read current project declarations and detect native references without evaluating project code. Setup readiness uses the same requester-bound review as Scripts; unknown includes the actual unavailable or failed-read reason and never proves setup is unnecessary. Reading readiness does not approve or run setup. To inspect this checkout from an ongoing Session, first call session.status.get with {"sessionId":"self","includeAcceptedWorkspace":true}; pass its result.acceptedWorkspace.checkout unchanged as workspace. If that proof is absent, report the checkout identity unavailable; do not guess identifiers from a folder name or path. Then read projects.worker.preferences.get with the checkout serverId and workspaceId as refId. A script is worker-portable only when its declaration permits it; absent execution permission and detected native commands remain primary-only. An unavailable or invalid definition is not an empty script list. Use these current reads rather than an earlier authoring prompt.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'projects_inspect', rpcMethod: 'daemon.projects.inspect.v1' },
    cli: { acceptsServerId: true, commands: [{ path: ['project', 'inspect'], visibility: 'canonical' }] },
    inputSchema: ProjectDefinitionInspectInputSchema, outputSchema: ProjectDefinitionInspectOutputSchema,
    inputHints: { fields: [{ path: 'workspace', title: 'Qualified checkout', prompt: 'Which workspace?', widget: 'json', required: true }] },
  },
  {
    id: 'projects.manifest.update', approvalPolicy: { uiConfirmation: 'policy' }, approval: {result: 'required'}, title: 'Update project file', description: 'Save reviewed project file bytes against the expected absence or content hash. Form, raw and imports share this writer.',
    safety: 'danger', sideEffectClass: 'write', executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'projects_manifest_update', rpcMethod: 'daemon.projects.manifest.update.v1' },
    cli: { acceptsServerId: true, commands: [{ path: ['project', 'manifest', 'update'], visibility: 'canonical' }] },
    inputSchema: ProjectManifestUpdateInputSchema, outputSchema: ProjectManifestUpdateOutputSchema,
    inputHints: { fields: [
      { path: 'workspace', title: 'Qualified checkout', prompt: 'Which workspace?', widget: 'json', required: true },
      { path: 'expectedBasis', title: 'Reviewed file basis', widget: 'json', required: true },
      { path: 'bytes', title: 'Project file contents', widget: 'textarea', required: true },
    ] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];

export function isProjectDefinitionActionId(value: string): value is ProjectDefinitionActionId {
  return (PROJECT_DEFINITION_ACTION_IDS as readonly string[]).includes(value);
}

export const ProjectDefinitionInspectOutputProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(ProjectDefinitionInspectOutputSchema));
