import { isManagedOpaquePresetMachineV1 } from './managedMachineV1.js';
import { isMachineOnlineV1 } from '../machineReachabilityV1.js';
import { isMachineReplaced } from '../identity/canonicalMachineId.js';
import type { BillingCapabilitiesV1, RetentionCapabilitiesV1 } from './providerFactsV1.js';
import type { ManagedAsleepWakeV1, ManagedControllerV1, ManagedMachineV1, ManagedMachineInputWakeV1, ManagedMachineNewSessionWakeV1, RetentionV1 } from './managedMachineV1.js';
import type { MachineRetentionCategoryV1, MachineRetentionDefaultsV1, MachineRetentionOverrideV1, MachineRetentionPolicyV1 } from '../../account/settings/machineRetentionDefaultsV1.js';

/** D21's selected product default, not a lifecycle timeout or resource limit. */
export const DEFAULT_MACHINE_UNUSED_RETENTION_MS_V1 = 3_600_000;
export type ResolvedMachineRetentionPolicyV1 = MachineRetentionPolicyV1 & Readonly<{
  category: MachineRetentionCategoryV1;
}>;

/** Until-delete permits wake after a manual Stop; destruction-ending policies cannot retain the resource. */
export function isMachineRetainedWakeEligibleV1(retention: RetentionV1, nativeCapabilities?: Pick<RetentionCapabilitiesV1, 'supportedIntents'>): boolean {
  return !(retention.kind !== 'until-delete' && retention.effect === 'delete')
    && (!nativeCapabilities || nativeCapabilities.supportedIntents.some(intent => intent === 'start' || intent === 'resume'));
}

/** The finite wake owner selects only the assigned installed-controller transport. */
export function resolveManagedFiniteWakeControllerV1(machine: Pick<ManagedMachineV1, 'controller'>):
  Readonly<{ kind: 'available'; controller: ManagedControllerV1 }>
  | Readonly<{ kind: 'unavailable'; reason: 'no_controller' }> {
  return machine.controller ? { kind: 'available', controller: machine.controller }
    : { kind: 'unavailable', reason: 'no_controller' };
}

/** Finite work needs its assigned installation now; accepted Session input retains Home custody. */
export function resolveManagedWakeAvailabilityV1(
  controller: ManagedControllerV1 | undefined,
  observed: Readonly<{
    id: string; installationId?: string | null; online: boolean;
    revokedAt?: number | null; replacedByMachineId?: string | null; replacedAt?: unknown;
  }> | undefined,
): ManagedMachineNewSessionWakeV1 {
  const assigned = resolveManagedFiniteWakeControllerV1({ controller });
  if (assigned.kind === 'unavailable') return assigned;
  return observed?.id === assigned.controller.machineId
    && observed.installationId === assigned.controller.installationId
    && isMachineOnlineV1({ active: observed.online, revokedAt: observed.revokedAt, presenceProtocolVersion: 1 })
    && !isMachineReplaced(observed)
    ? { kind: 'available' } : { kind: 'unavailable', reason: 'controller_unavailable' };
}

/** Controllerless accepted input uses Home custody even when finite new-Session wake is unavailable. */
export function resolveManagedAsleepWakeV1(
  wakeOnAcceptedInput: boolean,
  availability: ManagedMachineNewSessionWakeV1,
): ManagedAsleepWakeV1 {
  if (!wakeOnAcceptedInput) return 'off';
  return availability.kind === 'unavailable' && availability.reason === 'controller_unavailable'
    ? 'waitsForController' : 'onSend';
}

/** Desired intent is history; only an unsettled submitted effect proves a native power transition. */
export function resolveManagedMachinePendingPowerIntentV1(machine: Pick<ManagedMachineV1, 'observation' | 'submittedNativeEffect'>):
  'start' | 'resume' | 'stop' | 'suspend' | null {
  const intent = machine.submittedNativeEffect?.intent;
  const power = machine.observation?.power;
  if (intent === 'start' || intent === 'resume') return power !== 'running' ? intent : null;
  if (intent === 'stop') return power !== 'stopped' ? intent : null;
  if (intent === 'suspend') return power !== 'suspended' ? intent : null;
  return null;
}

/** One runtime decision for demand, Pending activation and retained-power presentation.
 * Presence and native observation remain independent inputs; this grants no dispatch authority.
 */
export function resolveManagedMachineRuntimeV1(machine: ManagedMachineV1, enrolledMachineId: string,
  machineReachable = false): Readonly<{
    available: boolean; ready: boolean; wakeState: ManagedMachineInputWakeV1 | null;
    state: ManagedMachineInputWakeV1 | 'stopping' | null; inspectionRequired: boolean;
    acceptedInputWakeOwner: 'home' | 'caller';
  }> {
  const observation = machine.observation;
  const available = machine.creationState === 'active' && machine.allocation !== 'confirmed-absent'
    && observation?.availability !== 'absent' && observation?.storage !== 'lost';
  const parked = observation?.power === 'stopped' || observation?.power === 'suspended';
  // A reachable guest proves readiness through failed Inspect, unless native facts report loss or parking.
  const ready = available && machineReachable && !parked
    && (observation?.availability === 'present' || observation?.availability === 'unavailable');
  const nativeTarget = available && machine.archivedAt === undefined && machine.enrolledMachineId === enrolledMachineId
    && machine.allocation === 'bound' && (isManagedOpaquePresetMachineV1(machine) || Boolean(machine.resource))
    && observation?.availability === 'present';
  const retainedTarget = nativeTarget && machine.desired !== 'delete' && !machine.cleanup && machine.submittedNativeEffect?.intent !== 'delete';
  const pendingPower = resolveManagedMachinePendingPowerIntentV1(machine);
  const starting = retainedTarget && (pendingPower === 'start' || pendingPower === 'resume');
  const retainedWake = retainedTarget && observation?.storage === 'retained'
    && isMachineRetainedWakeEligibleV1(machine.retention, machine.reviewedFacts?.retentionCapabilities);
  const wakeState = starting ? 'starting' : retainedWake && parked ? 'asleep' : null;
  const stopping = retainedTarget && (pendingPower === 'stop' || pendingPower === 'suspend');
  // Current native lifecycle is presentation, independent of whether automatic wake is enabled or eligible.
  const state = stopping ? 'stopping' : starting ? 'starting'
    : nativeTarget && parked ? 'asleep' : null;
  // Home dispatches accepted input through an assigned controller or its custodian Account daemon.
  return { available, ready, wakeState, state, acceptedInputWakeOwner: 'home',
    // An offline running observation may predate a vendor-side Stop. Native power owns fresh Inspect.
    inspectionRequired: wakeState === 'asleep' || !starting && !machineReachable && retainedWake && observation?.power === 'running' };
}

/** Presentation and finite placement consume the same runtime decision. */
export function resolveManagedMachineWakeStateV1(machine: ManagedMachineV1, enrolledMachineId: string): ManagedMachineInputWakeV1 | null {
  return resolveManagedMachineRuntimeV1(machine, enrolledMachineId).wakeState;
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

/** Choose only a declared wake verb, using the same paired-verb rule as presentation. */
export function resolveMachineWakeNativeIntentV1(observedPower: Parameters<typeof isRedundantManagedWakeIntentV1>[1],
  supportedIntents: NativeIntentsV1): 'start' | 'resume' | null {
  return (['start', 'resume'] as const).find(intent => supportedIntents.includes(intent)
    && !isRedundantManagedWakeIntentV1(intent, observedPower, supportedIntents)) ?? null;
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
    wakeOnAcceptedMessage: unused || category === 'stopped-billed',
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
  const defaultPolicy = { ...getMachineRetentionCategoryDefaultV1(category),
    // Cloud input wake is independent of whether stopped compute is billed or unknown.
    ...(input.billing.location === 'cloud' ? { wakeOnAcceptedMessage: true } : {}) };
  const policies = [
    input.machineOverride,
    input.presetOverride,
    input.categoryPreferences?.[category],
    defaultPolicy,
  ] as const;
  let retention: RetentionV1 = defaultPolicy.retention;
  let wakeOnAcceptedMessage = defaultPolicy.wakeOnAcceptedMessage;
  for (const policy of policies) {
    if (policy?.retention !== undefined) {
      retention = { ...policy.retention };
      break;
    }
  }
  for (const policy of policies) {
    if (policy?.wakeOnAcceptedMessage !== undefined) {
      wakeOnAcceptedMessage = policy.wakeOnAcceptedMessage;
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
  return { category, retention, wakeOnAcceptedMessage };
}
