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

/** Current retained power facts, shared by INT presentation and finite placement; not dispatch authority. */
export function resolveManagedMachineWakeStateV1(machine: ManagedMachineV1, enrolledMachineId: string): 'asleep' | 'starting' | null {
  if (machine.creationState !== 'active' || machine.archivedAt !== undefined || machine.enrolledMachineId !== enrolledMachineId
    || machine.allocation !== 'bound' || !machine.resource || machine.observation?.availability !== 'present'
    || machine.observation.storage === 'lost' || machine.desired === 'delete' || machine.cleanup
    || machine.submittedNativeEffect?.intent === 'delete') return null;
  if (machine.observation.power !== 'running' && machine.submittedNativeEffect?.intent === 'start') return 'starting';
  return machine.observation.storage === 'retained'
    && (machine.observation.power === 'stopped' || machine.observation.power === 'suspended')
    && machine.wakeOnAcceptedMessage && isMachineRetainedWakeEligibleV1(machine.retention, machine.reviewedFacts?.retentionCapabilities)
    ? 'asleep' : null;
}

/** Explicit live edits are refused rather than mapped to a different native effect. */
export function isMachineRetentionPolicySupportedV1(policy: MachineRetentionPolicyV1,
  nativeCapabilities: Pick<RetentionCapabilitiesV1, 'supportedIntents' | 'finiteOnly'>): boolean {
  return !(nativeCapabilities.finiteOnly && policy.retention.kind === 'until-delete')
    && (policy.retention.kind === 'until-delete' || nativeCapabilities.supportedIntents.includes(policy.retention.effect))
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
  // This qualifies Keep at acquisition only. An explicit native Stop Action never maps to Delete.
  if (supported && !supported.includes('stop') && supported.includes('delete')
    && retention.kind === 'unused' && retention.effect === 'stop') {
    retention = { ...retention, effect: 'delete' };
  }
  if (!isMachineRetainedWakeEligibleV1(retention, input.nativeCapabilities)) {
    wakeOnAcceptedMessage = false;
  }
  return { category, retention, wakeOnAcceptedMessage, retentionSource, wakeSource,
    source: retentionSource === wakeSource ? retentionSource : 'mixed' };
}
