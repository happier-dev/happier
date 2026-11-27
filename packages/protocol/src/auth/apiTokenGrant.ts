import { lazyZodSchema } from '../lazyZodSchema.js';
import { API_TOKEN_ENVIRONMENT_ACTION_IDS_V1, API_TOKEN_DISCOVERY_ACTION_IDS_V1, API_TOKEN_APPROVAL_OBSERVATION_ACTION_IDS_V1 } from './apiTokenActionIdsV1.js';
export { API_TOKEN_ENVIRONMENT_ACTION_IDS_V1 } from './apiTokenActionIdsV1.js';
import { z } from '../zodRuntimePolicy.js';
import type { ApiTokenGrantDenialReasonV1 } from './apiTokenGrantDenialReasonV1.js';
export { ApiTokenGrantDenialReasonV1Schema, type ApiTokenGrantDenialReasonV1 } from './apiTokenGrantDenialReasonV1.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';
import { CallerInputConstraintsV1Schema, type CallerInputConstraintsV1 } from './callerInputConstraintsV1.js';
export { CallerInputConstraintsV1Schema, type CallerInputConstraintsV1 } from './callerInputConstraintsV1.js';
import { ACTION_ID_FAMILIES_V1, ActionIdFamilyV1Schema, DECISION_ACTION_IDS, SESSION_MESSAGE_SEND_ACTION_ID_V1, type ActionIdFamilyV1 } from '../actions/actionIds.js';
import type { ExternalActionTargetV1 } from '../actions/externalActionApi.js';
import { AgentExecutionTargetV1Schema } from '../agents/executionTargetV1.js';
import { buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { CanonicalHttpOriginSchema } from '../http/canonicalHttpOrigin.js';
import { ProviderAgentTargetKeySchema } from '../providers/ids.js';
import type { SessionModelRefV2 } from '../providers/selection/v2.js';
import { isNativeAutomaticModelSelectionInputV1, type ProviderBoundModelRef } from '../providers/selection/v1.js';
import type { SocketRpcSessionWriteAuthorityV1 } from '../rpc/index.js';
import { SessionDirectoryIntentV1Schema } from '../sessions/creation/sessionDirectoryIntentV1.js';
import { SessionExecutionTargetV1Schema } from '../sessions/creation/sessionExecutionTargetV1.js';
import { SessionOrganizationPlacementV1Schema, SessionSectionPlacementV1Schema, type SessionOrganizationPlacementV1 } from '../sessions/creation/sessionSpawnNewResultV1.js';
import type { SessionPermissionMode } from '../sessions/metadata/sessionPermissionModes.js';
import { parseAgentPermissionIntentV1Alias, type AgentPermissionIntentV1 } from '../runtime/permissionIntentV1.js';
import { parseQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';
import { SessionSpawnNewInputV2BaseSchema, SessionSpawnNewTargetedAuthoringInputV2Schema } from '../sessions/creation/sessionSpawnNewInputV2.js';
import { ConnectedServiceBindingsV2Schema, type ConnectedServiceBindingsV2 } from '../connect/connectedServiceBindings.js';
import { DeploymentIdentifierV1Schema } from '../deployments/deploymentIdentifiersV1.js';
import { BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '../bots/templates/botTemplateActionIdsV1.js';
import { ManagedPresetSelectionV1Schema } from '../machines/managed/managedConfigurationV1.js';
import { ManagedControllerV1Schema } from '../machines/managed/managedMachineV1.js';
import type { ManagedAcquireInputV1 } from '../machines/managed/actionsV1.js';
import type { UsageQueryBatchInput } from '../inputs/usageQuery.js';
import { usageAppCallsSourceId } from '../usage/usageVocabularyV1.js';
import { isUsagePrivateRecapActionIdV1, USAGE_EXPORT_ACTION_ID_V1, USAGE_PRICE_ACTION_IDS, USAGE_QUERY_ACTION_ID_V1 } from '../usage/usageActionIdsV1.js';

/** Exact non-content preset route captured by Session root admission. */
export const ApiTokenSessionPresetAcquisitionV1Schema = lazyZodSchema(() => z.strictObject({
  selection: ManagedPresetSelectionV1Schema,
  controller: ManagedControllerV1Schema,
}));
export type ApiTokenSessionPresetAcquisitionV1 = z.infer<typeof ApiTokenSessionPresetAcquisitionV1Schema>;

/** Prompt-free admission projection; ordinary Session input retains private custody. */
export const ApiTokenSessionSpawnAdmissionV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.pick(SessionSpawnNewInputV2BaseSchema, {
  executionTarget: true, agentTarget: true, directory: true, organizationPlacement: true,
  modelSelection: true, permissionMode: true, connectedServices: true,
}), { agentTarget: z.optional(SessionSpawnNewInputV2BaseSchema.shape.agentTarget),
  managedPresetAcquisition: z.optional(ApiTokenSessionPresetAcquisitionV1Schema),
  machineSetupRequested: z.optional(z.literal(true)) })));
export type ApiTokenSessionSpawnAdmissionV1 = z.infer<typeof ApiTokenSessionSpawnAdmissionV1Schema>;
export function projectApiTokenSessionSpawnAdmissionV1(input: unknown,
  options: Readonly<{ managedPresetAcquisition?: ManagedAcquireInputV1 }> = {}): ApiTokenSessionSpawnAdmissionV1 {
  const canonical = SessionSpawnNewTargetedAuthoringInputV2Schema.parse(input);
  const captured = options.managedPresetAcquisition;
  const acquisition = captured ? ApiTokenSessionPresetAcquisitionV1Schema.parse({ selection: captured.selection,
    controller: 'controller' in captured ? captured.controller : undefined }) : undefined;
  if (acquisition && (canonical.sessionPlacement?.kind !== 'preset'
    || canonical.sessionPlacement.homeId !== acquisition.selection.homeId
    || canonical.sessionPlacement.presetId !== acquisition.selection.id
    || canonical.executionTarget.serverId !== acquisition.selection.homeId
    || canonical.executionTarget.machineId !== acquisition.controller.machineId)) {
    throw new Error('Session preset acquisition does not match its placement and execution target');
  }
  return ApiTokenSessionSpawnAdmissionV1Schema.parse({
    executionTarget: canonical.executionTarget, directory: canonical.directory,
    ...(acquisition ? { managedPresetAcquisition: acquisition } : {}),
    ...(canonical.agentTarget !== undefined ? { agentTarget: canonical.agentTarget } : {}),
    ...(canonical.organizationPlacement !== undefined ? { organizationPlacement: canonical.organizationPlacement } : {}),
    ...(canonical.modelSelection !== undefined ? { modelSelection: canonical.modelSelection } : {}),
    ...(canonical.permissionMode !== undefined ? { permissionMode: canonical.permissionMode } : {}),
    ...(canonical.connectedServices !== undefined ? { connectedServices: canonical.connectedServices } : {}),
    ...(canonical.machineSetupPlanInput !== undefined ? { machineSetupRequested: true } : {}),
  });
}

export const ApiTokenGrantOriginV1Schema = lazyZodSchema(() => CanonicalHttpOriginSchema.check(z.refine((value) => {
  // Zod runs refinements after a dirty superRefine; invalid input must stay a typed refusal.
  if (!CanonicalHttpOriginSchema.safeParse(value).success) return false;
  const url = new URL(value);
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}, 'Grant origins require HTTPS, except HTTP on loopback.')));

const GrantIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));
const modelKey = (ref: ProviderBoundModelRef) => JSON.stringify([ref.agentTargetKey, ref.providerConnectionId, ref.modelId]);


/** Exact authority that can carry the person's saved deployment choice. */
export function isApiTokenDeploymentGrantV1(grant: Readonly<{
  approve: boolean;
  create: unknown;
  actions: Readonly<{ families: readonly string[]; ids: readonly string[] }> | null;
  targets: Readonly<{ sessions: readonly string[]; machines: readonly string[]; environments?: readonly string[] }> | null;
}>): boolean {
  const actions = grant.actions;
  return !grant.approve && grant.create === null
    && actions !== null && actions.families.length === 0
    && actions.ids.length === API_TOKEN_ENVIRONMENT_ACTION_IDS_V1.length
    && API_TOKEN_ENVIRONMENT_ACTION_IDS_V1.every(id => actions.ids.includes(id))
    && grant.targets !== null && grant.targets.sessions.length === 0 && grant.targets.machines.length === 0
    && grant.targets.environments?.length === 1;
}

export const ApiTokenGrantV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  actions: z.nullable(z.strictObject({ families: z.array(ActionIdFamilyV1Schema), ids: z.array(GrantIdSchema) })),
  targets: z.nullable(z.strictObject({
    sessions: z.array(GrantIdSchema), machines: z.array(GrantIdSchema),
    /** Historical restricted grants without this field grant no Environment. */
    environments: z.optional(z.array(DeploymentIdentifierV1Schema)),
  })),
  /** Exact workflow.trigger.run_now operand restriction; absent/null is unrestricted. */
  automationIds: z.optional(z.nullable(z.array(GrantIdSchema).check(z.minLength(1)))),
  approve: z.boolean(),
  /** Absent means Ask. Only an exact single-Environment deployment grant may save Automatic. */
  deployApproval: z.optional(z.literal('automatic')),
  origins: z.array(ApiTokenGrantOriginV1Schema),
  models: CallerInputConstraintsV1Schema.shape.models,
  permissionModes: CallerInputConstraintsV1Schema.shape.permissionModes,
  create: z.nullable(z.strictObject({
    machineId: GrantIdSchema,
    agentTargetKey: ProviderAgentTargetKeySchema,
    directory: z.literal('managed'),
    placement: SessionOrganizationPlacementV1Schema,
    connectedServices: z.optional(ConnectedServiceBindingsV2Schema),
  })),
}).check(z.superRefine((value, context) => {
  const lists: ReadonlyArray<readonly [readonly string[], readonly (string | number)[]]> = [
    [value.origins, ['origins']],
    ...(value.actions ? [[value.actions.families, ['actions', 'families']], [value.actions.ids, ['actions', 'ids']]] as const : []),
    ...(value.targets ? [[value.targets.sessions, ['targets', 'sessions']], [value.targets.machines, ['targets', 'machines']]] as const : []),
    ...(value.targets?.environments ? [[value.targets.environments, ['targets', 'environments']]] as const : []),
    ...(value.models ? [[value.models.map(modelKey), ['models']]] as const : []),
    ...(value.permissionModes ? [[value.permissionModes, ['permissionModes']]] as const : []),
    ...(value.automationIds ? [[value.automationIds, ['automationIds']]] as const : []),
  ];
  for (const [list, path] of lists) if (new Set(list).size !== list.length) context.addIssue({ code: 'custom', path: [...path], message: 'Grant entries must be unique.' });
  if (value.actions && !value.actions.families.length && !value.actions.ids.length) context.addIssue({ code: 'custom', path: ['actions'], message: 'A restricted action grant must be nonempty.' });
  if (value.targets && !value.targets.sessions.length && !value.targets.machines.length && !value.targets.environments?.length) context.addIssue({ code: 'custom', path: ['targets'], message: 'A restricted target grant must be nonempty.' });
  if (value.create && value.targets && !value.targets.machines.includes(value.create.machineId)) {
    context.addIssue({ code: 'custom', path: ['create', 'machineId'], message: 'The creation machine must belong to the grant targets.' });
  }
  if (value.deployApproval === 'automatic' && !isApiTokenDeploymentGrantV1(value)) {
    context.addIssue({ code: 'custom', path: ['deployApproval'], message: 'Automatic deployment requires an exact single-Environment deployment grant.' });
  }
})));
export type ApiTokenGrantV1 = z.infer<typeof ApiTokenGrantV1Schema>;

/** The existing grant owns the saved choice; Environment content never invalidates it. */
export function resolveApiTokenDeploymentGrantV1(grant: ApiTokenGrantV1,
  deployment?: Readonly<{ environmentId: string; deployApproval?: 'automatic' | 'ask' }> | null): ApiTokenGrantV1 {
  if (deployment === undefined) return grant;
  if (!isApiTokenDeploymentGrantV1(grant)
    || deployment !== null && grant.targets?.environments?.[0] !== deployment.environmentId) {
    throw Object.assign(new Error('credential_scope_denied'), { code: 'credential_scope_denied' });
  }
  const { deployApproval: _previous, ...base } = grant;
  return deployment?.deployApproval === 'automatic' ? { ...base, deployApproval: 'automatic' } : base;
}
// Grants carry authority: stored reads must not erase an unknown restriction.
defineStoredReadProjection(ApiTokenGrantV1Schema, () => ApiTokenGrantV1Schema);
export const StoredApiTokenGrantV1Schema = createStoredReadSchema(ApiTokenGrantV1Schema);

export const API_TOKEN_FULL_GRANT_V1: ApiTokenGrantV1 = Object.freeze({
  v: 1, actions: null, targets: null, approve: false, origins: [], models: null, permissionModes: null, create: null,
});

export function isApiTokenGrantRestrictedV1(grant: ApiTokenGrantV1): boolean {
  return grant.actions !== null || grant.targets !== null || grant.models !== null || grant.permissionModes !== null || grant.create !== null || grant.automationIds != null;
}

/** App accounting can spend the parent Account scope or its named Environment scope. */
export function hasApiTokenUsageAppCallsScopeV1(grant: ApiTokenGrantV1): boolean {
  return grant.targets === null || !!grant.targets.environments?.length;
}

/** Applies the admitted credential's Environment scope before any usage operands are read. */
export function projectApiTokenUsageQueryV1(
  grant: ApiTokenGrantV1 | undefined,
  input: UsageQueryBatchInput,
  recapSourceSelection?: readonly string[],
) {
  const environments = grant?.targets?.environments;
  if (!environments?.length) return { ok: true, input } as const;

  const allowedSources = new Set(environments.map(usageAppCallsSourceId));
  const queries = input.queries.flatMap(query => {
    // An Account-wide recap ignores page source filters. A scoped token still
    // needs its explicit selection checked against the grant before any read.
    const requested = recapSourceSelection ?? query.sources;
    const sources = requested.length ? requested.filter(source => allowedSources.has(source)) : [...allowedSources];
    if (!sources.length) return [];
    // Project the requested evidence as well as the sources. Aggregation can
    // derive Work and Activity sections even without a private source read.
    return [{ ...query, sources, includeQuota: false, includeQuotaHistory: false, includeQuotaExactHistory: false,
      includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false,
      includeCoach: false, includeActivity: false, includeMessageStats: false }];
  });
  return queries.length ? { ok: true, input: { queries } } as const : {
    ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied',
    details: { reason: 'environment_not_granted' satisfies ApiTokenGrantDenialReasonV1 },
  } as const;
}

const DISCOVERY_IDS: ReadonlySet<string> = new Set(API_TOKEN_DISCOVERY_ACTION_IDS_V1);
const APPROVAL_OBSERVATION_IDS: ReadonlySet<string> = new Set(API_TOKEN_APPROVAL_OBSERVATION_ACTION_IDS_V1);
function actionGranted(grant: ApiTokenGrantV1, actionId: string, contributedQualifiedId?: string, contributedActionAdmission?: 'pre_open'): boolean {
  // Send includes answering agent questions; exact answer grants remain narrower.
  if (actionId === 'session.user_action.answer' && actionGranted(grant, SESSION_MESSAGE_SEND_ACTION_ID_V1)) return true;
  if (DISCOVERY_IDS.has(actionId)) return true;
  if ((DECISION_ACTION_IDS as readonly string[]).includes(actionId)) return grant.approve;
  if (APPROVAL_OBSERVATION_IDS.has(actionId)) return grant.approve;
  if (actionId === 'action.invoke') {
    if (grant.actions === null) return contributedQualifiedId !== undefined || contributedActionAdmission === 'pre_open';
    if (contributedQualifiedId !== undefined) return !!grant.actions?.ids.includes(contributedQualifiedId);
    return contributedActionAdmission === 'pre_open'
      && grant.actions?.ids.some((id) => parseQualifiedPluginActionId(id) !== null) === true;
  }
  return grant.actions === null || grant.actions.ids.includes(actionId)
    || grant.actions.families.some((family) => (ACTION_ID_FAMILIES_V1[family] as readonly string[]).includes(actionId));
}

/** Whether the grant lets a token call this Action at all (operand restrictions are checked separately). */
export function isApiTokenGrantActionAllowedV1(grant: ApiTokenGrantV1, actionId: string, contributedQualifiedId?: string): boolean {
  return actionGranted(grant, actionId, contributedQualifiedId);
}

export function isApiTokenGrantTargetMemberV1(grant: ApiTokenGrantV1, target?: ExternalActionTargetV1 | null, targetMachineId?: string | null): boolean {
  if (grant.targets === null) return true;
  if (!target) return false;
  return target.kind === 'machine'
    ? grant.targets.machines.includes(target.machineId)
    : grant.targets.sessions.includes(target.sessionId) || (!!targetMachineId && grant.targets.machines.includes(targetMachineId));
}

function placementsEqual(a: SessionOrganizationPlacementV1, b: SessionOrganizationPlacementV1): boolean {
  if (a.folderId !== b.folderId) return false;
  const aTags = new Set(a.tagIds);
  const bTags = new Set(b.tagIds);
  return aTags.size === bTags.size && [...aTags].every((tag) => bTags.has(tag));
}

function connectedServiceBindingsEqual(
  a: ConnectedServiceBindingsV2 | undefined,
  b: ConnectedServiceBindingsV2 | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const aIds = Object.keys(a.bindingsByServiceId);
  const bIds = Object.keys(b.bindingsByServiceId);
  return aIds.length === bIds.length && aIds.every((serviceId) => (
    Object.prototype.hasOwnProperty.call(b.bindingsByServiceId, serviceId)
    && JSON.stringify(a.bindingsByServiceId[serviceId]) === JSON.stringify(b.bindingsByServiceId[serviceId])
  ));
}

/** All transports call this owner; encrypted spawn fields are decisively rechecked by the daemon. */
export function evaluateApiTokenGrantV1(input: Readonly<{
  grant: ApiTokenGrantV1;
  actionId: string;
  contributedQualifiedId?: string;
  /** Host-only opaque ingress/currentness stage. Execution must supply the resolved identity. */
  contributedActionAdmission?: 'pre_open';
  /** Identifies which canonical owner projected the Session creation operand. */
  sessionSpawnInputKind?: 'public_api' | 'canonical_admission';
  spawnInput?: unknown;
  automationId?: unknown;
  /** Host-only opaque ingress/currentness; decoded execution and the native effect recheck the operand. */
  automationAdmission?: 'pre_open';
  /** Exact Environment from admitted routing metadata or the decoded Action operand. */
  environmentId?: unknown;
  /** Host-only opaque stage; it still requires the exact granted Environment metadata. */
  environmentAdmission?: 'pre_open';
  target?: ExternalActionTargetV1 | null;
  targetMachineId?: string | null;
}>): { ok: true } | { ok: false; reason: ApiTokenGrantDenialReasonV1; deniedActionId?: string } {
  const { grant, actionId, target } = input;
  if (!actionGranted(grant, actionId, input.contributedQualifiedId, input.contributedActionAdmission)) return { ok: false, reason: 'action_not_granted' };
  // Scope Usage evidence before dispatch, including Actions that run on a
  // client. The public price catalog supplies reference data for App calls.
  if (grant.targets?.environments?.length && ACTION_ID_FAMILIES_V1.usage.some(id => id === actionId)
    && actionId !== USAGE_QUERY_ACTION_ID_V1 && actionId !== USAGE_EXPORT_ACTION_ID_V1
    && actionId !== USAGE_PRICE_ACTION_IDS.get && !isUsagePrivateRecapActionIdV1(actionId)) {
    return { ok: false, reason: 'environment_not_granted' };
  }
  if (actionId === 'deployments.deploy' || 'environmentId' in input || input.environmentAdmission !== undefined) {
    const environment = DeploymentIdentifierV1Schema.safeParse(input.environmentId);
    const environmentAction = API_TOKEN_ENVIRONMENT_ACTION_IDS_V1.some((id) => id === actionId);
    if (!environment.success || environment.data !== input.environmentId
      || !environmentAction && input.environmentAdmission !== undefined
      || environmentAction && (target?.kind === 'session'
        || grant.targets !== null && !grant.targets.environments?.includes(environment.data))) {
      return { ok: false, reason: 'environment_not_granted' };
    }
    if (environmentAction) {
      // CI controller placement is routing, never a Machine grant.
      // The decoded operand and originating-token operation custody are rechecked at dispatch.
      return { ok: true };
    }
    // Other Actions carry Environment metadata while retaining ordinary target admission.
  }
  if (DISCOVERY_IDS.has(actionId)) return { ok: true };
  if (actionId === 'workflow.trigger.run_now' && grant.automationIds != null
    && !(input.automationAdmission === 'pre_open' && input.automationId === undefined)
    && (typeof input.automationId !== 'string' || !grant.automationIds.includes(input.automationId))) {
    return { ok: false, reason: 'automation_not_granted' };
  }
  const spawnInput = input.spawnInput;
  const creation = actionId === BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 && spawnInput && typeof spawnInput === 'object' && !Array.isArray(spawnInput)
    ? (spawnInput as Record<string, unknown>).creation : actionId === 'session.spawn_new' ? spawnInput : undefined;
  if (creation && typeof creation === 'object' && !Array.isArray(creation)
    && (creation as Record<string, unknown>).manager !== undefined
    && !resolveApiTokenSessionCapabilityCeilingV1(grant).has('submitAgentInput')) {
    return { ok: false, reason: 'action_not_granted', deniedActionId: SESSION_MESSAGE_SEND_ACTION_ID_V1 };
  }
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
      const projectedApiTarget = input.sessionSpawnInputKind === 'public_api'
        && fields.executionTarget === undefined;
      const agent = AgentExecutionTargetV1Schema.safeParse(fields.agentTarget);
      const directory = SessionDirectoryIntentV1Schema.safeParse(fields.directory);
      const placement = input.sessionSpawnInputKind === 'public_api'
        ? (() => {
            const publicPlacement = SessionSectionPlacementV1Schema.safeParse(fields.organizationPlacement);
            return publicPlacement.success
              ? { success: true as const, data: { folderId: publicPlacement.data.sectionId, tagIds: publicPlacement.data.tagIds } }
              : publicPlacement;
          })()
        : SessionOrganizationPlacementV1Schema.safeParse(fields.organizationPlacement);
      const hasConnectedServices = Object.prototype.hasOwnProperty.call(fields, 'connectedServices');
      const connectedServices = ConnectedServiceBindingsV2Schema.safeParse(fields.connectedServices);
      if ((!projectedApiTarget && (!execution.success || execution.data.machineId !== binding.machineId))
        || !agent.success || buildBackendTargetKeyV2(agent.data) !== binding.agentTargetKey
        || !directory.success || directory.data.kind !== 'managed'
        || !placement.success || !placementsEqual(placement.data, binding.placement)
        || (binding.connectedServices === undefined
          ? hasConnectedServices
          : !hasConnectedServices || !connectedServices.success
            || !connectedServiceBindingsEqual(connectedServices.data, binding.connectedServices))) {
        return { ok: false, reason: 'create_not_granted' };
      }
    }
    return { ok: true };
  }
  if (grant.targets !== null && !target) return { ok: false, reason: 'target_required' };
  return isApiTokenGrantTargetMemberV1(grant, target, input.targetMachineId) ? { ok: true } : { ok: false, reason: 'target_not_granted' };
}

export function isApiTokenGrantWithinV1(child: ApiTokenGrantV1, parent: ApiTokenGrantV1): boolean {
  const subset = (c: readonly string[] | null, p: readonly string[] | null) => p === null || (c !== null && c.every((item) => p.includes(item)));
  if (child.deployApproval === 'automatic' && parent.deployApproval !== 'automatic'
    || child.approve && !parent.approve || !subset(child.origins, parent.origins)
    || !subset(child.automationIds ?? null, parent.automationIds ?? null)
    || !subset(child.models?.map(modelKey) ?? null, parent.models?.map(modelKey) ?? null)
    || !subset(child.permissionModes?.map((mode) => parseAgentPermissionIntentV1Alias(mode)!) ?? null,
      parent.permissionModes?.map((mode) => parseAgentPermissionIntentV1Alias(mode)!) ?? null)) return false;
  if (parent.actions !== null) {
    if (child.actions === null) return false;
    const ordinaryIdWithin = (id: string) => (DECISION_ACTION_IDS as readonly string[]).includes(id)
      || APPROVAL_OBSERVATION_IDS.has(id)
      || actionGranted(parent, id);
    if (!child.actions.ids.every(ordinaryIdWithin)
      || !child.actions.families.every((family: ActionIdFamilyV1) => parent.actions!.families.includes(family) || (ACTION_ID_FAMILIES_V1[family] as readonly string[]).every(ordinaryIdWithin))) return false;
  }
  if (parent.targets !== null && (child.targets === null
    || !subset(child.targets.sessions, parent.targets.sessions)
    || !subset(child.targets.machines, parent.targets.machines)
    || !subset(child.targets.environments ?? [], parent.targets.environments ?? []))) return false;
  if (actionGranted(child, 'session.spawn_new')) {
    if (parent.create !== null) {
      if (child.create === null || child.create.machineId !== parent.create.machineId
        || child.create.agentTargetKey !== parent.create.agentTargetKey
        || !placementsEqual(child.create.placement, parent.create.placement)
        || !connectedServiceBindingsEqual(child.create.connectedServices, parent.create.connectedServices)) return false;
    } else if (child.create !== null && !isApiTokenGrantTargetMemberV1(parent, { kind: 'machine', machineId: child.create.machineId })) return false;
  }
  return true;
}

export function isModelRefGrantedV1(constraints: CallerInputConstraintsV1, ref: ProviderBoundModelRef | SessionModelRefV2 | 'automatic'): boolean {
  if (constraints.models === null) return true;
  if (ref === 'automatic' || 'source' in ref && (ref.source === 'team_resource' || ref.source === 'connected_account')) return false;
  const accountOrNative: ProviderBoundModelRef = 'source' in ref
    ? { agentTargetKey: ref.agentTargetKey, modelId: ref.modelId,
      providerConnectionId: ref.source === 'account_provider_connection' ? ref.providerConnectionId : null }
    : ref;
  return !isNativeAutomaticModelSelectionInputV1(accountOrNative)
    && constraints.models.some((candidate) => modelKey(candidate) === modelKey(accountOrNative));
}
/** Intersect every authenticated caller constraint using the canonical model membership rule. */
export function isModelRefGrantedByConstraintsV1(
  constraints: readonly (CallerInputConstraintsV1 | undefined)[],
  ref: Parameters<typeof isModelRefGrantedV1>[1],
): boolean {
  return constraints.every(constraint => constraint === undefined || isModelRefGrantedV1(constraint, ref));
}
/** Keep a permitted selection, or use the first permitted model in grant order. */
export function resolveEffectiveApiTokenModelRefV1<Current extends ProviderBoundModelRef | SessionModelRefV2 | 'automatic' = 'automatic'>(
  constraints: Pick<CallerInputConstraintsV1, 'models'>,
  ref?: Current,
  agentTargetKey?: string,
): ProviderBoundModelRef | Current | 'automatic' | null {
  const current = ref ?? 'automatic';
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
  if (actionGranted(grant, SESSION_MESSAGE_SEND_ACTION_ID_V1) || actionGranted(grant, 'session.turn.cancel')
    || actionGranted(grant, 'session.compact')) capabilities.add('submitAgentInput');
  if (actionGranted(grant, 'session.stop')) capabilities.add('stopSession');
  if (actionGranted(grant, 'session.archive')) capabilities.add('archiveSession');
  if (grant.approve) capabilities.add('approveRuntimePermissions');
  return capabilities;
}
