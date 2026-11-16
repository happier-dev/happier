import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AgentPermissionIntentV1Schema, type AgentPermissionIntentV1 } from '../runtime/permissionIntentV1.js';
import { ProviderAgentTargetKeySchema } from '../providers/ids.js';
import { SessionModelSelectionV1Schema, type SessionModelSelectionV1 } from '../providers/selection/v1.js';
import { SessionModelSelectionV2Schema, projectSessionModelSelectionV2ToV1, type SessionModelSelectionV2 } from '../providers/selection/v2.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../connect/connectedAccountPurposes.js';
import { qualifiedPurposeKey, QualifiedConnectedAccountPurposeBindingTargetV1Schema, QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema } from '../connect/connectedAccountPurposeBindings.js';
import { ConnectedAccountServiceIdentityV1Schema } from '../connect/qualifiedConnectedAccountPersistence.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionExecutionTargetV1Schema } from '../sessions/creation/sessionExecutionTargetV1.js';
import { ManagedMachinePresetV1Schema } from '../machines/managed/managedMachinePresetV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import type { MachineIsolationPolicyV1, MachineIsolationV1 } from '../machines/machineIsolationV1.js';

export const ManagedSessionPlacementV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('machine'), target: SessionExecutionTargetV1Schema }),
  z.strictObject({ kind: z.literal('preset'), homeId: ManagedMachinePresetV1Schema.shape.homeId, presetId: ManagedMachinePresetV1Schema.shape.id }),
]));
export type ManagedSessionPlacementV1 = z.infer<typeof ManagedSessionPlacementV1Schema>;

export const ManagedConnectedServiceDefaultV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: QualifiedConnectedAccountPurposeV1Schema,
  service: asProtocolZod(ConnectedAccountServiceIdentityV1Schema),
  target: z.nullable(QualifiedConnectedAccountPurposeBindingTargetV1Schema),
  teamResource: z.nullable(z.pick(QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema, { teamId: true, selection: true })),
}).check(z.superRefine((binding, context) => {
  if (binding.target && binding.teamResource) {
    context.addIssue({ code: 'custom', path: ['teamResource'], message: 'A purpose has one selection' });
  }
  const targetService = binding.target?.kind === 'account' ? binding.target.account.service : binding.target?.service;
  if (targetService && !sameStrictJsonValue(binding.service, targetService)) {
    context.addIssue({ code: 'custom', path: ['target'], message: 'Selection service must match its declared service' });
  }
})));
export type ManagedConnectedServiceDefaultV1 = z.infer<typeof ManagedConnectedServiceDefaultV1Schema>;

export const ManagedSessionDefaultsV1Schema = lazyZodSchema(() => z.strictObject({
  placement: z.optional(ManagedSessionPlacementV1Schema),
  permissionModeByAgentTargetKey: z.optional(z.record(ProviderAgentTargetKeySchema, asProtocolZod(AgentPermissionIntentV1Schema))),
  modelByAgentTargetKey: z.optional(z.record(ProviderAgentTargetKeySchema, z.union([SessionModelSelectionV1Schema, SessionModelSelectionV2Schema]))),
  connectedServicesByAgentTargetKey: z.optional(z.record(ProviderAgentTargetKeySchema, z.readonly(z.array(ManagedConnectedServiceDefaultV1Schema)))),
}).check(z.superRefine((defaults, context) => {
  for (const [key, model] of Object.entries(defaults.modelByAgentTargetKey ?? {})) {
    if (key !== model.ref.agentTargetKey) context.addIssue({ code: 'custom', path: ['modelByAgentTargetKey', key], message: 'Model Agent target must match its key' });
  }
  for (const [key, bindings] of Object.entries(defaults.connectedServicesByAgentTargetKey ?? {})) {
    const seen = new Set<string>();
    for (const [index, binding] of bindings.entries()) {
      const purpose = qualifiedPurposeKey(binding.purpose);
      if (seen.has(purpose)) context.addIssue({ code: 'custom', path: ['connectedServicesByAgentTargetKey', key, index, 'purpose'], message: 'A qualified purpose has one default' });
      seen.add(purpose);
    }
  }
})));
export type ManagedSessionDefaultsV1 = z.infer<typeof ManagedSessionDefaultsV1Schema>;

/** Request-only choices can explicitly retain the Agent's Automatic model. */
export type ManagedSessionExplicitChoicesV1 = Readonly<Omit<ManagedSessionDefaultsV1, 'modelByAgentTargetKey'> & {
  modelByAgentTargetKey?: Readonly<Record<string, SessionModelSelectionV1 | SessionModelSelectionV2 | null>>;
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

export type ManagedSessionDefaultsContext = Readonly<{
  /** Member-owned settings deliberately saved by the person; absent facets remain unset. */
  memberDefaults?: ManagedSessionDefaultsV1 | null;
  teamDefaults?: ManagedDefaultsV1 | null;
  groupIds?: readonly string[];
  homeDefaults?: ManagedSessionDefaultsV1 | null;
  policyDefaults?: Readonly<{ values: ManagedSessionDefaultsV1; locked: boolean; organization: string; supportUrl?: string }> | null;
}>;
export type ManagedDefaultDecision<T> = Readonly<{
  value: T | undefined;
  source: 'policy' | 'explicit' | 'member' | 'group' | 'team' | 'home' | 'none';
  lock: Readonly<{ organization: string; supportUrl?: string }> | null;
  groupConflict: boolean;
}>;
export type ManagedAgentSandboxAvailability =
  | Readonly<{ status: 'enabled' | 'disabled' }>
  | Readonly<{ status: 'unavailable'; reason: 'not_available_in_sandbox_type' }>;
export type ResolvedManagedSessionDefaults = Readonly<{
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

export type ManagedSessionDefaultsLayerV1 = Readonly<{
  source: 'explicit' | 'member' | 'group' | 'team' | 'home' | 'policy';
  defaults: ManagedSessionExplicitChoicesV1 | null;
}>;

export type ManagedSessionDefaultsLayerProjectionV1 = Readonly<{
  layers: readonly ManagedSessionDefaultsLayerV1[];
  purposeKeys: readonly string[];
}>;

/** The canonical layer order and connected-service purpose projection. */
export function projectManagedSessionDefaultsLayers(
  input: ManagedSessionDefaultsContext & Readonly<{
    agentTargetKey: string;
    explicitChoices?: ManagedSessionExplicitChoicesV1;
  }>,
): ManagedSessionDefaultsLayerProjectionV1 {
  const groups = (input.groupIds ?? []).flatMap(id => input.teamDefaults?.groups[id] ? [input.teamDefaults.groups[id]] : []);
  const layers: ManagedSessionDefaultsLayerV1[] = [
    { source: 'explicit', defaults: input.explicitChoices ?? null },
    { source: 'member', defaults: input.memberDefaults ?? null },
    ...groups.map(defaults => ({ source: 'group' as const, defaults })),
    { source: 'team', defaults: input.teamDefaults?.team ?? null },
    { source: 'home', defaults: input.homeDefaults ?? null },
    { source: 'policy', defaults: input.policyDefaults?.values ?? null },
  ];
  const targetKey = input.agentTargetKey;
  const purposeKeys = [...new Set(layers.flatMap(layer =>
    layer.defaults?.connectedServicesByAgentTargetKey?.[targetKey]?.map(value => qualifiedPurposeKey(value.purpose)) ?? []
  ))].sort();
  return { layers, purposeKeys };
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
    const candidates = [
      ['explicit', input.explicitChoices ? read(input.explicitChoices) : undefined],
      ['member', input.memberDefaults ? read(input.memberDefaults) : undefined],
      ['group', groupConflict ? undefined : first],
      ['team', input.teamDefaults ? read(input.teamDefaults.team) : undefined],
      ['home', input.homeDefaults ? read(input.homeDefaults) : undefined],
      ['policy', policyValue],
    ] as const;
    for (const [source, value] of candidates) if (value !== undefined) return { value, source, lock: null, groupConflict };
    return { value: undefined, source: 'none', lock: null, groupConflict };
  }
  const targetKey = input.agentTargetKey;
  const purposeKey = (value: z.infer<typeof ManagedConnectedServiceDefaultV1Schema>) =>
    qualifiedPurposeKey(value.purpose);
  const purposeKeys = new Set(projection.purposeKeys);
  const modelIdentity = (model: SessionModelSelectionV1 | SessionModelSelectionV2 | null) => model === null ? null : model.v === 1
    ? model.ref
    : projectSessionModelSelectionV2ToV1(model)?.ref ?? model.ref;
  const agentSandbox = resolveManagedAgentSandbox(input);
  return {
    placement: decide(defaults => defaults.placement),
    permissionMode: decide(defaults => defaults.permissionModeByAgentTargetKey?.[targetKey]),
    agentSandbox,
    model: decide(defaults => defaults.modelByAgentTargetKey?.[targetKey], (left, right) => sameStrictJsonValue(modelIdentity(left), modelIdentity(right))),
    connectedServices: [...purposeKeys].sort().map(key => decide(defaults =>
      defaults.connectedServicesByAgentTargetKey?.[targetKey]?.find(value => purposeKey(value) === key))),
  };
}
