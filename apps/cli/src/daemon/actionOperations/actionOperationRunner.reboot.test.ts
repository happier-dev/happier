import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';

describe('reboot Action operation uncertainty', () => {
  it('keeps a parsed blocked result terminal-failed with its exact receipt, never generic succeeded', async () => {
    const id = ActionIdSchema.safeParse('machines.reboot');
    expect(id.success).toBe(true);
    if (!id.success) throw new Error('Reboot must be published atomically before the operation fixture runs');
    const spec = getActionSpec(id.data), store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'blocked-operation', resolveAction: () =>
      ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    const receipt = { kind: 'blocked' as const, reasons: ['setup'] };
    const executor = createActionExecutor({
      ...createCliActionDeps({ token: '', sessionId: 'cli-global', mode: 'plain', ctx: null }),
      machineReboot: async () => receipt,
    });
    const scope = { accountId: 'account', machineId: 'machine' };
    expect(await runner.observe({ actionId: id.data, scope, input: {}, execute: async () => executor.execute(id.data,
      { serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation' }, {
        surface: 'ui', authority: 'present_user', serverId: 'home', presentUserConfirmation: { actionId: id.data },
      }) })).toMatchObject({ ok: true, result: receipt });
    expect(store.get(scope, 'blocked-operation')).toMatchObject({ state: 'failed', result: receipt,
      error: { errorCode: 'action_operation_failed' } });
  });
  it.each(['reboot-operation', 'unrelated-operation'])('keeps receipt %s uncertain and never dispatches the same retained request again', async receiptId => {
    const id = ActionIdSchema.safeParse('machines.reboot');
    expect(id.success).toBe(true);
    if (!id.success) throw new Error('Reboot must be published atomically before the operation fixture runs');
    const spec = getActionSpec(id.data);
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'reboot-operation', resolveAction: actionId =>
      actionId === spec.id ? { actionId: spec.id, title: spec.title, operation: spec.operation } : null });
    let dispatches = 0;
    const deps = {
      ...createCliActionDeps({ token: '', sessionId: 'cli-global', mode: 'plain', ctx: null }),
      // Target-daemon transport only. Policy, schemas, retained operation and
      // request replay all use their canonical real owners.
      machineReboot: async (_request: { input: unknown }) => {
        dispatches++; return { kind: 'accepted' as const, operation: { operationId: receiptId }, bootedAt: 1000 };
      },
    };
    const executor = createActionExecutor(deps);
    const scope = { accountId: 'account', machineId: 'machine' };
    const input = { serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation' };
    const request = { actionId: spec.id, scope, input, requestId: 'existing-envelope-request',
      execute: async (context: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]) =>
        executor.execute(id.data, input, { surface: 'ui', authority: 'present_user', serverId: 'home', signal: context.signal,
          operationAcceptance: context.operationAcceptance, presentUserConfirmation: { actionId: id.data } }) };
    const result = await runner.observe(request);
    expect(result).toMatchObject(receiptId === 'reboot-operation'
      ? { ok: true, result: { kind: 'accepted', operation: { operationId: receiptId }, bootedAt: 1000 } }
      : { ok: false, errorCode: 'action_outcome_unknown' });
    expect(store.get(scope, 'reboot-operation')).toMatchObject({ state: 'running', observation: { kind: 'outcome_uncertain' } });
    expect(await runner.observe(request)).toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
    expect(dispatches).toBe(1);
  });
});
