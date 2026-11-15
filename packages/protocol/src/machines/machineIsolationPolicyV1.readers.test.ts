import { describe, expect, it } from 'vitest';
import * as isolation from './machineIsolationV1.js';

describe('Machine isolation policy stored readers', () => {
  const policy = {
    configuredSandboxes: {
      node: { provisioner: { pluginId: 'fixture.compute', localId: 'local' }, presetId: 'node' },
      python: { provisioner: { pluginId: 'fixture.other', localId: 'local' }, presetId: 'python' },
    },
    workKinds: {
      sessions: { kind: 'sandbox', configuredSandboxId: 'node', lifecycle: 'fresh' },
      botsChannels: { kind: 'sandbox', configuredSandboxId: 'python', lifecycle: 'shared-kept' },
      automationsWorkflows: { kind: 'directly' },
    },
  };

  it('preserves independent work choices and defaults absent native preference off', () => {
    expect(isolation.readMachineIsolationPolicyV1({ isolationPolicyV1: policy })).toEqual(policy);
    expect(isolation.readMachineAgentNativeSandboxEnabledV1({ isolationPolicyV1: policy })).toBe(false);
    expect(isolation.readMachineAgentNativeSandboxEnabledV1({ isolationPolicyV1: { ...policy, agentNativeSandboxEnabled: true } })).toBe(true);
    expect(isolation.readMachineIsolationPolicyV1({})).toBeNull();
    expect(isolation.readMachineAgentNativeSandboxEnabledV1({})).toBe(false);
  });

  it('drops future stored fields while rejecting malformed present policy rather than choosing Directly', () => {
    expect(isolation.readMachineIsolationPolicyV1({ isolationPolicyV1: {
      ...policy, future: true, workKinds: { ...policy.workKinds, future: {} },
    } })).toEqual(policy);
    for (const isolationPolicyV1 of [null, {}, { ...policy, agentNativeSandboxEnabled: 'true' }]) {
      expect(() => isolation.readMachineIsolationPolicyV1({ isolationPolicyV1 })).toThrow();
    }
    expect(() => isolation.readMachineIsolationPolicyV1(null)).toThrow();
  });
});
