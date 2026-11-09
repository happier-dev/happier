import { describe, expect, it, vi } from 'vitest';

import { HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1 } from '../home/runtime/actionsV1.js';
import { REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1 } from '../remoteHosts/remoteHostActionsV1.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';

const context = { surface: 'ui', authority: 'present_user', bypassApprovals: true } as const;

describe('runtime Action input admission', () => {
  it.each([
    { actionId: 'home.runtime.get', input: { force: true }, admitted: { force: true },
      schema: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1['home.runtime.get'] },
    { actionId: 'remote_hosts.read', input: { hostId: ' host-a ' }, admitted: { hostId: 'host-a' },
      schema: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1['remote_hosts.read'] },
    { actionId: 'home.runtime.restart', input: { machineId: ' machine-a ' }, admitted: { machineId: 'machine-a' },
      schema: HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1['home.runtime.restart'] },
  ] as const)('does not reparse admitted $actionId input before dispatch', async row => {
    // Observe real schema execution without replacing any validation or policy.
    const schema = getActionSpec(row.actionId).inputSchema;
    const safeParse = vi.spyOn(schema, 'safeParse');
    const parse = vi.spyOn(schema, 'parse');
    const effects: unknown[] = [];
    // The answering client and connected Machine RPC are external boundaries.
    const executor = createActionExecutor({
      homeRuntimeActionExecute: async request => {
        effects.push(request);
        return { ok: true, result: { status: 'unavailable', reason: 'test_host_unavailable' } };
      },
      remoteHostActionExecute: async request => {
        effects.push(request);
        return { ok: true, result: { status: 'unavailable', reason: 'test_host_unavailable' } };
      },
      homeRuntimeTaskRpc: async request => { effects.push(request); return {}; },
    } satisfies Partial<ActionExecutorDeps>);
    try {
      for (let invocation = 0; invocation < 2; invocation++) {
        expect(await executor.execute(row.actionId, row.input, context)).toMatchObject({ ok: true,
          result: { status: 'unavailable' } });
      }
      expect(effects).toHaveLength(2);
      for (const effect of effects) {
        expect(effect).toMatchObject(row.actionId === 'home.runtime.restart'
          ? { machineId: 'machine-a', method: 'detect' }
          : { actionId: row.actionId, input: row.admitted });
      }
      // Each request parses its unchanged input once; dispatch spends that admission.
      expect(safeParse.mock.calls.length + parse.mock.calls.length).toBe(2);
    } finally {
      parse.mockRestore();
      safeParse.mockRestore();
    }
  });

  it('rejects malformed and refined runtime inputs before any external effect', async () => {
    const effects: unknown[] = [];
    const executor = createActionExecutor({
      homeRuntimeActionExecute: async request => { effects.push(request); return { ok: true, result: {} }; },
      remoteHostActionExecute: async request => { effects.push(request); return { ok: true, result: {} }; },
      homeRuntimeTaskRpc: async request => { effects.push(request); return {}; },
    } satisfies Partial<ActionExecutorDeps>);
    for (const [actionId, input] of [
      ['home.runtime.get', { force: 'yes' }],
      ['remote_hosts.read', { hostId: ' ' }],
      ['home.runtime.restart', { machineId: 'machine-a', command: 'unreviewed' }],
      ['relay.access.configure', { providerId: 'lan', config: { providerId: 'localOnly' } }],
    ] as const) {
      expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    }
    expect(effects).toEqual([]);
  });

  it('keeps runtime mutations behind approval and validates fresh external outputs', async () => {
    const effects: unknown[] = [];
    const executor = createActionExecutor({
      homeRuntimeActionExecute: async request => { effects.push(request); return { ok: true, result: { status: 'unexpected' } }; },
      remoteHostActionExecute: async request => { effects.push(request); return { ok: true, result: { status: 'unexpected' } }; },
      homeRuntimeTaskRpc: async request => { effects.push(request); return {}; },
    } satisfies Partial<ActionExecutorDeps>);
    for (const [actionId, input] of [
      ['home.runtime.restart', { machineId: 'machine-a' }],
      ['remote_hosts.delete', { hostId: 'host-a', expectedRevision: 1 }],
    ] as const) {
      expect(await executor.execute(actionId, input, { surface: 'agent', authority: 'account_automation' }))
        .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    }
    expect(effects).toEqual([]);
    for (const [actionId, input] of [['home.runtime.get', {}], ['remote_hosts.read', { hostId: 'host-a' }]] as const) {
      expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: false });
    }
    expect(effects).toHaveLength(2);
  });
});
