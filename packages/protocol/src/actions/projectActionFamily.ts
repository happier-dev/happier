import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema, lazyDefinition } from '../lazyZodSchema.js';
import { actionCliDerivedDefault } from './actionCliProjection.js';
import { readRecord } from '../inputs/inputRecords.js';
import { WorkspaceAddressV1Schema } from '../workspaces/workspaceRefV1.js';
import { ProjectExecutionChoiceV1Schema } from '../workspaces/projectWorkerPreferencesV1.js';
import { ProjectNativeRefV1Schema, ProjectMemoryDemandV1Schema } from '../workspaces/projectSetup/projectManifestV1.js';
import { QualifiedProjectTrustProjectV1Schema, ProjectTrustValueV1Schema } from '../workspaces/projectSetup/projectTrustRowV1.js';
import { ProjectCommandActionOutputV1Schema, createProjectCommandActionCompletionV1 } from './actionCompletion.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { actionInputServerId } from './specs/definition.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { SecretReferenceOverlayV1Schema } from '../profiles/secretReferenceOverlayV1.js';
import { ActionExecuteFailureSchema } from './actionExecutionResult.js';
import { ProjectSetupConsentFailureDetailsV1Schema, ProjectSetupConsentScopeV1Schema, type ProjectSetupConsentFailureDetailsV1 } from './projectSetupConsentFailure.js';
import { canRetainProjectSetupReviewV1, ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from './operations/v1.js';
import { normalizeWorkspaceRootPathV1 } from '../workspaces/workspaceRefResolutionV1.js';
import { ProjectComputeExecEnvV1Schema } from '../workspaces/projectComputeEnvV1.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
export { ProjectSetupConsentFailureDetailsV1Schema, ProjectSetupConsentScopeV1Schema,
  type ProjectSetupConsentFailureDetailsV1, type ProjectSetupConsentScopeV1 } from './projectSetupConsentFailure.js';
import { PROJECT_ACTION_IDS_V1, PROJECT_FINITE_ACTION_RPC_METHODS_V1, isProjectFiniteActionIdV1, type ProjectActionIdV1 } from './projectActionIdsV1.js';
export { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from './projectActionIdsV1.js';
export { PROJECT_ACTION_IDS_V1, isProjectActionIdV1, isProjectWorkspaceSyncPreparationActionV1, type ProjectActionIdV1 } from './projectActionIdsV1.js';
export { ProjectWorkerNoAcceptanceFailureDetailsV1Schema, readProjectWorkerNoAcceptanceFailureV1,
  type ProjectWorkerNoAcceptanceFailureDetailsV1 } from './projectWorkerRefusal.js';

/** These requester Project operations use native/Account ports, not a Machine RPC method. */
export function isRequesterProjectExecutionActionV1(actionId: string): actionId is 'projects.open' | 'projects.trust.list' | 'projects.trust.revoke' {
  return actionId === 'projects.open' || actionId === 'projects.trust.list' || actionId === 'projects.trust.revoke';
}

const nonempty = lazyZodSchema(() => z.string().check(z.minLength(1)));
const workspace = lazyZodSchema(() => WorkspaceAddressV1Schema);
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
  const finite = isProjectFiniteActionIdV1(actionId);
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
const projectComputeExecEnvSchema = ProjectComputeExecEnvV1Schema;
const projectScriptSelectionSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('named'), name: nonempty }),
  z.strictObject({ kind: z.literal('native'), source: ProjectNativeRefV1Schema }),
]));
export const PROJECT_ACTION_INPUT_SCHEMAS_V1 = {
  'projects.pages.list': ProjectPagesListInputV1Schema,
  'projects.trust.list': lazyZodSchema(() => z.strictObject({ project: z.optional(QualifiedProjectTrustProjectV1Schema) })),
  'projects.trust.revoke': lazyZodSchema(() => z.strictObject({ project: QualifiedProjectTrustProjectV1Schema,
    expectedRevision: z.number().check(z.int(), z.nonnegative()), expectedEffectDigest: nonempty })),
  'projects.prepare': ProjectPrepareInputV1Schema,
  'projects.script.run': lazyZodSchema(() => z.strictObject({
    workspace,
    selection: projectScriptSelectionSchema,
    choice: z.optional(ProjectExecutionChoiceV1Schema), expectedEffectDigest: z.optional(nonempty),
    memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
  })),
  'projects.compute.exec': lazyZodSchema(() => z.strictObject({
    workspace, executable: nonempty, argv: z.array(z.string()), cwd: nonempty,
    env: z.optional(projectComputeExecEnvSchema),
    environmentBindings: z.optional(SecretReferenceOverlayV1Schema), choice: z.optional(ProjectExecutionChoiceV1Schema),
    execution: z.optional(z.enum(['primary', 'portable'])),
    memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
  })),
} as const;
const ProjectScriptRunCliInputV1Schema = lazyZodSchema(() => z.strictObject({
  workspace: z.optional(workspace),
  name: z.optional(nonempty),
  selection: z.optional(projectScriptSelectionSchema),
  on: z.optional(nonempty),
  choice: z.optional(ProjectExecutionChoiceV1Schema),
  expectedEffectDigest: z.optional(nonempty),
  memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
}).check(
  z.refine(input => input.name === undefined || input.selection === undefined, {
    path: ['selection'], message: 'Provide either a script <name> or --selection-json, not both.',
  }),
  z.refine(input => input.on === undefined || input.choice === undefined, {
    path: ['choice'], message: 'Provide either --on or --choice-json, not both.',
  }),
));
const ProjectComputeExecCliInputV1Schema = lazyZodSchema(() => z.strictObject({
  workspace: z.optional(workspace),
  executable: z.optional(nonempty),
  argv: z.optional(z.array(z.string())),
  cwd: z.optional(nonempty),
  on: z.optional(nonempty),
  choice: z.optional(ProjectExecutionChoiceV1Schema),
  env: z.optional(projectComputeExecEnvSchema),
  environmentBindings: z.optional(SecretReferenceOverlayV1Schema),
  execution: z.optional(z.enum(['primary', 'portable'])),
  memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
}).check(
  z.refine(input => input.on === undefined || input.choice === undefined, {
    path: ['choice'], message: 'Provide either --on or --choice-json, not both.',
  }),
));
function bindProjectScriptRunCliInput(raw: unknown): Record<string, unknown> {
  const input = readRecord(raw);
  const result: Record<string, unknown> = {};
  if (input.workspace !== undefined) result.workspace = input.workspace;
  if (input.selection !== undefined) result.selection = input.selection;
  else if (typeof input.name === 'string') result.selection = { kind: 'named', name: input.name };
  if (input.choice !== undefined) result.choice = input.choice;
  else if (typeof input.on === 'string') result.choice = { kind: 'workers', destination: { kind: 'machine', machineId: input.on } };
  if (input.expectedEffectDigest !== undefined) result.expectedEffectDigest = input.expectedEffectDigest;
  if (input.memoryDemand !== undefined) result.memoryDemand = input.memoryDemand;
  return result;
}
function bindProjectComputeExecCliInput(raw: unknown): Record<string, unknown> {
  const input = readRecord(raw);
  const result: Record<string, unknown> = {};
  if (input.workspace !== undefined) result.workspace = input.workspace;
  if (input.executable !== undefined) result.executable = input.executable;
  if (input.argv !== undefined) result.argv = input.argv;
  else result.argv = actionCliDerivedDefault([]);
  if (input.cwd !== undefined) result.cwd = input.cwd;
  else if (input.workspace && typeof input.workspace === 'object' && !Array.isArray(input.workspace)) {
    const rootPath = (input.workspace as { rootPath?: unknown }).rootPath;
    if (typeof rootPath === 'string' && rootPath.trim().length > 0) {
      result.cwd = actionCliDerivedDefault(rootPath);
    }
  }
  if (input.choice !== undefined) result.choice = input.choice;
  else if (typeof input.on === 'string') result.choice = { kind: 'workers', destination: { kind: 'machine', machineId: input.on } };
  if (input.env !== undefined) result.env = input.env;
  if (input.environmentBindings !== undefined) result.environmentBindings = input.environmentBindings;
  if (input.execution !== undefined) result.execution = input.execution;
  if (input.memoryDemand !== undefined) result.memoryDemand = input.memoryDemand;
  return result;
}
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
    { path: 'env', title: 'Environment overrides', widget: 'json',
      description: 'Literal non-secret environment overrides only (e.g. CI=1, NODE_ENV=test). Never place secrets or tokens in env; use environmentBindings for saved secrets.' },
    { path: 'environmentBindings', title: 'Saved Secret references', widget: 'json' },
    { path: 'execution', title: 'Execution constraint', widget: 'select', options: [
      { value: 'primary', label: 'Primary Machine' }, { value: 'portable', label: 'Portable' },
    ] },
    { path: 'choice', title: 'Execution placement', widget: 'json' },
    { path: 'memoryDemand', title: 'Memory demand', widget: 'json' },
  ],
} as const satisfies Record<ProjectActionIdV1, NonNullable<PreNormalizedActionSpec['inputHints']>['fields']>;

function formatConciseComputeCommand(executable: string, argv: readonly string[]): string {
  const joined = [executable, ...argv].join(' ');
  return joined.length <= 160 ? joined : `${joined.slice(0, 159)}…`;
}

function row<const Id extends ProjectActionIdV1>(id: Id) {
  const clientRead = id === 'projects.pages.list';
  const read = id === 'projects.trust.list' || clientRead;
  return {
    id, approval: { result: 'required' },
    ...(id === 'projects.script.run' || id === 'projects.compute.exec'
      ? { contextualDefaults: { workspace: 'current_session_workspace' as const } } : {}),
    ...(id === 'projects.prepare' ? { approvalPolicy: { uiConfirmation: 'policy' as const, rpcConfirmation: true as const },
      executionPlacementForInput: (input: unknown) => isProjectSetupTrustRequestV1(id, input) ? 'account' as const : 'machine' as const } : {}),
    ...(id === 'projects.compute.exec' ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    ...(id === 'projects.script.run' ? {
      approvalPolicy: { requesterAppReview: (input: unknown, caller: Readonly<{ kind: string }> | undefined) => {
        if (caller?.kind !== 'session') return false;
        const script = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].safeParse(input);
        if (!script.success) return false;
        const { workspace, selection, choice } = script.data;
        return selection.kind === 'named' && choice?.kind === 'workers' && choice.destination.kind === 'machine'
          && choice.destination.machineId !== workspace.machineId;
      } },
    } : {}),
    originalExecution: { accountRoot: 'allowed' }, title: PROJECT_ACTION_COPY[id][0],
    approvalPresentation: {
      ...(id === 'projects.script.run' || id === 'projects.compute.exec' ? { referenceForField: (path: string, value: unknown, input: unknown) => {
        if (typeof value !== 'string') return undefined;
        const parsed = id === 'projects.script.run'
          ? PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].safeParse(input)
          : PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.compute.exec'].safeParse(input);
        if (!parsed.success) return undefined;
        if (path === 'workspace.machineId' || path === 'choice.destination.machineId') {
          return { kind: 'machine' as const, id: value, serverId: parsed.data.workspace.serverId };
        }
        return path === 'choice.destination.poolId' ? { kind: 'machinePool' as const, id: value } : undefined;
      } } : {}),
      summary: (input: unknown) => {
      if (id === 'projects.script.run') {
        const script = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].safeParse(input);
        if (script.success) {
          const { workspace, selection, choice } = script.data;
          if (selection.kind === 'named' && choice?.kind === 'workers' && choice.destination.kind === 'machine') {
            return `Run ${JSON.stringify(selection.name)} once on Worker ${JSON.stringify(choice.destination.machineId)}.\n`
              + `Checkout ${JSON.stringify(workspace.rootPath)} on ${JSON.stringify(workspace.machineId)} (Home ${JSON.stringify(workspace.serverId)}).`;
          }
        }
      }
      if (id === 'projects.compute.exec') {
        const exec = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.compute.exec'].safeParse(input);
        if (exec.success) {
          const { workspace, executable, argv, cwd, env, choice } = exec.data;
          const command = formatConciseComputeCommand(executable, argv);
          const envKeys = env ? Object.keys(env).sort() : [];
          const normalizedCwd = normalizeWorkspaceRootPathV1(cwd);
          const normalizedRoot = normalizeWorkspaceRootPathV1(workspace.rootPath);
          const details: string[] = [];
          if (normalizedCwd !== normalizedRoot) {
            details.push(`Directory ${JSON.stringify(cwd)}.`);
          }
          if (envKeys.length > 0) {
            details.push(`Env keys: ${envKeys.map((key) => JSON.stringify(key)).join(', ')}.`);
          }
          const detailSuffix = details.length > 0 ? `\n${details.join(' ')}` : '';
          if (choice?.kind === 'workers' && choice.destination.kind === 'machine') {
            return `Run ${JSON.stringify(command)} on Worker ${JSON.stringify(choice.destination.machineId)}.\n`
              + `Checkout ${JSON.stringify(workspace.rootPath)} on ${JSON.stringify(workspace.machineId)} (Home ${JSON.stringify(workspace.serverId)}).`
              + detailSuffix;
          }
          if (choice?.kind === 'workers' && choice.destination.kind === 'pool') {
            return `Run ${JSON.stringify(command)} on Worker pool ${JSON.stringify(choice.destination.poolId)}.\n`
              + `Checkout ${JSON.stringify(workspace.rootPath)} on ${JSON.stringify(workspace.machineId)} (Home ${JSON.stringify(workspace.serverId)}).`
              + detailSuffix;
          }
          if (choice?.kind === 'primary') {
            return `Run ${JSON.stringify(command)} on Primary ${JSON.stringify(workspace.machineId)}.\n`
              + `Checkout ${JSON.stringify(workspace.rootPath)} (Home ${JSON.stringify(workspace.serverId)}).`
              + detailSuffix;
          }
          return `Run ${JSON.stringify(command)} in checkout ${JSON.stringify(workspace.rootPath)} on ${JSON.stringify(workspace.machineId)} (Home ${JSON.stringify(workspace.serverId)}).`
            + detailSuffix;
        }
      }
      return PROJECT_ACTION_COPY[id][1];
    } },
    description: clientRead
      ? 'List authorized applicable built-in and plugin pages for the exact accepted Project and Home on the answering client, including user-hidden pages. This reads the existing page catalog without opening a Project, selecting a Machine or loading page content. Open a returned href with workspace.tabs.open; read or change navigation placement through settings.get and settings.set.'
      : id === 'projects.script.run'
      ? 'Run the selected Script on the exact qualified checkout through current declaration and worker policy. Read projects.inspect and projects.worker.preferences.get first; primary-only declarations cannot run on workers. An explicit invocation choice precedes the per-script override and saved checkout default; Ask requires a deliberate exact target choice. Setup-effect review follows the separate projects.prepare approval policy; waiving Run does not waive setup review. Only the user can grant remembered setup trust. Acceptance returns an exact-target operation, not completion: inspect action.operations.get and projects.execution.output.read for queue, copy, setup, output and exit facts. After possible acceptance or unknown outcome inspect that same target; do not repeat Run or fall back because it is busy, offline, failed or Stop is unconfirmed.'
      : id === 'projects.compute.exec'
      ? 'Run an ad-hoc command (such as heavy tests, builds, or typechecks) on a configured compute worker or checkout when allowAdHoc is enabled in workspace worker preferences. Defaults workspace from the current session context when available; supply executable, argv, cwd, and optional env or choice. Use env for literal non-secret overrides only (e.g. CI=1, NODE_ENV=test); never put secrets or tokens in env (use environmentBindings for saved secrets). Follows configured approval policy and setup review, returns an inspectable operation (read via action.operations.get and projects.execution.output.read), and never automatically offloads arbitrary shell commands.'
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
    cli: id === 'projects.script.run'
      ? {
          acceptsServerId: true,
          inputSchema: ProjectScriptRunCliInputV1Schema,
          bindInput: bindProjectScriptRunCliInput,
          inputHints: {
            title: PROJECT_ACTION_COPY[id][0],
            description: PROJECT_ACTION_COPY[id][1],
            fields: [
              { path: 'name', title: 'Script name', widget: 'text' },
              { path: 'on', title: 'Worker machine id', widget: 'text' },
              { path: 'workspace', title: 'Qualified checkout', widget: 'json' },
              { path: 'selection', title: 'Selected script', widget: 'json' },
              { path: 'choice', title: 'Execution placement', widget: 'json' },
              { path: 'expectedEffectDigest', title: 'Reviewed Script effect', widget: 'text' },
              { path: 'memoryDemand', title: 'Memory demand', widget: 'json' },
            ],
          },
          commands: [{ path: ['project', 'script', 'run'], positionals: ['name'], visibility: 'canonical' as const }],
        }
      : id === 'projects.compute.exec'
      ? {
          acceptsServerId: true,
          inputSchema: ProjectComputeExecCliInputV1Schema,
          bindInput: bindProjectComputeExecCliInput,
          inputHints: {
            title: PROJECT_ACTION_COPY[id][0],
            description: PROJECT_ACTION_COPY[id][1],
            fields: [
              { path: 'executable', title: 'Executable', widget: 'text' },
              { path: 'argv', title: 'Arguments', widget: 'json' },
              { path: 'on', title: 'Worker machine id', widget: 'text' },
              { path: 'cwd', title: 'Working directory', widget: 'text' },
              { path: 'workspace', title: 'Qualified checkout', widget: 'json' },
              { path: 'env', title: 'Environment overrides', widget: 'json',
      description: 'Literal non-secret environment overrides only (e.g. CI=1, NODE_ENV=test). Never place secrets or tokens in env; use environmentBindings for saved secrets.' },
              { path: 'environmentBindings', title: 'Saved Secret references', widget: 'json' },
              { path: 'execution', title: 'Execution constraint', widget: 'select', options: [
                { value: 'primary', label: 'Primary Machine' }, { value: 'portable', label: 'Portable' },
              ] },
              { path: 'choice', title: 'Execution placement', widget: 'json' },
              { path: 'memoryDemand', title: 'Memory demand', widget: 'json' },
            ],
          },
          commands: [{ path: ['project', 'compute', 'exec'], positionals: ['executable'], variadicPositional: 'argv', visibility: 'canonical' as const }],
        }
      : { acceptsServerId: true, commands: [{ path: ['project', ...id.split('.').slice(1)], visibility: 'canonical' as const }] },
    inputSchema: PROJECT_ACTION_INPUT_SCHEMAS_V1[id], outputSchema: PROJECT_ACTION_OUTPUT_SCHEMAS_V1[id],
    ...(id !== 'projects.trust.list' && id !== 'projects.trust.revoke' ? {
      invocationServerIdForInput: actionInputServerId<(typeof PROJECT_ACTION_INPUT_SCHEMAS_V1)[ProjectActionIdV1]>(PROJECT_ACTION_INPUT_SCHEMAS_V1[id], input =>
        'workspace' in input ? input.workspace.serverId : 'serverId' in input ? input.serverId : undefined),
    } : {}),
    ...(!clientRead && !id.startsWith('projects.trust.') ? {
      operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } },
      completion: lazyDefinition(() => id === 'projects.prepare'
      ? createProjectCommandActionCompletionV1({ immediateResultSchema: ProjectPrepareNoLaunchResultV1Schema })
      : createProjectCommandActionCompletionV1()) } : {}),
    inputHints: { title: PROJECT_ACTION_COPY[id][0], description: PROJECT_ACTION_COPY[id][1], fields: PROJECT_ACTION_INPUT_FIELDS[id] },
  } satisfies PreNormalizedActionSpec;
}
function createProjectActionSpecsV1() {
  return PROJECT_ACTION_IDS_V1.map(id => row(id));
}

export const PROJECT_ACTION_SPECS_V1: ReturnType<typeof createProjectActionSpecsV1> = lazyActionSpecArray(createProjectActionSpecsV1);
