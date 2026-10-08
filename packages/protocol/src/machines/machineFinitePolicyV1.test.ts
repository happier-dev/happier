import { describe, expect, it } from 'vitest';

import {
  MachineFinitePolicyV1Schema,
  readMachineFinitePolicyV1,
  mutateMachineFinitePolicyV1,
  type MachineFinitePolicyMetadataPortV1,
} from './machineFinitePolicyV1.js';

const defaultPolicy = { accepting: true, runAtMost: null };
const nextPolicy = { accepting: false, runAtMost: 3 };

describe('Machine finite policy', () => {
  it('defaults only successfully opened metadata with an absent policy field', () => {
    expect(readMachineFinitePolicyV1({ host: 'worker' })).toEqual({ status: 'ready', policy: defaultPolicy, source: 'default' });
    expect(readMachineFinitePolicyV1(null)).toEqual({ status: 'unavailable' });
    expect(readMachineFinitePolicyV1({ finitePolicyV1: null })).toEqual({ status: 'invalid' });
    expect(readMachineFinitePolicyV1({ finitePolicyV1: { accepting: true, runAtMost: 0 } })).toEqual({ status: 'invalid' });
    expect(readMachineFinitePolicyV1({ finitePolicyV1: { ...nextPolicy, future: 'drop' } })).toEqual({
      status: 'ready', policy: nextPolicy, source: 'stored',
    });
  });

  it('accepts positive safe integers without an invented ceiling and keeps writes strict', () => {
    expect(MachineFinitePolicyV1Schema.safeParse({ accepting: true, runAtMost: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    for (const runAtMost of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(MachineFinitePolicyV1Schema.safeParse({ accepting: true, runAtMost }).success).toBe(false);
    }
    expect(MachineFinitePolicyV1Schema.safeParse({ ...nextPolicy, future: true }).success).toBe(false);
  });

  it('rebases unrelated metadata contention but refuses a changed semantic policy', async () => {
    let snapshot = { status: 'ready' as const, metadata: { host: 'worker', displayName: 'first' }, metadataVersion: 1 };
    const port: MachineFinitePolicyMetadataPortV1 = {
      read: async () => snapshot,
      compareAndSwap: async ({ metadata, expectedMetadataVersion }) => {
        if (expectedMetadataVersion === 1) {
          snapshot = { ...snapshot, metadata: { host: 'worker', displayName: 'concurrent' }, metadataVersion: 2 };
          return { ...snapshot, status: 'conflict' };
        }
        expect(metadata).toEqual({ host: 'worker', displayName: 'concurrent', finitePolicyV1: nextPolicy });
        return { status: 'applied', metadata, metadataVersion: 3 };
      },
    };
    expect(await mutateMachineFinitePolicyV1({ expectedPolicy: defaultPolicy, expectedMetadataVersion: 1, policy: nextPolicy }, port))
      .toEqual({ status: 'applied', policy: nextPolicy, metadataVersion: 3 });
    expect(await mutateMachineFinitePolicyV1({ expectedPolicy: nextPolicy, expectedMetadataVersion: 1, policy: { accepting: false, runAtMost: null } }, port))
      .toEqual({ status: 'conflict', policy: defaultPolicy, metadataVersion: 2 });
  });

  it('observes an unknown write once and never automatically replays it', async () => {
    let writes = 0;
    let reads = 0;
    const result = await mutateMachineFinitePolicyV1({ expectedPolicy: defaultPolicy, expectedMetadataVersion: 1, policy: nextPolicy }, {
      read: async () => ({ status: 'ready', metadata: ++reads === 1 ? { host: 'worker' } : { finitePolicyV1: nextPolicy }, metadataVersion: reads }),
      compareAndSwap: async () => { writes++; return { status: 'outcomeUnknown' }; },
    });
    expect(result).toEqual({ status: 'satisfied', policy: nextPolicy, metadataVersion: 2 });
    expect(writes).toBe(1);
    expect(reads).toBe(2);
  });

  it('keeps a still-unresolved write unknown when the observation remains at the expected value', async () => {
    let writes = 0;
    expect(await mutateMachineFinitePolicyV1({ expectedPolicy: defaultPolicy, expectedMetadataVersion: 1, policy: nextPolicy }, {
      read: async () => ({ status: 'ready', metadata: { host: 'worker' }, metadataVersion: 1 }),
      compareAndSwap: async () => { writes++; return { status: 'outcomeUnknown' }; },
    })).toEqual({ status: 'outcomeUnknown' });
    expect(writes).toBe(1);
  });

  it('refuses unavailable and locked content before any metadata write', async () => {
    for (const status of ['locked', 'unavailable'] as const) {
      let writes = 0;
      expect(await mutateMachineFinitePolicyV1({ expectedPolicy: defaultPolicy, expectedMetadataVersion: 1, policy: nextPolicy }, {
        read: async () => ({ status }),
        compareAndSwap: async () => { writes++; return { status: 'outcomeUnknown' }; },
      })).toEqual({ status });
      expect(writes).toBe(0);
    }
  });
});
