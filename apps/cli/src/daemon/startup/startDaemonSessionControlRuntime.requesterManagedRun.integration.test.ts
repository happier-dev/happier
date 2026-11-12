import { expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';

it('admits a cold captured Account through the Run snapshot preparer and never falls back after its admission disappears', async () => {
  const fixture = await createAttachedManagedRunFixture({ issuedRequester: true, coldProviderCatalog: true,
    browserStartup: { resolveServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
      features: { providers: { enabled: true } }, capabilities: {},
    }) }) } });
  let snapshotId: string | undefined;
  try {
    const requester = fixture.requester;
    if (!requester) throw new Error('Expected actual requester');
    expect(requester.readAccountSettingsSnapshot().providerConnectionsCatalog).toBeUndefined();
    const ambient = getActiveAccountSettingsSnapshot();
    const acquired = AgentRuntimeDaemonServiceResponseV1Schema.parse(await fixture.dispatch({ kind: 'execution_run.snapshot.acquire_v1',
      backendTarget: { kind: 'backend', backendId: fixture.fixture.agentId } }));
    if (!acquired.ok || acquired.result.kind !== 'execution_run.snapshot') throw new Error('Expected real Run snapshot');
    snapshotId = acquired.result.snapshotId;
    const legacy = await fixture.dispatchRequest({ v: 1, context: { token: 'a'.repeat(43), sessionId: 'parent-session', executionRunSnapshotId: snapshotId },
      operation: { kind: 'execution_run.provider.admit_v1', selection: { agentTargetKey: fixture.fixture.agentTargetKey,
        providerConnectionId: 'run-gateway', modelId: 'example' }, backendTarget: { kind: 'backend', backendId: fixture.fixture.agentId },
        agentId: fixture.fixture.agentId, runId: fixture.proof.executionRunId, expectedAccountSettingsScopeKey: fixture.proof.expectedAccountSettingsScopeKey } });
    expect(legacy).toMatchObject({ ok: true, result: { kind: 'execution_run.provider.admitted', ok: true } });
    expect(requester.readAccountSettingsSnapshot().providerConnectionsCatalog).toBeUndefined();
    await expect(access(join(fixture.directory, 'gateway-started'))).rejects.toMatchObject({ code: 'ENOENT' });
    const response = await fixture.dispatchRequest({ v: 1, context: { token: 'a'.repeat(43), sessionId: 'parent-session', executionRunSnapshotId: snapshotId },
      operation: { kind: 'execution_run.provider.prepare_v1', selection: { agentTargetKey: fixture.fixture.agentTargetKey,
        providerConnectionId: 'run-gateway', modelId: 'example' }, backendTarget: { kind: 'backend', backendId: fixture.fixture.agentId },
        agentId: fixture.fixture.agentId, runId: fixture.proof.executionRunId,
        controllerOccurrenceId: fixture.proof.executionRunOccurrenceId,
        expectedAccountSettingsScopeKey: fixture.proof.expectedAccountSettingsScopeKey } });
    expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { kind: 'execution_run.provider.prepared', ok: true } });
    if (!response.ok || response.result.kind !== 'execution_run.provider.prepared' || !response.result.ok) throw new Error('Expected prepared Run');
    expect(requester.readAccountSettingsSnapshot().providerConnectionsCatalog?.status).toBe('ready');
    expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
    expect(requester.bootstrap.credentials.token).not.toBe(fixture.credentials.token);
    // Token rotation preserves Account/Home identity, while the requester
    // continues to own its captured holder and admission lifetime.
    expect(fixture.proof.expectedAccountSettingsScopeKey).toBe(fixture.snapshot.scopeKey);
    expect(requester.readAccountSettingsSnapshot()).not.toBe(ambient);
    expect(requester.bootstrap.attribution.accountId).toBe('account');
    const intent = fixture.fixture.gateway?.purposeBindings.bindings[0];
    if (!intent || intent.target.kind !== 'account') throw new Error('Expected canonical bound purpose');
    await expect(fixture.dispatch({ kind: 'provider_managed.purpose.resolve', requestId: 'issued-purpose',
      purpose: intent.purpose, target: intent.target, serviceRefs: [intent.target.account.service],
      expectedAccountSettingsScopeKey: fixture.proof.expectedAccountSettingsScopeKey,
    })).resolves.toMatchObject({ ok: true, result: { kind: 'provider_managed.purpose', binding: intent } });
    await expect(access(join(fixture.directory, 'gateway-started'))).resolves.toBeUndefined();
    const environment = new Map(response.result.environmentOverlay.map(entry => [entry.name, entry.value]));
    const endpoint = environment.get('RUN_PROVIDER_URL');
    const token = environment.get('RUN_PROVIDER_TOKEN');
    if (!endpoint || !token) throw new Error('Expected admitted Run endpoint materialization');
    const send = () => fetch(`${endpoint}/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'example', input: 'hello' }) });
    expect((await send()).ok).toBe(true);
    // A live managed parent has its own applied binding. The child already
    // acquired the Run-scoped consumer above; its PluginServices must not
    // reconstruct the parent's Session-scoped managed Provider invocation.
    fixture.tracked.runnerAgentSourceCustodyV1 = fixture.context.retainedAgent.sourceCustody;
    fixture.tracked.runnerProcessIdentity = fixture.context.runner;
    fixture.tracked.spawnOptions = { ...fixture.tracked.spawnOptions!,
      modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: fixture.fixture.agentTargetKey,
        providerConnectionId: fixture.proof.runtimeBindingBasis.connectionId, modelId: 'example' } },
      providerBindingMetadataV1: fixture.authorization.sessionBindingMetadata };
    const prepared = await fixture.dispatchRequest({ v: 1,
      context: { token: 'a'.repeat(43), sessionId: 'parent-session', executionRunSnapshotId: snapshotId },
      operation: { kind: 'plugin_services.prepare_v1', requestId: 'child-prepare', invocationId: fixture.proof.executionRunId,
        executionRunCwd: fixture.fixture.happyHomeDir } });
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, result: { kind: 'plugin_services.result_v1' } });
    if (!prepared.ok || prepared.result.kind !== 'plugin_services.result_v1') throw new Error('Expected child PluginServices');
    expect(decodeRunnerDaemonPluginServiceWireValueV1(prepared.result.value)).not.toHaveProperty('managedProvider');
    expect((await send()).ok).toBe(true);
    await expect(fixture.dispatchRequest({ v: 1,
      context: { token: 'a'.repeat(43), sessionId: 'parent-session', executionRunSnapshotId: snapshotId },
      operation: { kind: 'plugin_services.close_v1', requestId: 'child-close', invocationId: fixture.proof.executionRunId } }))
      .resolves.toMatchObject({ ok: true });
    expect((await send()).ok).toBe(true);
    const rootSnapshot = getActiveAccountSettingsSnapshot();
    fixture.withdrawRequesterAdmission();
    expect(await requester.isCurrent()).toBe(false);
    expect(() => requester.readAccountSettingsSnapshot()).toThrow('requester_account_context_unavailable');
    await expect(send()).rejects.toBeDefined();
    await expect(fixture.dispatch({ kind: 'provider_managed.binding.read', requestId: 'issued-no-handle', ...fixture.proof }))
      .resolves.toMatchObject({ ok: false, error: { code: 'provider_endpoint_unavailable' } });
    expect(getActiveAccountSettingsSnapshot()).toBe(rootSnapshot);
  } finally {
    if (snapshotId) await fixture.dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId });
    await fixture.cleanup();
  }
});
