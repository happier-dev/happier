import { describe, expect, it } from 'vitest';
import { parseMachinePublishedMetadataV1, StoredMachinePublishedMetadataV1Schema } from './machinePublishedContentV1.js';
import { MachineAgentIsolationPolicyV1Schema, MachineAgentIsolationPreviewInputV1Schema,
  MachineAgentIsolationSetInputV1Schema, readMachineAgentIsolationPolicyV1, agentIsolationMetadataFieldV1 } from './agentIsolationV1.js';
import { mutateMachineMetadataFieldV1 } from './machineMetadataFieldV1.js';

describe('Agent isolation policy boundary', () => {
  it('retains owner-reviewed member provisioning as distinct from historical enablement', async () => {
    let metadata: Record<string, unknown> = { agentIsolation: { enabled: true } };
    const reviewed = { enabled: true, memberProvisioning: 'linuxUsersV1' as const };
    let writes = 0;
    const port = { read: async () => ({ status: 'ready' as const, metadata, metadataVersion: 2 }),
      compareAndSwap: async (input: { metadata: Record<string, unknown> }) => {
        writes++; metadata = input.metadata;
        return { status: 'applied' as const, metadata, metadataVersion: 3 };
      } };
    expect(MachineAgentIsolationPolicyV1Schema.safeParse(reviewed).success).toBe(true);
    expect(readMachineAgentIsolationPolicyV1(metadata)).toMatchObject({ policy: { enabled: true } });
    expect(await mutateMachineMetadataFieldV1({ expectedMetadataVersion: 2, expectedPolicy: { enabled: true },
      policy: reviewed, comparison: 'field' }, port, agentIsolationMetadataFieldV1)).toMatchObject({ status: 'applied' });
    expect(readMachineAgentIsolationPolicyV1(metadata)).toMatchObject({ policy: reviewed });
    expect(await mutateMachineMetadataFieldV1({ expectedMetadataVersion: 3, expectedPolicy: reviewed,
      policy: reviewed, comparison: 'field' }, port, agentIsolationMetadataFieldV1)).toMatchObject({ status: 'unchanged' });
    expect(writes).toBe(1);
    expect(MachineAgentIsolationPolicyV1Schema.safeParse({ enabled: true, memberProvisioning: 'arbitraryRoot' }).success).toBe(false);
    expect(MachineAgentIsolationPreviewInputV1Schema.safeParse({ machineId: 'machine', enabled: true,
      memberProvisioning: 'linuxUsersV1' }).success).toBe(true);
    expect(MachineAgentIsolationSetInputV1Schema.safeParse({ machineId: 'machine', enabled: true,
      memberProvisioning: 'linuxUsersV1', expectedMetadataVersion: 1, expectedPolicy: { enabled: false },
      expectedPlanDigest: 'reviewed' }).success).toBe(true);
  });

  it('defaults only opened predecessor metadata and keeps mutation envelopes closed', () => {
    expect(readMachineAgentIsolationPolicyV1({ host: 'old' })).toEqual({ status: 'ready', source: 'default', policy: { enabled: false } });
    expect(readMachineAgentIsolationPolicyV1(null)).toEqual({ status: 'unavailable' });
    expect(readMachineAgentIsolationPolicyV1({ agentIsolation: { enabled: 'yes' } })).toEqual({ status: 'invalid' });
    expect(readMachineAgentIsolationPolicyV1({ agentIsolation: { enabled: true, future: 1 } })).toMatchObject({ status: 'ready', policy: { enabled: true } });
    expect(MachineAgentIsolationPolicyV1Schema.safeParse({ enabled: true, future: 1 }).success).toBe(false);
    expect(MachineAgentIsolationSetInputV1Schema.safeParse({ machineId: 'm', enabled: true, expectedPolicy: { enabled: false }, expectedMetadataVersion: 1, expectedPlanDigest: 'digest', command: 'whoami' }).success).toBe(false);
  });
  it('preserves requested isolation through strict publication and tolerant stored reads', () => {
    const base = { host: 'h', platform: 'linux', happyCliVersion: 'dev', homeDir: '/home/h', happyHomeDir: '/home/h/.happier' };
    const published = parseMachinePublishedMetadataV1({ ...base, agentIsolation: { enabled: true } });
    expect(StoredMachinePublishedMetadataV1Schema.parse(published)).toMatchObject({ agentIsolation: { enabled: true } });
  });

  it('rebases unrelated metadata edits without republishing equal intent', async () => {
    let metadata: Record<string, unknown> = { displayName: 'concurrent' };
    let writes = 0;
    const port = { read: async () => ({ status: 'ready' as const, metadata, metadataVersion: 2 }),
      compareAndSwap: async (input: { metadata: Record<string, unknown>; expectedMetadataVersion: number }) => {
        writes++;
        metadata = input.metadata;
        return { status: 'applied' as const, metadata, metadataVersion: 3 };
      } };
    const mutation = { expectedMetadataVersion: 1, expectedPolicy: { enabled: false }, policy: { enabled: true }, comparison: 'field' as const };
    expect(await mutateMachineMetadataFieldV1(mutation, port, agentIsolationMetadataFieldV1))
      .toMatchObject({ status: 'applied', metadataVersion: 3 });
    expect(metadata).toEqual({ displayName: 'concurrent', agentIsolation: { enabled: true } });
    expect(await mutateMachineMetadataFieldV1({ ...mutation, expectedPolicy: { enabled: true } }, port, agentIsolationMetadataFieldV1))
      .toMatchObject({ status: 'unchanged' });
    expect(writes).toBe(1);
  });
});
