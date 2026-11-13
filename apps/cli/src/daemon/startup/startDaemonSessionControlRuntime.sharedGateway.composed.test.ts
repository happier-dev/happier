import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { DaemonProviderModelProjectionRequestV1Schema } from '@happier-dev/protocol/rpc/providers';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import type { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';

import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import type { TrackedSession } from '@/daemon/types';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { attestRetainedManagedProvider } from '@/plugins/runtime/composition/retainedProviderAssembly';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { configuration } from '@/configuration';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  commitActiveProviderConnectionsCatalog, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { RunnerDaemonManagedProviderBootstrapV1Schema, decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import type { startDaemonControlServer } from '@/daemon/controlServer';

import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { brokerOpenFailureCases, openRefusedAccountConnectionBroker } from '@/providers/broker/accountConnectionClient.testkit';
import { logger } from '@/ui/logger';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const boundary = vi.hoisted(() => ({
  controlInput: null as Parameters<typeof startDaemonControlServer>[0] | null,
  machineRpc: vi.fn<typeof callExactMachineRpc>(),
}));
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callExactMachineRpc: boundary.machineRpc }));

// Replace only the loopback HTTP listener. The production dispatcher, runner
// authority, Provider admission, registry and connected-account custody stay real.
vi.mock('@/daemon/controlServer', () => ({
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.controlInput = input;
    return { port: 43129, stop: async () => {} };
  },
}));

it.each([
  { placement: 'local', failureReason: undefined }, { placement: 'peer', failureReason: undefined },
  ...brokerOpenFailureCases.map(failureReason => ({ placement: 'peer', failureReason })),
] as const)('prepares a titled $placement gateway (refusal $failureReason) through real runner dispatch', async ({ placement, failureReason }) => {
  await withConfiguredDaemonTestHome({ prefix: 'runner-shared-gateway-', env: {
    HAPPIER_ACCOUNT_SETTINGS_MODE: 'never',
  } }, async ({ homeDir }) => {
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'),
      happyHomeDir: homeDir, controller: createPluginReloadController(), physicalGateway: true, probeCatalog: placement === 'peer' });
    let runtime: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>> | undefined;
    let brokerAttempted = false;
    const warning = vi.spyOn(logger, 'warnLocalFile');
    try {
      const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.fixture`;
      const machineId = placement === 'peer' ? 'peer-worker' : fixture.machineId;
      const base = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings, machineGrants: [],
        connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
          gatewayPlacement: { kind: 'machine', machineId: fixture.machineId } })),
      });
      const resolved = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId,
        providerSettings: base, registry: fixture.contributes, dnsEvidenceByEndpointUrl: new Map() });
      if (resolved.status !== 'resolved') throw new Error('Expected Gateway configuration');
      const settings = ProviderSettingsV1Schema.parse({ ...base, machineGrants: [...new Set([machineId, fixture.machineId])].map(id => ({
        v: 1, connectionId: 'run-gateway', machineId: id, confirmedAt: 1,
        connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
        endpointSetFingerprint: resolved.record.endpointSetFingerprint,
      })) });
      const snapshot = { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken(token),
        providerConnectionsCatalog: { status: 'ready' as const, revision: 2, catalog: splitProviderSettingsV1(settings).catalog } };
      setActiveAccountSettingsSnapshot(snapshot);
      const hubModels = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
        happyHomeDir: homeDir, featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => snapshot,
        acquireRuntimeLease: async () => {
          const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
          if (!lease) throw new Error('Expected real Gateway registry');
          return lease;
        },
        resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
        modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected model mutation'); },
      });
      boundary.machineRpc.mockImplementation(async request => {
        expect(request.machineId).toBe(fixture.machineId);
        return await hubModels.projectModels(DaemonProviderModelProjectionRequestV1Schema.parse(request.request));
      });
      // Live c22 rejected scope.operationClaimId:too_big: the producer embedded
      // source custody and shared placement in JSON. A valid Session id must not
      // make that opaque claim exceed the strict runner protocol's ID boundary.
      const sessionId = `runner-shared-gateway-${'session'.repeat(24)}`;
      const selection = { agentTargetKey: fixture.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' };
      const authorized = await createRuntimeProviderSpawnAuthorizationAttempt({
        selection: { v: 1, updatedAt: 1, ref: selection }, runtimeModelDescriptor: { id: 'example', name: 'Example' },
        machineId, agentTargetKey: fixture.agentTargetKey, agentId: fixture.agentId,
        readModelProjection: request => hubModels.projectModels(request),
        lease: fixture.lease, getAccountSettingsSnapshot: () => snapshot,
        materializationBaseDir: join(homeDir, 'providers'), sessionId,
        managedPurposeBindingSnapshot: fixture.gateway!.purposeBindings,
      });
      expect(authorized, JSON.stringify(authorized)).toMatchObject({ ok: true });
      if (!authorized.ok) throw new Error('Expected real Provider admission');
      const metadata = authorized.attempt.authorization.sessionBindingMetadata;
      authorized.attempt.cleanupOnFailure();
      const basis = metadata.runtimeBindingBasis;
      if (!basis || basis.deployment.kind !== 'managedLocal') throw new Error('Expected real managed runtime basis');
      const mismatched = await fixture.lease.registry.createManagedProviderRuntimeInvocationServices?.({
        identity: basis.deployment.implementationIdentity,
        purposeBindings: basis.deployment.purposeBindings,
        sharedGateway: { homeId: 'home', accountId: 'account', connectionId: basis.connectionId,
          machineId: fixture.machineId, consumerId: sessionId },
        operationClaim: { kind: 'sessionDemand', sessionId,
          runtimeBindingBasis: { ...basis, deployment: { ...basis.deployment,
            managedRuntime: { ...basis.deployment.managedRuntime, requestAuthUses: [] } } },
          bindSessionCustody: async () => { throw new Error('Unexpected unshared custody'); },
        },
        signal: new AbortController().signal, isCurrent: () => true,
      });
      try {
        // Presentation-only changes are accepted below; changed request-auth
        // authority must still refuse before a gateway consumer is acquired.
        expect(mismatched).toBeNull();
      } finally { await mismatched?.cleanup(); }
      const retainedAgent = fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId)?.sessionRunnerFactoryBinding;
      if (!retainedAgent) throw new Error('Expected the admitted Agent runner binding');
      const runner = { pid: process.pid, processStartTimeMs: 1717171717000,
        processCommandHash: 'a'.repeat(64), snapshotIdentity: 'version:fixture' };
      const tracked: TrackedSession = {
        trackingKey: legacyPidSessionTrackingKey(runner.pid), pid: runner.pid, sessionRunnerPid: runner.pid, startedBy: 'daemon', happySessionId: sessionId,
        processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
        runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
        runnerAgentInvocationContext: { cwd: homeDir, environment: {}, providerBindingActive: true },
        spawnOptions: { directory: homeDir,
          backendTarget: { kind: 'backend', backendId: fixture.agentId },
          modelSelection: { v: 1, updatedAt: 1, ref: selection }, providerBindingMetadataV1: metadata },
      };
      runtime = await startDaemonSessionControlRuntime({
        machineId, serverId: configuration.activeServerId,
        pluginRuntimeController: fixture.gateway!.controller,
        serverBaseUrl: configuration.apiServerUrl, externalActionAccountId: 'account',
        credentials: { token, encryption: null }, api: {} as never,
        daemonSessionMutationCustody: {
          stageTranscriptMessage: async () => { throw new Error('Unexpected transcript write'); },
          stageTranscriptEvent: async () => ({ persisted: true, delivered: true }),
        },
        connectedServicesMaterializationBaseDir: join(homeDir, 'connected-services'),
        getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
        trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]), spawnAwaiterByKey: new Map(),
        spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(), getApiMachineForSessions: () => null,
        spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), connectedServicesRestartRequestedSessions: new Set(),
        beforeShutdown: () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {}, processEnv: {},
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: fixture.machineId }),
        ...(placement === 'peer' ? { openAccountConnectionProviderBrokerAccess: async request => {
          brokerAttempted = true;
          if (failureReason) return await openRefusedAccountConnectionBroker(request, failureReason);
          throw new Error('No broker effect during preparation');
        } } : {}),
      });
      const services = boundary.controlInput?.agentRuntimeDaemonServices;
      if (!services) throw new Error('Expected production runner service dispatcher');
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
        context: { token: 'c'.repeat(43), sessionId },
        operation: { kind: 'plugin_services.prepare_v1', requestId: 'gateway-prepare', invocationId: 'gateway-invocation' },
      });
      if (placement === 'peer') {
        // Missing the real hub forwarding must refuse preparation. A following
        // delivery uses the restored transport and must not retain that failure.
        boundary.machineRpc.mockRejectedValueOnce(Object.assign(new Error('RPC_METHOD_NOT_FOUND'), { code: 'RPC_METHOD_NOT_FOUND' }));
        const miswired = await services.dispatch(request, { sessionId, runner, retainedAgent,
          invocationContext: tracked.runnerAgentInvocationContext!, trackedSession: tracked, isCurrent: async () => true });
        expect(miswired).toMatchObject({ ok: false, error: { cause: { stage: 'managed_provider' } } });
      }
      const prepared = await services.dispatch(request, { sessionId, runner, retainedAgent,
        invocationContext: tracked.runnerAgentInvocationContext!, trackedSession: tracked, isCurrent: async () => true });
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
      if (!prepared.ok || prepared.result.kind !== 'plugin_services.result_v1') throw new Error('Expected prepared services');
      const preparedSnapshot = decodeRunnerDaemonPluginServiceWireValueV1(prepared.result.value);
      if (!preparedSnapshot || typeof preparedSnapshot !== 'object' || Array.isArray(preparedSnapshot) || !('managedProvider' in preparedSnapshot)) throw new Error('Expected managed Provider bootstrap');
      const parsedBootstrap = RunnerDaemonManagedProviderBootstrapV1Schema.safeParse(preparedSnapshot.managedProvider);
      expect(parsedBootstrap.success, JSON.stringify(parsedBootstrap)).toBe(true);
      if (!parsedBootstrap.success) throw new Error('Expected valid managed Provider bootstrap');
      const bootstrap = parsedBootstrap.data;
      expect(bootstrap.scope.runtimeBindingBasis).toStrictEqual(basis);
      const wrongClaim = await services.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({
        v: 1, context: request.context,
        operation: { kind: 'plugin_services.managed_provider.start_v1', requestId: 'gateway-wrong-claim',
          invocationId: 'gateway-invocation', retained: { v: 1,
            scope: { ...bootstrap.scope, operationClaimId: 'different-claim' }, custody: bootstrap.custody,
            providerPluginHardRevocationRevisionAtAdmission: bootstrap.providerPluginHardRevocationRevisionAtAdmission } },
      }), { sessionId, runner, retainedAgent, invocationContext: tracked.runnerAgentInvocationContext!,
        trackedSession: tracked, isCurrent: async () => true });
      expect(wrongClaim).toMatchObject({ ok: false, error: {
        code: 'plugin_services_managed_provider_retention_mismatch',
        cause: { code: 'managed_provider_retention_scope_operation_claim_id', stage: 'dispatch' } } });
      if (failureReason) {
        const refused = await services.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({
          v: 1, context: request.context,
          operation: { kind: 'plugin_services.managed_provider.start_v1', requestId: 'gateway-start-refused',
            invocationId: 'gateway-invocation', retained: { v: 1, scope: bootstrap.scope, custody: bootstrap.custody,
              providerPluginHardRevocationRevisionAtAdmission: bootstrap.providerPluginHardRevocationRevisionAtAdmission } },
        }), { sessionId, runner, retainedAgent, invocationContext: tracked.runnerAgentInvocationContext!,
          trackedSession: tracked, isCurrent: async () => true });
        expect(refused).toMatchObject({ ok: false });
        expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(refused)).toEqual(refused);
        if (failureReason === 'admission_refused') {
          expect(refused).toMatchObject({ error: { cause: { code: 'session_not_active' } } });
        }
        expect(JSON.stringify(refused)).not.toContain(failureReason);
        const records = warning.mock.calls.flatMap(([label]) => {
          try { return [JSON.parse(label) as { kind?: string; reason?: string }]; } catch { return []; }
        });
        for (const kind of ['runner_managed_provider_start_refused', 'runner_plugin_services_dispatch_refused']) {
          expect.soft(records.filter(record => record.kind === kind)).toContainEqual(expect.objectContaining({ kind, reason: failureReason,
            ...(failureReason === 'admission_refused' ? { admissionReasonCode: 'session_not_active' } : {}),
            ...(failureReason === 'broker_open_refused' ? { admissionReasonCode: 'broker_unavailable' } : {}),
            ...(failureReason === 'endpoint_discovery_failed' ? { httpStatus: 403, discoveryCause: 'http_response' } : {}),
          }));
        }
        expect(warning.mock.calls.filter(([label]) => label === '[ProviderBroker] Account connection open refused')).toEqual([
          ['[ProviderBroker] Account connection open refused', { reason: failureReason,
            ...(failureReason === 'admission_refused' ? { admissionReasonCode: 'session_not_active' } : {}),
            ...(failureReason === 'broker_open_refused' ? { admissionReasonCode: 'broker_unavailable' } : {}),
            ...(failureReason === 'endpoint_discovery_failed' ? { httpStatus: 403, discoveryCause: 'http_response' } : {}),
          }],
        ]);
        expect(JSON.stringify(records)).not.toContain('do-not-log');
        return;
      }
      if (placement === 'peer') {
        expect(commitActiveProviderConnectionsCatalog({ scopeKey: snapshot.scopeKey,
          lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), catalog: {
          status: 'ready', revision: 3, catalog: splitProviderSettingsV1(ProviderSettingsV1Schema.parse({
            ...settings, machineGrants: settings.machineGrants.filter(grant => grant.machineId !== machineId),
          })).catalog,
        } })).toBe(true);
        const revoked = await services.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({
          v: 1, context: request.context,
          operation: { kind: 'plugin_services.managed_provider.start_v1', requestId: 'gateway-revoked',
            invocationId: 'gateway-invocation', retained: { v: 1, scope: bootstrap.scope, custody: bootstrap.custody,
              providerPluginHardRevocationRevisionAtAdmission: bootstrap.providerPluginHardRevocationRevisionAtAdmission } },
        }), { sessionId, runner, retainedAgent, invocationContext: tracked.runnerAgentInvocationContext!,
          trackedSession: tracked, isCurrent: async () => true });
        // Observe the policy effect, independently of diagnostic presentation.
        expect(revoked, JSON.stringify(revoked)).toMatchObject({ ok: false });
        expect(brokerAttempted).toBe(false);
        return;
      }
      const started = await services.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({
        v: 1, context: request.context,
        operation: { kind: 'plugin_services.managed_provider.start_v1', requestId: 'gateway-start',
          invocationId: 'gateway-invocation', retained: { v: 1, scope: bootstrap.scope,
            custody: bootstrap.custody,
            providerPluginHardRevocationRevisionAtAdmission: bootstrap.providerPluginHardRevocationRevisionAtAdmission } },
      }), { sessionId, runner, retainedAgent, invocationContext: tracked.runnerAgentInvocationContext!,
        trackedSession: tracked, isCurrent: async () => true });
      expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
      const providerRuntime = await fixture.lease.registry.acquireManagedProviderRuntime?.(basis.deployment.implementationIdentity);
      if (!providerRuntime) throw new Error('Expected admitted gateway runtime');
      const retained = await attestRetainedManagedProvider({ paths: resolvePluginStorePaths({ happyHomeDir: homeDir }),
        sessionId, identity: basis.deployment.implementationIdentity,
        occurrenceId: providerRuntime.activationOccurrenceId, sourceCustody: providerRuntime.sourceCustody,
        manifestAuthority: 'external', runtimeBindingBasis: basis });
      expect(retained).toMatchObject({ identity: basis.deployment.implementationIdentity });
    } finally {
      warning.mockRestore();
      await runtime?.stopControlServer();
      resetActiveAccountSettingsSnapshotForTests();
      boundary.controlInput = null;
      boundary.machineRpc.mockReset();
      await fixture.cleanup();
    }
  });
});
