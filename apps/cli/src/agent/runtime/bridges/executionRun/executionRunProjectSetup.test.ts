import { describe, expect, it } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createExecutionRunProjectSetupProjection, createExecutionRunProjectSetupProjectionOwner } from './executionRunProjectSetup';

describe('Execution Run setup snapshot publication', () => {
  it('publishes equal progress and owner facts once, and still carries their real changes', () => {
    const scope = { accountId: 'account', machineId: 'machine' };
    let publications = 0;
    const setup = createExecutionRunProjectSetupProjection({ runId: 'run', scope, signal: new AbortController().signal,
      readBaseSnapshot: () => ({ version: 1, operationId: 'run', actionId: 'execution.run.start', state: 'running',
        scope, title: 'Run', createdAt: 1, startedAt: 1, cancellation: 'supported' }), publish: () => { publications++; } });
    for (let i = 0; i < 100; i++) {
      setup.context.operationProgress?.update({ phase: 'preparing', label: 'Preparing' });
      setup.context.operationOwnerUpdate?.update({ observation: null, state: 'running', cancellation: 'supported' });
    }
    expect(publications).toBe(1);
    expect(setup.snapshot()?.progress).toEqual({ kind: 'phase', phase: 'preparing', label: 'Preparing' });
    setup.context.operationProgress?.update({ phase: 'ready', label: 'Ready' });
    expect(publications).toBe(2);
    expect(setup.snapshot()?.progress).toEqual({ kind: 'phase', phase: 'ready', label: 'Ready' });
  });
  it('does not create a push-refresh feedback loop for equal reviews and publishes a changed review once', async () => {
    const controller = new AbortController();
    const scope = { accountId: 'account', machineId: 'machine' };
    const pushed: ActionOperationSnapshotV1[] = [];
    const runtime = createHostActionOperationRuntime({ machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId, publishSnapshot: snapshot => { pushed.push(snapshot); } });
    const listeners = new Set<(id: string) => void>();
    const setup = createExecutionRunProjectSetupProjection({ runId: 'run', scope, signal: controller.signal,
      readBaseSnapshot: () => ({ version: 1, operationId: 'run', actionId: 'execution.run.start', state: 'running',
        scope, title: 'Run', createdAt: 1, startedAt: 1, cancellation: 'supported' }),
      publish: () => { for (const listener of listeners) listener('run'); },
    });
    const detach = runtime.attachOwner(createExecutionRunProjectSetupProjectionOwner({
      getSetup: id => id === 'run' ? setup : undefined, listIds: () => ['run'],
      waitForChange: async () => { throw new Error('A snapshot read must not wait for execution'); },
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    }));
    setup.context.operationOwnerUpdate?.update({ domainRef: { kind: 'projectCommand', purpose: 'setup',
      serverId: 'home', machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/workspace' } });
    let details = { kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const,
      reviewedEffectDigest: 'first', reviewedEffect: { commands: ['install'] } };
    const waiting = setup.context.operationReview!.waitForResume(details, { review: async () => ({ ...details }) });
    const completed = waiting.catch(() => undefined);
    try {
      const initial = await runtime.handlers.getV2({ operationId: 'run', refreshSetupReview: true });
      pushed.length = 0;
      for (let i = 0; i < 100; i++) await runtime.handlers.getV2({ operationId: 'run', refreshSetupReview: true });
      expect(pushed).toHaveLength(0);
      expect(await runtime.handlers.getV2({ operationId: 'run', refreshSetupReview: true })).toEqual(initial);
      details = { ...details, reviewedEffectDigest: 'changed', reviewedEffect: { commands: ['build'] } };
      const changed = await runtime.handlers.getV2({ operationId: 'run', refreshSetupReview: true });
      expect(pushed).toHaveLength(1);
      expect(changed).toMatchObject({ kind: 'found', operation: { setupReview: details } });
      expect(initial.kind === 'found' && changed.kind === 'found' && changed.operation.revision > initial.operation.revision).toBe(true);
    } finally { detach(); controller.abort(); await completed; }
  });
});
