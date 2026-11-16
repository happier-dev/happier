import { describe, expect, it } from 'vitest';
import { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';

const scope = { accountId: 'requester', machineId: 'controller' } as const;

function preparationRunner() {
  const store = createActionOperationStore();
  const spec = getActionSpec(MACHINE_PRESET_PREPARE_ACTION_ID_V1);
  const runner = createActionOperationRunner({ store, generateOperationId: () => 'original-build',
    resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
  return { store, runner };
}

describe('original Action executor retirement', () => {
  it.each(['success', 'failure'] as const)('joins the original handler through actual retirement after Stop (%s)', async outcome => {
    const { store, runner } = preparationRunner();
    let release!: () => void;
    const nativeCompletion = new Promise<void>(resolve => { release = resolve; });
    let retired = false, stops = 0;
    await runner.observe({ actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1, scope, requestId: 'prepare-original',
      cancellation: 'supported', execute: async context => {
        context.onCancellationRequested(() => { stops++; });
        context.operationAcceptance?.accept({ status: 'accepted', operationId: 'original-build' });
        try {
          // Genuine native boundary: an in-flight build can outlive its receipt.
          await nativeCompletion;
          if (outcome === 'failure') throw new Error('native build failed after Stop');
          return { ok: true, result: {} };
        } finally { retired = true; }
      } });
    if (outcome === 'success') {
      // Native reconciliation can publish terminal state while the original
      // executor still owns an earlier in-flight provider call.
      store.succeed('original-build', {});
      expect(await runner.waitForTerminal(scope, 'original-build')).toMatchObject({ state: 'succeeded' });
    }
    let joined = false;
    const retirement = runner.cancelAndWait(scope, 'original-build').then(result => { joined = true; return result; });
    try {
      expect(stops).toBe(outcome === 'success' ? 0 : 1);
      // Drain already-settled Promise continuations without releasing the
      // native boundary; a snapshot-only wait must be observable as too early.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(joined).toBe(false);
      expect(retired).toBe(false);
    } finally { release(); }
    await expect(retirement).resolves.toEqual({ kind: outcome === 'success' ? 'already_settled' : 'requested' });
    expect(retired).toBe(true);
    if (outcome === 'failure') expect(store.get(scope, 'original-build')).toMatchObject({ state: 'failed' });
  });

  it('preserves unsupported Stop without waiting for or cancelling that invocation', async () => {
    const { runner } = preparationRunner();
    let release!: () => void;
    const nativeCompletion = new Promise<void>(resolve => { release = resolve; });
    let stops = 0;
    await runner.observe({ actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1, scope, cancellation: 'unsupported',
      execute: async context => {
        context.onCancellationRequested(() => { stops++; });
        context.operationAcceptance?.accept({ status: 'accepted', operationId: 'original-build' });
        await nativeCompletion;
        return { ok: true, result: {} };
      } });
    try {
      await expect(runner.cancelAndWait(scope, 'original-build')).resolves.toEqual({ kind: 'unsupported' });
      expect(stops).toBe(0);
    } finally { release(); }
    await runner.waitForTerminal(scope, 'original-build');
  });

  it('does not stop or join another Account invocation and returns settled or absent owners immediately', async () => {
    const { runner } = preparationRunner();
    let release!: () => void;
    const nativeCompletion = new Promise<void>(resolve => { release = resolve; });
    let stops = 0;
    await runner.observe({ actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1, scope, cancellation: 'supported',
      execute: async context => {
        context.onCancellationRequested(() => { stops++; });
        context.operationAcceptance?.accept({ status: 'accepted', operationId: 'original-build' });
        await nativeCompletion;
        return { ok: true, result: {} };
      } });
    try {
      await expect(runner.cancelAndWait({ ...scope, accountId: 'another-account' }, 'original-build'))
        .resolves.toEqual({ kind: 'not_found' });
      expect(stops).toBe(0);
    } finally { release(); }
    await runner.waitForTerminal(scope, 'original-build');
    await expect(runner.cancelAndWait(scope, 'original-build')).resolves.toEqual({ kind: 'already_settled' });
    await expect(runner.cancelAndWait(scope, 'missing')).resolves.toEqual({ kind: 'not_found' });
  });
});
