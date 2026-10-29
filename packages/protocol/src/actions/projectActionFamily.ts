import { z } from 'zod/mini';
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
import { canRetainProjectSetupReviewV1, ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from './operations/v1.js';
import { normalizeWorkspaceRootPathV1 } from '../workspaces/workspaceRefResolutionV1.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
export { ProjectSetupConsentFailureDetailsV1Schema, ProjectSetupConsentScopeV1Schema,
  type ProjectSetupConsentFailureDetailsV1, type ProjectSetupConsentScopeV1 } from './projectSetupConsentFailure.js';
import { PROJECT_ACTION_IDS_V1, type ProjectActionIdV1 } from './projectActionIdsV1.js';
export { PROJECT_ACTION_IDS_V1, isProjectActionIdV1, isProjectWorkspaceSyncPreparationActionV1, type ProjectActionIdV1 } from './projectActionIdsV1.js';
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

const nonempty = lazyZodSchema(() => z.string().check(z.minLength(1)));
const workspace = WorkspaceAddressV1Schema;
export const ProjectSetupConsentRequiredV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('pendingApproval'), code: z.enum(['project_setup_consent_required', 'project_setup_effect_changed']), reviewedEffectDigest: nonempty,
  consentScope: z.optional(ProjectSetupConsentScopeV1Schema),
}));
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
  const finite = Object.prototype.hasOwnProperty.call(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId);
  if (!canRetainProjectSetupReviewV1(actionId)) return null;
  const operation = ProjectCommandActionOutputV1Schema.safeParse(value);
  if (operation.success && operation.data.operation.actionId === actionId && operation.data.operation.setupReview
    && (operation.data.operation.state === 'accepted' || operation.data.operation.state === 'running')
    && (finite || operation.data.operation.domainRef?.kind === 'projectCommand'
      && operation.data.operation.domainRef.purpose === 'setup')) {
    const review = operation.data.operation.setupReview;
    return { kind: 'pendingApproval', code: review.code, reviewedEffectDigest: review.reviewedEffectDigest,
      ...(review.consentScope ? { consentScope: review.consentScope } : {}) };
  }
  // Cold starts must name their original admitted operation and exact setup
  // target. A standalone review/failure cannot establish that custody.
  if (!finite) return null;
  const pending = ProjectSetupConsentRequiredV1Schema.safeParse(value);
  if (pending.success) return pending.data;
  const failure = readProjectSetupConsentFailureV1(value);
  return failure ? { kind: 'pendingApproval', code: failure.details.code,
    reviewedEffectDigest: failure.details.reviewedEffectDigest,
    ...(failure.details.consentScope ? { consentScope: failure.details.consentScope } : {}) } : null;
}
export const ProjectPrepareNoLaunchResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('notRequired'), reviewedEffectDigest: nonempty }),
  z.strictObject({ kind: z.literal('skippedForInvocation'), reviewedEffectDigest: nonempty }),
  z.strictObject({ kind: z.literal('success'), reviewedEffectDigest: nonempty }),
]));
export type ProjectPrepareNoLaunchResultV1 = z.infer<typeof ProjectPrepareNoLaunchResultV1Schema>;
export const ProjectPrepareResultV1Schema = lazyZodSchema(() => z.union([
  ProjectPrepareNoLaunchResultV1Schema,
  ProjectSetupConsentRequiredV1Schema,
  ProjectCommandActionOutputV1Schema,
]));
export type ProjectPrepareResultV1 = z.infer<typeof ProjectPrepareResultV1Schema>;
export const ProjectPrepareInputV1Schema = lazyZodSchema(() => z.strictObject({
  workspace, phase: z.enum(['setup', 'teardown']), skipForInvocation: z.optional(z.boolean()), expectedEffectDigest: z.optional(nonempty),
  consentScope: z.optional(ProjectSetupConsentScopeV1Schema),
  /** Decide the existing target-held invocation; never admit another preparation. */
  heldOperationId: z.optional(nonempty),
}).check(z.refine(input => input.consentScope === undefined || input.expectedEffectDigest !== undefined, {
  path: ['expectedEffectDigest'], message: 'Requested setup consent scope requires the reviewed effect digest',
}), z.refine(input => input.heldOperationId === undefined || input.expectedEffectDigest !== undefined
  && (input.consentScope !== undefined || input.skipForInvocation === true), {
  path: ['heldOperationId'], message: 'A retained decision requires its reviewed digest and consent or Skip choice',
}), z.refine(input => input.consentScope !== 'untilChanged' || input.heldOperationId !== undefined && input.skipForInvocation !== true, {
  path: ['heldOperationId'], message: 'Remembered consent requires an exact retained operation and cannot skip setup',
})));
export type ProjectPrepareInputV1 = z.infer<typeof ProjectPrepareInputV1Schema>;

/** Classification only; the Action schema admits operands before routing or execution. */
export function isProjectSetupTrustRequestV1(actionId: string, input: unknown): boolean {
  return actionId === 'projects.prepare' && typeof input === 'object' && input !== null
    && 'consentScope' in input && input.consentScope === 'untilChanged';
}

/** The retained producer, not caller-provided effect facts, supplies remembered-consent review. */
export function readProjectSetupTrustRequestOperationV1(input: ProjectPrepareInputV1, response: unknown): ActionOperationSnapshotV1 | null {
  const parsed = ActionOperationGetV1ResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.kind !== 'found') return null;
  const operation = parsed.data.operation;
  const target = operation.domainRef;
  return operation.operationId === input.heldOperationId && canRetainProjectSetupReviewV1(operation.actionId)
    && (operation.state === 'accepted' || operation.state === 'running') && operation.setupReview
    && target?.kind === 'projectCommand' && target.sourceWorkspace !== undefined
    && target.serverId === input.workspace.serverId && target.machineId === input.workspace.machineId
    && operation.scope.machineId === target.machineId && target.workspaceRefId === input.workspace.workspaceId
    && normalizeWorkspaceRootPathV1(target.cwd) === normalizeWorkspaceRootPathV1(input.workspace.rootPath)
    && (target.purpose === 'teardown' ? 'teardown' : 'setup') === input.phase
    ? operation : null;
}
const projectPageDisplay = {
  id: nonempty, title: nonempty, icon: nonempty, href: nonempty,
  disabledReason: z.nullable(z.string()),
};
/** Navigation output uses the rendered catalog glyph, rather than authored icon tokens. */
export const ProjectPageDescriptorV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ ...projectPageDisplay, kind: z.literal('builtin') }),
  z.strictObject({ ...projectPageDisplay, kind: z.literal('plugin'), destination: asProtocolZod(PluginContributionIdentityV1Schema) }),
]));
export type ProjectPageDescriptorV1 = z.infer<typeof ProjectPageDescriptorV1Schema>;
export const ProjectPagesListInputV1Schema = lazyZodSchema(() => z.strictObject({ workspaceRefId: nonempty, serverId: nonempty }));
export type ProjectPagesListInputV1 = z.infer<typeof ProjectPagesListInputV1Schema>;
export const ProjectPagesListOutputV1Schema = lazyZodSchema(() => z.strictObject({ pages: z.array(ProjectPageDescriptorV1Schema) }));
export type ProjectPagesListOutputV1 = z.infer<typeof ProjectPagesListOutputV1Schema>;
export const PROJECT_ACTION_INPUT_SCHEMAS_V1 = {
  'projects.pages.list': ProjectPagesListInputV1Schema,
  'projects.trust.list': lazyZodSchema(() => z.strictObject({ project: z.optional(QualifiedProjectTrustProjectV1Schema) })),
  'projects.trust.revoke': lazyZodSchema(() => z.strictObject({ project: QualifiedProjectTrustProjectV1Schema,
    expectedRevision: z.number().check(z.int(), z.nonnegative()), expectedEffectDigest: nonempty })),
  'projects.prepare': ProjectPrepareInputV1Schema,
  'projects.script.run': lazyZodSchema(() => z.strictObject({
    workspace,
    selection: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('named'), name: nonempty }),
      z.strictObject({ kind: z.literal('native'), source: ProjectNativeRefV1Schema }),
    ]),
    choice: z.optional(ProjectExecutionChoiceV1Schema), expectedEffectDigest: z.optional(nonempty),
    memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
  })),
  'projects.compute.exec': lazyZodSchema(() => z.strictObject({
    workspace, executable: nonempty, argv: z.array(z.string()), cwd: nonempty,
    environmentBindings: z.optional(SecretReferenceOverlayV1Schema), choice: z.optional(ProjectExecutionChoiceV1Schema),
    execution: z.optional(z.enum(['primary', 'portable'])),
    memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
  })),
} as const;
// Refusal and pre-launch failure use the incumbent ActionExecuteFailure envelope;
// they cannot masquerade as successful launch evidence for generic completion.
const finiteResult = lazyZodSchema(() => z.union([ProjectCommandActionOutputV1Schema, ProjectSetupConsentRequiredV1Schema]));
export const ProjectComputeExecResultV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(finiteResult));
export const PROJECT_ACTION_OUTPUT_SCHEMAS_V1 = {
  'projects.pages.list': ProjectPagesListOutputV1Schema,
  'projects.trust.list': lazyZodSchema(() => z.strictObject({ trust: z.array(z.strictObject({
    project: QualifiedProjectTrustProjectV1Schema, revision: z.number().check(z.int(), z.nonnegative()), value: ProjectTrustValueV1Schema,
  })) })),
  'projects.trust.revoke': lazyZodSchema(() => z.strictObject({ project: QualifiedProjectTrustProjectV1Schema, status: z.enum(['removed', 'notFound', 'conflict', 'refused']) })),
  'projects.prepare': ProjectPrepareResultV1Schema,
  'projects.script.run': finiteResult,
  'projects.compute.exec': finiteResult,
} as const;

// What a person reads in Settings, approvals and the form. Agents read `description`.
const PROJECT_ACTION_COPY = {
  'projects.pages.list': ['List project pages', 'See the pages available for this project on this device.'],
  'projects.trust.list': ['List trusted projects', 'See which projects you have allowed to run their setup on your machines.'],
  'projects.trust.revoke': ['Stop trusting a project', 'Take back a project\'s permission to run its setup. It asks again next time.'],
  'projects.prepare': ['Set up a project', 'Run a project\'s setup on a machine, so it is ready to work in.'],
  'projects.script.run': ['Run a project script', 'Run one of the scripts a project declares, on a machine you choose.'],
  'projects.compute.exec': ['Run a command in a project', 'Run a command you give in a project\'s folder on a machine.'],
} as const satisfies Record<ProjectActionIdV1, readonly [title: string, summary: string]>;

// Forms and approval review share these operands; schemas alone do not publish review fields.
const PROJECT_ACTION_INPUT_FIELDS = {
  'projects.pages.list': [
    { path: 'workspaceRefId', title: 'Checkout', widget: 'text', required: true },
    { path: 'serverId', title: 'Home', widget: 'text', required: true },
  ],
  'projects.trust.list': [
    { path: 'project', title: 'Project', widget: 'json' },
  ],
  'projects.trust.revoke': [
    { path: 'project', title: 'Project', widget: 'json', required: true },
    { path: 'expectedRevision', title: 'Reviewed revision', widget: 'number', required: true },
    { path: 'expectedEffectDigest', title: 'Reviewed setup effect', widget: 'text', required: true },
  ],
  'projects.prepare': [
    { path: 'workspace', title: 'Qualified checkout', widget: 'json', required: true },
    { path: 'phase', title: 'Preparation phase', widget: 'select', required: true,
      options: [{ value: 'setup', label: 'Setup' }, { value: 'teardown', label: 'Teardown' }] },
    { path: 'skipForInvocation', title: 'Skip for this invocation', widget: 'boolean' },
    { path: 'expectedEffectDigest', title: 'Reviewed setup effect', widget: 'text' },
    { path: 'consentScope', title: 'Setup consent scope', widget: 'json' },
    { path: 'heldOperationId', title: 'Held operation', widget: 'text' },
  ],
  'projects.script.run': [
    { path: 'workspace', title: 'Qualified checkout', widget: 'json', required: true },
    { path: 'selection', title: 'Selected script', widget: 'json', required: true },
    { path: 'choice', title: 'Execution placement', widget: 'json' },
    { path: 'expectedEffectDigest', title: 'Reviewed Script effect', widget: 'text',
      description: 'Optional freshness precondition for this exact Script effect. Omit unless you have its reviewed Script digest; a setup or projects.prepare digest is a different value. This field does not grant approval.' },
    { path: 'memoryDemand', title: 'Memory demand', widget: 'json' },
  ],
  'projects.compute.exec': [
    { path: 'workspace', title: 'Qualified checkout', widget: 'json', required: true },
    { path: 'executable', title: 'Executable', widget: 'text', required: true },
    { path: 'argv', title: 'Arguments', widget: 'json', required: true },
    { path: 'cwd', title: 'Working directory', widget: 'text', required: true },
    { path: 'environmentBindings', title: 'Saved Secret references', widget: 'json' },
    { path: 'execution', title: 'Execution constraint', widget: 'select', options: [
      { value: 'primary', label: 'Primary Machine' }, { value: 'portable', label: 'Portable' },
    ] },
    { path: 'choice', title: 'Execution placement', widget: 'json' },
    { path: 'memoryDemand', title: 'Memory demand', widget: 'json' },
  ],
} as const satisfies Record<ProjectActionIdV1, NonNullable<PreNormalizedActionSpec['inputHints']>['fields']>;

function row<const Id extends ProjectActionIdV1>(id: Id) {
  const clientRead = id === 'projects.pages.list';
  const read = id === 'projects.trust.list' || clientRead;
  return {
    id, approval: { result: 'required' },
    ...(id === 'projects.prepare' ? { approvalPolicy: { uiConfirmation: 'policy' as const, rpcConfirmation: true as const },
      executionPlacementForInput: (input: unknown) => isProjectSetupTrustRequestV1(id, input) ? 'account' as const : 'machine' as const } : {}),
    ...(id === 'projects.compute.exec' ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    originalExecution: { accountRoot: 'allowed' }, title: PROJECT_ACTION_COPY[id][0],
    description: clientRead
      ? 'List authorized applicable built-in and plugin pages for the exact accepted Project and Home on the answering client, including user-hidden pages. This reads the existing page catalog without opening a Project, selecting a Machine or loading page content. Open a returned href with workspace.tabs.open; read or change navigation placement through settings.get and settings.set.'
      : id === 'projects.script.run'
      ? 'Run the selected Script on the exact qualified checkout through current declaration and worker policy. Read projects.inspect and projects.worker.preferences.get first; primary-only declarations cannot run on workers. An explicit invocation choice precedes the per-script override and saved checkout default; Ask requires a deliberate exact target choice. Setup-effect review follows the separate projects.prepare approval policy; waiving Run does not waive setup review. Only the user can grant remembered setup trust. Acceptance returns an exact-target operation, not completion: inspect action.operations.get and projects.execution.output.read for queue, copy, setup, output and exit facts. After possible acceptance or unknown outcome inspect that same target; do not repeat Run or fall back because it is busy, offline, failed or Stop is unconfirmed.'
      : id === 'projects.compute.exec'
      ? 'Run an explicitly requested ad-hoc command on the exact qualified checkout. Read projects.worker.preferences.get first: allowAdHoc must be enabled in ready current preferences; opted-out and unavailable settings are distinct refusals. Commands follow configurable Action approval and reviewed setup consent, and arbitrary shell commands are not automatically offloaded. Observe the chosen target through projects.worker.status or finite-purpose machines.pools.resolve. Acceptance is an inspectable operation, not completion; read its exact-target state and output, and never repeat or change targets after possible acceptance without renewed explicit intent.'
      : id === 'projects.prepare'
      ? 'Prepare the exact Project checkout. Request consentScope untilChanged with heldOperationId and expectedEffectDigest to ask a present person to remember the retained setup effect until it changes. A person must approve through the ordinary approval flow; an agent cannot grant or approve its own setup trust. Approval rechecks the retained target review and uses the approving Account Trust writer. Ordinary preparation and one-time consent follow the projects.prepare approval policy; a waiver writes no remembered trust.'
      : 'Use the authenticated Account and exact Project workspace. Setup-effect review follows the projects.prepare approval policy. A waiver permits only this invocation and does not grant remembered setup trust; only the user can grant that trust.',
    safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : id === 'projects.trust.revoke' ? 'write' : 'external',
    requiredAuthority: 'account_automation', executionPlacement: clientRead ? 'client' : id.startsWith('projects.trust.') ? 'account' : 'machine',
    placements: [], surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: !clientRead && !id.startsWith('projects.trust.') },
    bindings: { mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_'),
      ...(id === 'projects.prepare' || id === 'projects.script.run' || id === 'projects.compute.exec'
        ? { rpcMethod: id === 'projects.prepare' ? PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.prepare']
          : id === 'projects.script.run' ? PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.script.run']
          : PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.compute.exec'] } : {}) },
    cli: { acceptsServerId: true, commands: [{ path: ['project', ...id.split('.').slice(1)], visibility: 'canonical' }] },
    inputSchema: PROJECT_ACTION_INPUT_SCHEMAS_V1[id], outputSchema: PROJECT_ACTION_OUTPUT_SCHEMAS_V1[id],
    ...(!clientRead && !id.startsWith('projects.trust.') ? {
      operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } },
      completion: lazyDefinition(() => id === 'projects.prepare'
      ? createProjectCommandActionCompletionV1({ immediateResultSchema: ProjectPrepareNoLaunchResultV1Schema })
      : createProjectCommandActionCompletionV1()) } : {}),
    inputHints: { title: PROJECT_ACTION_COPY[id][0], description: PROJECT_ACTION_COPY[id][1], fields: PROJECT_ACTION_INPUT_FIELDS[id] },
  } satisfies PreNormalizedActionSpec;
}
export const PROJECT_ACTION_SPECS_V1 = PROJECT_ACTION_IDS_V1.map(id => row(id));
