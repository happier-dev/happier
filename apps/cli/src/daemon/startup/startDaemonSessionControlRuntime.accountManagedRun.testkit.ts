import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import axios from 'axios';
import { ProviderConnectionIdSchema, type AccountEncryptionCurrentnessResponse, type SessionExecutionRunBrokerAuthorityRequestV1, type SessionExecutionRunBrokerAuthorityResponseV1 } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { projectProviderRuntimeBindingBasis } from '@/providers/spawn/runtimeBindingBasis';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createAccountConnectionManagedConsumerSourceOpen } from '@/providers/broker/accountConnectionSource';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { AGENT_RUNTIME_DAEMON_SERVICES_PATH, AgentRuntimeDaemonServiceRequestV1Schema, type AgentRuntimeDaemonServiceRequestV1, type AgentRuntimeDaemonServiceResponseV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createCurrentRunnerManagedProviderRunServices } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { TrackedSession } from '@/daemon/types';
import type { AgentRuntimeDaemonServiceRoutes, startDaemonControlServer } from '@/daemon/controlServer';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { admitRequesterSessionBootstrap, type RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/createRequesterSessionRuntimeContext';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null,
  resolveRunAuthority: null as ((request: SessionExecutionRunBrokerAuthorityRequestV1) => SessionExecutionRunBrokerAuthorityResponseV1) | null,
  refusedCapabilityRoot: '', blockedCapabilityPaths: new Set<string>() }));
// One filesystem boundary for the two exact capability-retirement fault cases.
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rm: async (...args: Parameters<typeof original.rm>) => {
    const path = String(args[0]);
    if (boundary.refusedCapabilityRoot && path.startsWith(boundary.refusedCapabilityRoot)) {
      boundary.blockedCapabilityPaths.add(path);
      throw Object.assign(new Error('Fixture capability cleanup refused'), { code: 'EACCES' });
    }
    return await original.rm(...args);
  } };
});
// Only the private loopback control server and authenticated Home reads are
// substituted. The actual dispatcher, Account source, catalog, custody and OS
// child remain production owners.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43127, stop: async () => {} };
} }));
vi.mock('@/session/transport/http/sessionsHttp', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById: async ({ sessionId }: { sessionId: string }) => createSessionRecordFixture({
    id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine' }), dataEncryptionKey: null, share: null,
  }),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: async (): Promise<AccountEncryptionCurrentnessResponse> => ({
    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
  }),
}));
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: async (input: { request: SessionExecutionRunBrokerAuthorityRequestV1 }) => boundary.resolveRunAuthority?.(input.request) ?? ({
  status: 'current', executionRunId: input.request.executionRunId, occurrenceId: input.request.expectedOccurrenceId,
  parentSessionId: 'parent-session', intent: 'review', runtimeState: 'idle', teamCredentialProviderModel: null,
}) }));
vi.mock('@/ui/logger', () => ({ logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));

/** A genuine installed Agent/Provider and live daemon service dispatcher for
 * consumer delivery tests. No source projection, runtime owner or token is
 * fabricated by this fixture. */
export async function createAttachedManagedRunFixture(input: Readonly<{ directory?: string; issuedRequester?: boolean;
  resolveRunAuthority?(request: SessionExecutionRunBrokerAuthorityRequestV1): SessionExecutionRunBrokerAuthorityResponseV1;
}> = {}) {
  boundary.resolveRunAuthority = input.resolveRunAuthority ?? null;
  const directory = input.directory ?? await mkdtemp(join(tmpdir(), 'happier-attached-managed-run-'));
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  env.patch({ HAPPIER_HOME_DIR: join(directory, 'home') });
  reloadConfiguration();
  const fixture = await createManagedRunLaunchFixture({ directory, controller: pluginReloadController, physicalGateway: true });
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.fixture`;
  const credentials: StoredCredentials = { token, encryption: null };
  const snapshot = { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKey(credentials) };
  setActiveAccountSettingsSnapshot(snapshot);
  let daemon: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>> | null = null;
  let requester: RequesterSessionRuntimeContext | null = null;
  let machineAdmissionCurrent = true;
  let restoreHome: (() => void) | null = null;
  const sourceDiagnostics: { stage: string; error: string | null } = { stage: 'not_opened', error: null };
  let releaseAuthorization: (() => void | Promise<void>) | null = null;
  const cleanup = async () => {
    boundary.refusedCapabilityRoot = '';
    try { await requester?.dispose(); await daemon?.stopControlServer(); await releaseAuthorization?.(); await fixture.cleanup(); }
    finally {
      restoreHome?.();
      resetActiveAccountSettingsSnapshotForTests(); env.restore(); reloadConfiguration(); boundary.control = null; boundary.resolveRunAuthority = null;
      boundary.blockedCapabilityPaths.clear();
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    if (!fixture.gateway) throw new Error('Expected canonical physical source');
    const authorization = await createRuntimeProviderSpawnAuthorizationAttempt({ selection: { v: 1, updatedAt: 1,
      ref: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' } },
      machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, agentId: fixture.agentId, lease: fixture.lease,
      getAccountSettingsSnapshot: () => snapshot, materializationBaseDir: fixture.happyHomeDir,
      scope: { kind: 'execution_run', executionRunId: 'run-private' },
      resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent });
    if (!authorization.ok) throw new Error(authorization.error.code);
    releaseAuthorization = authorization.attempt.cleanupOnFailure;
    const basis = projectProviderRuntimeBindingBasis(authorization.attempt.authorization);
    const models = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
      featureGate: { isEnabled: () => true }, acquireRuntimeLease: async () => {
        const lease = pluginReloadController.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected immutable registry');
        return lease;
      }, resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
      modelSettingsMutation: async (): Promise<never> => { throw new Error('No settings mutation'); } });
    const retainedAgent = fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId)?.sessionRunnerFactoryBinding;
    if (!retainedAgent) throw new Error('Expected genuine retained Agent');
    const tracked: TrackedSession = { pid: process.pid, sessionRunnerPid: process.pid, startedBy: 'daemon', happySessionId: 'parent-session',
      spawnOptions: { directory: fixture.happyHomeDir, backendTarget: { kind: 'backend', backendId: fixture.agentId } },
      runnerAgentInvocationContext: { cwd: fixture.happyHomeDir, environment: {}, providerBindingActive: false },
      runnerAgentBootstrapIdentity: { agentId: fixture.agentId, backendId: fixture.agentId } };
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void | Promise<void>>();
    const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
    daemon = await startDaemonSessionControlRuntime({ machineId: fixture.machineId, serverId: 'home', serverBaseUrl: 'https://home.test',
      externalActionAccountId: 'account', credentials, api: {} as never,
      resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
      ...(input.issuedRequester ? { resolveRequesterSessionRuntimeContext: async (sessionId: string) =>
        requester?.bootstrap.getBoundSessionId() === sessionId ? requester : null } : {}),
      connectedServiceRuntimeRegistry,
      openAccountConnectionManagedConsumerSource: async input => {
        sourceDiagnostics.stage = 'reading_owned_snapshot';
        const owned = await input.readAccountSettingsSnapshot();
        sourceDiagnostics.stage = owned ? 'opening_source' : 'missing_owned_snapshot';
        try {
        const access = await createAccountConnectionManagedConsumerSourceOpen({ homeId: 'home', accountId: 'account', machineId: fixture.machineId,
          expectedAccountSettingsScopeKey: input.expectedAccountSettingsScopeKey, getAccountSettingsSnapshot: () => owned,
          custody: createManagedProviderExplicitStartCustody({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
            controller: pluginReloadController }), withRegistry: async read => {
              const contributes = fixture.lease.registry.contributes;
              if (!contributes.providersByContributionKey) throw new Error('Missing committed Provider projection');
              return await read({ ...contributes, providersByContributionKey: contributes.providersByContributionKey });
            },
          resolveBindingIntent: input.resolveManagedPurposeBindingIntent, admitConsumer: async () => await input.isCurrent(),
          projectModels: request => models.projectModelsForAccount(request, { getAccountSettingsSnapshot: () => owned,
            resolveManagedPurposeBindingIntent: input.resolveManagedPurposeBindingIntent, signal: input.signal, isCurrent: input.isCurrent }),
        })({ ...input.request, signal: input.signal });
        sourceDiagnostics.stage = access ? 'source_opened' : 'source_refused';
        return access;
        } catch (error) { sourceDiagnostics.error = error instanceof Error ? error.message : String(error); throw error; }
      },
      daemonSessionMutationCustody: { stageTranscriptMessage: async (): Promise<never> => { throw new Error('No transcript mutation'); },
        stageTranscriptEvent: async () => ({ persisted: true, delivered: true }) },
      connectedServicesMaterializationBaseDir: join(fixture.happyHomeDir, 'connected-services'),
      getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
      pidToTrackedSession, pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
      getApiMachineForSessions: () => null, spawnResourceCleanupByPid, sessionAttachCleanupByPid: new Map(),
      connectedServicesRestartRequestedPids: new Set(), beforeShutdown: async () => {}, onHappySessionWebhook: async () => {},
      requestShutdown: () => {}, processEnv: {} });
    if (input.issuedRequester) {
      const issuedToken = `e30.${Buffer.from(JSON.stringify({ sub: 'account', jti: 'issued-requester' })).toString('base64url')}.fixture`;
      const home = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
        if (new URL(url).origin !== 'https://home.test') throw new Error('Unexpected requester Home');
        if (config?.headers?.Authorization !== `Bearer ${issuedToken}`) throw new Error('Wrong requester credential');
        const path = new URL(url).pathname;
        if (path.endsWith('/profile')) return { status: 200, data: { id: 'account' } };
        if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v1/artifacts') return { status: 200, data: [] };
        if (path === '/v4/connect/qualified/accounts') return { status: 200, data: {
          service: { pluginId: fixture.gateway!.pluginId, localId: 'accounts' }, accounts: [{
            ref: { service: { pluginId: fixture.gateway!.pluginId, localId: 'accounts' }, accountId: 'upstream-account' },
            status: 'connected', authenticationModeId: 'manual', configurationReady: true, configurationRevision: 'configuration-1',
            revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(32)}`, scopes: [], displayName: 'Fixture account',
          }],
        } };
        return { status: 200, data: { content: { t: 'plain', v: fixture.snapshot.settings }, version: 1 } };
      });
      restoreHome = () => home.mockRestore();
      const admission = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: issuedToken } },
        existingSessionId: 'parent-session', boundary: { serverId: 'home', serverHttpBaseUrl: 'https://home.test', happyHomeDir: fixture.happyHomeDir },
        context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account',
          machineId: fixture.machineId, installationId: 'installation', role: 'use', encryptionMode: 'plain' },
          verifyMachineAdmissionCurrent: async () => machineAdmissionCurrent } });
      if (!admission) throw new Error('Expected actual requester bootstrap admission');
      const catalog = fixture.snapshot.providerConnectionsCatalog;
      if (!catalog || !await admission.admitted.savedSecretOperationContext.commitProviderConnectionsCatalog({
        expectedSettingsVersion: admission.admitted.accountSettingsContext.settingsVersion, catalog,
      })) throw new Error('Expected owned Provider catalog admission');
      requester = await createRequesterSessionRuntimeContext({ bootstrap: admission.admitted,
        activeServerDir: fixture.happyHomeDir, connectedServicesMaterializationBaseDir: join(fixture.happyHomeDir, 'issued-connected-services'),
        resolveQualifiedConnectedAccountV4Support: () => 'advertised', coordinatorInput: {
          machineId: fixture.machineId, machineIdProvider: () => fixture.machineId, runtimeId: 'issued-runtime', happyHomeDir: fixture.happyHomeDir,
          logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
            HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
          pidToTrackedSession, connectedServiceRuntimeRegistry,
          connectedServiceAuthGroupPreTurnSwitchCoordinator: daemon.connectedServiceAuthGroupPreTurnSwitchCoordinator,
        } });
      if (!requester) throw new Error('Expected actual issued requester runtime');
      tracked.requesterSessionRuntimeContext = requester;
      tracked.requesterWorkAttributionV1 = requester.bootstrap.attribution;
    }
    const service = boundary.control?.agentRuntimeDaemonServices;
    if (!service) throw new Error('Expected genuine private service dispatcher');
    const signal = new AbortController().signal;
    const runner = { pid: process.pid, processStartTimeMs: 1, processCommandHash: 'a'.repeat(64), snapshotIdentity: 'fixture-runner' };
    const context: Parameters<AgentRuntimeDaemonServiceRoutes['dispatch']>[1] = { sessionId: 'parent-session', runner, retainedAgent,
      invocationContext: tracked.runnerAgentInvocationContext!, trackedSession: tracked,
      isCurrent: async () => pidToTrackedSession.get(tracked.pid) === tracked, signal };
    const dispatchRequest = async (request: unknown) => await service.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse(request), context);
    const dispatch = async (operation: unknown) => await dispatchRequest({ v: 1,
      context: { token: 'a'.repeat(43), sessionId: 'parent-session' }, operation });
    const proof = { executionRunId: 'run-private', executionRunOccurrenceId: 'run-occurrence', agentId: fixture.agentId, modelId: 'example',
      runtimeBindingBasis: basis, expectedAccountSettingsScopeKey: requester?.readAccountSettingsSnapshot().scopeKey ?? snapshot.scopeKey };
    return { directory, fixture, attempt: authorization.attempt, authorization: authorization.attempt.authorization, credentials, snapshot, proof,
      dispatch, dispatchRequest, context, tracked, spawnResourceCleanupByPid,
      capabilityCleanupFilesystem: {
        refuse: () => { boundary.refusedCapabilityRoot = join(directory, 'request-auth'); },
        restore: () => { boundary.refusedCapabilityRoot = ''; },
        readBlockedPaths: () => [...boundary.blockedCapabilityPaths],
      },
      requester, sourceDiagnostics, withdrawRequesterAdmission: () => { machineAdmissionCurrent = false; }, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

/** The real private authority client above the fixture's captured control HTTP
 * boundary. Fault hooks substitute transport responses, never source cleanup. */
export async function createAttachedManagedRunControlTransport(
  fixture: Awaited<ReturnType<typeof createAttachedManagedRunFixture>>,
  input: Readonly<{
    beforeDispatch?(request: AgentRuntimeDaemonServiceRequestV1): Response | null | Promise<Response | null>;
    afterDispatch?(request: AgentRuntimeDaemonServiceRequestV1, response: AgentRuntimeDaemonServiceResponseV1): void | Promise<void>;
  }> = {},
) {
  const authority = {
    happyHomeDir: fixture.fixture.happyHomeDir, publicReleaseRing: 'stable' as const,
    path: await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: fixture.fixture.happyHomeDir, publicReleaseRing: 'stable' }),
    sessionId: 'parent-session', runner: { ...fixture.context.runner, snapshotIdentity: 'fixture-runner' },
    retainedAgent: fixture.context.retainedAgent,
  };
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 43127, capability: 'a'.repeat(43) });
  const originalFetch = globalThis.fetch;
  type Binding = Extract<Extract<AgentRuntimeDaemonServiceResponseV1, { ok: true }>['result'], { kind: 'provider_managed.binding' }>;
  let binding: Binding | null = null;
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = new URL(url instanceof Request ? url.url : String(url));
    if (target.port !== '43127' || target.pathname !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) return await originalFetch(url, init);
    if (new Headers(init?.headers).get('x-happier-daemon-token') !== 'a'.repeat(43)) return new Response('', { status: 401 });
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    const refused = await input.beforeDispatch?.(request);
    if (refused) return refused;
    const response = await fixture.dispatchRequest(request);
    if (response.ok && response.result.kind === 'provider_managed.binding') binding = response.result;
    await input.afterDispatch?.(request, response);
    return Response.json(response);
  });
  return { services: createCurrentRunnerManagedProviderRunServices(authority),
    readBinding() {
      if (!binding) throw new Error('Expected real daemon binding response');
      return binding;
    },
    async cleanup() {
      if (binding) await fixture.dispatch({ kind: 'provider_managed.binding.close', requestId: 'finally-close', bindingId: binding.bindingId });
      vi.unstubAllGlobals();
    },
  };
}
