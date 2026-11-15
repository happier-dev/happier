import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { ExecutionRunIntentSchema } from '../../execution/runs/runPrimitives.js';
import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderModelIdSchema } from '../../providers/ids.js';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2, readBackendTargetRefV2 } from '../../backends/targets/backendTargetRefV2.js';
import type { AgentExecutionTargetV1 } from '../../agents/executionTargetV1.js';
import type { ProviderBoundModelRef, SessionModelSelectionV1 } from '../../providers/selection/v1.js';
import type { AcpConfigOptionOverridesV1 } from '../../sessions/metadata/metadataOverridesV1.js';
import { PROVIDER_REASONING_EFFORT_OPTION_ID } from '../../providers/catalog/reasoningEffort.js';

/** Role V1 is an executable declaration: every object boundary is closed. */
export const RoleEngineV1Schema = lazyZodSchema(() => z.strictObject({
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: z.optional(ProviderModelIdSchema),
  /** The Provider connection serving `modelId`; absent for the Agent's native models (and every 0.2 role). */
  providerConnectionId: z.optional(ProviderConnectionIdSchema),
  effort: z.optional(z.string().check(z.minLength(1))),
}));
export type RoleEngineV1 = z.infer<typeof RoleEngineV1Schema>;

/** A model ref's fields on a role engine: the model and, when a Provider connection serves it, that connection. */
export function roleEngineModelFieldsV1(ref: ProviderBoundModelRef | null | undefined): Pick<RoleEngineV1, 'modelId' | 'providerConnectionId'> {
  return { ...(ref?.modelId ? { modelId: ref.modelId } : {}), ...(ref?.providerConnectionId ? { providerConnectionId: ref.providerConnectionId } : {}) };
}

/**
 * The one model ref a role engine runs: its own Provider connection, else the
 * connection the same Agent already runs on (the parent's or baseline's), else
 * the Agent's native model. No model of its own is no ref.
 */
export function readRoleEngineModelRefV1(
  engine: Pick<RoleEngineV1, 'agentTargetKey' | 'modelId' | 'providerConnectionId'>,
  inherited?: ProviderBoundModelRef | null,
): ProviderBoundModelRef | undefined {
  if (!engine.modelId) return undefined;
  const providerConnectionId = engine.providerConnectionId
    ?? (inherited?.agentTargetKey === engine.agentTargetKey ? inherited.providerConnectionId : null);
  return providerConnectionId
    ? { agentTargetKey: engine.agentTargetKey, providerConnectionId, modelId: engine.modelId }
    : { agentTargetKey: engine.agentTargetKey, providerConnectionId: null, modelId: engine.modelId };
}

/** The engine fields of a Session-authoring selection: what the shared engine picker reads and writes. */
export type RoleEngineSessionSelectionV1 = Readonly<{
  agentTarget?: AgentExecutionTargetV1;
  modelSelection?: SessionModelSelectionV1 | null;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
}>;

/** A role's `effort` as the Agent's `reasoning_effort` option override, and back. */
export function roleEffortToSessionConfigOptionOverridesV1(effort: string | undefined): AcpConfigOptionOverridesV1 | null {
  return effort ? { v: 1, updatedAt: 0, overrides: { [PROVIDER_REASONING_EFFORT_OPTION_ID]: { value: effort, updatedAt: 0 } } } : null;
}
export function readRoleEffortFromSessionConfigOptionOverridesV1(overrides: AcpConfigOptionOverridesV1 | null | undefined): string | undefined {
  const effort = overrides?.overrides[PROVIDER_REASONING_EFFORT_OPTION_ID]?.value;
  return typeof effort === 'string' && effort ? effort : undefined;
}

/**
 * A stored role engine as the shared picker's selection. A role's `effort` is
 * the Agent's `reasoning_effort` option (the id admission stamps back); a
 * retained `backend:` key reads as its canonical Agent target.
 */
export function roleEngineToSessionSelectionV1(engine: RoleEngineV1 | undefined): RoleEngineSessionSelectionV1 {
  if (!engine) return {};
  let agentTargetKey: string;
  try {
    agentTargetKey = buildBackendTargetKeyV2(readBackendTargetRefV2(engine.agentTargetKey));
  } catch {
    return {};
  }
  const target = parseBackendTargetKeyV2(agentTargetKey);
  if (target.kind !== 'agent') return {};
  const agentTarget: AgentExecutionTargetV1 = { kind: 'agent', identity: target.identity,
    ...(target.definitionId === undefined ? {} : { definitionId: target.definitionId }) };
  return {
    agentTarget,
    modelSelection: engine.modelId ? { v: 1, updatedAt: 0, ref: readRoleEngineModelRefV1({ ...engine, agentTargetKey, modelId: engine.modelId })! } : null,
    sessionConfigOptionOverrides: roleEffortToSessionConfigOptionOverridesV1(engine.effort),
  };
}

/** The canonical role engine a picker selection writes; no Agent is no engine of its own. */
export function sessionSelectionToRoleEngineV1(selection: RoleEngineSessionSelectionV1): RoleEngineV1 | undefined {
  if (!selection.agentTarget) return undefined;
  const effort = readRoleEffortFromSessionConfigOptionOverridesV1(selection.sessionConfigOptionOverrides);
  return {
    agentTargetKey: buildBackendTargetKeyV2(selection.agentTarget),
    ...roleEngineModelFieldsV1(selection.modelSelection?.ref),
    ...(effort ? { effort } : {}),
  };
}

export const RoleRunsAsV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session') }),
  z.strictObject({ kind: z.literal('background_run'), intent: ExecutionRunIntentSchema }),
]));
export type RoleRunsAsV1 = z.infer<typeof RoleRunsAsV1Schema>;

/** All role editors use the task profile when a session role becomes a background run. */
export const DEFAULT_ROLE_BACKGROUND_INTENT_V1 = 'task' as const;

export function resolveRoleRunsAsKindV1(kind: RoleRunsAsV1['kind'], current?: RoleRunsAsV1): RoleRunsAsV1 {
  return kind === 'session' ? { kind: 'session' } : {
    kind: 'background_run',
    intent: current?.kind === 'background_run' ? current.intent : DEFAULT_ROLE_BACKGROUND_INTENT_V1,
  };
}

export const RoleArtifactV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.string().check(z.minLength(1)),
  instructions: z.string(),
  engine: z.optional(RoleEngineV1Schema),
  runsAs: RoleRunsAsV1Schema,
  profileId: z.optional(z.string().check(z.minLength(1))),
  workspaceWrites: z.enum(['allow', 'deny']),
  secondOpinion: z.enum(['off', 'encouraged']),
  canDelegateToOtherRoles: z.optional(z.boolean()),
  enabled: z.boolean(),
}));
export type RoleArtifactV1 = z.infer<typeof RoleArtifactV1Schema>;

/** Ordinary Role writers and restores share one body-derived header projection. */
export function buildRoleArtifactHeaderV1(role: RoleArtifactV1): Readonly<Record<string, unknown>> {
  return { kind: 'role.v1', name: role.name };
}
