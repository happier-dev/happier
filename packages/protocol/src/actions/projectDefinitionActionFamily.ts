import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import { PROJECT_DEFINITION_ACTION_IDS, PROJECT_DEFINITION_ACTION_RPC_METHODS_V1 } from './projectDefinitionActionIdsV1.js';
export { PROJECT_DEFINITION_ACTION_IDS, PROJECT_DEFINITION_INSPECT_ACTION_ID } from './projectDefinitionActionIdsV1.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { ProjectDefinitionDetectionV1Schema, ProjectDefinitionImportCandidateV1Schema, ProjectExecutionInputV1Schema, ProjectNativeInvocationPreviewV1Schema, ProjectNativeRefV1Schema, ProjectToolInspectionV1Schema } from '../workspaces/projectSetup/projectManifestV1.js';
import { ProjectManifestDiagnosticSchema, ProjectManifestFileBasisV1Schema, ProjectManifestUpdateResultSchema } from '../workspaces/projectSetup/projectManifestDocument.js';
import { ProjectManifestV1Schema } from '../workspaces/projectSetup/projectManifestV1.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { WorkspaceAddressV1Schema } from '../workspaces/workspaceRefV1.js';
import { ProjectSetupReviewV1Schema } from './projectSetupConsentFailure.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
export type ProjectDefinitionActionId = typeof PROJECT_DEFINITION_ACTION_IDS[number];

// These public Action roots retain Classic composition/JSON Schema projection;
// nested domain schemas remain the single Mini validation owners.
export const ProjectDefinitionWorkspaceSchema = WorkspaceAddressV1Schema;
export type ProjectDefinitionWorkspace = z.infer<typeof ProjectDefinitionWorkspaceSchema>;
/** Query demand, not execution authority. Lists carry summaries; opened rows request exact native details. */
export const ProjectDefinitionInspectReadSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['overview', 'rail']), detectedRows: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ kind: z.enum(['scripts', 'imports', 'guidance', 'editor', 'create', 'tools', 'services', 'setup', 'placement', 'applications']) }),
  z.strictObject({ kind: z.literal('detail'), sources: ProjectDefinitionDetectionV1Schema.shape.entries }),
  z.strictObject({ kind: z.literal('execution'), command: z.optional(z.strictObject({
    usage: z.enum(['script', 'service', 'setup']), name: z.string().check(z.minLength(1)),
  })) }),
]));
export type ProjectDefinitionInspectRead = z.infer<typeof ProjectDefinitionInspectReadSchema>;
export const ProjectDefinitionInspectInputSchema = lazyZodSchema(() => z.strictObject({ workspace: ProjectDefinitionWorkspaceSchema,
  read: z.optional(ProjectDefinitionInspectReadSchema),
  /** The `revision` of the result the caller already holds; an equal current result returns no body. */
  ifRevision: z.optional(z.string().check(z.minLength(1))),
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
/** Raw author text is delivered only to an open editor or a guarded authoring operation. */
export const ProjectManifestInspectionSnapshotSchema = lazyZodSchema(() => z.strictObject({
  basis: ProjectManifestFileBasisV1Schema,
  document: z.nullable(z.union([
    z.strictObject({ status: z.literal('valid'), manifest: ProjectManifestV1Schema, diagnostics: z.array(ProjectManifestDiagnosticSchema),
      bytes: z.optional(z.string()), original: z.optional(z.record(z.string(), z.unknown())) }),
    z.strictObject({ status: z.literal('invalid'), diagnostics: z.array(ProjectManifestDiagnosticSchema),
      bytes: z.optional(z.string()), original: z.optional(z.unknown()) }),
  ])),
}).check(z.refine(snapshot => (snapshot.basis.kind === 'absent') === (snapshot.document === null),
  'An absent file has no document; a present file has an inspected document')));
export type ProjectManifestInspectionSnapshot = z.infer<typeof ProjectManifestInspectionSnapshotSchema>;
export const ProjectDefinitionInspectOutputSchema = lazyZodSchema(() => z.strictObject({
  /** Content hash of this projected result, for a later `ifRevision` revalidation. */
  revision: z.optional(z.string().check(z.minLength(1))),
  /** Import/native/tool detail reads carry only file status, not a complete declaration projection. */
  definitionScope: z.optional(z.literal('statusOnly')),
  definition: ProjectManifestInspectionSnapshotSchema, detection: ProjectDefinitionDetectionV1Schema,
  detectionSummary: z.optional(z.strictObject({ total: z.number().check(z.int(), z.nonnegative()),
    scripts: z.number().check(z.int(), z.nonnegative()), services: z.number().check(z.int(), z.nonnegative()),
    sourceFiles: z.optional(z.array(z.string())),
    files: z.array(z.strictObject({ file: z.string(), total: z.number().check(z.int(), z.nonnegative()),
      scripts: z.number().check(z.int(), z.nonnegative()), services: z.number().check(z.int(), z.nonnegative()) })),
  })),
  importCandidates: z.array(ProjectDefinitionImportCandidateV1Schema),
  commands: z.optional(z.array(z.strictObject({
    name: z.string().check(z.minLength(1)), usage: z.enum(['script', 'service', 'setup']), source: ProjectNativeRefV1Schema,
    availability: z.enum(['available', 'unavailable', 'unresolved', 'ambiguous']), code: z.optional(z.string()),
    invocation: z.optional(ProjectNativeInvocationPreviewV1Schema),
    executionInputs: z.optional(z.array(ProjectExecutionInputV1Schema)),
  }))),
  toolchainExecutionInputs: z.optional(z.array(ProjectExecutionInputV1Schema)),
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
export const ProjectDefinitionInspectOutputProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(ProjectDefinitionInspectOutputSchema));
/** The current result equals the caller's `ifRevision`: nothing is resent. */
export const ProjectDefinitionInspectUnchangedSchema = lazyZodSchema(() => z.strictObject({
  unchanged: z.literal(true), revision: z.string().check(z.minLength(1)),
}));
export const ProjectDefinitionInspectResultSchema = lazyZodSchema(() => z.union([
  ProjectDefinitionInspectOutputSchema, ProjectDefinitionInspectUnchangedSchema,
]));
export type ProjectDefinitionInspectResult = z.infer<typeof ProjectDefinitionInspectResultSchema>;
export const ProjectManifestUpdateOutputSchema = lazyZodSchema(() => z.lazy(() => ProjectManifestUpdateResultSchema));
export const PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS = {
  'projects.inspect': ProjectDefinitionInspectInputSchema,
  'projects.manifest.update': ProjectManifestUpdateInputSchema,
} as const;
export const PROJECT_DEFINITION_ACTION_OUTPUT_SCHEMAS = {
  'projects.inspect': ProjectDefinitionInspectResultSchema,
  'projects.manifest.update': ProjectManifestUpdateOutputSchema,
} as const;

function createProjectDefinitionActionSpecs() {
  return [
  {
    id: 'projects.inspect', approval: {result: 'required'}, title: 'Inspect project definitions', description: 'Read current project declarations and detect native references without evaluating project code. Setup readiness uses the same requester-bound review as Scripts; unknown includes the actual unavailable or failed-read reason and never proves setup is unnecessary. Reading readiness does not approve or run setup. To inspect this checkout from an ongoing Session, first call session.status.get with {"sessionId":"self","includeAcceptedWorkspace":true}; pass its result.acceptedWorkspace.checkout unchanged as workspace. If that proof is absent, report the checkout identity unavailable; do not guess identifiers from a folder name or path. Then read projects.worker.preferences.get with the checkout serverId and workspaceId as refId. A script is worker-portable only when its declaration permits it; absent execution permission and detected native commands remain primary-only. An unavailable or invalid definition is not an empty script list. The default read (read.kind "scripts") lists undeclared native Script references (name and file) with empty importCandidates; to get a reference\'s resolved command, availability and invocation, call again with read {"kind":"detail","sources":[...]} passing the chosen detection.entries unchanged. Every result carries a revision; passing it back as ifRevision returns {unchanged:true, revision} with no body while the result is equal, so keep using the result you hold. Use these current reads rather than an earlier authoring prompt.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'projects_inspect', rpcMethod: PROJECT_DEFINITION_ACTION_RPC_METHODS_V1['projects.inspect'] },
    cli: { acceptsServerId: true, commands: [{ path: ['project', 'inspect'], visibility: 'canonical' }] },
    inputSchema: ProjectDefinitionInspectInputSchema, outputSchema: ProjectDefinitionInspectResultSchema,
    inputHints: { fields: [{ path: 'workspace', title: 'Qualified checkout', prompt: 'Which workspace?', widget: 'json', required: true }] },
  },
  {
    id: 'projects.manifest.update', approvalPolicy: { uiConfirmation: 'policy' }, approval: {result: 'required'}, title: 'Update project file', description: 'Save reviewed project file bytes against the expected absence or content hash. Form, raw and imports share this writer.',
    safety: 'danger', sideEffectClass: 'write', executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'projects_manifest_update', rpcMethod: PROJECT_DEFINITION_ACTION_RPC_METHODS_V1['projects.manifest.update'] },
    cli: { acceptsServerId: true, commands: [{ path: ['project', 'manifest', 'update'], visibility: 'canonical' }] },
    inputSchema: ProjectManifestUpdateInputSchema, outputSchema: ProjectManifestUpdateOutputSchema,
    inputHints: { fields: [
      { path: 'workspace', title: 'Qualified checkout', prompt: 'Which workspace?', widget: 'json', required: true },
      { path: 'expectedBasis', title: 'Reviewed file basis', widget: 'json', required: true },
      { path: 'bytes', title: 'Project file contents', widget: 'textarea', required: true },
    ] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const PROJECT_DEFINITION_ACTION_SPECS: ReturnType<typeof createProjectDefinitionActionSpecs> = lazyActionSpecArray(createProjectDefinitionActionSpecs);

export function isProjectDefinitionActionId(value: string): value is ProjectDefinitionActionId {
  return (PROJECT_DEFINITION_ACTION_IDS as readonly string[]).includes(value);
}
