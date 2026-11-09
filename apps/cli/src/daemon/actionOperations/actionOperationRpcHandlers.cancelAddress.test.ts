import { describe, expect, it, onTestFinished } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createActionOperationStore } from './actionOperationStore';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationCancellationFixture } from './actionOperationCancellation.testkit';

describe('reviewed cancellation Address at the operation RPC receiver', () => {
  it.each([
    { mode: 'plain', operand: 'matching' }, { mode: 'e2ee', operand: 'matching' },
    { mode: 'plain', operand: 'substituted' }, { mode: 'e2ee', operand: 'substituted' },
  ] as const)('admits only the authenticated original cancel Address ($mode/$operand)', async ({ mode, operand }) => {
    const release = new Map<string, () => void>();
    const executions: Promise<unknown>[] = [];
    onTestFinished(async () => {
      for (const finish of release.values()) finish();
      await Promise.all(executions);
    });
    const store = createActionOperationStore();
    const scope = { accountId: 'requester', machineId: 'machine' };
    const signals = new Map<string, AbortSignal>();
    const cleanups: string[] = [];
    let sequence = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `operation-${++sequence}`,
      resolveAction: actionId => ({ actionId, title: 'Script', operation: { version: 1,
        visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } } }) });
    executions.push(...['operation-1', 'operation-2'].map(operationId => runner.observe({ actionId: 'projects.script.run', scope,
      cancellation: 'supported', execute: async context => {
        signals.set(operationId, context.signal);
        context.publishOwnerUpdate({ state: 'running' });
        context.onCancellationRequested(() => { cleanups.push(operationId); });
        await new Promise<void>(resolve => {
          release.set(operationId, resolve);
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      } })));
    await new Promise<void>(resolve => setImmediate(resolve));
    const address = { serverId: 'srv_cancel', machineId: 'machine', operationId: 'operation-1' };
    const { cancel, diagnostics } = await createActionOperationCancellationFixture({ mode, accountId: scope.accountId, address, store, runner });
    if (operand === 'matching') {
      expect(await cancel('operation-1'), JSON.stringify(diagnostics)).toEqual({ kind: 'requested' });
      expect(cleanups).toEqual(['operation-1']);
      expect(signals.get('operation-1')?.aborted).toBe(true);
    } else {
      expect(await cancel('operation-2'), JSON.stringify(diagnostics)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(cleanups).toEqual([]);
      expect(signals.get('operation-1')?.aborted).toBe(false);
    }
    expect(signals.get('operation-2')?.aborted).toBe(false);
  });
});
