import { describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';

import { createHostActionOperationRuntime } from './createHostActionOperationRuntime';

const scope = { accountId: 'account', machineId: 'machine' };

describe('operation effects after Home acknowledges terminal success', () => {
  it.each([true, false, 'rejected'] as const)('releases the settled operation before Home acknowledgement (%s)', async acknowledgement => {
    let answer!: (admitted: boolean) => void;
    let reject!: (error: Error) => void;
    const held = new Promise<boolean>((resolve, rejectAck) => { answer = resolve; reject = rejectAck; });
    const published: ActionOperationSnapshotV1[] = [];
    const refresh = vi.fn(async () => {});
    const dependencies = { machineId: scope.machineId, resolveAccountId: async () => scope.accountId,
      generateOperationId: () => 'setup',
      publishSnapshotAcknowledged: async (snapshot: ActionOperationSnapshotV1) => { published.push(snapshot); return held; } };
    const runtime = createHostActionOperationRuntime(dependencies);
    const result = { ok: true as const, result: { membershipApplied: true } };
    await expect(runtime.observeExecution({ actionId: 'machines.setup.apply', input: { requestId: 'reviewed' },
      execute: async context => {
        context.afterTerminalSuccessAcknowledged?.(refresh);
        return result;
      } })).resolves.toEqual(result);

    expect(await runtime.handlers.getV2({ operationId: 'setup', waitForTerminal: true })).toMatchObject({
      kind: 'found', operation: { state: 'succeeded', result: result.result },
    });
    expect(await runtime.runner.cancel(scope, 'setup')).toMatchObject({ kind: 'already_settled' });
    expect(refresh).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
    expect(published[0]).toEqual(runtime.store.get(scope, 'setup'));
    if (acknowledgement === 'rejected') reject(new Error('Home disconnected'));
    else answer(acknowledgement);
    await new Promise<void>(resolve => setImmediate(resolve));
    await vi.waitFor(() => {
      if (acknowledgement === true) expect(refresh).toHaveBeenCalledOnce();
      else expect(refresh).not.toHaveBeenCalled();
    });
    expect(runtime.store.get(scope, 'setup')).toMatchObject({ state: 'succeeded', result: result.result });
  });

  it('leaves the acknowledged Home result known when the last effect replaces the daemon', async () => {
    let homeSnapshot: ActionOperationSnapshotV1 | undefined;
    let successor: ReturnType<typeof createHostActionOperationRuntime> | undefined;
    let effectSignal: AbortSignal | undefined;
    const runtime = createHostActionOperationRuntime({
      machineId: scope.machineId, resolveAccountId: async () => scope.accountId,
      generateOperationId: () => 'restarted-setup',
      publishSnapshotAcknowledged: async snapshot => {
        homeSnapshot = snapshot;
        return true;
      },
    });
    await runtime.observeExecution({ actionId: 'machines.setup.apply', input: {}, execute: async context => {
      context.afterTerminalSuccessAcknowledged?.(async () => {
        effectSignal = context.signal;
        expect(homeSnapshot).toMatchObject({ state: 'succeeded', result: { membershipApplied: true } });
        successor = createHostActionOperationRuntime({ machineId: scope.machineId,
          resolveAccountId: async () => scope.accountId });
      });
      return { ok: true, result: { membershipApplied: true } };
    } });
    await vi.waitFor(() => expect(successor).toBeDefined());
    expect(effectSignal?.aborted).toBe(false);
    expect(homeSnapshot).toMatchObject({ operationId: 'restarted-setup', state: 'succeeded',
      result: { membershipApplied: true } });
    expect(await successor!.handlers.getV2({ operationId: 'restarted-setup' })).toMatchObject({ kind: 'not_found' });
  });

  it('does not publish or run a last effect after an operation fails', async () => {
    const publishSnapshotAcknowledged = vi.fn(async () => true);
    const refresh = vi.fn(async () => {});
    const dependencies = { machineId: scope.machineId, resolveAccountId: async () => scope.accountId,
      generateOperationId: () => 'failed-setup', publishSnapshotAcknowledged };
    const runtime = createHostActionOperationRuntime(dependencies);
    await runtime.observeExecution({ actionId: 'machines.setup.apply', input: {}, execute: async context => {
      context.afterTerminalSuccessAcknowledged?.(refresh);
      return { ok: false, errorCode: 'native_failed', error: 'native_failed' };
    } });
    expect(runtime.store.get(scope, 'failed-setup')).toMatchObject({ state: 'failed', error: { errorCode: 'native_failed' } });
    expect(publishSnapshotAcknowledged).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('preserves success when the acknowledged last effect fails', async () => {
    const refresh = vi.fn(async () => { throw new Error('Restart unavailable'); });
    const dependencies = { machineId: scope.machineId, resolveAccountId: async () => scope.accountId,
      generateOperationId: () => 'settled-setup', publishSnapshotAcknowledged: async () => true };
    const runtime = createHostActionOperationRuntime(dependencies);
    await runtime.observeExecution({ actionId: 'machines.setup.apply', input: {}, execute: async context => {
      context.afterTerminalSuccessAcknowledged?.(refresh);
      return { ok: true, result: { membershipApplied: true } };
    } });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(runtime.store.get(scope, 'settled-setup')).toMatchObject({ state: 'succeeded', result: { membershipApplied: true } });
  });
});
