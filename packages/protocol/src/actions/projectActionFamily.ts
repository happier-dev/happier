import { z } from 'zod';
import { lazyZodSchema, lazyDefinition } from '../lazyZodSchema.js';
import { WorkspaceAddressV1Schema } from '../workspaces/workspaceRefV1.js';
import { ProjectExecutionChoiceV1Schema } from '../workspaces/projectWorkerPreferencesV1.js';
import { ProjectNativeRefV1Schema, ProjectMemoryDemandV1Schema } from '../workspaces/projectSetup/projectManifestV1.js';
import { QualifiedProjectTrustProjectV1Schema, ProjectTrustValueV1Schema } from '../workspaces/projectSetup/projectTrustRowV1.js';
import { ProjectCommandActionOutputV1Schema, createProjectCommandActionCompletionV1 } from './actionCompletion.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { SecretReferenceOverlayV1Schema } from '../profiles/secretReferenceOverlayV1.js';
import { ActionExecuteFailureSchema } from './actionExecutionResult.js';
import { ProjectSetupConsentFailureDetailsV1Schema, ProjectSetupConsentScopeV1Schema, type ProjectSetupConsentFailureDetailsV1 } from './projectSetupConsentFailure.js';
export { ProjectSetupConsentFailureDetailsV1Schema, ProjectSetupConsentScopeV1Schema,
  type ProjectSetupConsentFailureDetailsV1, type ProjectSetupConsentScopeV1 } from './projectSetupConsentFailure.js';
import { PROJECT_ACTION_IDS_V1, type ProjectActionIdV1 } from './projectActionIdsV1.js';
export { PROJECT_ACTION_IDS_V1, isProjectActionIdV1, type ProjectActionIdV1 } from './projectActionIdsV1.js';
export { ProjectWorkerNoAcceptanceFailureDetailsV1Schema, readProjectWorkerNoAcceptanceFailureV1,
  type ProjectWorkerNoAcceptanceFailureDetailsV1 } from './projectWorkerRefusal.js';

export const PROJECT_FINITE_ACTION_RPC_METHODS_V1 = {
  'projects.prepare': RPC_METHODS.DAEMON_PROJECTS_PREPARE,
  'projects.script.run': RPC_METHODS.DAEMON_PROJECTS_SCRIPT_RUN,
  'projects.compute.exec': RPC_METHODS.DAEMON_PROJECTS_COMPUTE_EXEC,
} as const;

/** These requester Project operations use native/Account ports, not a Machine RPC method. */
export function isRequesterProjectExecutionActionV1(actionId: string): actionId is 'projects.open' | 'projects.trust.list' | 'projects.trust.revoke' {
  return actionId === 'projects.open' || actionId === 'projects.trust.list' || actionId === 'projects.trust.revoke';
}

const nonempty = lazyZodSchema(() => z.string().min(1));
const workspace = WorkspaceAddressV1Schema;
export const ProjectSetupConsentRequiredV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('pendingApproval'), code: z.enum(['project_setup_consent_required', 'project_setup_effect_changed']), reviewedEffectDigest: nonempty,
  consentScope: ProjectSetupConsentScopeV1Schema.optional(),
}).strict());
export type ProjectSetupConsentRequiredV1 = z.infer<typeof ProjectSetupConsentRequiredV1Schema>;
export type ProjectSetupConsentFailureV1 = Readonly<{
  ok: false;
  errorCode: ProjectSetupConsentFailureDetailsV1['code'];
  error: string;
  details: ProjectSetupConsentFailureDetailsV1;
}>;

/** Only the two actual D18 producer failures may carry these redacted review facts. */
export function readProjectSetupConsentFailureV1(value: unknown): ProjectSetupConsentFailureV1 | null {
  const failure = ActionExecuteFailureSchema.safeParse(value);
  if (!failure.success) return null;
  const details = ProjectSetupConsentFailureDetailsV1Schema.safeParse(failure.data.details);
  if (!details.success || details.data.code !== failure.data.errorCode) return null;
  return { ok: false, errorCode: details.data.code, error: details.data.code, details: details.data };
}

/** A no-effect setup precondition retains invocation custody, never reviewer authority. */
export function readProjectSetupConsentHoldV1(actionId: string, value: unknown): ProjectSetupConsentRequiredV1 | null {
  if (!Object.prototype.hasOwnProperty.call(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId)) return null;
  const pending = ProjectSetupConsentRequiredV1Schema.safeParse(value);
  if (pending.success) return pending.data;
  const operation = ProjectCommandActionOutputV1Schema.safeParse(value);
  if (operation.success && operation.data.operation.actionId === actionId && operation.data.operation.setupReview) {
    const review = operation.data.operation.setupReview;
    return { kind: 'pendingApproval', code: review.code, reviewedEffectDigest: review.reviewedEffectDigest,
      ...(review.consentScope ? { consentScope: review.consentScope } : {}) };
  }
  const failure = readProjectSetupConsentFailureV1(value);
  return failure ? { kind: 'pendingApproval', code: failure.details.code,
    reviewedEffectDigest: failure.details.reviewedEffectDigest,
    ...(failure.details.consentScope ? { consentScope: failure.details.consentScope } : {}) } : null;
}
export const ProjectPrepareNoLaunchResultV1Schema = lazyZodSchema(() => z.union([
  z.object({ kind: z.literal('notRequired'), reviewedEffectDigest: nonempty }).strict(),
  z.object({ kind: z.literal('skippedForInvocation'), reviewedEffectDigest: nonempty }).strict(),
  z.object({ kind: z.literal('success'), reviewedEffectDigest: nonempty }).strict(),
]));
export type ProjectPrepareNoLaunchResultV1 = z.infer<typeof ProjectPrepareNoLaunchResultV1Schema>;
export const ProjectPrepareResultV1Schema = lazyZodSchema(() => z.union([
  ProjectPrepareNoLaunchResultV1Schema,
  ProjectSetupConsentRequiredV1Schema,
  ProjectCommandActionOutputV1Schema,
]));
export type ProjectPrepareResultV1 = z.infer<typeof ProjectPrepareResultV1Schema>;
export const ProjectPrepareInputV1Schema = lazyZodSchema(() => z.object({
  workspace, phase: z.enum(['setup', 'teardown']), skipForInvocation: z.boolean().optional(), expectedEffectDigest: nonempty.optional(),
  consentScope: ProjectSetupConsentScopeV1Schema.optional(),
}).strict().refine(input => input.consentScope === undefined || input.expectedEffectDigest !== undefined, {
  path: ['expectedEffectDigest'], message: 'Requested setup consent scope requires the reviewed effect digest',
}));
export type ProjectPrepareInputV1 = z.infer<typeof ProjectPrepareInputV1Schema>;
export const PROJECT_ACTION_INPUT_SCHEMAS_V1 = {
  'projects.trust.list': lazyZodSchema(() => z.object({ project: z.optional(QualifiedProjectTrustProjectV1Schema) }).strict()),
  'projects.trust.revoke': lazyZodSchema(() => z.object({ project: QualifiedProjectTrustProjectV1Schema,
    expectedRevision: z.number().int().nonnegative(), expectedEffectDigest: nonempty }).strict()),
  'projects.prepare': ProjectPrepareInputV1Schema,
  'projects.script.run': lazyZodSchema(() => z.object({
    workspace,
    selection: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('named'), name: nonempty }).strict(),
      z.object({ kind: z.literal('native'), source: ProjectNativeRefV1Schema }).strict(),
    ]),
    choice: ProjectExecutionChoiceV1Schema.optional(), expectedEffectDigest: nonempty.optional(),
    memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
  }).strict()),
  'projects.compute.exec': lazyZodSchema(() => z.object({
    workspace, executable: nonempty, argv: z.array(z.string()), cwd: nonempty,
    environmentBindings: SecretReferenceOverlayV1Schema.optional(), choice: ProjectExecutionChoiceV1Schema.optional(),
    memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
  }).strict()),
} as const;
// Refusal and pre-launch failure use the incumbent ActionExecuteFailure envelope;
// they cannot masquerade as successful launch evidence for generic completion.
const finiteResult = lazyZodSchema(() => z.union([ProjectCommandActionOutputV1Schema, ProjectSetupConsentRequiredV1Schema]));
export const PROJECT_ACTION_OUTPUT_SCHEMAS_V1 = {
  'projects.trust.list': lazyZodSchema(() => z.object({ trust: z.array(z.object({
    project: QualifiedProjectTrustProjectV1Schema, revision: z.number().int().nonnegative(), value: ProjectTrustValueV1Schema,
  }).strict()) }).strict()),
  'projects.trust.revoke': lazyZodSchema(() => z.object({ project: QualifiedProjectTrustProjectV1Schema, status: z.enum(['removed', 'notFound', 'conflict', 'refused']) }).strict()),
  'projects.prepare': ProjectPrepareResultV1Schema,
  'projects.script.run': finiteResult,
  'projects.compute.exec': finiteResult,
} as const;

// What a person reads in Settings, approvals and the form. Agents read `description`.
const PROJECT_ACTION_COPY = {
  'projects.trust.list': ['List trusted projects', 'See which projects you have allowed to run their setup on your machines.'],
  'projects.trust.revoke': ['Stop trusting a project', 'Take back a project\'s permission to run its setup. It asks again next time.'],
  'projects.prepare': ['Set up a project', 'Run a project\'s setup on a machine, so it is ready to work in.'],
  'projects.script.run': ['Run a project script', 'Run one of the scripts a project declares, on a machine you choose.'],
  'projects.compute.exec': ['Run a command in a project', 'Run a command you give in a project\'s folder on a machine.'],
} as const satisfies Record<ProjectActionIdV1, readonly [title: string, summary: string]>;

function row<const Id extends ProjectActionIdV1>(id: Id) {
  const read = id === 'projects.trust.list';
  return {
    id, title: PROJECT_ACTION_COPY[id][0],
    description: id === 'projects.script.run'
      ? 'Run the selected Script on the exact qualified checkout through current declaration and worker policy. Read projects.inspect and projects.worker.preferences.get first; primary-only declarations cannot run on workers. An explicit invocation choice precedes the per-script override and saved checkout default; Ask requires a deliberate exact target choice. Setup-effect human consent is separate from configurable Action approval. Acceptance returns an exact-target operation, not completion: inspect action.operations.get and projects.execution.output.read for queue, copy, setup, output and exit facts. After possible acceptance or unknown outcome inspect that same target; do not repeat Run or fall back because it is busy, offline, failed or Stop is unconfirmed.'
      : id === 'projects.compute.exec'
      ? 'Run an explicitly requested ad-hoc command on the exact qualified checkout. Read projects.worker.preferences.get first: allowAdHoc must be enabled in ready current preferences; opted-out and unavailable settings are distinct refusals. Commands follow configurable Action approval and reviewed setup consent, and arbitrary shell commands are not automatically offloaded. Observe the chosen target through projects.worker.status or finite-purpose machines.pools.resolve. Acceptance is an inspectable operation, not completion; read its exact-target state and output, and never repeat or change targets after possible acceptance without renewed explicit intent.'
      : 'Use the authenticated Account and exact Project workspace. Setup-effect human consent is separate from configurable Action invocation approval.',
    safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : id === 'projects.trust.revoke' ? 'write' : 'external',
    requiredAuthority: 'account_automation', executionPlacement: id.startsWith('projects.trust.') ? 'account' : 'machine',
    placements: [], surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: !id.startsWith('projects.trust.') },
    bindings: { mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_'),
      ...(id === 'projects.prepare' || id === 'projects.script.run' || id === 'projects.compute.exec'
        ? { rpcMethod: id === 'projects.prepare' ? PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.prepare']
          : id === 'projects.script.run' ? PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.script.run']
          : PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.compute.exec'] } : {}) },
    cli: { acceptsServerId: true, commands: [{ path: ['project', ...id.split('.').slice(1)], visibility: 'canonical' }] },
    inputSchema: PROJECT_ACTION_INPUT_SCHEMAS_V1[id], outputSchema: PROJECT_ACTION_OUTPUT_SCHEMAS_V1[id],
    ...(!id.startsWith('projects.trust.') ? {
      operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } },
      completion: lazyDefinition(() => id === 'projects.prepare'
      ? createProjectCommandActionCompletionV1({ immediateResultSchema: ProjectPrepareNoLaunchResultV1Schema })
      : createProjectCommandActionCompletionV1()) } : {}),
    inputHints: { title: PROJECT_ACTION_COPY[id][0], description: PROJECT_ACTION_COPY[id][1], fields: [] },
  } satisfies PreNormalizedActionSpec;
}
export const PROJECT_ACTION_SPECS_V1 = PROJECT_ACTION_IDS_V1.map(id => row(id));
