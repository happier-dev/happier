import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { CallerInputConstraintsV1Schema, type CallerInputConstraintsV1 } from './callerInputConstraintsV1.js';
export { CallerInputConstraintsV1Schema, type CallerInputConstraintsV1 } from './callerInputConstraintsV1.js';
import { ACTION_ID_FAMILIES_V1, ActionIdFamilyV1Schema, type ActionIdFamilyV1 } from '../actions/actionIds.js';
import { DECISION_ACTION_IDS } from '../actions/decisionAuthority.js';
import type { ExternalActionTargetV1 } from '../actions/externalActionApi.js';
import { AgentExecutionTargetV1Schema } from '../agents/executionTargetV1.js';
import { buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { CanonicalHttpOriginSchema } from '../http/canonicalHttpOrigin.js';
import { ProviderAgentTargetKeySchema } from '../providers/ids.js';
import { isNativeAutomaticModelSelectionInputV1, type ProviderBoundModelRef } from '../providers/selection/v1.js';
import type { SocketRpcSessionWriteAuthorityV1 } from '../rpc/index.js';
import { SessionDirectoryIntentV1Schema } from '../sessions/creation/sessionDirectoryIntentV1.js';
import { SessionExecutionTargetV1Schema } from '../sessions/creation/sessionExecutionTargetV1.js';
import { SessionOrganizationPlacementV1Schema, type SessionOrganizationPlacementV1 } from '../sessions/creation/sessionSpawnNewResultV1.js';
import type { SessionPermissionMode } from '../sessions/metadata/sessionPermissionModes.js';
import { parseAgentPermissionIntentV1Alias, type AgentPermissionIntentV1 } from '../runtime/permissionIntentV1.js';
import { parseQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';
import { SessionSpawnNewInputV2BaseSchema, SessionSpawnNewInputV2Schema } from '../sessions/creation/sessionSpawnNewInputV2.js';

/** Prompt-free admission projection; ordinary Session input retains private custody. */
export const ApiTokenSessionSpawnAdmissionV1Schema = lazyZodSchema(() => SessionSpawnNewInputV2BaseSchema.pick({
  executionTarget: true, agentTarget: true, directory: true, organizationPlacement: true,
  modelSelection: true, permissionMode: true,
}).strict());
export type ApiTokenSessionSpawnAdmissionV1 = z.infer<typeof ApiTokenSessionSpawnAdmissionV1Schema>;
export function projectApiTokenSessionSpawnAdmissionV1(input: unknown): ApiTokenSessionSpawnAdmissionV1 {
  const canonical = SessionSpawnNewInputV2Schema.parse(input);
  return ApiTokenSessionSpawnAdmissionV1Schema.parse({
    executionTarget: canonical.executionTarget, agentTarget: canonical.agentTarget, directory: canonical.directory,
    ...(canonical.organizationPlacement !== undefined ? { organizationPlacement: canonical.organizationPlacement } : {}),
    ...(canonical.modelSelection !== undefined ? { modelSelection: canonical.modelSelection } : {}),
    ...(canonical.permissionMode !== undefined ? { permissionMode: canonical.permissionMode } : {}),
  });
}

export const ApiTokenGrantOriginV1Schema = lazyZodSchema(() => CanonicalHttpOriginSchema.refine((value) => {
  // Zod runs refinements after a dirty superRefine; invalid input must stay a typed refusal.
  if (!CanonicalHttpOriginSchema.safeParse(value).success) return false;
  const url = new URL(value);
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}, 'Grant origins require HTTPS, except HTTP on loopback.'));

const GrantIdSchema = lazyZodSchema(() => z.string().min(1));
const modelKey = (ref: ProviderBoundModelRef) => JSON.stringify([ref.agentTargetKey, ref.providerConnectionId, ref.modelId]);

export const ApiTokenGrantV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  actions: z.object({ families: z.array(ActionIdFamilyV1Schema), ids: z.array(GrantIdSchema) }).strict().nullable(),
  targets: z.object({ sessions: z.array(GrantIdSchema), machines: z.array(GrantIdSchema) }).strict().nullable(),
  approve: z.boolean(),
  origins: z.array(ApiTokenGrantOriginV1Schema),
  models: CallerInputConstraintsV1Schema.shape.models,
  permissionModes: CallerInputConstraintsV1Schema.shape.permissionModes,
  create: z.object({
    machineId: GrantIdSchema,
    agentTargetKey: ProviderAgentTargetKeySchema,
    directory: z.literal('managed'),
    placement: SessionOrganizationPlacementV1Schema,
  }).strict().nullable(),
}).strict().superRefine((value, context) => {
  const lists: ReadonlyArray<readonly [readonly string[], readonly (string | number)[]]> = [
    [value.origins, ['origins']],
    ...(value.actions ? [[value.actions.families, ['actions', 'families']], [value.actions.ids, ['actions', 'ids']]] as const : []),
    ...(value.targets ? [[value.targets.sessions, ['targets', 'sessions']], [value.targets.machines, ['targets', 'machines']]] as const : []),
    ...(value.models ? [[value.models.map(modelKey), ['models']]] as const : []),
    ...(value.permissionModes ? [[value.permissionModes, ['permissionModes']]] as const : []),
  ];
  for (const [list, path] of lists) if (new Set(list).size !== list.length) context.addIssue({ code: 'custom', path: [...path], message: 'Grant entries must be unique.' });
  if (value.actions && !value.actions.families.length && !value.actions.ids.length) context.addIssue({ code: 'custom', path: ['actions'], message: 'A restricted action grant must be nonempty.' });
  if (value.targets && !value.targets.sessions.length && !value.targets.machines.length) context.addIssue({ code: 'custom', path: ['targets'], message: 'A restricted target grant must be nonempty.' });
  if (value.create && value.targets && !value.targets.machines.includes(value.create.machineId)) {
    context.addIssue({ code: 'custom', path: ['create', 'machineId'], message: 'The creation machine must belong to the grant targets.' });
  }
}));
export type ApiTokenGrantV1 = z.infer<typeof ApiTokenGrantV1Schema>;
export const StoredApiTokenGrantV1Schema = createStoredReadSchema(ApiTokenGrantV1Schema);

export const API_TOKEN_FULL_GRANT_V1: ApiTokenGrantV1 = Object.freeze({
  v: 1, actions: null, targets: null, approve: false, origins: [], models: null, permissionModes: null, create: null,
});

export function isApiTokenGrantRestrictedV1(grant: ApiTokenGrantV1): boolean {
  return grant.actions !== null || grant.targets !== null || grant.models !== null || grant.permissionModes !== null || grant.create !== null;
}

const DISCOVERY_IDS = new Set(['action.spec.search', 'action.spec.get', 'action.options.resolve']);
function actionGranted(grant: ApiTokenGrantV1, actionId: string, contributedQualifiedId?: string, contributedActionAdmission?: 'pre_open'): boolean {
  if (actionId === 'session.user_action.answer') actionId = 'session.message.send';
  if (DISCOVERY_IDS.has(actionId)) return true;
  if ((DECISION_ACTION_IDS as readonly string[]).includes(actionId)) return grant.approve;
  if (actionId === 'action.invoke') {
    if (grant.actions === null) return contributedQualifiedId !== undefined || contributedActionAdmission === 'pre_open';
    if (contributedQualifiedId !== undefined) return !!grant.actions?.ids.includes(contributedQualifiedId);
    return contributedActionAdmission === 'pre_open'
      && grant.actions?.ids.some((id) => parseQualifiedPluginActionId(id) !== null) === true;
  }
  return grant.actions === null || grant.actions.ids.includes(actionId)
    || grant.actions.families.some((family) => (ACTION_ID_FAMILIES_V1[family] as readonly string[]).includes(actionId));
}

export function isApiTokenGrantTargetMemberV1(grant: ApiTokenGrantV1, target?: ExternalActionTargetV1 | null, targetMachineId?: string | null): boolean {
  if (grant.targets === null) return true;
  if (!target) return false;
  return target.kind === 'machine'
    ? grant.targets.machines.includes(target.machineId)
    : grant.targets.sessions.includes(target.sessionId) || (!!targetMachineId && grant.targets.machines.includes(targetMachineId));
}

function placementsEqual(a: SessionOrganizationPlacementV1, b: SessionOrganizationPlacementV1): boolean {
  return a.folderId === b.folderId && a.tagIds.length === b.tagIds.length && a.tagIds.every((tag, index) => tag === b.tagIds[index]);
}

/** All transports call this owner; encrypted spawn fields are decisively rechecked by the daemon. */
export function evaluateApiTokenGrantV1(input: Readonly<{
  grant: ApiTokenGrantV1;
  actionId: string;
  contributedQualifiedId?: string;
  /** Host-only opaque ingress/currentness stage. Execution must supply the resolved identity. */
  contributedActionAdmission?: 'pre_open';
  spawnInput?: unknown;
  target?: ExternalActionTargetV1 | null;
  targetMachineId?: string | null;
}>): { ok: true } | { ok: false; reason: 'action_not_granted' | 'target_required' | 'target_not_granted' | 'create_not_granted' } {
  const { grant, actionId, target } = input;
  if (!actionGranted(grant, actionId, input.contributedQualifiedId, input.contributedActionAdmission)) return { ok: false, reason: 'action_not_granted' };
  if (DISCOVERY_IDS.has(actionId)) return { ok: true };
  if (actionId === 'session.spawn_new' && grant.create !== null) {
    const binding = grant.create;
    if (target?.kind !== 'machine' || target.machineId !== binding.machineId) return { ok: false, reason: 'create_not_granted' };
    if (input.spawnInput !== undefined) {
      const raw = input.spawnInput;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'create_not_granted' };
      const fields = raw as Record<string, unknown>;
      const execution = SessionExecutionTargetV1Schema.safeParse(fields.executionTarget);
      // API projection puts Machine identity in the verified envelope target;
      // the host binds executionTarget before the strict execution-stage check.
      const projectedApiTarget = input.contributedActionAdmission === 'pre_open'
        && fields.executionTarget === undefined;
      const agent = AgentExecutionTargetV1Schema.safeParse(fields.agentTarget);
      const directory = SessionDirectoryIntentV1Schema.safeParse(fields.directory);
      const placement = SessionOrganizationPlacementV1Schema.safeParse(fields.organizationPlacement);
      if ((!projectedApiTarget && (!execution.success || execution.data.machineId !== binding.machineId))
        || !agent.success || buildBackendTargetKeyV2(agent.data) !== binding.agentTargetKey
        || !directory.success || directory.data.kind !== 'managed'
        || !placement.success || !placementsEqual(placement.data, binding.placement)) return { ok: false, reason: 'create_not_granted' };
    }
    return { ok: true };
  }
  if (grant.targets !== null && !target) return { ok: false, reason: 'target_required' };
  return isApiTokenGrantTargetMemberV1(grant, target, input.targetMachineId) ? { ok: true } : { ok: false, reason: 'target_not_granted' };
}

export function isApiTokenGrantWithinV1(child: ApiTokenGrantV1, parent: ApiTokenGrantV1): boolean {
  const subset = (c: readonly string[] | null, p: readonly string[] | null) => p === null || (c !== null && c.every((item) => p.includes(item)));
  if (child.approve && !parent.approve || !subset(child.origins, parent.origins)
    || !subset(child.models?.map(modelKey) ?? null, parent.models?.map(modelKey) ?? null)
    || !subset(child.permissionModes?.map((mode) => parseAgentPermissionIntentV1Alias(mode)!) ?? null,
      parent.permissionModes?.map((mode) => parseAgentPermissionIntentV1Alias(mode)!) ?? null)) return false;
  if (parent.actions !== null) {
    if (child.actions === null) return false;
    const ordinaryIdWithin = (id: string) => (DECISION_ACTION_IDS as readonly string[]).includes(id)
      || actionGranted(parent, id);
    if (!child.actions.ids.every(ordinaryIdWithin)
      || !child.actions.families.every((family: ActionIdFamilyV1) => parent.actions!.families.includes(family) || (ACTION_ID_FAMILIES_V1[family] as readonly string[]).every(ordinaryIdWithin))) return false;
  }
  if (parent.targets !== null && (child.targets === null
    || !subset(child.targets.sessions, parent.targets.sessions)
    || !subset(child.targets.machines, parent.targets.machines))) return false;
  if (actionGranted(child, 'session.spawn_new')) {
    if (parent.create !== null) {
      if (child.create === null || child.create.machineId !== parent.create.machineId
        || child.create.agentTargetKey !== parent.create.agentTargetKey
        || !placementsEqual(child.create.placement, parent.create.placement)) return false;
    } else if (child.create !== null && !isApiTokenGrantTargetMemberV1(parent, { kind: 'machine', machineId: child.create.machineId })) return false;
  }
  return true;
}

export function isModelRefGrantedV1(constraints: CallerInputConstraintsV1, ref: ProviderBoundModelRef | 'automatic'): boolean {
  return constraints.models === null || (ref !== 'automatic'
    && !isNativeAutomaticModelSelectionInputV1(ref)
    && constraints.models.some((candidate) => modelKey(candidate) === modelKey(ref)));
}
/** Keep a permitted selection, or use the first permitted model in grant order. */
export function resolveEffectiveApiTokenModelRefV1(
  constraints: Pick<CallerInputConstraintsV1, 'models'>,
  current: ProviderBoundModelRef | 'automatic' = 'automatic',
  agentTargetKey?: string,
): ProviderBoundModelRef | 'automatic' | null {
  const models = constraints.models === null ? null
    : constraints.models.filter((ref) => agentTargetKey === undefined || ref.agentTargetKey === agentTargetKey);
  if (models === null) return current === 'automatic' || agentTargetKey === undefined
    || current.agentTargetKey === agentTargetKey ? current : 'automatic';
  const input = { models, permissionModes: null };
  if ((current === 'automatic' || agentTargetKey === undefined || current.agentTargetKey === agentTargetKey)
    && isModelRefGrantedV1(input, current)) return current;
  return models?.find((candidate) => isModelRefGrantedV1(input, candidate)) ?? null;
}
/** Shared creation/session default, retaining a permitted choice in canonical intent vocabulary. */
export function resolveEffectiveApiTokenPermissionModeV1(
  constraints: Pick<CallerInputConstraintsV1, 'permissionModes'>,
  current?: SessionPermissionMode,
): AgentPermissionIntentV1 | null {
  if (current !== undefined && isPermissionModeGrantedV1({ ...constraints, models: null }, current)) {
    return parseAgentPermissionIntentV1Alias(current);
  }
  const mode = constraints.permissionModes === null ? 'default' : constraints.permissionModes[0];
  return mode === undefined ? null : parseAgentPermissionIntentV1Alias(mode);
}
export function isPermissionModeGrantedV1(constraints: CallerInputConstraintsV1, mode: SessionPermissionMode): boolean {
  const intent = parseAgentPermissionIntentV1Alias(mode);
  return constraints.permissionModes === null || (intent !== null
    && constraints.permissionModes.some((candidate) => parseAgentPermissionIntentV1Alias(candidate) === intent));
}
export function isOriginAllowedByApiTokenGrantV1(grant: ApiTokenGrantV1, origin: string): boolean {
  return ApiTokenGrantOriginV1Schema.safeParse(origin).success && grant.origins.includes(origin);
}
export function resolveApiTokenSessionCapabilityCeilingV1(grant: ApiTokenGrantV1): ReadonlySet<SocketRpcSessionWriteAuthorityV1> {
  const capabilities = new Set<SocketRpcSessionWriteAuthorityV1>(['readTranscript']);
  if (actionGranted(grant, 'session.message.send') || actionGranted(grant, 'session.turn.cancel')) capabilities.add('submitAgentInput');
  if (actionGranted(grant, 'session.stop')) capabilities.add('stopSession');
  if (actionGranted(grant, 'session.archive')) capabilities.add('archiveSession');
  if (grant.approve) capabilities.add('approveRuntimePermissions');
  return capabilities;
}
