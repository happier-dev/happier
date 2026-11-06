import type { BillingCapabilitiesV1, RetentionCapabilitiesV1 } from './providerFactsV1.js';
import type { ManagedMachineV1, RetentionV1 } from './managedMachineV1.js';
import type { MachineRetentionCategoryV1, MachineRetentionDefaultsV1, MachineRetentionOverrideV1, MachineRetentionPolicyV1 } from '../../account/settings/machineRetentionDefaultsV1.js';

/** D21's selected product default, not a lifecycle timeout or resource limit. */
export const DEFAULT_MACHINE_UNUSED_RETENTION_MS_V1 = 3_600_000;
export type MachineRetentionPolicySourceV1 = 'machine' | 'preset' | 'category' | 'default';
export type ResolvedMachineRetentionPolicyV1 = MachineRetentionPolicyV1 & Readonly<{
  category: MachineRetentionCategoryV1;
  source: MachineRetentionPolicySourceV1 | 'mixed';
  retentionSource: MachineRetentionPolicySourceV1;
  wakeSource: MachineRetentionPolicySourceV1;
}>;

/** Until-delete permits wake after a manual Stop; destruction-ending policies cannot retain the resource. */
export function isMachineRetainedWakeEligibleV1(retention: RetentionV1, nativeCapabilities?: Pick<RetentionCapabilitiesV1, 'supportedIntents'>): boolean {
  return !(retention.kind !== 'until-delete' && retention.effect === 'delete')
    && (!nativeCapabilities || nativeCapabilities.supportedIntents.some(intent => intent === 'start' || intent === 'resume'));
}

function isManagedMachineWakeTargetV1(machine: ManagedMachineV1, enrolledMachineId: string): boolean {
  return machine.creationState === 'active' && machine.archivedAt === undefined && machine.enrolledMachineId === enrolledMachineId
    && machine.allocation === 'bound' && Boolean(machine.resource) && machine.observation?.availability === 'present'
    && machine.observation.storage !== 'lost' && machine.desired !== 'delete' && !machine.cleanup
    && machine.submittedNativeEffect?.intent !== 'delete';
}

/** Current retained power facts, shared by INT presentation and finite placement; not dispatch authority. */
export function resolveManagedMachineWakeStateV1(machine: ManagedMachineV1, enrolledMachineId: string): 'asleep' | 'starting' | null {
  if (!isManagedMachineWakeTargetV1(machine, enrolledMachineId)) return null;
  if (machine.observation?.power !== 'running'
    && (machine.submittedNativeEffect?.intent === 'start' || machine.submittedNativeEffect?.intent === 'resume')) return 'starting';
  return machine.observation?.storage === 'retained'
    && (machine.observation.power === 'stopped' || machine.observation.power === 'suspended')
    && isMachineRetainedWakeEligibleV1(machine.retention, machine.reviewedFacts?.retentionCapabilities)
    ? 'asleep' : null;
}

/** Offline runtime demand must not trust a retained running observation after a vendor stop. */
export function isManagedMachineWakeInspectionRequiredV1(machine: ManagedMachineV1, enrolledMachineId: string,
  machineReachable: boolean): boolean {
  const state = resolveManagedMachineWakeStateV1(machine, enrolledMachineId);
  return state === 'asleep' || state !== 'starting' && !machineReachable
    && isManagedMachineWakeTargetV1(machine, enrolledMachineId)
    && machine.observation?.storage === 'retained' && machine.observation.power === 'running'
    && isMachineRetainedWakeEligibleV1(machine.retention, machine.reviewedFacts?.retentionCapabilities);
}

type RetentionEffectV1 = Extract<RetentionV1, { effect: unknown }>['effect'];
type NativeIntentsV1 = RetentionCapabilitiesV1['supportedIntents'];

/**
 * The native intent that carries out a retention effect. Stop means "parked, not billed": the
 * provider's native Stop, or its native Suspend when that is the only way it parks. Delete never
 * stands in for Stop. Null when the provider declares nothing that can carry the effect.
 */
export function resolveMachineRetentionNativeIntentV1(effect: RetentionEffectV1, supportedIntents: NativeIntentsV1): 'stop' | 'suspend' | 'delete' | null {
  if (effect === 'delete') return supportedIntents.includes('delete') ? 'delete' : null;
  return supportedIntents.includes('stop') ? 'stop' : supportedIntents.includes('suspend') ? 'suspend' : null;
}

/** Retention effects a provider can carry out; the only filter any consumer applies to its declared intents. */
export function supportedMachineRetentionEffectsV1(supportedIntents: NativeIntentsV1): RetentionEffectV1[] {
  return (['stop', 'delete'] as const).filter(effect => resolveMachineRetentionNativeIntentV1(effect, supportedIntents) !== null);
}

/**
 * A provider that declares both wake verbs offers one: Resume for a suspended machine and Start
 * otherwise, the same rule accepted-message wake dispatches by. A pair on one machine is noise.
 */
export function isRedundantManagedWakeIntentV1(intent: 'start' | 'resume', observedPower: 'running' | 'stopped' | 'suspended' | 'unknown' | undefined,
  supportedIntents: NativeIntentsV1): boolean {
  const suspended = observedPower === 'suspended';
  return intent === 'start' ? suspended && supportedIntents.includes('resume') : !suspended && supportedIntents.includes('start');
}

/** Explicit live edits are refused rather than mapped to a different native effect. */
export function isMachineRetentionPolicySupportedV1(policy: MachineRetentionPolicyV1,
  nativeCapabilities: Pick<RetentionCapabilitiesV1, 'supportedIntents' | 'finiteOnly'>): boolean {
  return !(nativeCapabilities.finiteOnly && policy.retention.kind === 'until-delete')
    && (policy.retention.kind === 'until-delete' || resolveMachineRetentionNativeIntentV1(policy.retention.effect, nativeCapabilities.supportedIntents) !== null)
    && (!policy.wakeOnAcceptedMessage || isMachineRetainedWakeEligibleV1(policy.retention, nativeCapabilities));
}

export function resolveMachineRetentionCategoryV1(
  billing: Pick<BillingCapabilitiesV1, 'location' | 'stoppedBilling'>,
): MachineRetentionCategoryV1 {
  if (billing.location === 'local') return 'local';
  if (billing.location === 'cloud') {
    if (billing.stoppedBilling === 'not-billed') return 'running-only';
    if (billing.stoppedBilling === 'billed') return 'stopped-billed';
  }
  return 'unknown';
}

export function getMachineRetentionCategoryDefaultV1(category: MachineRetentionCategoryV1): MachineRetentionPolicyV1 {
  const unused = category === 'local' || category === 'running-only';
  return {
    retention: unused
      ? { kind: 'unused', afterMs: DEFAULT_MACHINE_UNUSED_RETENTION_MS_V1, effect: 'stop' }
      : { kind: 'until-delete' },
    wakeOnAcceptedMessage: unused,
  };
}

/** Sole policy resolver. Callers snapshot its output; preferences never rewrite an allocation. */
export function resolveMachineRetentionPolicyV1(input: Readonly<{
  billing: Pick<BillingCapabilitiesV1, 'location' | 'stoppedBilling'>;
  machineOverride?: MachineRetentionOverrideV1;
  presetOverride?: MachineRetentionOverrideV1;
  categoryPreferences?: MachineRetentionDefaultsV1;
  nativeCapabilities?: Pick<RetentionCapabilitiesV1, 'supportedIntents' | 'finiteOnly'>;
}>): ResolvedMachineRetentionPolicyV1 {
  const category = resolveMachineRetentionCategoryV1(input.billing);
  const defaultPolicy = getMachineRetentionCategoryDefaultV1(category);
  const policies = [
    ['machine', input.machineOverride],
    ['preset', input.presetOverride],
    ['category', input.categoryPreferences?.[category]],
    ['default', defaultPolicy],
  ] as const;
  let retention: RetentionV1 = defaultPolicy.retention;
  let wakeOnAcceptedMessage = defaultPolicy.wakeOnAcceptedMessage;
  let retentionSource: MachineRetentionPolicySourceV1 = 'default';
  let wakeSource: MachineRetentionPolicySourceV1 = 'default';
  for (const [source, policy] of policies) {
    if (policy?.retention !== undefined) {
      retention = { ...policy.retention };
      retentionSource = source;
      break;
    }
  }
  for (const [source, policy] of policies) {
    if (policy?.wakeOnAcceptedMessage !== undefined) {
      wakeOnAcceptedMessage = policy.wakeOnAcceptedMessage;
      wakeSource = source;
      break;
    }
  }
  const supported = input.nativeCapabilities?.supportedIntents;
  if (input.nativeCapabilities?.finiteOnly && retention.kind === 'until-delete') {
    retention = { kind: 'unused', afterMs: DEFAULT_MACHINE_UNUSED_RETENTION_MS_V1, effect: 'delete' };
  }
  // This qualifies Keep at acquisition only. An explicit native Stop Action never maps to Delete,
  // and a provider that can park with Suspend keeps the user's data: only a provider with no way
  // to park falls back to Delete.
  if (supported && resolveMachineRetentionNativeIntentV1('stop', supported) === null && supported.includes('delete')
    && retention.kind === 'unused' && retention.effect === 'stop') {
    retention = { ...retention, effect: 'delete' };
  }
  if (!isMachineRetainedWakeEligibleV1(retention, input.nativeCapabilities)) {
    wakeOnAcceptedMessage = false;
  }
  return { category, retention, wakeOnAcceptedMessage, retentionSource, wakeSource,
    source: retentionSource === wakeSource ? retentionSource : 'mixed' };
}

export function resolveMachineWakeNativeIntentV1(observedPower: Parameters<typeof isRedundantManagedWakeIntentV1>[1],
  supportedIntents: NativeIntentsV1): 'start' | 'resume' | null {
  return (['start', 'resume'] as const).find(intent => supportedIntents.includes(intent)
    && !isRedundantManagedWakeIntentV1(intent, observedPower, supportedIntents)) ?? null;
}
