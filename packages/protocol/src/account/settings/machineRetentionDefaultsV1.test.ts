import { describe, expect, it } from 'vitest';
import * as owner from './accountSettings.js';
import { applyAccountSettingMutationV1 } from './accountSettingMutationV1.js';
import { resolveMachineRetentionPolicyV1 as resolve } from '../../machines/managed/resolveMachineRetentionPolicyV1.js';
import { MACHINE_RETENTION_CATEGORIES_V1, MachineRetentionPolicyV1Schema, updateMachineRetentionCategoryPreferenceV1 } from './machineRetentionDefaultsV1.js';

const unused = { kind: 'unused', afterMs: 3_600_000, effect: 'stop' } as const;
const keep = { kind: 'until-delete' } as const;

describe('managed machine category preference through Account settings', () => {
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
    const policy = { retention: { kind: 'deadline', at: 4_000, effect: 'stop', interrupts: true },
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
        .toMatchObject({ category: 'running-only', retention: unused, wakeOnAcceptedMessage: true, source: 'default' });
    }
    expect(resolve({ billing: { location: 'unknown', stoppedBilling: 'not-billed' } }))
      .toMatchObject({ category: 'unknown', retention: keep, wakeOnAcceptedMessage: false });
    expect(resolve({ billing: { location: 'cloud', stoppedBilling: 'billed' } }))
      .toMatchObject({ category: 'stopped-billed', retention: keep, wakeOnAcceptedMessage: false });
    const params = { billing: { location: 'local' as const, stoppedBilling: 'billed' as const },
      categoryPreferences: { v: 1 as const, local: { retention: keep, wakeOnAcceptedMessage: false } },
      presetOverride: { retention: unused, wakeOnAcceptedMessage: true },
      machineOverride: { retention: keep, wakeOnAcceptedMessage: true } };
    const snapshot = resolve(params);
    expect(snapshot).toMatchObject({ category: 'local', source: 'machine', retention: keep, wakeOnAcceptedMessage: true });
    expect(resolve({ ...params, machineOverride: undefined })).toMatchObject({ source: 'preset', retention: unused });
    expect(resolve({ ...params, machineOverride: undefined, presetOverride: undefined }))
      .toMatchObject({ source: 'category', retention: keep, wakeOnAcceptedMessage: false });
    params.machineOverride.wakeOnAcceptedMessage = false;
    expect(snapshot.wakeOnAcceptedMessage).toBe(true);
    expect(resolve({ billing: params.billing, categoryPreferences: params.categoryPreferences,
      presetOverride: { retention: unused }, machineOverride: { wakeOnAcceptedMessage: false } }))
      .toMatchObject({ retention: unused, wakeOnAcceptedMessage: false,
        retentionSource: 'preset', wakeSource: 'machine' });
  });

  it('qualifies finite no-keep capabilities once and never promises wake after destruction', () => {
    const billing = { location: 'cloud', stoppedBilling: 'billed' } as const;
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
    expect(resolve({ billing: { location: 'local', stoppedBilling: 'unknown' },
      machineOverride: { retention: { ...unused, effect: 'delete' }, wakeOnAcceptedMessage: true },
      nativeCapabilities: { supportedIntents: ['start', 'stop', 'delete'] } }))
      .toMatchObject({ retention: { ...unused, effect: 'delete' }, wakeOnAcceptedMessage: false });
  });

  it('does not silently change an explicitly selected deadline Stop into Delete', () => {
    const retention = { kind: 'deadline', at: 4_000, effect: 'stop', interrupts: true } as const;
    expect(resolve({ billing: { location: 'local', stoppedBilling: 'unknown' },
      machineOverride: { retention }, nativeCapabilities: { supportedIntents: ['delete'] } }).retention)
      .toEqual(retention);
  });
});
