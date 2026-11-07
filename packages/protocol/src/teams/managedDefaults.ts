import { z } from 'zod/mini';
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
  teamDefaults?: ManagedDefaultsV1 | null;
  groupIds?: readonly string[];
  homeDefaults?: ManagedSessionDefaultsV1 | null;
  policyDefaults?: Readonly<{ values: ManagedSessionDefaultsV1; locked: boolean; organization: string; supportUrl?: string }> | null;
}>;
export type ManagedDefaultDecision<T> = Readonly<{
  value: T | undefined;
  source: 'policy' | 'explicit' | 'group' | 'team' | 'home' | 'none';
  lock: Readonly<{ organization: string; supportUrl?: string }> | null;
  groupConflict: boolean;
}>;
export type ResolvedManagedSessionDefaults = Readonly<{
  placement: ManagedDefaultDecision<ManagedSessionPlacementV1>;
  permissionMode: ManagedDefaultDecision<AgentPermissionIntentV1>;
  model: ManagedDefaultDecision<SessionModelSelectionV1 | SessionModelSelectionV2>;
  connectedServices: readonly ManagedDefaultDecision<ManagedConnectedServiceDefaultV1>[];
}>;

/** One decision per field/purpose. Defaults express intent and never confer resource access. */
export function resolveManagedSessionDefaults(input: ManagedSessionDefaultsContext & Readonly<{
  agentTargetKey: string; explicitChoices?: ManagedSessionDefaultsV1;
}>): ResolvedManagedSessionDefaults {
  const groups = (input.groupIds ?? []).flatMap(id => input.teamDefaults?.groups[id] ? [input.teamDefaults.groups[id]] : []);
  function decide<T>(read: (defaults: ManagedSessionDefaultsV1) => T | undefined,
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
      ['explicit', input.explicitChoices && read(input.explicitChoices)],
      ['group', groupConflict ? undefined : first],
      ['team', input.teamDefaults && read(input.teamDefaults.team)],
      ['home', input.homeDefaults && read(input.homeDefaults)],
      ['policy', policyValue],
    ] as const;
    for (const [source, value] of candidates) if (value !== undefined && value !== null) return { value, source, lock: null, groupConflict };
    return { value: undefined, source: 'none', lock: null, groupConflict };
  }
  const targetKey = input.agentTargetKey;
  const purposeKey = (value: z.infer<typeof ManagedConnectedServiceDefaultV1Schema>) =>
    qualifiedPurposeKey(value.purpose);
  const layers = [input.explicitChoices, ...groups, input.teamDefaults?.team, input.homeDefaults, input.policyDefaults?.values];
  const purposeKeys = new Set(layers.flatMap(layer => layer?.connectedServicesByAgentTargetKey?.[targetKey]?.map(purposeKey) ?? []));
  const modelIdentity = (model: SessionModelSelectionV1 | SessionModelSelectionV2) => model.v === 1
    ? model.ref
    : projectSessionModelSelectionV2ToV1(model)?.ref ?? model.ref;
  return {
    placement: decide(defaults => defaults.placement),
    permissionMode: decide(defaults => defaults.permissionModeByAgentTargetKey?.[targetKey]),
    model: decide(defaults => defaults.modelByAgentTargetKey?.[targetKey], (left, right) => sameStrictJsonValue(modelIdentity(left), modelIdentity(right))),
    connectedServices: [...purposeKeys].sort().map(key => decide(defaults =>
      defaults.connectedServicesByAgentTargetKey?.[targetKey]?.find(value => purposeKey(value) === key))),
  };
}
