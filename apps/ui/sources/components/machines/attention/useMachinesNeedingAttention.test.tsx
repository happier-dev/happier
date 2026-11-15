import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';

import {
  createMachineFixture,
  renderHook,
  standardCleanup,
} from '@/dev/testkit';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { summarizeMachinesNeedingAttention, useMachinesNeedingAttention } from './useMachinesNeedingAttention';

const before = storage.getState();
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: transport.rpc }),
);
afterEach(() => {
  standardCleanup();
  storage.setState(before);
  transport.rpc.mockClear();
});

function shortOnMemory(id: string): Machine {
  const metadata = createMachineFixture().metadata;
  if (metadata === null) throw new Error('Machine fixture metadata is missing');
  return createMachineFixture({
    id,
    activeAt: Date.now(),
    metadata: {
      ...metadata,
      host: 'build-box',
    },
    daemonState: {
      resources: {
        v: 1,
        vitals: { state: 'reporting' },
        host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 },
        attention: {
          level: 'needs_you',
          reasons: [
            {
              key: 'memory',
              metric: 'memory',
              kind: 'memory_pressure',
              since: 1,
              level: 'needs_you',
              pressure: 'critical',
              swapping: false,
            },
          ],
        },
      },
    },
  });
}

describe('machines needing attention', () => {
  it('tells apart two machines that share a name, as every list of machines does', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    await publishMachineInventoryForTest({ serverId, accountId: 'attention-account' },
      [shortOnMemory('a1b2c3d4e5'), shortOnMemory('f6e5d4c3b2')]);
    const hook = await renderHook(() => useMachinesNeedingAttention());
    const titles = hook.getCurrent().map((row) => row.title);
    expect(titles).toHaveLength(2);
    // One fact per machine, and the two rows never read the same.
    expect(new Set(titles).size).toBe(2);
    expect(titles.every((title) => title.includes('build-box'))).toBe(true);
    await hook.unmount();
  });

  it('waits for a machine whose name is still being read instead of listing it as Loading', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const unread = createMachineFixture({ ...shortOnMemory('0f1e2d3c4b'), metadata: null, availability: undefined });
    await publishMachineInventoryForTest({ serverId, accountId: 'attention-account' }, [shortOnMemory('a1b2c3d4e5'), unread]);
    const hook = await renderHook(() => useMachinesNeedingAttention());
    expect(hook.getCurrent().map((row) => row.machineId)).toEqual(['a1b2c3d4e5']);
    await hook.unmount();
  });

  it('reads several machines as one fact with one way in, and one machine by its name and reason', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    await publishMachineInventoryForTest({ serverId, accountId: 'attention-account' },
      [shortOnMemory('a1b2c3d4e5'), shortOnMemory('f6e5d4c3b2'), shortOnMemory('0a9b8c7d6e')]);
    const hook = await renderHook(() => useMachinesNeedingAttention());
    const rows = hook.getCurrent();
    const several = summarizeMachinesNeedingAttention(rows);
    expect(several?.title).toBe('3 machines need you');
    // Several machines open the list of machines, not one of them.
    expect(several?.machine).toBeNull();
    const one = summarizeMachinesNeedingAttention(rows.slice(0, 1));
    expect(one?.title).toBe(rows[0]!.title);
    expect(one?.machine).toEqual({ serverId: rows[0]!.serverId, machineId: rows[0]!.machineId, tab: rows[0]!.tab });
    expect(summarizeMachinesNeedingAttention([])).toBeNull();
    await hook.unmount();
  });
});

// P03-TESTKIT-SERVER: the unconfigured test build seeds no Home; select one through the real owner.
beforeEach(async () => { await selectActiveTestHomeForTests(); });
