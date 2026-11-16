import { describe, expect, it } from 'vitest';
import { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';

const scope = { accountId: 'requester', machineId: 'controller' } as const;

describe('Action executor completion without cancellation', () => {
  it.each(['success', 'failure'] as const)('waits beyond a terminal projection through the original handler finally (%s)', async outcome => {
    const store = createActionOperationStore();
    const spec = getActionSpec(MACHINE_PRESET_PREPARE_ACTION_ID_V1);
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'child-operation',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    let release!: () => void;
    const nativeCompletion = new Promise<void>(resolve => { release = resolve; });
    let retired = false, stops = 0;
    await runner.observe({ actionId: spec.id, scope, cancellation: 'supported', execute: async context => {
      context.onCancellationRequested(() => { stops++; });
      context.operationAcceptance?.accept({ status: 'accepted', operationId: 'child-operation' });
      try {
        await nativeCompletion;
        if (outcome === 'failure') throw new Error('native call failed');
        return { ok: true, result: {} };
      } finally { retired = true; }
    } });
    store.succeed('child-operation', {});
    expect(await runner.waitForTerminal(scope, 'child-operation')).toMatchObject({ state: 'succeeded' });
    let joined = false;
    let completion: ReturnType<typeof runner.waitForCompletion> | undefined;
    try {
      await expect(runner.waitForCompletion({ ...scope, accountId: 'other-account' }, 'child-operation')).resolves.toBeNull();
      completion = runner.waitForCompletion(scope, 'child-operation').then(snapshot => { joined = true; return snapshot; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(joined).toBe(false);
      expect(retired).toBe(false);
      expect(stops).toBe(0);
    } finally { release(); }
    await expect(completion).resolves.toMatchObject({ operationId: 'child-operation' });
    expect(retired).toBe(true);
    expect(stops).toBe(0);
    await expect(runner.waitForCompletion(scope, 'child-operation')).resolves.toMatchObject({ operationId: 'child-operation' });
    await expect(runner.waitForCompletion(scope, 'missing')).resolves.toBeNull();
  });
});
