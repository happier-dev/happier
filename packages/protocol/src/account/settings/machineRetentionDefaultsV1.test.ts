import { describe, expect, it } from 'vitest';
import * as owner from './accountSettings.js';
import { applyAccountSettingMutationV1 } from './accountSettingMutationV1.js';
import { isMachineRetentionPolicySupportedV1, isRedundantManagedWakeIntentV1, resolveMachineRetentionNativeIntentV1, resolveMachineWakeNativeIntentV1, resolveMachineRetentionPolicyV1 as resolve, resolveManagedMachineWakeStateV1, supportedMachineRetentionEffectsV1 } from '../../machines/managed/resolveMachineRetentionPolicyV1.js';
import { MACHINE_RETENTION_CATEGORIES_V1, MachineRetentionPolicyV1Schema, updateMachineRetentionCategoryPreferenceV1 } from './machineRetentionDefaultsV1.js';
import { ManagedMachineV1Schema } from '../../machines/managed/managedMachineV1.js';

const unused = { kind: 'unused', afterMs: 3_600_000, effect: 'stop' } as const;
const keep = { kind: 'until-delete' } as const;

describe('managed machine category preference through Account settings', () => {
  it('defaults deletion reminders to two days and admits a deliberate nonnegative lead time', () => {
    expect(owner.accountSettingsParse({}).managedMachineDeletionReminderLeadTimeMs).toBe(172_800_000);
    const edited = applyAccountSettingMutationV1({ unrelated: 'preserved' }, { operations: [
      { op: 'set', key: 'managedMachineDeletionReminderLeadTimeMs', value: 604_800_000 },
    ] });
    expect(edited).toEqual({ status: 'applied', raw: {
      unrelated: 'preserved', managedMachineDeletionReminderLeadTimeMs: 604_800_000,
    } });
    for (const value of [-1, 1.5, '2 days']) {
      expect(applyAccountSettingMutationV1({}, { operations: [
        { op: 'set', key: 'managedMachineDeletionReminderLeadTimeMs', value },
      ] })).toMatchObject({ status: 'invalid' });
    }
    expect(applyAccountSettingMutationV1({}, { operations: [
      { op: 'set', key: 'managedMachineDeletionReminderLeadTimeMs', value: 0 },
    ] })).toMatchObject({ status: 'applied' });
  });
  it('defaults creation on and admits only boolean acquisition preferences', () => {
    expect(owner.accountSettingsParse({}).managedMachineCreationEnabled).toBe(true);
    expect(owner.accountSettingsParse({ managedMachineCreationEnabled: false }).managedMachineCreationEnabled).toBe(false);
    expect(applyAccountSettingMutationV1({}, { operations: [
      { op: 'set', key: 'managedMachineCreationEnabled', value: false },
    ] })).toEqual({ status: 'applied', raw: { managedMachineCreationEnabled: false } });
    expect(applyAccountSettingMutationV1({}, { operations: [
      { op: 'set', key: 'managedMachineCreationEnabled', value: 'false' },
    ] })).toMatchObject({ status: 'invalid' });
  });
  it('reads absent predecessor preferences as inherited and drops stored extras recursively', () => {
    expect(owner.accountSettingsParse({}).machineRetentionDefaultsV1).toEqual({ v: 1 });
    const parsed = owner.accountSettingsParse({ machineRetentionDefaultsV1: {
      v: 1, future: true, local: { retention: { ...unused, future: true }, wakeOnAcceptedMessage: false, future: true },
    } });
    expect(parsed.machineRetentionDefaultsV1).toEqual({ v: 1, local: { retention: unused, wakeOnAcceptedMessage: false } });
  });

  it('admits canonical preference mutations and refuses hidden resource data', () => {
    const value = { v: 1, local: { retention: unused, wakeOnAcceptedMessage: true } };
    expect(applyAccountSettingMutationV1({ unrelated: 'preserved' }, { operations: [
      { op: 'set', key: 'machineRetentionDefaultsV1', value },
    ] })).toEqual({ status: 'applied', raw: { unrelated: 'preserved', machineRetentionDefaultsV1: value } });
    expect(applyAccountSettingMutationV1({}, { operations: [
      { op: 'set', key: 'machineRetentionDefaultsV1', value: { ...value, managedId: 'secret-resource' } },
    ] })).toMatchObject({ status: 'invalid', reason: 'invalidValue' });
  });

  it('refuses absolute deadlines in every reusable category without narrowing one-off policies', () => {
    const policy = { retention: { kind: 'deadline', at: 4_000, effect: 'stop' },
      wakeOnAcceptedMessage: true } as const;
    expect(MachineRetentionPolicyV1Schema.parse(policy)).toEqual(policy);
    for (const category of MACHINE_RETENTION_CATEGORIES_V1) {
      expect(applyAccountSettingMutationV1({}, { operations: [
        { op: 'set', key: 'machineRetentionDefaultsV1', value: { v: 1, [category]: policy } },
      ] })).toMatchObject({ status: 'invalid', reason: 'invalidValue' });
      expect(() => updateMachineRetentionCategoryPreferenceV1({ v: 1 }, category, policy)).toThrow();
      for (const retention of [unused, keep]) {
        const value = { v: 1, [category]: { retention, wakeOnAcceptedMessage: true } };
        expect(applyAccountSettingMutationV1({}, { operations: [
          { op: 'set', key: 'machineRetentionDefaultsV1', value },
        ] })).toEqual({ status: 'applied', raw: { machineRetentionDefaultsV1: value } });
      }
    }
  });

  it('resolves descriptor facts and precedence without provider identity or mutating snapshots', () => {
    for (const providerId of ['one', 'other']) {
      const billing = { location: 'cloud', stoppedBilling: 'not-billed', providerId } as const;
      expect(resolve({ billing }))
        .toEqual({ category: 'running-only', retention: unused, wakeOnAcceptedMessage: true });
    }
    expect(resolve({ billing: { location: 'unknown', stoppedBilling: 'not-billed' } }))
      .toMatchObject({ category: 'unknown', retention: keep, wakeOnAcceptedMessage: false });
    expect(resolve({ billing: { location: 'cloud', stoppedBilling: 'billed' } }))
      .toMatchObject({ category: 'stopped-billed', retention: keep, wakeOnAcceptedMessage: true });
    const params = { billing: { location: 'local' as const, stoppedBilling: 'billed' as const },
      categoryPreferences: { v: 1 as const, local: { retention: keep, wakeOnAcceptedMessage: false } },
      presetOverride: { retention: unused, wakeOnAcceptedMessage: true },
      machineOverride: { retention: keep, wakeOnAcceptedMessage: true } };
    const snapshot = resolve(params);
    expect(snapshot).toMatchObject({ category: 'local', retention: keep, wakeOnAcceptedMessage: true });
    expect(resolve({ ...params, machineOverride: undefined })).toMatchObject({ retention: unused, wakeOnAcceptedMessage: true });
    expect(resolve({ ...params, machineOverride: undefined, presetOverride: undefined }))
      .toMatchObject({ retention: keep, wakeOnAcceptedMessage: false });
    params.machineOverride.wakeOnAcceptedMessage = false;
    expect(snapshot.wakeOnAcceptedMessage).toBe(true);
    expect(resolve({ billing: params.billing, categoryPreferences: params.categoryPreferences,
      presetOverride: { retention: unused }, machineOverride: { wakeOnAcceptedMessage: false } }))
      .toMatchObject({ retention: unused, wakeOnAcceptedMessage: false });
  });

  it('defaults cloud accepted-input wake on independently of stopped billing and preserves the per-Machine opt-out', () => {
    for (const stoppedBilling of ['not-billed', 'billed', 'unknown'] as const) {
      const billing = { location: 'cloud', stoppedBilling } as const;
      expect(resolve({ billing }).wakeOnAcceptedMessage).toBe(true);
      expect(resolve({ billing, machineOverride: { wakeOnAcceptedMessage: false } }).wakeOnAcceptedMessage).toBe(false);
    }
  });

  it('keeps explicit wake available when accepted-input auto-wake is off without misclassifying running compute', () => {
    const provider = { pluginId: 'fixture.cloud', localId: 'vm' };
    const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
      enrolledMachineId: 'guest', launch: { provider, schemaVersion: 1, name: 'Cloud', choices: {} },
      allocation: 'bound', resource: { contributionRef: provider, schemaVersion: 1, value: { id: 'native' } },
      creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1, retention: keep,
      wakeOnAcceptedMessage: false, observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' } });
    expect(resolveManagedMachineWakeStateV1(machine, 'guest')).toBe('asleep');
    expect(resolveManagedMachineWakeStateV1({ ...machine,
      observation: { ...machine.observation!, power: 'running' } }, 'guest')).toBeNull();
    expect(resolveManagedMachineWakeStateV1({ ...machine,
      observation: { ...machine.observation!, storage: 'lost' } }, 'guest')).toBeNull();
    for (const power of ['stopped', 'suspended'] as const) {
      expect(resolveManagedMachineWakeStateV1({ ...machine,
        submittedNativeEffect: { intent: 'resume', requestId: 'same-wake', intentRevision: 1 },
        observation: { ...machine.observation!, power } }, 'guest')).toBe('starting');
    }
  });

  it('qualifies finite no-keep capabilities once and never promises wake after destruction', () => {
    const billing = { location: 'cloud', stoppedBilling: 'billed' } as const;
    const retainedWake = { retention: keep, wakeOnAcceptedMessage: true };
    expect(resolve({ billing, machineOverride: retainedWake,
      nativeCapabilities: { supportedIntents: ['start', 'stop', 'delete'] } }))
      .toMatchObject(retainedWake);
    expect(isMachineRetentionPolicySupportedV1(retainedWake, { supportedIntents: ['start', 'stop', 'delete'] })).toBe(true);
    expect(resolve({ billing, machineOverride: retainedWake, nativeCapabilities: { supportedIntents: ['delete'] } }))
      .toMatchObject({ retention: keep, wakeOnAcceptedMessage: false });
    expect(isMachineRetentionPolicySupportedV1(retainedWake, { supportedIntents: ['delete'] })).toBe(false);
    expect(resolve({ billing, nativeCapabilities: { supportedIntents: ['delete'], finiteOnly: true } }))
      .toMatchObject({ retention: { ...unused, effect: 'delete' }, wakeOnAcceptedMessage: false });
    expect(resolve({ billing, nativeCapabilities: { supportedIntents: ['delete'], finiteOnly: false } }))
      .toMatchObject({ retention: keep, wakeOnAcceptedMessage: false });
    expect(resolve({ billing, nativeCapabilities: { supportedIntents: ['delete'] } }))
      .toMatchObject({ retention: keep, wakeOnAcceptedMessage: false });
    expect(resolve({ billing: { location: 'cloud', stoppedBilling: 'not-billed' },
      nativeCapabilities: { supportedIntents: ['delete'] } }))
      .toMatchObject({ retention: { ...unused, effect: 'delete' }, wakeOnAcceptedMessage: false });
    expect(resolve({ billing: { location: 'local', stoppedBilling: 'unknown' },
      nativeCapabilities: { supportedIntents: ['stop', 'delete'] } }))
      .toMatchObject({ retention: unused, wakeOnAcceptedMessage: false });
    expect(resolve({ billing: { location: 'local', stoppedBilling: 'unknown' },
      nativeCapabilities: { supportedIntents: [] } }))
      .toMatchObject({ retention: unused, wakeOnAcceptedMessage: false });
    const destructionWake = { retention: { ...unused, effect: 'delete' as const }, wakeOnAcceptedMessage: true };
    expect(resolve({ billing: { location: 'local', stoppedBilling: 'unknown' },
      machineOverride: destructionWake,
      nativeCapabilities: { supportedIntents: ['start', 'stop', 'delete'] } }))
      .toMatchObject({ retention: { ...unused, effect: 'delete' }, wakeOnAcceptedMessage: false });
    expect(isMachineRetentionPolicySupportedV1(destructionWake, { supportedIntents: ['start', 'stop', 'delete'] })).toBe(false);
  });

  it('parks a suspend-only provisioner with Suspend instead of rewriting unused Stop to Delete', () => {
    const local = { location: 'local', stoppedBilling: 'unknown' } as const;
    const suspendOnly = { supportedIntents: ['start', 'suspend', 'resume', 'delete'] } as const;
    expect(resolve({ billing: local, nativeCapabilities: suspendOnly }))
      .toMatchObject({ retention: unused, wakeOnAcceptedMessage: true });
    expect(isMachineRetentionPolicySupportedV1({ retention: unused, wakeOnAcceptedMessage: true }, suspendOnly)).toBe(true);
    expect(supportedMachineRetentionEffectsV1(suspendOnly.supportedIntents)).toEqual(['stop', 'delete']);
    expect(resolveMachineRetentionNativeIntentV1('stop', suspendOnly.supportedIntents)).toBe('suspend');
    expect(resolveMachineRetentionNativeIntentV1('stop', ['stop', 'suspend', 'delete'])).toBe('stop');
    expect(resolveMachineRetentionNativeIntentV1('delete', suspendOnly.supportedIntents)).toBe('delete');
    expect(resolveMachineRetentionNativeIntentV1('stop', ['delete'])).toBeNull();
    // finiteOnly still turns Keep into Delete: the resource cannot be retained.
    expect(resolve({ billing: local, machineOverride: { retention: keep }, nativeCapabilities: { ...suspendOnly, finiteOnly: true } }).retention)
      .toMatchObject({ kind: 'unused', effect: 'delete' });
  });

  it('offers one wake verb per observed power instead of a Start and Resume pair', () => {
    const both = ['start', 'suspend', 'resume', 'delete'] as const;
    expect(isRedundantManagedWakeIntentV1('start', 'suspended', both)).toBe(true);
    expect(isRedundantManagedWakeIntentV1('resume', 'suspended', both)).toBe(false);
    expect(isRedundantManagedWakeIntentV1('resume', 'stopped', both)).toBe(true);
    expect(isRedundantManagedWakeIntentV1('start', 'stopped', both)).toBe(false);
    // A provider with a single wake verb always offers it.
    expect(isRedundantManagedWakeIntentV1('start', 'suspended', ['start', 'stop'])).toBe(false);
    expect(isRedundantManagedWakeIntentV1('resume', 'stopped', ['resume', 'suspend'])).toBe(false);
    expect(resolveMachineWakeNativeIntentV1('stopped', ['resume'])).toBe('resume');
    expect(resolveMachineWakeNativeIntentV1('stopped', both)).toBe('start');
    expect(resolveMachineWakeNativeIntentV1('suspended', both)).toBe('resume');
    expect(resolveMachineWakeNativeIntentV1('stopped', ['stop', 'delete'])).toBeNull();
  });

  it('does not silently change an explicitly selected deadline Stop into Delete', () => {
    const retention = { kind: 'deadline', at: 4_000, effect: 'stop' } as const;
    expect(resolve({ billing: { location: 'local', stoppedBilling: 'unknown' },
      machineOverride: { retention }, nativeCapabilities: { supportedIntents: ['delete'] } }).retention)
      .toEqual(retention);
  });
});
