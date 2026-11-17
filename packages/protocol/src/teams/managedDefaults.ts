import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { AgentPermissionIntentV1 } from '../runtime/permissionIntentV1.js';
import type { SessionModelSelectionV1 } from '../providers/selection/v1.js';
import { projectSessionModelSelectionV2ToV1, type SessionModelSelectionV2 } from '../providers/selection/v2.js';
import { qualifiedPurposeKey } from '../connect/connectedAccountPurposeBindings.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import type { AgentExecutionTargetV1 } from '../agents/executionTargetV1.js';
import { buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { ProjectSessionDefaultsV1Schema, type ProjectSessionDefaultsV1 } from '../projects/projectSessionDefaultsV1.js';
import type { MachineIsolationPolicyV1, MachineIsolationV1 } from '../machines/machineIsolationV1.js';
import { ManagedConnectedServiceDefaultV1Schema, ManagedSessionDefaultsV1Schema,
  type ManagedConnectedServiceDefaultV1, type ManagedSessionDefaultsV1, type ManagedSessionPlacementV1,
} from './managedSessionDefaultsV1.js';

export {
  ManagedSessionPlacementV1Schema,
  ManagedConnectedServiceDefaultV1Schema,
  ManagedSessionDefaultsV1Schema,
  type ManagedSessionPlacementV1,
  type ManagedConnectedServiceDefaultV1,
  type ManagedSessionDefaultsV1,
} from './managedSessionDefaultsV1.js';

/** Request-only choices can explicitly retain the Agent's Automatic model. */
export type ManagedSessionExplicitChoicesV1 = Readonly<Omit<ManagedSessionDefaultsV1, 'modelByAgentTargetKey'> & {
  modelByAgentTargetKey?: Readonly<Record<string, SessionModelSelectionV1 | SessionModelSelectionV2 | null>>;
  defaultAgentTarget?: AgentExecutionTargetV1;
}>;

export const ManagedDefaultsV1Schema = lazyZodSchema(() => z.strictObject({
  team: ManagedSessionDefaultsV1Schema,
  groups: z.record(z.string().check(z.minLength(1)), ManagedSessionDefaultsV1Schema),
}));
export type ManagedDefaultsV1 = z.infer<typeof ManagedDefaultsV1Schema>;

export function readManagedDefaultsV1(raw: unknown):
  | Readonly<{ status: 'available'; defaults: ManagedDefaultsV1 | null }>
  | Readonly<{ status: 'repair_required'; defaults: null }> {
  if (raw === null || raw === undefined) return { status: 'available', defaults: null };
  const parsed = ManagedDefaultsV1Schema.safeParse(raw);
  return parsed.success ? { status: 'available', defaults: parsed.data } : { status: 'repair_required', defaults: null };
}

export const ManagedSessionDefaultsContextV1Schema = lazyZodSchema(() => z.strictObject({
  memberDefaults: z.optional(z.nullable(ManagedSessionDefaultsV1Schema)),
  memberApprovalProfileSource: z.optional(z.literal('machine')),
  primaryTeamId: z.optional(z.nullable(z.string())),
  personalProjectDefaults: z.optional(z.nullable(ProjectSessionDefaultsV1Schema)),
  projectDefaults: z.optional(z.nullable(ProjectSessionDefaultsV1Schema)),
  teamDefaults: z.optional(z.nullable(ManagedDefaultsV1Schema)),
  groupIds: z.optional(z.readonly(z.array(z.string()))),
  homeDefaults: z.optional(z.nullable(ManagedSessionDefaultsV1Schema)),
  policyDefaults: z.optional(z.nullable(z.strictObject({
    values: ManagedSessionDefaultsV1Schema, locked: z.boolean(), organization: z.string(), supportUrl: z.optional(z.string()),
  }))),
}));
export type ManagedSessionDefaultsContext = Readonly<z.infer<typeof ManagedSessionDefaultsContextV1Schema>>;
export type ManagedDefaultDecision<T> = Readonly<{
  value: T | undefined;
  source: 'policy' | 'explicit' | 'personal-project' | 'project' | 'member' | 'machine' | 'group' | 'team' | 'home' | 'none';
  lock: Readonly<{ organization: string; supportUrl?: string }> | null;
  groupConflict: boolean;
}>;
/** Names come from the admitted selected-scope read, never inferred from ids. */
export type ManagedDefaultSourceNamesV1 = Readonly<{
  teamName?: string | null;
  projectName?: string | null;
  organization?: string | null;
}>;
export type ManagedAgentSandboxAvailability =
  | Readonly<{ status: 'enabled' | 'disabled' }>
  | Readonly<{ status: 'unavailable'; reason: 'not_available_in_sandbox_type' }>;
export type ResolvedManagedSessionDefaults = Readonly<{
  agentTarget: ManagedDefaultDecision<AgentExecutionTargetV1>;
  approvalProfileId: ManagedDefaultDecision<string | null> & Readonly<{ teamOrGroupDerived: boolean }>;
  placement: ManagedDefaultDecision<ManagedSessionPlacementV1>;
  permissionMode: ManagedDefaultDecision<AgentPermissionIntentV1>;
  agentSandbox: Readonly<{
    value: 'on' | 'off' | undefined;
    source: 'explicit' | 'machine' | 'none';
    availability: ManagedAgentSandboxAvailability | undefined;
  }>;
  model: ManagedDefaultDecision<SessionModelSelectionV1 | SessionModelSelectionV2 | null>;
  connectedServices: readonly ManagedDefaultDecision<ManagedConnectedServiceDefaultV1>[];
}>;
export type ResolvedInheritedManagedSessionDefaults = Readonly<{
  [Field in keyof ResolvedManagedSessionDefaults]: Field extends 'connectedServices'
    ? readonly (ResolvedManagedSessionDefaults['connectedServices'][number] & { names: ManagedDefaultSourceNamesV1 })[]
    : ResolvedManagedSessionDefaults[Field] & { names: ManagedDefaultSourceNamesV1 };
}>;

export type ManagedSessionDefaultsLayerV1 = Readonly<{
  source: 'explicit' | 'personal-project' | 'project' | 'member' | 'group' | 'team' | 'home' | 'policy';
  defaults: ManagedSessionExplicitChoicesV1 | null;
}>;

export type ManagedSessionDefaultsLayerProjectionV1 = Readonly<{
  layers: readonly ManagedSessionDefaultsLayerV1[];
  purposeKeys: readonly string[];
  agentTarget: ManagedDefaultDecision<AgentExecutionTargetV1>;
  targetKey: string;
}>;

/** The canonical layer order and connected-service purpose projection. */
export function projectManagedSessionDefaultsLayers(
  input: ManagedSessionDefaultsContext & Readonly<{
    agentTargetKey: string;
    explicitChoices?: ManagedSessionExplicitChoicesV1;
    inheritBelowProjectScope?: 'personal-project' | 'project';
  }>,
): ManagedSessionDefaultsLayerProjectionV1 {
  const groups = (input.groupIds ?? []).flatMap(id => input.teamDefaults?.groups[id] ? [input.teamDefaults.groups[id]] : []);
  const layers: ManagedSessionDefaultsLayerV1[] = [
    { source: 'explicit', defaults: input.explicitChoices ?? null },
    ...(!input.inheritBelowProjectScope && input.personalProjectDefaults ? [{ source: 'personal-project' as const, defaults: input.personalProjectDefaults }] : []),
    ...(input.inheritBelowProjectScope !== 'project' && input.projectDefaults ? [{ source: 'project' as const, defaults: input.projectDefaults }] : []),
    { source: 'member', defaults: input.memberDefaults ?? null },
    ...groups.map(defaults => ({ source: 'group' as const, defaults })),
    { source: 'team', defaults: input.teamDefaults?.team ?? null },
    { source: 'home', defaults: input.homeDefaults ?? null },
    { source: 'policy', defaults: input.policyDefaults?.values ?? null },
  ];
  const agentLayer = layers.find(layer => layer.defaults?.defaultAgentTarget !== undefined);
  const agentTarget: ManagedDefaultDecision<AgentExecutionTargetV1> = {
    value: agentLayer?.defaults?.defaultAgentTarget, source: agentLayer?.source ?? 'none', lock: null, groupConflict: false,
  };
  const targetKey = agentTarget.value ? buildBackendTargetKeyV2(agentTarget.value) : input.agentTargetKey;
  const purposeKeys = [...new Set(layers.flatMap(layer =>
    layer.defaults?.connectedServicesByAgentTargetKey?.[targetKey]?.map(value => qualifiedPurposeKey(value.purpose)) ?? []
  ))].sort();
  return { layers, purposeKeys, agentTarget, targetKey };
}

export type ManagedAgentSandboxContext = Readonly<{
  machineIsolation?: MachineIsolationV1 | null;
  nativeSandboxAvailable?: boolean;
  /** O-MACH isolationPolicyV1 projection; its owner reads and validates stored metadata. */
  machineIsolationPolicy?: Readonly<Pick<MachineIsolationPolicyV1, 'agentNativeSandboxEnabled'>> | null;
  /** Canonical provisioner sessionPlacement support reader result; omission makes no support claim. */
  sandboxTypeSupportsNativeSandbox?: boolean;
  explicitAgentSandbox?: 'on' | 'off';
  /** Omission must preserve a native continuation's retained profile. */
  retainedNativeProfile?: boolean;
}>;

/** Native sandbox intent is independent from permission and placement defaults. */
export function resolveManagedAgentSandbox(input: ManagedAgentSandboxContext): ResolvedManagedSessionDefaults['agentSandbox'] {
  const isolated = input.machineIsolation != null;
  const machineSandboxEnabled = input.machineIsolationPolicy?.agentNativeSandboxEnabled === true;
  const source = input.explicitAgentSandbox !== undefined ? 'explicit'
    : !input.retainedNativeProfile && isolated && (input.nativeSandboxAvailable || machineSandboxEnabled) ? 'machine' : 'none';
  const value = source === 'explicit' ? input.explicitAgentSandbox
    : source === 'machine' ? machineSandboxEnabled ? 'on' : 'off' : undefined;
  const availability: ManagedAgentSandboxAvailability | undefined = value === undefined ? undefined
    : value === 'off' ? { status: 'disabled' }
    : isolated && (!input.nativeSandboxAvailable || !input.sandboxTypeSupportsNativeSandbox)
      ? { status: 'unavailable', reason: 'not_available_in_sandbox_type' }
      : { status: 'enabled' };
  return { value, source, availability };
}

/** One decision per field/purpose. Defaults express intent and never confer resource access. */
export function resolveManagedSessionDefaults(input: ManagedSessionDefaultsContext & ManagedAgentSandboxContext & Readonly<{
  agentTargetKey: string; explicitChoices?: ManagedSessionExplicitChoicesV1;
  inheritBelowProjectScope?: 'personal-project' | 'project';
}>): ResolvedManagedSessionDefaults {
  const projection = projectManagedSessionDefaultsLayers(input);
  const groups = projection.layers.filter(layer => layer.source === 'group').flatMap(layer => layer.defaults ? [layer.defaults] : []);
  function decide<T>(read: (defaults: ManagedSessionExplicitChoicesV1) => T | undefined,
    equal: (left: T, right: T) => boolean = sameStrictJsonValue): ManagedDefaultDecision<T> {
    const groupValues = groups.flatMap(group => { const value = read(group); return value === undefined ? [] : [value]; });
    const first = groupValues[0];
    const groupConflict = first !== undefined && groupValues.some(value => !equal(first, value));
    const policy = input.policyDefaults;
    const policyValue = policy ? read(policy.values) : undefined;
    if (policy?.locked && policyValue !== undefined) return {
      value: policyValue, source: 'policy', groupConflict,
      lock: { organization: policy.organization, ...(policy.supportUrl ? { supportUrl: policy.supportUrl } : {}) },
    };
    for (const layer of projection.layers) {
      if (layer.source === 'group' && groupConflict) continue;
      const value = layer.defaults ? read(layer.defaults) : undefined;
      if (value !== undefined) return { value, source: layer.source, lock: null, groupConflict };
    }
    return { value: undefined, source: 'none', lock: null, groupConflict };
  }
  const { agentTarget, targetKey } = projection;
  const purposeKey = (value: z.infer<typeof ManagedConnectedServiceDefaultV1Schema>) =>
    qualifiedPurposeKey(value.purpose);
  const purposeKeys = new Set(projection.purposeKeys);
  const modelIdentity = (model: SessionModelSelectionV1 | SessionModelSelectionV2 | null) => model === null ? null : model.v === 1
    ? model.ref
    : projectSessionModelSelectionV2ToV1(model)?.ref ?? model.ref;
  const agentSandbox = resolveManagedAgentSandbox(input);
  const approval = decide(defaults => defaults.approvalProfileId);
  const approvalSource = approval.source === 'member' && input.memberApprovalProfileSource === 'machine' ? 'machine' : approval.source;
  return {
    agentTarget,
    approvalProfileId: { ...approval, source: approvalSource,
      teamOrGroupDerived: approvalSource === 'project' || approvalSource === 'team' || approvalSource === 'group' },
    placement: decide(defaults => defaults.placement),
    permissionMode: decide(defaults => defaults.permissionModeByAgentTargetKey?.[targetKey]),
    agentSandbox,
    model: decide(defaults => defaults.modelByAgentTargetKey?.[targetKey], (left, right) => sameStrictJsonValue(modelIdentity(left), modelIdentity(right))),
    connectedServices: [...purposeKeys].sort().map(key => decide(defaults =>
      defaults.connectedServicesByAgentTargetKey?.[targetKey]?.find(value => purposeKey(value) === key))),
  };
}

/** The editor's clear result: the same resolver, with its edited project layer
 * and higher personal layer excluded at the canonical projection. */
export function resolveInheritedManagedSessionDefaults(input: ManagedSessionDefaultsContext & ManagedAgentSandboxContext & Readonly<{
  scope: 'personal-project' | 'project';
  names: ManagedDefaultSourceNamesV1;
  agentTarget?: AgentExecutionTargetV1;
}>): ResolvedInheritedManagedSessionDefaults {
  const resolved = resolveManagedSessionDefaults({ ...input,
    inheritBelowProjectScope: input.scope,
    agentTargetKey: input.agentTarget ? buildBackendTargetKeyV2(input.agentTarget) : '',
    ...(input.agentTarget ? { explicitChoices: { defaultAgentTarget: input.agentTarget } } : {}),
  });
  const names = input.names;
  return {
    agentTarget: { ...resolved.agentTarget, names },
    approvalProfileId: { ...resolved.approvalProfileId, names },
    placement: { ...resolved.placement, names },
    permissionMode: { ...resolved.permissionMode, names },
    agentSandbox: { ...resolved.agentSandbox, names },
    model: { ...resolved.model, names },
    connectedServices: resolved.connectedServices.map(decision => ({ ...decision, names })),
  };
}

export type ManagedSessionDefaultsContextInput = Readonly<{
  /** Captured selected-scope read, completed after placement chooses its Machine. */
  context?: ManagedSessionDefaultsContext;
  team?: Readonly<{
    id: string;
    policy: Readonly<{ managedDefaults?: ManagedDefaultsV1 | null; homeDefaults?: ManagedSessionDefaultsV1 | null }>;
    managedDefaultsGroupIds?: readonly string[];
  }> | null;
  home?: ManagedSessionDefaultsV1 | null;
  policy?: ManagedSessionDefaultsContext['policyDefaults'];
  memberDefaults?: ManagedSessionDefaultsV1 | null;
  creationMachineApprovalProfileId?: string | null;
  personalDefaultsRow?: ProjectSessionDefaultsV1 | null;
  projectSourceDefaults?: Readonly<{
    sourceId: string;
    owner: Readonly<{ kind: 'team'; teamId: string } | { kind: 'account'; accountId: string }>;
    defaults: ProjectSessionDefaultsV1 | null;
  }> | null;
  primaryTeamId?: string | null;
  sharedTeamIds?: readonly string[];
}>;

/** Select the launch Team once; transport loaders use this owner before reading its projection. */
export function resolveManagedSessionDefaultsTeamId(input: Pick<ManagedSessionDefaultsContextInput,
  'primaryTeamId' | 'projectSourceDefaults' | 'sharedTeamIds'>): string | null {
  if (input.primaryTeamId) return input.primaryTeamId;
  if (input.projectSourceDefaults?.owner.kind === 'team') return input.projectSourceDefaults.owner.teamId;
  const shared = [...new Set(input.sharedTeamIds ?? [])];
  return shared.length === 1 ? shared[0]! : null;
}

/** Assemble admitted projections without transport, resource acquisition or a second precedence order. */
export function buildManagedSessionDefaultsContext(input: ManagedSessionDefaultsContextInput): ManagedSessionDefaultsContext {
  const captured = input.context;
  const selectsTeam = input.primaryTeamId !== undefined || input.projectSourceDefaults !== undefined || input.sharedTeamIds !== undefined;
  const primaryTeamId = selectsTeam ? resolveManagedSessionDefaultsTeamId(input) : captured?.primaryTeamId ?? null;
  const team = input.team?.id === primaryTeamId ? input.team : null;
  const retainedTeam = captured?.primaryTeamId === primaryTeamId ? captured : undefined;
  const memberDefaults = input.memberDefaults === undefined ? captured?.memberDefaults : input.memberDefaults;
  const machineFilled = memberDefaults?.approvalProfileId === undefined
    && input.creationMachineApprovalProfileId !== undefined && input.creationMachineApprovalProfileId !== null;
  const memberApprovalProfileSource = machineFilled ? 'machine'
    : input.memberDefaults === undefined ? captured?.memberApprovalProfileSource : undefined;
  return {
    primaryTeamId,
    memberDefaults: machineFilled ? { ...memberDefaults, approvalProfileId: input.creationMachineApprovalProfileId }
      : memberDefaults ?? null,
    ...(memberApprovalProfileSource ? { memberApprovalProfileSource } : {}),
    personalProjectDefaults: input.personalDefaultsRow === undefined ? captured?.personalProjectDefaults ?? null : input.personalDefaultsRow,
    projectDefaults: input.projectSourceDefaults === undefined ? captured?.projectDefaults ?? null : input.projectSourceDefaults?.defaults ?? null,
    teamDefaults: input.team === undefined ? retainedTeam?.teamDefaults ?? null : team?.policy.managedDefaults ?? null,
    groupIds: input.team === undefined ? retainedTeam?.groupIds ?? [] : team?.managedDefaultsGroupIds ?? [],
    homeDefaults: (team ? team.policy.homeDefaults : input.home === undefined ? captured?.homeDefaults : input.home) ?? null,
    policyDefaults: input.policy === undefined ? captured?.policyDefaults ?? null : input.policy,
  };
}
