import { describe, expect, it } from 'vitest';
import { readMachineResourcesPolicyV1, getMachineResourcesPolicyV1, mutateMachineResourcesPolicyV1, MachineResourcesPolicyPatchV1Schema } from './machineResourcesPolicyV1.js';
import { MACHINE_RESOURCES_ACTION_SPECS } from '../../actions/specs/machineResources.js';
import type { MachineMetadataFieldPortV1 } from '../machineMetadataFieldV1.js';

describe('machine resources policy', () => {
  it('persists deliberate monitoring mode and interval through the sole per-Machine policy writer', async () => {
    expect(readMachineResourcesPolicyV1({})).toMatchObject({ status: 'ready', policy: {
      monitoring: { mode: 'always', intervalMs: 2_000 },
    } });
    const [, setSpec] = MACHINE_RESOURCES_ACTION_SPECS;
    for (const mode of ['off', 'while_viewing', 'always']) {
      let metadata: Record<string, unknown> = { host: 'preserved', resourcesPolicyV1: {
        v: 1, guard: { keepAwake: 'off' }, monitoring: { mode: 'always', intervalMs: 2_000 },
      } };
      const input = { machineId: 'machine', expectedRevision: 3, patch: { monitoring: { mode, intervalMs: 91_234 } } };
      expect(setSpec.inputSchema.safeParse(input).success).toBe(true);
      const { machineId: _machineId, ...mutation } = input;
      const result = await mutateMachineResourcesPolicyV1(mutation, {
        read: async () => ({ status: 'ready', metadata, metadataVersion: 3 }),
        compareAndSwap: async request => {
          metadata = request.metadata;
          return { status: 'applied', metadata, metadataVersion: 4 };
        },
      });
      expect(result).toMatchObject({ status: 'applied', policy: {
        monitoring: { mode, intervalMs: 91_234 }, guard: { keepAwake: 'off' },
      } });
      expect(metadata.host).toBe('preserved');
      expect(readMachineResourcesPolicyV1(metadata)).toMatchObject({ status: 'ready', policy: {
        monitoring: { mode, intervalMs: 91_234 },
      } });
    }
  });
  it('persists the browser admission override through the existing policy Action input and writer', async () => {
    const { MachineResourcesPolicySetInputV1Schema } = await import('../../actions/specs/machineResources.js');
    for (const browserMaxConcurrent of [null, 1, 4, 7, Number.MAX_SAFE_INTEGER]) {
      const input = { machineId: 'machine', expectedRevision: 3, patch: { processes: { browserMaxConcurrent } } };
      expect(MachineResourcesPolicySetInputV1Schema.safeParse(input).success).toBe(true);
      expect(await mutateMachineResourcesPolicyV1({ expectedRevision: input.expectedRevision, patch: input.patch }, {
        read: async () => ({ status: 'ready', metadataVersion: 3, metadata: { resourcesPolicyV1: {
          v: 1, processes: { toolIdleCloseMs: null, allProcessesVisible: true,
            browserMaxConcurrent: browserMaxConcurrent === null ? 2 : null }, guard: { keepAwake: 'off' },
        } } }),
        compareAndSwap: async ({ metadata }) => ({ status: 'applied', metadata, metadataVersion: 4 }),
      })).toMatchObject({ status: 'applied', policy: { processes: { browserMaxConcurrent,
        toolIdleCloseMs: null, allProcessesVisible: true }, guard: { keepAwake: 'off' } } });
    }
    expect(readMachineResourcesPolicyV1({})).toMatchObject({ status: 'ready', policy: { processes: { browserMaxConcurrent: null } } });
    for (const browserMaxConcurrent of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4']) {
      expect(MachineResourcesPolicyPatchV1Schema.safeParse({ processes: { browserMaxConcurrent } }).success).toBe(false);
    }
  });
  it('defaults all Guard rules off except keep awake and deep-patches their single policy document', async () => {
    expect(readMachineResourcesPolicyV1({})).toMatchObject({ status: 'ready', policy: { guard: {
      memoryGuard: { enabled: false, actAt: 'critical', sustainMs: 120_000, cooldownMs: 60_000,
        steps: { browsers: true, devServers: true, idleSessions: true }, pausedUntil: null },
      idleSessions: { enabled: false, afterMs: 7_200_000, warnBeforeMs: 300_000 },
      idleTerminals: { enabled: false, afterMs: 7_200_000, warnBeforeMs: 300_000 },
      leftBehind: { mode: 'off', graceMs: 0 }, sessionMemoryCeiling: { bytes: null, warnAtPercent: 90 }, keepAwake: 'on',
    } } });
    const result = await mutateMachineResourcesPolicyV1({ expectedRevision: 3, patch: { guard: {
      memoryGuard: { enabled: true, steps: { browsers: false } }, idleSessions: { afterMs: 423_456 },
    } } }, {
      read: async () => ({ status: 'ready', metadata: { host: 'preserved', resourcesPolicyV1: {
        v: 1, guard: { keepAwake: 'off', memoryGuard: { cooldownMs: 91_234 } },
        processes: { allProcessesVisible: true },
      } }, metadataVersion: 3 }),
      compareAndSwap: async ({ metadata }) => ({ status: 'applied', metadata, metadataVersion: 4 }),
    });
    expect(result).toMatchObject({ status: 'applied', revision: 4, policy: {
      guard: { keepAwake: 'off', memoryGuard: { enabled: true, cooldownMs: 91_234,
        steps: { browsers: false, devServers: true, idleSessions: true } }, idleSessions: { afterMs: 423_456, warnBeforeMs: 300_000 } },
      processes: { allProcessesVisible: true },
    } });
  });

  it('validates merged Guard deadlines and preserves custom physical ranges without resetting unedited controls', async () => {
    let metadata: Record<string, unknown> = { resourcesPolicyV1: { v: 1, guard: {
      memoryGuard: { enabled: true }, idleSessions: { afterMs: 600_000, warnBeforeMs: 300_000 },
    } } };
    let writes = 0;
    const port = { read: async () => ({ status: 'ready' as const, metadata, metadataVersion: 3 }),
      compareAndSwap: async (request: { metadata: Record<string, unknown> }) => {
        writes++; metadata = request.metadata; return { status: 'applied' as const, metadata, metadataVersion: 4 };
      } };
    expect(await mutateMachineResourcesPolicyV1({ expectedRevision: 3, patch: { guard: { idleSessions: { afterMs: 300_000 } } } }, port))
      .toEqual({ status: 'unavailable', reason: 'invalid_policy_patch' });
    expect(writes).toBe(0);
    expect(await mutateMachineResourcesPolicyV1({ expectedRevision: 3, patch: { guard: {
      memoryGuard: { cooldownMs: 91_234 }, sessionMemoryCeiling: { bytes: Number.MAX_SAFE_INTEGER, warnAtPercent: 91.5 },
      idleSessions: { afterMs: 91_234, warnBeforeMs: 0 },
    } } }, port)).toMatchObject({ status: 'applied', policy: { guard: { memoryGuard: { enabled: true, cooldownMs: 91_234 },
      idleSessions: { afterMs: 91_234, warnBeforeMs: 0 }, sessionMemoryCeiling: { bytes: Number.MAX_SAFE_INTEGER, warnAtPercent: 91.5 } } } });
    for (const patch of [{ memoryGuard: { sustainMs: 59_999 } }, { memoryGuard: { cooldownMs: 59_999 } },
      { idleTerminals: { afterMs: 59_999 } }, { leftBehind: { graceMs: -1 } }, { sessionMemoryCeiling: { bytes: 0 } },
      { sessionMemoryCeiling: { warnAtPercent: 100 } }, { memoryGuard: { steps: { unknown: true } } }]) {
      expect(MachineResourcesPolicyPatchV1Schema.safeParse({ guard: patch }).success).toBe(false);
    }
    expect(readMachineResourcesPolicyV1({ resourcesPolicyV1: { v: 1, guard: { memoryGuard: { future: true } } } }))
      .toMatchObject({ status: 'ready', policy: { guard: { memoryGuard: { enabled: false } } } });
  });

  it('defaults storage and merges its partial edits through the existing writer without changing other sections', async () => {
    const defaults = { wholeDiskEnabled: false, protectedFolders: [], logRetentionDays: 30, trashEmptyAfterDays: 7,
      scheduledScan: null, suggestUnusedAfterDays: 30 };
    expect(readMachineResourcesPolicyV1({})).toMatchObject({ status: 'ready', source: 'default', policy: { storage: defaults } });
    expect(readMachineResourcesPolicyV1({ resourcesPolicyV1: { v: 1, guard: { keepAwake: 'off' } } }))
      .toMatchObject({ status: 'ready', source: 'stored', policy: { storage: defaults, guard: { keepAwake: 'off' } } });
    const result = await mutateMachineResourcesPolicyV1({ expectedRevision: 4, patch: { storage: { logRetentionDays: null, suggestUnusedAfterDays: 365 } } }, {
      read: async () => ({ status: 'ready', metadata: { host: 'worker', resourcesPolicyV1: {
        v: 1, processes: { allProcessesVisible: true, toolIdleCloseMs: null }, guard: { keepAwake: 'off' }, alerts: { cpu: { abovePct: 83 } },
        storage: { wholeDiskEnabled: true, protectedFolders: [{ path: '/data/projects', addedAt: 1000 }], trashEmptyAfterDays: null,
          scheduledScan: { weekday: 0, time: '03:00', onlyOnPower: true } },
      } }, metadataVersion: 4 }),
      compareAndSwap: async ({ metadata }) => {
        expect(metadata.host).toBe('worker');
        return { status: 'applied', metadata, metadataVersion: 5 };
      },
    });
    expect(result).toMatchObject({ status: 'applied', revision: 5, policy: {
      processes: { allProcessesVisible: true, toolIdleCloseMs: null }, guard: { keepAwake: 'off' }, alerts: { cpu: { abovePct: 83 } },
      storage: { ...defaults, wholeDiskEnabled: true, protectedFolders: [{ path: '/data/projects', addedAt: 1000 }], logRetentionDays: null,
        trashEmptyAfterDays: null, suggestUnusedAfterDays: 365, scheduledScan: { weekday: 0, time: '03:00', onlyOnPower: true } },
    } });
  });

  it('drops unknown stored storage fields while rejecting malformed known values and unknown patch authority', () => {
    const stored = { wholeDiskEnabled: true, protectedFolders: [{ path: '/data/projects', addedAt: 1000, future: true }], future: true,
      scheduledScan: { weekday: 6, time: '23:59', onlyOnPower: true, future: true } };
    const read = readMachineResourcesPolicyV1({ resourcesPolicyV1: { v: 1, storage: stored } });
    expect(read).toMatchObject({ status: 'ready', policy: { storage: { wholeDiskEnabled: true,
      protectedFolders: [{ path: '/data/projects', addedAt: 1000 }], scheduledScan: { weekday: 6, time: '23:59', onlyOnPower: true } } } });
    if (read.status === 'ready') expect(Reflect.has(read.policy.storage, 'future')).toBe(false);
    for (const patch of [
      { logRetentionDays: 0 }, { trashEmptyAfterDays: 1.5 }, { suggestUnusedAfterDays: '30' },
      { wholeDiskEnabled: 'true' }, { protectedFolders: [{ path: '/data', addedAt: -1 }] },
      { scheduledScan: { weekday: 7, time: '03:00', onlyOnPower: true } },
      { scheduledScan: { weekday: 0, time: '24:00', onlyOnPower: true } },
      { scheduledScan: { weekday: 0, time: '03:00', onlyOnPower: false } },
      { scheduledScan: { weekday: 0, time: '03:00', onlyOnPower: true, authority: 'other' } },
    ]) {
      expect(MachineResourcesPolicyPatchV1Schema.safeParse({ storage: patch }).success).toBe(false);
      // Unknown stored fields are intentionally dropped; malformed known values must still fail.
      if (!('scheduledScan' in patch && 'authority' in patch.scheduledScan)) {
        expect(readMachineResourcesPolicyV1({ resourcesPolicyV1: { v: 1, storage: patch } })).toEqual({ status: 'invalid' });
      }
    }
    expect(MachineResourcesPolicyPatchV1Schema.safeParse({ storage: { future: true } }).success).toBe(false);
    for (const days of [1, 91, 365, Number.MAX_SAFE_INTEGER]) {
      expect(MachineResourcesPolicyPatchV1Schema.safeParse({ storage: { logRetentionDays: days, trashEmptyAfterDays: days, suggestUnusedAfterDays: days } }).success).toBe(true);
    }
    expect(MachineResourcesPolicyPatchV1Schema.safeParse({ storage: { logRetentionDays: null, trashEmptyAfterDays: null, scheduledScan: null } }).success).toBe(true);
  });

  it('defaults process controls and persists visibility, Off and custom idle durations through the same writer', async () => {
    expect(readMachineResourcesPolicyV1({})).toMatchObject({ status: 'ready', policy: {
      processes: { allProcessesVisible: false, toolIdleCloseMs: 300_000 },
    } });
    for (const toolIdleCloseMs of [null, 300_000, 600_000, 1_800_000, 1_000, 91_234, Number.MAX_SAFE_INTEGER]) {
      const result = await mutateMachineResourcesPolicyV1({ expectedRevision: 4, patch: { processes: { toolIdleCloseMs } } }, {
        read: async () => ({ status: 'ready', metadata: { host: 'worker', resourcesPolicyV1: {
          v: 1, processes: { allProcessesVisible: true, toolIdleCloseMs: 10_000 }, alerts: { cpu: { abovePct: 83 } },
        } }, metadataVersion: 4 }),
        compareAndSwap: async ({ metadata }) => {
          expect(metadata.host).toBe('worker');
          return { status: 'applied', metadata, metadataVersion: 5 };
        },
      });
      expect(result).toMatchObject({ status: 'applied', revision: 5, policy: {
        processes: { allProcessesVisible: true, toolIdleCloseMs }, alerts: { cpu: { abovePct: 83 } },
      } });
    }
    expect(await mutateMachineResourcesPolicyV1({ expectedRevision: 1, patch: { processes: { allProcessesVisible: true } } }, {
      read: async () => ({ status: 'ready', metadata: { resourcesPolicyV1: { v: 1, processes: { toolIdleCloseMs: 10_000 } } }, metadataVersion: 1 }),
      compareAndSwap: async ({ metadata }) => ({ status: 'applied', metadata, metadataVersion: 2 }),
    })).toMatchObject({ status: 'applied', policy: { processes: { allProcessesVisible: true, toolIdleCloseMs: 10_000 } } });
  });

  it('tolerates unknown stored process fields but rejects invalid process controls and unknown inputs', () => {
    expect(readMachineResourcesPolicyV1({ resourcesPolicyV1: { v: 1, processes: { toolIdleCloseMs: null, future: true } } }))
      .toMatchObject({ status: 'ready', policy: { processes: { allProcessesVisible: false, toolIdleCloseMs: null } } });
    for (const toolIdleCloseMs of [0, 999, 1_000.5, Number.MAX_SAFE_INTEGER + 1, '300000']) {
      expect(MachineResourcesPolicyPatchV1Schema.safeParse({ processes: { toolIdleCloseMs } }).success).toBe(false);
      expect(readMachineResourcesPolicyV1({ resourcesPolicyV1: { v: 1, processes: { toolIdleCloseMs } } }))
        .toEqual({ status: 'invalid' });
    }
    expect(MachineResourcesPolicyPatchV1Schema.safeParse({ processes: { future: true } }).success).toBe(false);
    expect(MachineResourcesPolicyPatchV1Schema.safeParse({ processes: { allProcessesVisible: 'true' } }).success).toBe(false);
  });

  it('round-trips canonical policy writes through persisted metadata and the strict Action consumers', async () => {
    const [getSpec, setSpec] = MACHINE_RESOURCES_ACTION_SPECS;
    let metadata: Record<string, unknown> = { host: 'worker' };
    let metadataVersion = 1;
    // The metadata transport is the boundary; the policy writer and readers remain real.
    const port: MachineMetadataFieldPortV1 = {
      read: async () => ({ status: 'ready', metadata, metadataVersion }),
      compareAndSwap: async request => {
        metadata = JSON.parse(JSON.stringify(request.metadata));
        metadataVersion++;
        return { status: 'applied', metadata, metadataVersion };
      },
    };
    const initial = await getMachineResourcesPolicyV1(port);
    expect(getSpec.outputSchema.parse(initial)).toEqual(initial);
    expect(initial).toMatchObject({ status: 'ready', source: 'default', revision: 1, policy: { guard: { keepAwake: 'on' } } });
    const { machineId: _machineId, ...mutation } = setSpec.inputSchema.parse({ machineId: 'machine', expectedRevision: 1,
      patch: { guard: { keepAwake: 'off' }, processes: { browserMaxConcurrent: 7 }, storage: { trashEmptyAfterDays: null } } });
    const result = await mutateMachineResourcesPolicyV1(mutation, port);
    expect(setSpec.outputSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ status: 'applied', revision: 2, policy: { guard: { keepAwake: 'off' },
      processes: { browserMaxConcurrent: 7 }, storage: { trashEmptyAfterDays: null } } });
    expect(metadata.host).toBe('worker');
    const read = await getMachineResourcesPolicyV1(port);
    expect(getSpec.outputSchema.parse(read)).toEqual(read);
    expect(read).toMatchObject({ status: 'ready', source: 'stored', revision: 2 });
    if (result.status !== 'applied' || read.status !== 'ready') throw new Error('Expected the persisted policy to be readable');
    expect(read.policy).toEqual(result.policy);
    expect(readMachineResourcesPolicyV1(metadata)).toEqual({ status: 'ready', source: 'stored', policy: result.policy });
    const unchanged = await mutateMachineResourcesPolicyV1({ ...mutation, expectedRevision: 2 }, port);
    expect(setSpec.outputSchema.parse(unchanged)).toEqual({ status: 'unchanged', policy: read.policy, revision: 2 });
    const conflict = await mutateMachineResourcesPolicyV1(mutation, port);
    expect(setSpec.outputSchema.parse(conflict)).toEqual({ status: 'conflict', policy: read.policy, revision: 2 });
  });
  it('defaults absent sections and drops unknown stored fields without tolerating malformed known values', () => {
    const read = readMachineResourcesPolicyV1({ resourcesPolicyV1: { v: 1, alerts: { cpu: { abovePct: 83, future: true } }, future: {} } });
    expect(read).toMatchObject({ status: 'ready', source: 'stored', policy: { v: 1, alerts: {
      memory: { enabled: false, level: 'critical', sustainMs: 300_000 },
      cpu: { enabled: false, abovePct: 83, sustainMs: 900_000 },
      disk: { enabled: false, threshold: { freeFraction: 0.1 } },
    } } });
    expect(read.status === 'ready' && Reflect.has(read.policy, 'future')).toBe(false);
    expect(readMachineResourcesPolicyV1({})).toMatchObject({ status: 'ready', source: 'default' });
    expect(readMachineResourcesPolicyV1(null)).toEqual({ status: 'unavailable' });
    expect(readMachineResourcesPolicyV1({ resourcesPolicyV1: { v: 1, alerts: { cpu: { abovePct: 101 } } } })).toEqual({ status: 'invalid' });
  });

  it('accepts the full meaningful custom range and rejects unknown mutation fields', () => {
    for (const abovePct of [1, 83.5, 100]) expect(MachineResourcesPolicyPatchV1Schema.safeParse({ alerts: { cpu: { abovePct } } }).success).toBe(true);
    for (const sustainMs of [60_000, 7 * 24 * 60 * 60_000]) expect(MachineResourcesPolicyPatchV1Schema.safeParse({ alerts: { memory: { sustainMs } } }).success).toBe(true);
    for (const sustainMs of [0, 60_001, 8 * 24 * 60 * 60_000]) expect(MachineResourcesPolicyPatchV1Schema.safeParse({ alerts: { memory: { sustainMs } } }).success).toBe(false);
    for (const freeFraction of [0, 0.435, 1]) expect(MachineResourcesPolicyPatchV1Schema.safeParse({ alerts: { disk: { threshold: { freeFraction } } } }).success).toBe(true);
    expect(MachineResourcesPolicyPatchV1Schema.safeParse({ alerts: { cpu: { future: true } } }).success).toBe(false);
  });

  it('deep patches only the chosen fields, preserves unrelated metadata, and conflicts on a stale revision', async () => {
    let snapshot = { status: 'ready' as const, metadata: { host: 'worker', resourcesPolicyV1: { v: 1, alerts: { cpu: { abovePct: 83 } } } }, metadataVersion: 4 };
    let writes = 0;
    const port = { read: async () => snapshot, compareAndSwap: async ({ metadata }: { metadata: Record<string, unknown>; expectedMetadataVersion: number }) => {
      writes++;
      expect(metadata.host).toBe('worker');
      return { status: 'applied' as const, metadata, metadataVersion: 5 };
    } };
    expect(await mutateMachineResourcesPolicyV1({ expectedRevision: 4, patch: { alerts: { cpu: { enabled: true } } } }, port)).toMatchObject({
      status: 'applied', revision: 5, policy: { alerts: { cpu: { abovePct: 83, enabled: true, sustainMs: 900_000 } } },
    });
    snapshot = { ...snapshot, metadataVersion: 6 };
    expect(await mutateMachineResourcesPolicyV1({ expectedRevision: 4, patch: { alerts: { cpu: { enabled: true } } } }, port)).toMatchObject({ status: 'conflict', revision: 6 });
    expect(writes).toBe(1);
  });

  it('returns current policy after a CAS race and never retries the stale patch', async () => {
    let writes = 0;
    expect(await mutateMachineResourcesPolicyV1({ expectedRevision: 1, patch: { alerts: { memory: { enabled: true } } } }, {
      read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 1 }),
      compareAndSwap: async () => { writes++; return { status: 'conflict', metadata: { resourcesPolicyV1: { v: 1, alerts: { cpu: { abovePct: 77 } } } }, metadataVersion: 2 }; },
    })).toMatchObject({ status: 'conflict', revision: 2, policy: { alerts: { cpu: { abovePct: 77 }, memory: { enabled: false } } } });
    expect(writes).toBe(1);
  });

  it('observes a lost acknowledgement once and preserves an unresolved outcome without replay', async () => {
    for (const accepted of [false, true]) {
      let reads = 0;
      let writes = 0;
      const result = await mutateMachineResourcesPolicyV1({ expectedRevision: 1, patch: { alerts: { cpu: { enabled: true } } } }, {
        read: async () => ({ status: 'ready', metadata: ++reads > 1 && accepted
          ? { resourcesPolicyV1: { v: 1, alerts: { cpu: { enabled: true } } } } : {}, metadataVersion: accepted && reads > 1 ? 2 : 1 }),
        compareAndSwap: async () => { writes++; throw new Error('connection_lost_after_send'); },
      });
      expect(result).toMatchObject(accepted ? { status: 'applied', revision: 2 } : { status: 'unavailable', reason: 'outcomeUnknown' });
      expect(writes).toBe(1);
      expect(reads).toBe(2);
    }
  });
});
