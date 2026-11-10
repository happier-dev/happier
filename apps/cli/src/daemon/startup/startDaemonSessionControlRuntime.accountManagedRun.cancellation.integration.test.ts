import { expect, it } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';

it('cancels pending managed Run admission and recovery, and refuses a cancelled commit without a new authority read', async () => {
  let defer = false;
  let enter = () => {};
  let release = () => {};
  let released = Promise.resolve();
  let observedSignal: AbortSignal | undefined;
  let authorityReads = 0;
  const fixture = await createAttachedManagedRunFixture({ browserStartup: {
    resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
      features: { providers: { enabled: true } },
    }) }),
  }, resolveRunAuthority: async (request, signal) => {
    authorityReads++;
    if (defer) {
      observedSignal = signal;
      enter();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        void released.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
      });
    }
    return { status: 'current', executionRunId: request.executionRunId, occurrenceId: request.expectedOccurrenceId!,
      parentSessionId: 'parent-session', intent: 'review', runtimeState: 'idle', teamCredentialProviderModel: null };
  } });
  let pending: Promise<unknown> | undefined;
  try {
    for (const phase of ['open', 'read', 'commit'] as const) {
      defer = false;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      released = new Promise<void>(resolve => { release = resolve; });
      const controller = new AbortController();
      let snapshotId: string | undefined;
      let bindingId: string | undefined;
      if (phase === 'commit') {
        const acquired = await fixture.dispatch({ kind: 'execution_run.snapshot.acquire_v1',
          backendTarget: { kind: 'backend', backendId: fixture.fixture.agentId } });
        if (!acquired.ok || acquired.result.kind !== 'execution_run.snapshot') throw new Error(JSON.stringify(acquired));
        snapshotId = acquired.result.snapshotId;
        const prepared = await fixture.dispatchRequest({ v: 1, context: { token: 'a'.repeat(43), sessionId: 'parent-session', executionRunSnapshotId: snapshotId },
          operation: { kind: 'execution_run.provider.prepare_v1', backendTarget: { kind: 'backend', backendId: fixture.fixture.agentId },
            agentId: fixture.fixture.agentId, runId: fixture.proof.executionRunId, controllerOccurrenceId: fixture.proof.executionRunOccurrenceId,
            selection: { agentTargetKey: fixture.fixture.agentTargetKey, providerConnectionId: 'run-gateway', modelId: 'example' },
            expectedAccountSettingsScopeKey: fixture.proof.expectedAccountSettingsScopeKey } });
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, result: { kind: 'execution_run.provider.prepared', ok: true } });
      } else if (phase === 'read') {
        const opened = await fixture.dispatch({ kind: 'provider_managed.binding.open', requestId: 'open', ...fixture.proof });
        if (!opened.ok || opened.result.kind !== 'provider_managed.binding') throw new Error(JSON.stringify(opened));
        bindingId = opened.result.bindingId;
        // A released binding needs a new admission; reading an active binding
        // consumes its admitted proof without another Home RPC.
        await fixture.dispatch({ kind: 'provider_managed.binding.close', requestId: 'release-before-recovery', bindingId });
      }
      defer = true;
      const readsBeforeCommit = authorityReads;
      if (phase === 'commit') controller.abort();
      pending = fixture.dispatchRequest({ v: 1,
        context: { token: 'a'.repeat(43), sessionId: 'parent-session', ...(snapshotId ? { executionRunSnapshotId: snapshotId } : {}) },
        operation: phase === 'commit' ? { kind: 'execution_run.provider.revalidate_v1' }
          : { kind: phase === 'read' ? 'provider_managed.binding.read' : 'provider_managed.binding.open',
              requestId: 'cancelled-read', ...fixture.proof, ...(bindingId ? { bindingId } : {}) } }, controller.signal);
      if (phase !== 'commit') {
        await entered;
        controller.abort();
        expect(observedSignal?.aborted).toBe(true);
      }
      await expect(pending).resolves.toMatchObject(phase === 'commit'
        ? { ok: false }
        : { ok: false, error: { code: 'provider_endpoint_unavailable' } });
      if (phase === 'commit') expect(authorityReads).toBe(readsBeforeCommit);
      release();
    }
  } finally {
    release();
    try { await pending; } finally { await fixture.cleanup(); }
  }
});
