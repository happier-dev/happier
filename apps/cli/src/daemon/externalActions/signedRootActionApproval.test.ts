import { expect, it } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import { createSignedRootActionApprovalAcknowledgement } from './signedRootActionApproval';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { executeLiveCliApprovalRequest } from '@/session/actions/approvals/deferredResult';

it.each(['connectedServices.authentication.submitManual', 'connectedServices.authentication.completeOAuth'] as const)(
  'reports %s approval while retaining its live result on the original request', async actionId => {
  const owner = createSignedRootActionApprovalAcknowledgement();
  const approval = { kind: 'approval_request_created' as const, artifactId: 'manual-approval',
    actionId };
  let release!: () => void;
  const completion = new Promise<void>(resolve => { release = resolve; });
  const notices: unknown[] = [];
  let settled = false;
  const result: ActionExecuteResult = { ok: true, result: { status: 'connected', attemptId: 'manual-attempt' } };
  const execution = owner.execute({ actionId: approval.actionId, surface: 'cli', signal: new AbortController().signal,
    onApprovalRequested: notice => { notices.push(notice); },
    // The injected execution port represents admitted native work. Keep its
    // approval publication and effect completion in their real order.
    run: async (_signal, progress) => {
      progress?.update({ progress: { phase: 'waiting_for_approval', approval } });
      await completion;
      return result;
    },
  });
  void execution.then(() => { settled = true; });
  try {
    await expect.poll(() => notices.length > 0 || settled).toBe(true);
    expect(settled).toBe(false);
    expect(notices).toEqual([approval]);
    release();
    await expect(execution).resolves.toEqual(result);
  } finally { release(); await execution; await owner.close(); }
});

it('cancels the original transport and preserves a prompt failure', async () => {
  const failure = new Error('Terminal prompt failed');
  const executor = createActionExecutor({});
  let cancelled = false;
  await expect(executeLiveCliApprovalRequest({ context: { surface: 'cli' }, execute: executor.execute,
    onApprovalRequested: async () => { throw failure; },
    run: (signal, notify) => new Promise<ActionExecuteResult | null>(resolve => {
      signal.addEventListener('abort', () => {
        cancelled = true;
        resolve({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
      }, { once: true });
      notify({ kind: 'approval_request_created', artifactId: 'manual-approval',
        actionId: 'connectedServices.authentication.submitManual' });
    }),
  })).rejects.toBe(failure);
  expect(cancelled).toBe(true);
});

it('cancels the original transport when the prompt returns an approval failure', async () => {
  const failure = { ok: false as const, errorCode: 'approval_not_found', error: 'approval_not_found' };
  const executor = createActionExecutor({});
  await expect(executeLiveCliApprovalRequest({ context: { surface: 'cli' }, execute: executor.execute,
    onApprovalRequested: async () => failure,
    run: (signal, notify) => new Promise<ActionExecuteResult | null>(resolve => {
      signal.addEventListener('abort', () => resolve({ ok: false, errorCode: 'cancelled', error: 'cancelled' }), { once: true });
      notify({ kind: 'approval_request_created', artifactId: 'manual-approval',
        actionId: 'connectedServices.authentication.submitManual' });
    }),
  })).resolves.toEqual(failure);
});
