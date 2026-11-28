import { join } from 'node:path';
import axios from 'axios';

import { expect, it, onTestFinished, vi } from 'vitest';
import { ProviderConnectionIdSchema, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { DaemonProviderModelProjectionRequestV1Schema } from '@happier-dev/protocol/rpc/providers';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import type { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';

import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import type { TrackedSession } from '@/daemon/types';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { attestRetainedManagedProvider } from '@/plugins/runtime/composition/retainedProviderAssembly';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { configuration } from '@/configuration';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  commitActiveProviderConnectionsCatalog, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { AgentRuntimeDaemonServiceRequestV1Schema, type AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { RunnerDaemonManagedProviderBootstrapV1Schema, RunnerDaemonSharedGatewayHttpBindingV1Schema, decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createRunnerManagedProviderConsumerAccess } from '@/agent/runtime/session/process/runnerManagedProviderConsumerAccess';
import type { startDaemonControlServer } from '@/daemon/controlServer';

import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { brokerOpenFailureCases, openRefusedAccountConnectionBroker } from '@/providers/broker/accountConnectionClient.testkit';
import { logger } from '@/ui/logger';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { prepareRequesterSessionBootstrap, type RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/createRequesterSessionRuntimeContext';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';

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
  { placement: 'local', failureReason: undefined, requesterAccountId: 'guest' },
  { placement: 'peer', failureReason: 'broker_open_refused', requesterAccountId: 'guest' },
  ...brokerOpenFailureCases.map(failureReason => ({ placement: 'peer', failureReason })),
] satisfies readonly { placement: 'local' | 'peer'; failureReason?: typeof brokerOpenFailureCases[number]; requesterAccountId?: string }[])(
  'prepares a titled $placement gateway (requester $requesterAccountId, refusal $failureReason) through real runner dispatch',
  async ({ placement, failureReason, requesterAccountId }) => {
  await withConfiguredDaemonTestHome({ prefix: 'runner-shared-gateway-', env: {
    HAPPIER_ACCOUNT_SETTINGS_MODE: 'never',
  } }, async ({ homeDir }) => {
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'),
      happyHomeDir: homeDir, controller: requesterAccountId ? pluginReloadController : createPluginReloadController(),
      physicalGateway: true, probeCatalog: placement === 'peer' });
    let runtime: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>> | undefined;
    let requester: RequesterSessionRuntimeContext | null = null;
    let replacementController: ReturnType<typeof createPluginReloadController> | undefined;
    const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
    let brokerAttempted = false;
    let brokerRequesterSource: { homeId?: string; accountId?: string; connectionId: string } | undefined;
    let machineHomeId = 'home';
    const warning = vi.spyOn(logger, 'warnLocalFile');
    try {
      const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.fixture`;
      const requesterCredentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: requesterAccountId })).toString('base64url')}.fixture`, encryption: null };
      const machineId = placement === 'peer' ? 'peer-worker' : fixture.machineId;
      const base = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings, machineGrants: [],
        connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
          gatewayPlacement: requesterAccountId && placement === 'local'
            ? { kind: 'sessionMachine' } : { kind: 'machine', machineId: fixture.machineId } })),
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
      const emptyCatalog = { status: 'ready' as const, revision: 2,
        catalog: splitProviderSettingsV1(ProviderSettingsV1Schema.parse({ ...settings, connections: [], machineGrants: [] })).catalog };
      setActiveAccountSettingsSnapshot(requesterAccountId ? { ...snapshot, providerConnectionsCatalog: emptyCatalog } : snapshot);
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
      // Session metadata is read through Home before Provider admission. Keep
      // that external boundary real-shaped while the admission owner stays real.
      onTestFinished(installAxiosRequestMethodAdapter());
      const home = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (path === `/v2/sessions/${sessionId}`) {
          expect(options?.headers?.Authorization).toBe(`Bearer ${requesterAccountId ? requesterCredentials.token : token}`);
          return { status: 200, data: {
            session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', dataEncryptionKey: null,
              ...(requesterAccountId ? { ownerAccountId: requesterAccountId } : {}),
              metadata: JSON.stringify(createTestMetadata({ machineId, path: homeDir })), share: null }),
          } };
        }
        if (path === '/v1/account/profile') return { status: 200, data: { id: requesterAccountId } };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path.startsWith('/v4/connect/qualified/')) {
          expect(options?.headers?.Authorization).toBe(`Bearer ${requesterCredentials.token}`);
          const ref = fixture.gateway!.purposeBindings.bindings[0]!.target.account;
          const authentication = { authenticationModeId: 'manual', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null };
          if (path === '/v4/connect/qualified/accounts') return { status: 200, data: {
            service: ref.service, accounts: [{ ref, ...authentication, status: 'connected', configurationReady: true, scopes: [] }],
          } };
          if (path === '/v4/connect/qualified/credential') return { status: 200, data: { ref, ...authentication,
            metadata: { scopes: [] }, content: { t: 'plain', v: { v: 1, values: { token: 'requester-upstream-fixture' } } },
          } };
          if (path === '/v4/connect/qualified/configuration') return { status: 404, data: null };
        }
        if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
          recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        } };
        throw new Error(`Unexpected Gateway Home read: ${path}`);
      });
      onTestFinished(() => home.mockRestore());
      const requesterBootstrap = requesterAccountId ? await (async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        onTestFinished(() => channel.close());
        const prepared = await prepareRequesterSessionBootstrap({ credentials: requesterCredentials,
          attribution: { serverId: configuration.activeServerId, accountId: requesterAccountId, machineId, installationId: 'shared-gateway-installation' },
          machineAdmission: { actorAccountId: requesterAccountId, custodianAccountId: 'account', role: 'use' },
          boundary: { serverId: configuration.activeServerId, serverHttpBaseUrl: configuration.apiServerUrl, happyHomeDir: homeDir },
          homeServerIdentityId: 'home', boundSessionId: sessionId, verifyMachineAdmissionCurrent: async () => true });
        if (!prepared) throw new Error('Expected admitted requester Session');
        onTestFinished(prepared.cleanupOnFailure);
        await channel.settleTransport();
        const context = prepared.admitted.savedSecretOperationContext;
        expect(await context.commitProviderConnectionsCatalog({ expectedSettingsVersion: context.readSnapshot()!.settingsVersion,
          catalog: snapshot.providerConnectionsCatalog })).toBe(true);
        return prepared.admitted;
      })() : null;
      const selection = { agentTargetKey: fixture.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' };
      const authorized = await createRuntimeProviderSpawnAuthorizationAttempt({
        selection: { v: 1, updatedAt: 1, ref: selection }, runtimeModelDescriptor: { id: 'example', name: 'Example' },
        machineId, agentTargetKey: fixture.agentTargetKey, agentId: fixture.agentId,
        readModelProjection: request => hubModels.projectModels(request),
        lease: fixture.lease, getAccountSettingsSnapshot: requesterBootstrap ? requesterBootstrap.savedSecretOperationContext.readSnapshot : () => snapshot,
        ...(requesterBootstrap ? { savedSecretOperationContext: requesterBootstrap.savedSecretOperationContext } : {}),
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
        ...(requesterBootstrap ? { requesterWorkAttributionV1: requesterBootstrap.attribution } : {}),
        spawnOptions: { directory: homeDir,
          backendTarget: { kind: 'backend', backendId: fixture.agentId },
          modelSelection: { v: 1, updatedAt: 1, ref: selection }, providerBindingMetadataV1: metadata },
      };
      const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
      const startControl = (pluginRuntimeController: ReturnType<typeof createPluginReloadController>) =>
        startDaemonSessionControlRuntime({
        machineId, serverId: configuration.activeServerId,
        pluginRuntimeController,
        serverBaseUrl: configuration.apiServerUrl, externalActionAccountId: 'account',
        credentials: { token, encryption: null }, api: {} as never,
        daemonSessionMutationCustody: {
          stageTranscriptMessage: async () => { throw new Error('Unexpected transcript write'); },
          stageTranscriptEvent: async () => ({ persisted: true, delivered: true }),
        },
        connectedServicesMaterializationBaseDir: join(homeDir, 'connected-services'),
        getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
        trackedSessionsByKey, connectedServiceRuntimeRegistry,
        ...(requesterBootstrap ? { resolveRequesterSessionRuntimeContext: async () => requester,
          managedProviderOperationAuthority: fixture.gateway!.operationAuthority } : {}),
        spawnAwaiterByKey: new Map(),
        spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(), getApiMachineForSessions: () => null,
        spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), connectedServicesRestartRequestedSessions: new Set(),
        beforeShutdown: () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {}, processEnv: {},
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: machineHomeId, machineId }),
        ...(placement === 'peer' ? { openAccountConnectionProviderBrokerAccess: async (request, brokerRequester) => {
          brokerRequesterSource = { homeId: brokerRequester?.homeId, accountId: brokerRequester?.bootstrap.attribution.accountId, connectionId: request.connectionId };
          brokerAttempted = true;
          if (failureReason) return await openRefusedAccountConnectionBroker(request, failureReason);
          throw new Error('No broker effect during preparation');
        } } : {}),
      });
      runtime = await startControl(fixture.gateway!.controller);
      if (requesterBootstrap) {
        requester = await createRequesterSessionRuntimeContext({ bootstrap: requesterBootstrap,
          providerAccountUsageStore: createProviderAccountUsageStore(),
          activeServerDir: configuration.activeServerDir, connectedServicesMaterializationBaseDir: join(homeDir, 'connected-services'),
          resolveQualifiedConnectedAccountV4Support: () => 'advertised',
          coordinatorInput: { machineId, machineIdProvider: () => machineId, runtimeId: 'shared-gateway-test',
            happyHomeDir: homeDir, logger, processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
            trackedSessionsByKey, connectedServiceRuntimeRegistry,
            connectedServiceAuthGroupPreTurnSwitchCoordinator: runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator },
        });
        if (!requester) throw new Error('Expected requester runtime');
        tracked.requesterSessionRuntimeContext = requester;
      }
      const initialServices = boundary.controlInput?.agentRuntimeDaemonServices;
      if (!initialServices) throw new Error('Expected production runner service dispatcher');
      let services = initialServices;
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
        if (requesterAccountId) expect(brokerRequesterSource).toEqual({ homeId: 'home', accountId: requesterAccountId, connectionId: 'run-gateway' });
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
      if (requesterBootstrap) {
        const retained = { v: 1 as const, scope: bootstrap.scope, custody: bootstrap.custody,
          providerPluginHardRevocationRevisionAtAdmission: bootstrap.providerPluginHardRevocationRevisionAtAdmission };
        const dispatch = async (operation: AgentRuntimeDaemonServiceRequestV1['operation']) =>
          services.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({ ...request, operation }),
            { sessionId, runner, retainedAgent, invocationContext: tracked.runnerAgentInvocationContext!,
              trackedSession: tracked, isCurrent: async () => true });
        const invoke = async (operation: AgentRuntimeDaemonServiceRequestV1['operation']) => {
          const reply = await dispatch(operation);
          if (!reply.ok) throw new PluginError({ code: reply.error.code, message: reply.error.code });
          if (reply.result.kind !== 'plugin_services.result_v1') throw new Error('Expected runner Provider result');
          return decodeRunnerDaemonPluginServiceWireValueV1(reply.result.value);
        };
        const providerIdentity = basis.deployment.implementationIdentity;
        const replaceDaemon = async () => {
          await runtime?.stopControlServer();
          await replacementController?.shutdown();
          replacementController = createPluginReloadController();
          const lease = await replacementController.acquireRuntimeRegistry({
            resolveRuntimeRegistry: () => fixture.gateway!.createRegistry(new Set([retained.scope.pluginId, retainedAgent.pluginId])),
          });
          try {
            const installed = await lease.registry.acquireManagedProviderRuntime?.(providerIdentity);
            expect(installed?.sourceCustody).toEqual(retained.scope.sourceCustody);
            expect(installed?.activationOccurrenceId).not.toBe(retained.scope.occurrenceId);
            runtime = await startControl(replacementController);
            const replacementServices = boundary.controlInput?.agentRuntimeDaemonServices;
            if (!replacementServices) throw new Error('Expected replacement daemon PluginServices');
            services = replacementServices;
          } finally {
            await lease.release();
          }
        };
        const prepareRetained = (requestId: string) => invoke({
          ...request.operation, kind: 'plugin_services.prepare_v1',
          requestId, invocationId: 'gateway-invocation', managedProviderRetention: retained,
        });
        let refusedAccessCode: string | undefined;
        const consumer = await createRunnerManagedProviderConsumerAccess({
          signal: new AbortController().signal, credentialTransport: basis.runtimeCredentialTransport,
          readAccess: async () => {
            try {
              return RunnerDaemonSharedGatewayHttpBindingV1Schema.parse(await invoke({
                kind: 'plugin_services.managed_provider.read_shared_gateway_access_v1', requestId: 'gateway-read-access',
                invocationId: 'gateway-invocation', retained,
              }));
            } catch (error) {
              if (error instanceof PluginError) refusedAccessCode = error.code;
              throw error;
            }
          },
          materialize: binding => invoke({ ...binding, kind: 'plugin_services.managed_provider.materialize_agent_binding_v1',
            requestId: 'gateway-materialize', invocationId: 'gateway-invocation', retained }),
        });
        try {
          const env = consumer.transformLaunchEnvironment(Object.fromEntries(
            consumer.materialization.env.flatMap(entry => entry.value === null ? [] : [[entry.name, entry.value]])));
          const turn = (input: string) => fetch(`${env.RUN_PROVIDER_URL}/responses`, { method: 'POST',
            headers: { authorization: `Bearer ${env.RUN_PROVIDER_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: selection.modelId, input }) });
          const first = await turn('before daemon replacement');
          expect(first.status).toBe(200);
          expect(await first.text()).toBe('ok');

          await replaceDaemon();
          const restored = await prepareRetained('gateway-replacement-prepare');
          expect(restored).toMatchObject({ managedProvider: { custody: 'daemonShared', scope: retained.scope } });
          await invoke({ kind: 'plugin_services.managed_provider.start_v1',
            requestId: 'gateway-replacement-start', invocationId: 'gateway-invocation', retained });
          const second = await turn('after daemon replacement');
          expect(second.status).toBe(200);
          expect(await second.text()).toBe('ok');

          // The Machine custodian has the same connection and a grant. The
          // retained guest invocation must still use the guest's catalog.
          setActiveAccountSettingsSnapshot(snapshot);
          machineHomeId = 'different-home';
          const wrongHome = await dispatch({
            ...request.operation, requestId: 'gateway-wrong-home', invocationId: 'gateway-wrong-home',
          });
          expect(wrongHome).toMatchObject({ ok: false, error: { cause: { code: 'requester_session_not_current' } } });
          machineHomeId = 'home';

          const context = requesterBootstrap.savedSecretOperationContext;
          expect(await context.commitProviderConnectionsCatalog({ expectedSettingsVersion: context.readSnapshot()!.settingsVersion,
            catalog: { ...emptyCatalog, revision: 3 } })).toBe(true);
          const missing = await dispatch({
            ...request.operation, requestId: 'gateway-missing', invocationId: 'gateway-private-catalog',
          });
          expect(missing).toMatchObject({ ok: false, error: { cause: { code: 'provider_connection_not_found' } } });

          const withoutGrant = splitProviderSettingsV1(ProviderSettingsV1Schema.parse({ ...settings, machineGrants: [] })).catalog;
          expect(await context.commitProviderConnectionsCatalog({ expectedSettingsVersion: context.readSnapshot()!.settingsVersion,
            catalog: { ...emptyCatalog, revision: 4, catalog: withoutGrant } })).toBe(true);
          const disabled = await dispatch({
            ...request.operation, requestId: 'gateway-disabled', invocationId: 'gateway-missing-grant',
          });
          expect(disabled).toMatchObject({ ok: false, error: { cause: { code: 'provider_not_enabled_on_machine' } } });

          await replaceDaemon();
          const revokedPreparation = await prepareRetained('gateway-revoked-replacement-prepare');
          expect(revokedPreparation).not.toHaveProperty('managedProvider');
          const revokedTurn = await turn('after grant revocation and daemon replacement');
          expect(revokedTurn.status).toBe(503);
          expect(await revokedTurn.json()).toMatchObject({ error: { code: 'broker_unavailable' } });
          expect(refusedAccessCode).toBe('plugin_services_managed_provider_authority_unavailable');
        } finally {
          await consumer.cleanup();
        }
      }
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
      await replacementController?.shutdown();
      await requester?.dispose();
      resetActiveAccountSettingsSnapshotForTests();
      boundary.controlInput = null;
      boundary.machineRpc.mockReset();
      await fixture.cleanup();
    }
  });
});
