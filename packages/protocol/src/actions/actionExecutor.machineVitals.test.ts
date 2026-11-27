import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { listActionSpecsForCatalogSurface } from './actionCatalog.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { listMachineVitalsSummariesV1, readMachineVitalsResourcesProjectionV1 } from '../machines/vitals/listMachineVitalsSummariesV1.js';
import { MachineResourceAttentionV1Schema } from '../machines/resources/machineResourceSummaryV1.js';
import { MachineVitalsSampleV1Schema } from '../machines/vitals/machineVitalsSampleV1.js';
import { MachineVitalsSummariesListOutputV1Schema } from './specs/machineVitals.js';
import { RPC_ERROR_CODES, RpcError } from '../rpc/errors.js';
import { projectMachineVitalsSeriesV1 } from '../machines/vitals/machineVitalsSeriesV1.js';

describe('Machine vitals Action front door', () => {
  it('projects one timestamp per 15-second slot while preserving observations and explicit gaps', () => {
    const series = projectMachineVitalsSeriesV1({
      cpu: [{ t: 15_000, y: 25 }, { t: 45_000, y: 35 }, { t: 75_000, y: null }, { t: 90_000, y: 45 }],
      memory: [], networkRx: [], networkTx: [],
    }, 300_000);
    expect(series.cpu.map(point => point.t)).toEqual(Array.from({ length: 20 }, (_, index) => (index + 1) * 15_000));
    expect(series.cpu.map(point => point.y)).toEqual([
      25, 25, 35, 35, null, 45, 45, 45, 45,
      null, null, null, null, null, null, null, null, null, null, null,
    ]);
    expect(series.memory).toEqual([]);
    expect(series.networkRx).toEqual([]);
    expect(series.networkTx).toEqual([]);
  });

  it('exposes safe reads on their answering surfaces and returns the machine answer', async () => {
    const cases = [
      ['machines.vitals.get', { machineId: 'machine', view: 'summary' }, { state: 'reporting', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } }],
      ['machines.vitals.history.get', { machineId: 'machine', range: '24h' }, { range: '24h', bucketMs: 300_000, points: [], today: { rxBytes: 0, txBytes: 0 } }],
      ['machines.vitals.summaries.list', {}, []],
    ] as const;
    for (const [rawId, input, answer] of cases) {
      const id = ActionIdSchema.parse(rawId);
      for (const surface of ['ui', 'cli', 'agent', 'mcp', 'voice'] as const) {
        if (surface === 'voice' && rawId === 'machines.vitals.history.get') continue;
        expect(listActionSpecsForCatalogSurface({ surface }).some(spec => spec.id === id)).toBe(true);
        expect(isApprovalRequiredByActionsSettings(id, ActionsSettingsV1Schema.parse({ v: 1 }), { surface })).toBe(false);
        const executor = createActionExecutor({ machineVitalsAction: async () => answer } as unknown as ActionExecutorDeps);
        expect(await executor.execute(id, input, { surface, serverId: 'home' })).toEqual({ ok: true, result: answer });
      }
    }
  });

  it('rejects foreign Home targets and unsupported ranges before reaching transport', async () => {
    let reached = false;
    const executor = createActionExecutor({ machineVitalsAction: async () => { reached = true; return []; } } as unknown as ActionExecutorDeps);
    const id = ActionIdSchema.parse('machines.vitals.history.get');
    expect(await executor.execute(id, { serverId: 'foreign', machineId: 'machine', range: '1h' }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(getActionSpec(id).inputSchema.safeParse({ machineId: 'machine', range: '30d' }).success).toBe(false);
    expect(reached).toBe(false);
  });

  it('returns each fleet state, preserving synced attention and reading only eligible machines', async () => {
    const attention = MachineResourceAttentionV1Schema.parse({ level: 'needs_you', reasons: [{
      key: 'memory', level: 'needs_you', since: 15_000, metric: 'memory', kind: 'memory_pressure',
      pressure: 'critical', swapping: true,
    }] });
    const sample = MachineVitalsSampleV1Schema.parse({
      v: 1, sampledAt: 30_000, intervalMs: 15_000,
      cpu: { reported: true, busyPct: 32, load1: 0.314 },
      memory: { reported: true, availableBytes: 64, usedBytes: 960, totalBytes: 1024, pressure: { level: 'critical', source: 'kernel_level' } },
      disk: { reported: false, reason: 'unavailable' }, network: { reported: true, rxBps: 10, txBps: 20 },
    });
    const calls: string[] = [];
    const executor = createActionExecutor({ machineVitalsAction: async () => listMachineVitalsSummariesV1({
      machines: [
        { machineId: 'live', name: 'Live', online: true, resources: readMachineVitalsResourcesProjectionV1({ resources: {
          vitals: { state: 'reporting' }, attention,
          host: { logicalCores: 8, effectiveCores: 0.5, memoryTotalBytes: 1024, bootedAt: 0 },
        } }) },
        { machineId: 'old', name: 'Old', online: true },
        { machineId: 'offline', name: 'Offline', online: false, resources: { vitals: { state: 'reporting' }, attention } },
        { machineId: 'broken', name: 'Broken', online: true, resources: { vitals: { state: 'unavailable' }, attention } },
        { machineId: 'unreachable', name: 'Unreachable', online: true, resources: { vitals: { state: 'reporting' }, attention } },
        { machineId: 'missing-method', name: 'Missing method', online: true, resources: { vitals: { state: 'reporting' }, attention } },
        { machineId: 'empty', name: 'Empty', online: true, resources: { vitals: { state: 'reporting' }, attention } },
      ],
      // The transport boundary exposes a daemon answer or connection failure.
      readSummary: async machineId => {
        calls.push(machineId);
        if (machineId === 'unreachable') throw new RpcError('Private transport diagnostics', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        if (machineId === 'missing-method') return { errorCode: 'RPC_METHOD_NOT_FOUND', error: 'Method not found' };
        return { state: 'reporting', sample: machineId === 'live' ? sample : null,
          series5m: { cpu: [{ t: 15_000, y: 25 }], memory: [{ t: 15_000, y: 80 }], networkRx: [], networkTx: [] },
          attention: { level: 'calm', reasons: [] } };
      },
    }) } as unknown as ActionExecutorDeps);
    const result = await executor.execute(ActionIdSchema.parse('machines.vitals.summaries.list'), {}, { surface: 'cli', serverId: 'home' });
    expect(result).toMatchObject({ ok: true, result: [
      { machineId: 'live', state: 'reporting', attention, summary: {
        sampledAt: 30_000, stepMs: 15_000, seriesFrom: 15_000,
        cpu: { busyPct: 32, load1: 0.31, logicalCores: 8, effectiveCores: 0.5, tone: 'calm', series: [{ t: 15_000, y: 25 }, { t: 30_000, y: 25 }] },
        memory: { availableBytes: 64, totalBytes: 1024, pressure: 'critical', tone: 'crit', series: [{ t: 15_000, y: 80 / 1024 * 100 }, { t: 30_000, y: 80 / 1024 * 100 }] },
      } },
      { machineId: 'old', state: 'not_reporting' },
      { machineId: 'offline', state: 'offline', attention },
      { machineId: 'broken', state: 'unavailable', attention },
      { machineId: 'unreachable', state: 'unavailable', attention },
      { machineId: 'missing-method', state: 'not_reporting', attention },
      { machineId: 'empty', state: 'reporting', attention },
    ] });
    if (!result.ok) throw new Error('Expected fleet read success');
    const fleet = MachineVitalsSummariesListOutputV1Schema.parse(result.result);
    expect(fleet[0].summary).not.toHaveProperty('attention');
    expect(fleet[0].summary).not.toHaveProperty('sample');
    expect(fleet[4]).toEqual({ machineId: 'unreachable', name: 'Unreachable', presence: 'online',
      state: 'unavailable', attention, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    expect(fleet[6]).not.toHaveProperty('summary');
    expect(calls).toEqual(['live', 'unreachable', 'missing-method', 'empty']);
  });
});
