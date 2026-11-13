// Real committed Agent/Provider and native Home/control boundary fixture.
import { createAttachedManagedRunFixture, createAttachedManagedRunControlTransport } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';
import { expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { adoptTrackedSessionRunnerIdentity } from '@/daemon/sessions/sessionReportCorrelation';
import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { dispatchCurrentRunnerDaemonPluginService } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

it('retains initial managed Provider authority failure and ordinary withdrawal through the real launch client', async () => {
  let fault: 'changed' | 'unavailable' = 'changed';
  const fixture = await createAttachedManagedRunFixture({ browserStartup: {
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: 'machine' }),
  } });
  let transport: Awaited<ReturnType<typeof createAttachedManagedRunControlTransport>> | null = null;
  let prepared = false;
  try {
    adoptTrackedSessionRunnerIdentity(fixture.tracked, fixture.context.runner);
    fixture.tracked.runnerAgentSourceCustodyV1 = fixture.context.retainedAgent.sourceCustody;
    fixture.tracked.spawnOptions = { ...fixture.tracked.spawnOptions,
      modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: fixture.fixture.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' } },
      providerBindingMetadataV1: fixture.authorization.sessionBindingMetadata };
    fixture.tracked.runnerAgentInvocationContext = { ...fixture.context.invocationContext, providerBindingActive: true };
    transport = await createAttachedManagedRunControlTransport(fixture, {
      afterDispatch(request, response) {
        if (request.operation.kind !== 'plugin_services.prepare_v1' || !response.ok) return;
        prepared = true;
        if (fault === 'unavailable') fixture.initialPolicyFilesystem.refuse();
        else if (fixture.tracked.spawnOptions) fixture.tracked.spawnOptions.providerBindingMetadataV1 = undefined;
      },
    });
    const authority = transport.authority;
    const local = createUnavailablePluginServices();
    for (const nextFault of ['unavailable', 'changed'] as const) {
      fault = nextFault;
      prepared = false;
      fixture.tracked.spawnOptions!.providerBindingMetadataV1 = fixture.authorization.sessionBindingMetadata;
      const failure = await prepareRunnerDaemonPluginServices({ invocationId: `initial-policy-launch-${fault}`,
        signal: new AbortController().signal, local,
        // This host has no managed-service work to execute: authority fails before start.
        bindManagedServices: () => local.managedServices,
        processOwner: { kind: 'session', sessionId: 'parent-session' },
        dispatch: (operation, options) => dispatchCurrentRunnerDaemonPluginService({ authority, operation, ...options }),
      }).then(() => null, (error: unknown) => error);
      expect(prepared, JSON.stringify({ fault, failure })).toBe(true);
      if (fault === 'unavailable') {
        expect(fixture.initialPolicyFilesystem.readFailures(), JSON.stringify(failure)).toBeGreaterThan(0);
        expect(failure).toMatchObject({ data: { failureCause: { errorCode: 'EACCES' } } });
      } else {
        expect(failure).not.toMatchObject({ data: { failureCause: { errorCode: 'EACCES' } } });
      }
      expect(failure).toMatchObject({ code: 'plugin_services_managed_provider_authority_unavailable' });
      fixture.initialPolicyFilesystem.restore();
      await dispatchCurrentRunnerDaemonPluginService({ authority, operation: { kind: 'plugin_services.close_v1',
        requestId: `close-${fault}`, invocationId: `initial-policy-launch-${fault}` } });
    }
  } finally {
    fixture.initialPolicyFilesystem.restore();
    await transport?.cleanup();
    await fixture.cleanup();
  }
});
