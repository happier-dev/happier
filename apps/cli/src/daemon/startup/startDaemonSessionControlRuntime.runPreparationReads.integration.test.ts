import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';
import { logger } from '@/ui/logger';

it('admits Run authority once, reuses it at commit, and refuses an explicitly withdrawn preparation', async () => {
  let runReads = 0;
  let withdrawDuringRunRead = () => {};
  const fixture = await createAttachedManagedRunFixture({ issuedRequester: true, coldProviderCatalog: true,
    resolveRunAuthority: request => {
      runReads++;
      withdrawDuringRunRead();
      return { status: 'current', executionRunId: request.executionRunId, occurrenceId: request.expectedOccurrenceId!,
        parentSessionId: 'parent-session', intent: 'review', runtimeState: 'idle', teamCredentialProviderModel: null };
    },
    browserStartup: { resolveServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
      features: { providers: { enabled: true } }, capabilities: {},
    }) }) } });
  let snapshotId: string | undefined;
  const diagnostics = vi.spyOn(logger, 'infoFile');
  const readCounts = () => {
    const paths = vi.mocked(axios.get).mock.calls.map(([url]) => new URL(String(url)).pathname);
    return { profile: paths.filter(path => path.endsWith('/profile')).length,
      accounts: paths.filter(path => path === '/v4/connect/qualified/accounts').length,
      catalog: paths.filter(path => path === '/v1/account/entity-rows/provider-connections').length,
      history: paths.filter(path => path === '/v2/account/settings/history').length };
  };
  try {
    const acquired = await fixture.dispatch({ kind: 'execution_run.snapshot.acquire_v1',
      backendTarget: { kind: 'backend', backendId: fixture.fixture.agentId } });
    if (!acquired.ok || acquired.result.kind !== 'execution_run.snapshot') throw new Error('Expected real Run snapshot');
    snapshotId = acquired.result.snapshotId;
    const before = readCounts();
    const prepared = await fixture.dispatchRequest({ v: 1,
      context: { token: 'a'.repeat(43), sessionId: 'parent-session', executionRunSnapshotId: snapshotId },
      operation: { kind: 'execution_run.provider.prepare_v1', selection: { agentTargetKey: fixture.fixture.agentTargetKey,
        providerConnectionId: 'run-gateway', modelId: 'example' }, backendTarget: { kind: 'backend', backendId: fixture.fixture.agentId },
        agentId: fixture.fixture.agentId, runId: fixture.proof.executionRunId, controllerOccurrenceId: fixture.proof.executionRunOccurrenceId,
        expectedAccountSettingsScopeKey: fixture.proof.expectedAccountSettingsScopeKey } });
    expect(prepared, JSON.stringify({ prepared, source: fixture.sourceDiagnostics })).toMatchObject({
      ok: true, result: { kind: 'execution_run.provider.prepared', ok: true } });
    const after = readCounts();
    // The initial Run witness captures occurrence and selection once. Later
    // preparation phases consume it instead of repeating transport discovery.
    expect({ profile: after.profile - before.profile, accounts: after.accounts - before.accounts,
      catalog: after.catalog - before.catalog, history: after.history - before.history, runReads })
      .toEqual({ profile: 0, accounts: 6, catalog: 1, history: 0, runReads: 1 });
    const phases = diagnostics.mock.calls.flatMap(([marker, record]) =>
      marker === '[PROVIDER] Run preparation phase' ? [record] : []);
    // One bounded completion record per awaited preparation step, never per poll.
    expect(phases).toHaveLength(14);
    expect(phases).toEqual(expect.arrayContaining([
      'request_account_context', 'request_settings', 'request_features',
      'provider_authorization', 'provider_before_effect', 'managed_endpoint',
      'binding_account_context', 'binding_run_authority', 'managed_source_open',
      'consumer_application_start', 'binding_source_currentness',
      'provider_materialization', 'endpoint_currentness', 'provider_commit',
    ].map(phase => ({ runId: fixture.proof.executionRunId, phase, outcome: 'completed',
      startedAtMs: expect.any(Number), finishedAtMs: expect.any(Number), elapsedMs: expect.any(Number) }))));
    for (const phase of phases) {
      expect(phase).toEqual(expect.objectContaining({ elapsedMs: expect.toSatisfy((value: number) => value >= 0) }));
    }
    // Commit consumes the admitted Run, even if its discovery RPC is unavailable.
    withdrawDuringRunRead = () => { throw new Error('Run authority must not be read again'); };
    const committed = await fixture.dispatchRequest({ v: 1,
      context: { token: 'a'.repeat(43), sessionId: 'parent-session', executionRunSnapshotId: snapshotId },
      operation: { kind: 'execution_run.provider.revalidate_v1' } });
    expect(committed).toMatchObject({ ok: true, result: { kind: 'execution_run.provider.revalidated', result: { ok: true } } });
    expect(runReads).toBe(1);
    fixture.withdrawRequesterAdmission();
    const revalidated = await fixture.dispatchRequest({ v: 1,
      context: { token: 'a'.repeat(43), sessionId: 'parent-session', executionRunSnapshotId: snapshotId },
      operation: { kind: 'execution_run.provider.revalidate_v1' } });
    expect(revalidated).toMatchObject({ ok: true, result: { kind: 'execution_run.provider.revalidated', result: { ok: false } } });
    expect(runReads).toBe(1);
    expect(diagnostics.mock.calls.filter(([marker]) => marker === '[PROVIDER] Run preparation phase')).toHaveLength(14);
  } finally {
    diagnostics.mockRestore();
    if (snapshotId) await fixture.dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId });
    await fixture.cleanup();
  }
});
