// Real committed Agent/Provider and native Home/control boundary fixture.
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';
import { expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { adoptTrackedSessionRunnerIdentity } from '@/daemon/sessions/sessionReportCorrelation';


it('names the managed gateway preparation refusal site in file diagnostics without private messages', async () => {
  const log = vi.spyOn(logger, 'warnLocalFile');
  const fixture = await createAttachedManagedRunFixture({ browserStartup: {
    resolveCurrentMachineExecutionOriginContext: async () => null,
  } });
  try {
    adoptTrackedSessionRunnerIdentity(fixture.tracked, fixture.context.runner);
    fixture.tracked.runnerAgentSourceCustodyV1 = fixture.context.retainedAgent.sourceCustody;
    fixture.tracked.spawnOptions = { ...fixture.tracked.spawnOptions,
      modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: fixture.fixture.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' } },
      providerBindingMetadataV1: fixture.authorization.sessionBindingMetadata };
    fixture.tracked.runnerAgentInvocationContext = { ...fixture.context.invocationContext, providerBindingActive: true };
    const response = await fixture.dispatch({ kind: 'plugin_services.prepare_v1', requestId: 'missing-origin', invocationId: 'missing-origin' });
    expect(response).toMatchObject({ ok: false, error: { code: 'plugin_services_managed_provider_authority_unavailable' } });
    const diagnostics = log.mock.calls.map(([line]) => JSON.parse(String(line)))
      .filter(row => row.kind === 'runner_plugin_services_prepare_refused');
    expect(diagnostics).toContainEqual(expect.objectContaining({
      cause: { code: 'plugin_services_managed_provider_authority_unavailable', stage: 'managed_provider' },
      refusalSite: 'gateway_execution_identity',
    }));
    expect(JSON.stringify(response)).not.toContain('gateway_execution_identity');
  } finally {
    await fixture.cleanup();
    log.mockRestore();
  }
});
