import { z } from 'zod';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2, type PersistedBackendTargetRefV2 } from '../../backends/targets/backendTargetRefV2.js';
import { assertNonEscalatingPermissionMode } from '../../actions/permissionPrivilege.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import type { ExecutionRunIntent } from '../../execution/runs/runPrimitives.js';
import type { ProviderBoundModelRef, SessionModelSelectionV1 } from '../../providers/selection/v1.js';
import type { RoleEngineV1, RoleRunsAsV1 } from '../../prompts/roles/roleArtifactV1.js';
import type { ResolvedRolesSnapshotV1 } from '../../prompts/roles/rolesV1.js';
import type { AgentPermissionIntentV1 } from '../../runtime/permissionIntentV1.js';
import type { SessionSpawnNewInputV2 } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import type { SessionAgentSpawnPolicyV1, SessionAgentStartOverridesV1 } from './sessionAgentSpawnPolicyV1.js';
import { SessionIdSchema } from '../../sessions/idsV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { DEFAULT_SESSION_AGENT_START_ALLOW_LISTS_V1, type SessionAgentStartAllowListsV1 } from './sessionAgentStartAllowListsV1.js';

/** Private field check; admitAgentStartV1 is the single public admission owner. */
function readSessionAgentStartPolicyDeniedField(
  policy: SessionAgentSpawnPolicyV1,
  overrides: SessionAgentStartOverridesV1,
): string | null {
  if (!policy.allowCustomDirectory && overrides.customDirectory) return 'directory';
  if (!policy.allowCrossMachine && overrides.crossMachine) return 'executionTarget.machineId';
  if (!policy.allowBackendTargetOverride && overrides.backendTarget) return 'agentTarget';
  if (!policy.allowModelOverride && overrides.modelSelection) return 'modelSelection';
  if (!policy.allowPermissionModeOverride && overrides.permissionMode) return 'permissionMode';
  if (!policy.allowAgentModeOverride && overrides.agentModeId) return 'agentModeId';
  if (!policy.allowConfigOptionOverrides && overrides.configOptions) return 'configuration.options';
  if (!policy.allowProfileOverride && overrides.profileId) return 'profileId';
  if (!policy.allowEnvironmentVariables && overrides.environmentVariables) return 'environmentVariables';
  if (!policy.allowConnectedServicesOverride && overrides.connectedServices) return 'connectedServices';
  if (!policy.allowMcpSelectionOverride && overrides.mcpSelection) return 'mcpSelection';
  if (!policy.allowTranscriptStorageOverride && overrides.transcriptStorage) return 'transcriptStorage';
  if (policy.permissionCeiling !== null && overrides.requiredPermissionMode !== undefined
    && (typeof overrides.requiredPermissionMode !== 'string'
    || !assertNonEscalatingPermissionMode({
      requestedMode: overrides.requiredPermissionMode,
      callerMode: policy.permissionCeiling,
    }).ok)) return 'permissionMode';
  return null;
}

export type Unresolved = Readonly<{ kind: 'unresolved' }>;
export type PermissionModeCeiling = AgentPermissionIntentV1;

type AgentStartConfigurationV1 = Readonly<{
  agentTarget?: PersistedBackendTargetRefV2;
  modelSelection?: ProviderBoundModelRef | SessionModelSelectionV1;
  permissionMode?: AgentPermissionIntentV1;
  agentModeId?: string;
  configOptions?: NonNullable<SessionSpawnNewInputV2['configuration']>['options'];
  profileId?: string;
  connectedServices?: SessionSpawnNewInputV2['connectedServices'];
  mcpSelection?: SessionSpawnNewInputV2['mcpSelection'];
  transcriptStorage?: SessionSpawnNewInputV2['transcriptStorage'];
}>;

type AgentStartClearFieldV1 = 'modelSelection' | 'agentModeId' | 'configOptions' | 'profileId' | 'connectedServices' | 'mcpSelection';
export type AgentStartFactsV1 = Readonly<{
  machineId?: string | Unresolved;
  directory?: string | Unresolved;
  /** Presence of explicit launch overrides; no environment values enter admission facts. */
  hasEnvironmentVariables?: boolean | Unresolved;
}> & { readonly [Key in keyof AgentStartConfigurationV1]?: AgentStartConfigurationV1[Key] | Unresolved
  | (Key extends AgentStartClearFieldV1 ? null : never) };

export type AgentStartBaselineV1 = Readonly<{
  machineId: string;
  directory: string;
  configuration?: AgentStartConfigurationV1;
}>;

/** FIN's role materializer is the sole producer of these accepted leaf selections. */
export type MaterializedWorkflowLeafV1 = Readonly<{
  blockId: string;
  sourceKey?: string;
  roleId?: string;
  runsAs: RoleRunsAsV1;
  workspaceWrites: 'allow' | 'deny';
  actionId?: string;
  facts: AgentStartFactsV1;
}> & (Readonly<{ kind: 'session' | 'detached_run'; engine: RoleEngineV1 }>
  | Readonly<{ kind: 'action'; engine?: RoleEngineV1 }>);

export type AgentStartRequestV1 =
  | Readonly<{ kind: 'spawn_new'; facts: AgentStartFactsV1; targetSessionId?: string; roleId?: string }>
  | Readonly<{ kind: 'execution_run'; facts: AgentStartFactsV1; source: 'execution_run' | 'review' | 'subagents_plan' | 'subagents_delegate' | 'voice_agent'; roleId?: string; backendTargets: readonly PersistedBackendTargetRefV2[]; intent: ExecutionRunIntent }>
  | (Readonly<{ kind: 'workflow_run_leaf'; targetSessionId?: string }> & (
    Readonly<{ leaf: MaterializedWorkflowLeafV1; selection?: undefined }>
    // Host-only Run admission for Action choices bound at invoke time. This
    // stamps the Run, never approves a child; FIN re-admits each concrete start
    // through this arm without `selection`, at the Run's frozen depth.
    | Readonly<{ leaf: Extract<MaterializedWorkflowLeafV1, { kind: 'action' }>; selection: 'deferred' }>
  ))
  | Readonly<{ kind: 'definition_write'; leaves: readonly MaterializedWorkflowLeafV1[] }>
  | Readonly<{ kind: 'trigger_write'; scope: 'session' | 'workflow'; targetSessionId?: string; leaves: readonly MaterializedWorkflowLeafV1[] }>
  // Role writes consume check 1 only; keeping them here avoids a second subtree policy owner.
  | Readonly<{ kind: 'session_target'; targetSessionId: string }>;

export const AgentStartSessionCallerV1Schema = z.object({
  kind: z.literal('session'),
  sessionId: asProtocolZod(SessionIdSchema),
  starterDepth: z.number().int().nonnegative().safe(),
  turnDepth: z.number().int().nonnegative().safe(),
}).strict();
export type AgentStartSessionCallerV1 = Readonly<z.infer<typeof AgentStartSessionCallerV1Schema>>;

export type AgentStartCallerV1 =
  | AgentStartSessionCallerV1
  | Readonly<{ kind: 'originless'; runId: string; runDepth: number; runOriginSessionId?: string }>;

/** Host caller depth projection shared by admission and authenticated Session witnesses. */
export function readAgentStartCallerWorkDepthV1(caller: AgentStartCallerV1): number {
  return caller.kind === 'session' ? Math.max(caller.starterDepth, caller.turnDepth) : caller.runDepth;
}

export type AgentStartContextV1 = Readonly<{
  /** Host-only present-user start; role binding still runs, agent restrictions do not. */
  initiator?: 'user';
  caller: AgentStartCallerV1;
  baseline: AgentStartBaselineV1;
  ledSubtreeSessionIds: readonly string[];
  workDepthLimit: number;
  roles: ResolvedRolesSnapshotV1;
  callerPermissionCeiling: PermissionModeCeiling;
  allowLists?: SessionAgentStartAllowListsV1;
}>;

export type StampedStartV1 = Readonly<{
  workDepth: number;
  engine?: RoleEngineV1;
  intent?: ExecutionRunIntent;
  profileId?: string;
  roleId?: string;
  workspaceWrites?: 'allow' | 'deny';
}>;
export const AGENT_START_REFUSAL_CODES_V1 = [
  'subtree_denied', 'role_target_unavailable', 'role_runs_as_mismatch', 'policy_denied_field',
  'permission_exceeds_ceiling', 'work_depth_exceeded', 'definition_exceeds_authority',
  'run_access_denied', 'target_unavailable',
] as const;
export type AgentStartRefusalV1 = Readonly<{
  code: (typeof AGENT_START_REFUSAL_CODES_V1)[number];
  field?: string;
  roleId?: string;
  blockId?: string;
  cause?: AgentStartRefusalV1;
}>;
export const AgentStartRefusalV1Schema: z.ZodType<AgentStartRefusalV1> = z.object({
  code: z.enum(AGENT_START_REFUSAL_CODES_V1),
  field: z.string().min(1).optional(),
  roleId: z.string().min(1).optional(),
  blockId: z.string().min(1).optional(),
  cause: z.lazy(() => AgentStartRefusalV1Schema).optional(),
}).strict();
export type AgentStartAdmissionV1 = Readonly<{ ok: true; stamped: StampedStartV1 }> | Readonly<{ ok: false; refusal: AgentStartRefusalV1 }>;

function isUnresolved(value: unknown): value is Unresolved {
  return value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'unresolved';
}

function modelRef(value: AgentStartFactsV1['modelSelection']) {
  return value && !isUnresolved(value) && 'ref' in value ? value.ref : value;
}

function differs(value: unknown, baseline: unknown): boolean {
  return value !== undefined && (isUnresolved(value) || !sameStrictJsonValue(value, baseline));
}

function deriveOverrides(facts: AgentStartFactsV1, baseline: AgentStartBaselineV1): SessionAgentStartOverridesV1 {
  const configuration = baseline.configuration;
  return {
    customDirectory: differs(facts.directory, baseline.directory),
    crossMachine: differs(facts.machineId, baseline.machineId),
    backendTarget: facts.agentTarget !== undefined && (isUnresolved(facts.agentTarget)
      || !configuration?.agentTarget
      || buildBackendTargetKeyV2(facts.agentTarget) !== buildBackendTargetKeyV2(configuration.agentTarget)),
    modelSelection: differs(modelRef(facts.modelSelection), modelRef(configuration?.modelSelection)),
    permissionMode: differs(facts.permissionMode, configuration?.permissionMode),
    agentModeId: differs(facts.agentModeId, configuration?.agentModeId),
    configOptions: differs(facts.configOptions, configuration?.configOptions),
    profileId: differs(facts.profileId, configuration?.profileId),
    environmentVariables: facts.hasEnvironmentVariables === true || isUnresolved(facts.hasEnvironmentVariables),
    connectedServices: differs(facts.connectedServices, configuration?.connectedServices),
    mcpSelection: differs(facts.mcpSelection, configuration?.mcpSelection),
    transcriptStorage: differs(facts.transcriptStorage, configuration?.transcriptStorage),
    requiredPermissionMode: facts.permissionMode ?? configuration?.permissionMode,
  };
}

export function admitAgentStartV1(
  policy: SessionAgentSpawnPolicyV1,
  request: AgentStartRequestV1,
  context: AgentStartContextV1,
): AgentStartAdmissionV1 {
  const allowLists = context.allowLists ?? DEFAULT_SESSION_AGENT_START_ALLOW_LISTS_V1;
  const workDepth = context.initiator === 'user' ? 0 : readAgentStartCallerWorkDepthV1(context.caller) + 1;
  const refuse = (refusal: AgentStartRefusalV1): AgentStartAdmissionV1 => ({ ok: false, refusal });
  const targetSessionId = 'targetSessionId' in request ? request.targetSessionId : undefined;
  if (targetSessionId !== undefined && context.initiator !== 'user') {
    const ownSessionId = context.caller.kind === 'session' ? context.caller.sessionId : context.caller.runOriginSessionId;
    if (!ownSessionId || (targetSessionId !== ownSessionId && !context.ledSubtreeSessionIds.includes(targetSessionId))) {
      return refuse({ code: 'subtree_denied' });
    }
  }
  if (request.kind === 'session_target') return { ok: true, stamped: { workDepth } };

  // An originless Run has no Session configuration to inherit or compare against.
  const baseline: AgentStartBaselineV1 = context.caller.kind === 'session'
    ? context.baseline
    : { machineId: context.baseline.machineId, directory: context.baseline.directory };

  const checkSelection = (
    facts: AgentStartFactsV1,
    roleId: string | undefined,
    directKind: 'spawn_new' | 'execution_run' | undefined,
    targets: readonly PersistedBackendTargetRefV2[],
    materialized?: MaterializedWorkflowLeafV1,
    requestedIntent?: ExecutionRunIntent,
    deferredSelection = false,
  ): AgentStartAdmissionV1 => {
    const role = roleId === undefined ? undefined : context.roles[roleId];
    if (roleId !== undefined && (!role || !role.enabled)) return refuse({ code: 'role_target_unavailable', roleId });
    if (role && directKind && role.runsAs.kind !== (directKind === 'spawn_new' ? 'session' : 'background_run')) {
      return refuse({ code: 'role_runs_as_mismatch', roleId });
    }
    if (role?.profileUnavailable) return refuse({ code: 'target_unavailable', roleId });
    const engine = materialized?.engine ?? role?.engine;
    if (role && directKind && !engine) return refuse({ code: 'target_unavailable', roleId });
    let effectiveFacts = facts;
    let effectiveTargets = targets;
    if (engine) {
      const parsedTarget = (() => {
        try { return parseBackendTargetKeyV2(engine.agentTargetKey); } catch { return null; }
      })();
      if (!parsedTarget) return refuse({ code: 'target_unavailable', ...(roleId ? { roleId } : {}) });
      if (directKind) {
        const inheritedModel = modelRef(baseline.configuration?.modelSelection);
        const providerConnectionId = inheritedModel && !isUnresolved(inheritedModel)
          && inheritedModel.agentTargetKey === engine.agentTargetKey ? inheritedModel.providerConnectionId : null;
        effectiveFacts = {
          ...facts,
          agentTarget: parsedTarget,
          modelSelection: engine.modelId ? { agentTargetKey: engine.agentTargetKey, providerConnectionId, modelId: engine.modelId } : undefined,
          profileId: role?.profileId,
          ...(engine.effort ? { configOptions: {
            ...(!isUnresolved(facts.configOptions) ? facts.configOptions : {}),
            reasoning_effort: { value: engine.effort, updatedAtMs: baseline.configuration?.configOptions?.reasoning_effort?.updatedAtMs ?? 0 },
          } } : {}),
        };
        effectiveTargets = [parsedTarget];
      } else {
        // FIN has already materialized precedence. Never rebind its accepted facts from Settings.
        effectiveFacts = {
          ...facts,
          agentTarget: facts.agentTarget ?? parsedTarget,
          ...(facts.modelSelection === undefined && engine.modelId
            ? { modelSelection: { agentTargetKey: engine.agentTargetKey, providerConnectionId: null, modelId: engine.modelId } }
            : {}),
        };
        effectiveTargets = [parsedTarget];
      }
    } else if (targets.length > 0 && facts.agentTarget === undefined) {
      effectiveFacts = { ...facts, agentTarget: targets[0] };
    }

    const permissionMode = effectiveFacts.permissionMode ?? baseline.configuration?.permissionMode ?? context.callerPermissionCeiling;
    // Unknown choices are checked when bound. Every known choice still passes
    // the same policy owner now; ordinary starts and authoring remain closed.
    const knownFacts: AgentStartFactsV1 = deferredSelection
      ? Object.fromEntries(Object.entries(effectiveFacts).filter(([, value]) => !isUnresolved(value)))
      : effectiveFacts;
    const overrides = deriveOverrides(knownFacts, baseline);
    const deniedField = readSessionAgentStartPolicyDeniedField(policy, {
      ...overrides,
      requiredPermissionMode: deferredSelection && isUnresolved(permissionMode) ? undefined : permissionMode,
      backendTarget: overrides.backendTarget || effectiveTargets.some((target) => differs(
        buildBackendTargetKeyV2(target),
        baseline.configuration?.agentTarget ? buildBackendTargetKeyV2(baseline.configuration.agentTarget) : undefined,
      )),
    });
    if (context.initiator !== 'user' && deniedField) return refuse({ code: 'policy_denied_field', field: deniedField });
    if (context.initiator !== 'user' && roleId !== undefined && allowLists.allowedRoleIds !== null && !allowLists.allowedRoleIds.includes(roleId)) {
      return refuse({ code: 'policy_denied_field', field: 'roleId' });
    }
    const effectiveTarget = effectiveFacts.agentTarget ?? baseline.configuration?.agentTarget;
    if (!deferredSelection && (Object.values(effectiveFacts).some(isUnresolved) || !effectiveTarget || isUnresolved(effectiveTarget))) {
      return refuse({ code: 'target_unavailable' });
    }
    const allowedAgentTargetKeys = allowLists.allowedAgentTargetKeys;
    const knownTargets = effectiveTarget && !isUnresolved(effectiveTarget) ? [effectiveTarget, ...effectiveTargets] : effectiveTargets;
    if (context.initiator !== 'user' && allowedAgentTargetKeys !== null && knownTargets
      .some((target) => !allowedAgentTargetKeys.includes(buildBackendTargetKeyV2(target)))) {
      return refuse({ code: 'policy_denied_field', field: 'agentTarget' });
    }
    if (isUnresolved(permissionMode) ? !deferredSelection
      : context.initiator !== 'user' && !assertNonEscalatingPermissionMode({ requestedMode: permissionMode, callerMode: context.callerPermissionCeiling }).ok) {
      return refuse({ code: 'permission_exceeds_ceiling' });
    }
    if (deferredSelection) return { ok: true, stamped: { workDepth } };
    if (!effectiveTarget || isUnresolved(effectiveTarget)) return refuse({ code: 'target_unavailable' });
    const selection = modelRef(effectiveFacts.modelSelection ?? baseline.configuration?.modelSelection);
    const stampedEngine: RoleEngineV1 = engine ?? {
      agentTargetKey: buildBackendTargetKeyV2(effectiveTarget),
      ...(selection && !isUnresolved(selection) ? { modelId: selection.modelId } : {}),
    };
    const runsAs = materialized?.runsAs ?? role?.runsAs;
    const intent = runsAs?.kind === 'background_run' ? runsAs.intent : requestedIntent;
    const profileId = roleId !== undefined
      ? directKind ? role?.profileId : effectiveFacts.profileId
      : effectiveFacts.profileId ?? baseline.configuration?.profileId;
    return { ok: true, stamped: {
      workDepth, engine: stampedEngine,
      ...((materialized?.workspaceWrites ?? role?.workspaceWrites) !== undefined
        ? { workspaceWrites: materialized?.workspaceWrites ?? role?.workspaceWrites }
        : {}),
      ...(intent ? { intent } : {}),
      ...(typeof profileId === 'string' ? { profileId } : {}),
      ...(roleId ? { roleId } : {}),
    } };
  };

  if (request.kind === 'definition_write' || request.kind === 'trigger_write') {
    if (request.kind === 'trigger_write' && workDepth > context.workDepthLimit) return refuse({ code: 'work_depth_exceeded' });
    for (const leaf of request.leaves) {
      const admission = checkSelection(leaf.facts, leaf.roleId, undefined, [], leaf);
      if (!admission.ok) return refuse({ code: 'definition_exceeds_authority', blockId: leaf.blockId, cause: admission.refusal });
    }
    return { ok: true, stamped: { workDepth } };
  }
  const admission = request.kind === 'workflow_run_leaf'
    ? checkSelection(request.leaf.facts, request.leaf.roleId, undefined, [], request.leaf, undefined, request.selection === 'deferred')
    : checkSelection(request.facts, request.roleId, request.kind, request.kind === 'execution_run' ? request.backendTargets : [], undefined, request.kind === 'execution_run' ? request.intent : undefined);
  if (!admission.ok) return admission;
  // A direct Workflow creates a Run before its leaf; an originless caller is
  // already that frozen Run. Keep the Run stamp distinct from leaf admission.
  const startedWorkDepth = request.kind === 'workflow_run_leaf' && request.selection !== 'deferred' && context.caller.kind === 'session'
    ? workDepth + 1 : workDepth;
  return context.initiator !== 'user' && startedWorkDepth > context.workDepthLimit ? refuse({ code: 'work_depth_exceeded' }) : admission;
}
