import { expect, it } from 'vitest';
import type { AccountJsonKvCollectionPort, AccountJsonKvRow } from '../../todos/todoActionOperationsV1.js';
import { machineOutcomeSummaryAddress, readMachineOutcomeSummaries, retainMachineOutcomeSummary } from './machineOutcomeSummaryV1.js';
import { classifyAccountJsonKvKey } from '../../account/accountJsonKv.js';

it('retains the latest native outcome per producing Machine and Environment without replacing another resource', async () => {
  // Account KV persistence is the external boundary; summary identity and merge stay real.
  const rows = new Map<string, AccountJsonKvRow>();
  const port: AccountJsonKvCollectionPort = {
    read: async key => rows.get(key) ?? { value: null, version: -1 },
    list: async prefix => [...rows.values()].filter(row => row.key.startsWith(prefix)),
    mutate: async changes => {
      for (const change of changes) rows.set(change.key, { ...change, version: change.version + 1 });
      return { success: true, results: changes.map(change => ({ key: change.key, version: change.version + 1 })) };
    },
  };
  const failed = { kind: 'backup', serverId: 'home', machineId: 'machine-a', environmentId: 'environment-a',
    operationId: 'failed-run', state: 'failed', occurredAt: 100, errorCode: 'backup_failed' } as const;
  const succeeded = { ...failed, operationId: 'recovered-run', state: 'succeeded', occurredAt: 200, errorCode: null } as const;
  // The existing generic Account JSON migration census must include retained facts.
  expect(classifyAccountJsonKvKey(machineOutcomeSummaryAddress(failed).key)).toBe('workspace');
  const otherMachine = { ...failed, machineId: 'machine-b' };
  const otherEnvironment = { ...failed, environmentId: 'environment-b' };
  await retainMachineOutcomeSummary(port, failed);
  await retainMachineOutcomeSummary(port, otherMachine);
  await retainMachineOutcomeSummary(port, otherEnvironment);
  await retainMachineOutcomeSummary(port, succeeded);
  await retainMachineOutcomeSummary(port, failed);
  expect(await readMachineOutcomeSummaries(port)).toEqual(expect.arrayContaining([succeeded, otherMachine, otherEnvironment]));
  expect(await readMachineOutcomeSummaries(port)).toHaveLength(3);
  expect(await readMachineOutcomeSummaries(port, ['unrelated', machineOutcomeSummaryAddress(failed).key]))
    .toEqual([succeeded]);
});

it('keeps pressure rules and volumes independently current within the native Machine summary', async () => {
  const rows = new Map<string, AccountJsonKvRow>();
  const port: AccountJsonKvCollectionPort = {
    read: async key => rows.get(key) ?? { value: null, version: -1 },
    list: async prefix => [...rows.values()].filter(row => row.key.startsWith(prefix)),
    mutate: async changes => {
      for (const change of changes) rows.set(change.key, { ...change, version: change.version + 1 });
      return { success: true, results: changes.map(change => ({ key: change.key, version: change.version + 1 })) };
    },
  };
  const memory = { kind: 'pressure', serverId: 'home', machineId: 'machine', since: 90,
    episode: { kind: 'alert', rule: 'memory', state: 'fired', at: 100 } } as const;
  const recovered = { ...memory, episode: { ...memory.episode, state: 'recovered', at: 200 } } as const;
  const disk = { ...memory, episode: { ...memory.episode, rule: 'disk', volumeId: 'volume-a' } } as const;
  await retainMachineOutcomeSummary(port, memory);
  await retainMachineOutcomeSummary(port, disk);
  await retainMachineOutcomeSummary(port, recovered);
  expect(await readMachineOutcomeSummaries(port)).toEqual([disk, recovered]);
});
