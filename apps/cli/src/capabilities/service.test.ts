import { describe, expect, it, vi } from 'vitest';
import { CHECKLIST_IDS } from './checklistIds';
import { createCapabilitiesService, type Capability } from './service';
import { CapabilityError } from './errors';
import type { CapabilitiesDetectContextBuilder } from './service';
import type { CapabilityDetectRequest, ChecklistId } from './types';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { PluginError } from '@happier-dev/plugin-sdk';

describe('createCapabilitiesService', () => {
  it('keeps parent facts outside requester execution and merges a mixed inventory after one physical execution', async () => {
    let inRequester = false;
    let physicalExecutions = 0;
    const service = createCapabilitiesService({
      capabilities: [{
        descriptor: { id: 'tool.parent', kind: 'tool' }, effects: { detect: [] },
        detect: async () => {
          if (inRequester) throw new CapabilityError('The requester has no daemon factory lease', 'factory-unavailable');
          return { available: true, installed: true };
        },
      }, {
        descriptor: { id: 'cli.physical', kind: 'cli' }, effects: { detect: ['private_read', 'process'] },
        detect: async () => ({ available: inRequester, installed: inRequester }),
      }],
      checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
      buildContext: async () => ({ cliSnapshot: null }),
    });
    const observed = await service.detect({ requests: [{ id: 'tool.parent' }, { id: 'cli.physical' }] }, {
      executeEffects: async (_effects, execute) => {
        physicalExecutions += 1;
        inRequester = true;
        try { return await execute(); } finally { inRequester = false; }
      },
    });
    expect(observed).toMatchObject({ results: {
      'tool.parent': { ok: true, data: { available: true, installed: true } },
      'cli.physical': { ok: true, data: { available: true, installed: true } },
    } });
    expect(physicalExecutions).toBe(1);
  });

  it.each(['requester_authority_unavailable', 'member_setup_required', 'launch_probe_failed'])(
    'keeps the native preparation cause %s without private setup content', async reason => {
      const service = createCapabilitiesService({ capabilities: [{
        descriptor: { id: 'cli.fixture', kind: 'cli', methods: { probeModels: {} } },
        detect: async () => ({}), invoke: async () => ({ ok: true, result: {} }),
      }], checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
        buildContext: async () => ({ cliSnapshot: null }) });
      expect(await service.invoke({ id: 'cli.fixture', method: 'probeModels' }, {
        executeEffects: async () => { throw new PluginError({ code: 'agent_isolation_unavailable',
          message: 'private setup diagnostic', retryable: false,
          details: { reason, phase: 'native_execution_preparation', environment: { TOKEN: 'private' }, output: 'private' } }); },
      })).toEqual({ ok: false, error: { code: 'agent_isolation_unavailable', message: 'agent_isolation_unavailable',
        retryable: false, details: { reason, phase: 'native_execution_preparation' } } });
    });

  it.each([
    Object.assign(new RpcError('private diagnostic', 'agent_isolation_unavailable'), { details: { retryable: false } }),
    new PluginError({ code: 'agent_isolation_unavailable', message: 'private diagnostic', retryable: false }),
  ])('preserves a typed contribution refusal and its retryability rather than rewriting it as invoke-failed (%s)', async (failure) => {
    const service = createCapabilitiesService({ capabilities: [{
      descriptor: { id: 'cli.fixture', kind: 'cli', methods: { probeModels: {} } },
      detect: async () => ({}),
      invoke: async () => { throw failure; },
    }], checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
      buildContext: async () => ({ cliSnapshot: null }) });
    expect(await service.invoke({ id: 'cli.fixture', method: 'probeModels' })).toEqual({
      ok: false, error: { code: 'agent_isolation_unavailable', message: 'agent_isolation_unavailable', retryable: false },
    });
  });

  it('admits the selected method and effective mixed checklist before discovery or effects', async () => {
    let discoveries = 0;
    let effects = 0;
    let admissions = 0;
    const service = createCapabilitiesService({
      capabilities: [{
        descriptor: { id: 'tool.fixture', kind: 'tool', methods: { list: {}, write: {} } },
        effects: { detect: request => request.params?.private === true ? ['private_read'] : [],
          invoke: { list: [], write: ['file_write'] } },
        detect: async () => { effects += 1; return { available: true }; },
        invoke: async () => { effects += 1; return { ok: true, result: {} }; },
      }],
      checklists: { [CHECKLIST_IDS.NEW_SESSION]: [{ id: 'tool.fixture' }], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
      buildContext: async () => { discoveries += 1; return { cliSnapshot: null }; },
    });
    const executeEffects = async () => { admissions += 1; throw new CapabilityError('Denied', 'effect-denied'); };
    expect(await service.invoke({ id: 'tool.fixture', method: 'list' }, { executeEffects })).toMatchObject({ ok: true });
    expect(await service.invoke({ id: 'tool.fixture', method: 'write' }, { executeEffects }))
      .toMatchObject({ ok: false, error: { code: 'effect-denied' } });
    expect(await service.invoke({ id: 'tool.fixture', method: 'unknown' }, { executeEffects }))
      .toMatchObject({ ok: false, error: { code: 'unsupported-method' } });
    await expect(service.detect({ checklistId: CHECKLIST_IDS.NEW_SESSION,
      overrides: { 'tool.fixture': { params: { private: true } } } }, { executeEffects }))
      .rejects.toMatchObject({ code: 'effect-denied' });
    expect({ effects, discoveries, admissions }).toEqual({ effects: 1, discoveries: 0, admissions: 2 });
    expect(await service.invoke({ id: 'tool.fixture', method: 'write' }, {
      executeEffects: async (_effects, execute) => { admissions += 1; return await execute(); },
    })).toMatchObject({ ok: true });
    // Finite work consumes the admitted effect once; completion cannot acquire
    // a second permission decision after the mutation already happened.
    expect({ effects, discoveries, admissions }).toEqual({ effects: 2, discoveries: 0, admissions: 3 });
    await service.detect({ requests: [{ id: 'tool.fixture', params: { private: true } }] }, {
      executeEffects: async (_effects, execute) => { admissions += 1; return await execute(); },
    });
    // Shared discovery and the entire finite checklist consume one execution,
    // not a second admission after discovery has already disclosed data.
    expect({ effects, discoveries, admissions }).toEqual({ effects: 3, discoveries: 1, admissions: 4 });
  });

  it('rejects an undeclared capability method before invoking its implementation', async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, result: { unexpected: true } }));
    const service = createCapabilitiesService({
      capabilities: [{
        descriptor: {
          id: 'tool.executionRuns',
          kind: 'tool',
          methods: { list: { title: 'List' } },
        },
        detect: async () => ({}),
        invoke,
      }],
      checklists: {
        [CHECKLIST_IDS.NEW_SESSION]: [],
        [CHECKLIST_IDS.MACHINE_DETAILS]: [],
      },
      buildContext: async () => ({ cliSnapshot: null }),
    });

    await expect(service.invoke({
      id: 'tool.executionRuns',
      method: 'hiddenMutation',
    })).resolves.toEqual({
      ok: false,
      error: {
        message: 'Unsupported method: hiddenMutation',
        code: 'unsupported-method',
      },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('applies top-level bypassCache to checklist requests before building context', async () => {
    const buildContext = vi.fn<CapabilitiesDetectContextBuilder>(async () => ({ cliSnapshot: null }));
    const detect = vi.fn(async () => ({ available: true }));

    const capabilities: Capability[] = [
      {
        descriptor: { id: 'cli.claude', kind: 'cli' },
        detect,
      },
      {
        descriptor: { id: 'tool.executionRuns', kind: 'tool' },
        detect,
      },
    ];

    const service = createCapabilitiesService({
      capabilities,
      checklists: {
        [CHECKLIST_IDS.NEW_SESSION]: [
          { id: 'cli.claude' },
          { id: 'tool.executionRuns' },
        ] as CapabilityDetectRequest[],
      } as Record<ChecklistId, CapabilityDetectRequest[]>,
      buildContext,
    });

    await service.detect({
      checklistId: CHECKLIST_IDS.NEW_SESSION,
      bypassCache: true,
    });

    expect(buildContext.mock.calls[0]?.[0]).toEqual([
      { id: 'cli.claude', params: { bypassCache: true } },
      { id: 'tool.executionRuns', params: { bypassCache: true } },
    ]);
  });
});
