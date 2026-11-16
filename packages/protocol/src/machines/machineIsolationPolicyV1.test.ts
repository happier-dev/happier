import { describe, expect, it } from 'vitest';
import type { MachineMetadataFieldPortV1 } from './machineMetadataFieldV1.js';
import { getMachineIsolationV1, machineIsolationMetadataFieldV1, mutateMachineIsolationV1 } from './machineIsolationPolicyV1.js';

function boundary(metadata: Record<string, unknown> = {}) {
  let current = metadata;
  const writes: Record<string, unknown>[] = [];
  const port: MachineMetadataFieldPortV1 = {
    read: async () => ({ status: 'ready', metadata: current, metadataVersion: 3 }),
    compareAndSwap: async input => {
      current = input.metadata;
      writes.push(current);
      return { status: 'applied', metadata: current, metadataVersion: 4 };
    },
  };
  return { port, writes };
}

describe('Machine isolation metadata policy', () => {
  it('reads missing policy as Directly and refuses malformed saved isolation', async () => {
    expect(await getMachineIsolationV1(boundary().port)).toMatchObject({ status: 'ready', source: 'default',
      policy: { configuredSandboxes: {}, workKinds: { sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } } } });
    expect(await getMachineIsolationV1(boundary({ isolationPolicyV1: { workKinds: {} } }).port)).toEqual({ status: 'invalid' });
  });

  it('writes admitted references once without replacing unrelated metadata', async () => {
    const b = boundary({ host: 'laptop', rolesV1: { active: ['sessions'] } });
    const expectedPolicy = machineIsolationMetadataFieldV1.defaultValue();
    const policy = { ...expectedPolicy,
      configuredSandboxes: { local: { provisioner: { pluginId: 'acme.sandbox', localId: 'local' }, presetId: 'preset' } },
      workKinds: { ...expectedPolicy.workKinds, sessions: { kind: 'sandbox' as const, configuredSandboxId: 'local', lifecycle: 'fresh' as const } } };
    const validated: unknown[] = [];
    const result = await mutateMachineIsolationV1({ expectedMetadataVersion: 3, expectedPolicy, policy }, b.port, {
      validateConfiguredSandboxes: async entry => { validated.push(entry); return 'valid'; },
    });
    expect(result).toEqual({ status: 'applied', policy, metadataVersion: 4 });
    expect(validated).toEqual([policy.configuredSandboxes]);
    expect(b.writes).toEqual([{ host: 'laptop', rolesV1: { active: ['sessions'] }, isolationPolicyV1: policy }]);
  });

  it('rejects dangling choices and non-admitted or remote preset entries before writing', async () => {
    const b = boundary();
    const expectedPolicy = machineIsolationMetadataFieldV1.defaultValue();
    const dangling = { ...expectedPolicy, workKinds: { ...expectedPolicy.workKinds,
      sessions: { kind: 'sandbox', configuredSandboxId: 'missing', lifecycle: 'fresh' } } };
    expect(await mutateMachineIsolationV1({ expectedMetadataVersion: 3, expectedPolicy, policy: dangling }, b.port,
      { validateConfiguredSandboxes: async () => 'valid' })).toEqual({ status: 'invalid' });
    const configured = { ...expectedPolicy, configuredSandboxes: {
      local: { provisioner: { pluginId: 'acme.sandbox', localId: 'remote' }, presetId: 'preset' } } };
    expect(await mutateMachineIsolationV1({ expectedMetadataVersion: 3, expectedPolicy, policy: configured }, b.port,
      { validateConfiguredSandboxes: async () => 'invalid' })).toEqual({ status: 'invalid' });
    expect(b.writes).toEqual([]);
  });
});
