import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunHostRuntime } from '../executionRunHostRuntime';
import { createExecutionRunSnapshotLease } from '../contributionSnapshotLease';
import { withExecutionRunHostRuntimeCleanup } from './cleanup';
import { createLazyExecutionRunHostRuntime } from './lazy';
import { withExecutionRunPermissionResponder } from './permissionResponder';
import { withExecutionRunRuntimeIdentityPublication } from '@/agent/runtime/identity/executionRunRuntimeIdentityPublication';

function createRuntime(dispose: ExecutionRunHostRuntime['dispose']): ExecutionRunHostRuntime {
  return {
    readResumeSupport: async () => false,
    provisionRuntime: async () => ({ runtimeId: 'child-runtime' }),
    deliverInput: async () => ({ status: 'admitted' }),
    getRuntimeLifetimeSignal: () => new AbortController().signal,
    cancel: async () => {},
    subscribeMessages: () => () => {},
    dispose,
  };
}

describe('withExecutionRunHostRuntimeCleanup snapshot lifetime', () => {
  it('preserves structured input, exact custody evidence and lifetime through the composed wrappers', async () => {
    const lifetime = new AbortController();
    const witness = { inputId: 'input-1', turnId: 'turn-1', userMessageSeq: 7, userMessageSeqs: [7] };
    const interaction = { kind: 'retained_agent_session.v1' as const, capabilities: { open: ['create' as const], delivery: ['newTurn' as const], cancel: true } };
    const input = { text: 'inspect', structuredInput: { target: { path: 'src/main.ts' } } };
    const outcome = { kind: 'accepted' as const, localId: 'input-1', userMessageSeq: 7, providerTurnId: 'turn-1' };
    const event = { kind: 'turn-complete' as const, sessionId: 'child-runtime', turnId: 'turn-1', sequence: 1, emittedAtMs: 1 };
    let observeOutcome: Parameters<NonNullable<ExecutionRunHostRuntime['subscribeProviderInputOutcomes']>>[0] | undefined;
    let observeEvent: Parameters<NonNullable<ExecutionRunHostRuntime['subscribeRuntimeEvents']>>[0] | undefined;
    let delivered: Parameters<ExecutionRunHostRuntime['deliverInput']> | undefined;
    const cleanup = vi.fn();
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime: async () => withExecutionRunHostRuntimeCleanup(withExecutionRunRuntimeIdentityPublication({
        runtime: withExecutionRunPermissionResponder({
          ...createRuntime(async () => {}),
          getRuntimeLifetimeSignal: () => lifetime.signal,
          interaction,
          deliverInput: async (...args) => {
            delivered = args;
            observeOutcome?.(outcome);
            observeEvent?.(event);
            return { status: 'admitted' };
          },
          steerInput: async () => ({
            status: 'unavailable',
            diagnostic: { code: 'unavailable', severity: 'warning' },
            retryable: true,
          }),
          subscribeProviderInputOutcomes: (handler) => {
            observeOutcome = handler;
            return () => { observeOutcome = undefined; };
          },
          subscribeRuntimeEvents: (handler) => {
            observeEvent = handler;
            return () => { observeEvent = undefined; };
          },
          readActiveTurnAdmissionWitness: () => witness,
        }, { respondToPermissionRequest: () => true }),
        identity: { runtimeDescriptor: null, runtimeCapabilities: { executionRun: { supported: true } }, runtimeFacets: null },
      }), cleanup),
    });
    const shellLifetime = runtime.getRuntimeLifetimeSignal();
    expect(runtime.subscribeProviderInputOutcomes).toBeUndefined();
    const outcomes: unknown[] = [];
    const events: unknown[] = [];
    // Runtime-event observers subscribe before lazy provisioning so a fast
    // native refusal cannot lose its recovery-waiting projection.
    const unsubscribeEvent = runtime.subscribeRuntimeEvents?.((value) => events.push(value));
    await runtime.provisionRuntime();
    expect(runtime.interaction).toEqual(interaction);
    const unsubscribeOutcome = runtime.subscribeProviderInputOutcomes?.((value) => outcomes.push(value));
    await expect(runtime.deliverInput('child-runtime', input, { localId: 'input-1' })).resolves.toEqual({ status: 'admitted' });
    expect(delivered).toEqual(['child-runtime', input, { localId: 'input-1' }]);
    expect(outcomes).toEqual([outcome]);
    expect(events).toEqual([event]);
    expect(runtime.readActiveTurnAdmissionWitness?.()).toEqual(witness);
    await expect(runtime.steerInput?.('child-runtime', input)).resolves.toEqual({
      status: 'unavailable',
      diagnostic: { code: 'unavailable', severity: 'warning' },
      retryable: true,
    });
    unsubscribeOutcome?.();
    unsubscribeEvent?.();
    expect(observeOutcome).toBeUndefined();
    expect(observeEvent).toBeUndefined();
    lifetime.abort('native retired');
    expect(shellLifetime.aborted).toBe(true);
    expect(shellLifetime.reason).toBe('native retired');
    await runtime.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(runtime.steerInput?.('child-runtime', input)).rejects.toThrow('disposed');
  });

  it('releases the final snapshot reference when runtime disposal fails and remains idempotent', async () => {
    const releaseServingRegistry = vi.fn(async () => {});
    const snapshotLease = createExecutionRunSnapshotLease(releaseServingRegistry);
    const releaseRuntime = snapshotLease.retain();
    const disposeError = new Error('runtime dispose failed');
    const disposeRuntime = vi.fn(async () => {
      throw disposeError;
    });
    const runtime = withExecutionRunHostRuntimeCleanup(
      createRuntime(disposeRuntime),
      releaseRuntime,
    );

    await snapshotLease.releaseOwner();
    expect(releaseServingRegistry).not.toHaveBeenCalled();

    await expect(runtime.dispose()).rejects.toBe(disposeError);
    expect(releaseServingRegistry).toHaveBeenCalledTimes(1);

    await expect(runtime.dispose()).rejects.toBe(disposeError);
    expect(releaseServingRegistry).toHaveBeenCalledTimes(1);
  });
});
