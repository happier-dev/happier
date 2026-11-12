import { expect, it } from 'vitest';
import type { ProviderBrokerRouteGrantPayloadV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';
import { resolveTeamCredentialBrokerRequestPolicy } from '@/providers/broker/requestPolicySnapshot';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { CHECKLIST_IDS } from '@/capabilities/checklistIds';
import { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import { createCapabilitiesService } from '@/capabilities/service';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { ApiMachineClient } from '@/api/apiMachine';
import { createApiMachineTransportFixture } from '@/testkit/apiMachineTransport';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt } from './bootstrapMachineSyncRuntime';

it('reads custodian Muse models for a Team member without impersonating requester automation', async () => {
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, coldStart: true,
    plugins: [{ manifest: { schemaVersion: 2, id: 'acme.team-muse-test', version: '1.0.0', displayName: 'Team catalog fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' }, contributes: {} },
      files: { 'daemon.mjs': 'export function activate() {}' } }],
    resolveContributes: happyHomeDir => resolveMergedContributionRegistry({ happyHomeDir }),
  });
  const machineId = 'custodian-machine';
  const target = { kind: 'account' as const, account: {
    service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, accountId: 'custodian-muse',
  } };
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected credential mutation'); };
  const purposes = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
    selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
    assertTargetAccountMaterializable: unexpected,
    resolveTarget: async requested => requested.kind === 'account' ? { account: requested.account, displayName: 'Muse' } : null,
  });
  const rpc = new RpcHandlerManager({ scopePrefix: machineId, scopeKind: 'machine', localMachineId: machineId,
    encryptionMode: 'plain', logger: () => {} });
  let nativeReads = 0;
  let nativeAvailable = true;
  // Native Agent invocation and Machine transport are IO boundaries. Bootstrap,
  // RPC admission, published Muse declarations, purpose binding and projection stay real.
  const hostCapabilities = createCapabilitiesService({ capabilities: [{ descriptor: { id: 'cli.muse', kind: 'cli',
      methods: { probeModels: {} } }, effects: { detect: [], invoke: { probeModels: ['private_read'] } },
    detect: async () => ({}), invoke: async request => {
    nativeReads++;
    expect(request).toMatchObject({ method: 'probeModels', params: { connectedServices: {
      v: 2, bindingsByServiceId: { 'happier.agent.muse/muse-account': { source: 'connected', profileId: 'custodian-muse' } },
    } } });
    return nativeAvailable ? { ok: true, result: { agentId: 'muse', source: 'dynamic', supportsFreeform: false,
      availableModels: [{ id: 'muse-spark-1.3-contributor', name: 'Muse Spark' }] } }
      : { ok: false, error: { code: 'native_unavailable', message: 'Unavailable' } };
  } }], checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] }, buildContext: async () => ({ cliSnapshot: null }) });
  const registeredHostCapabilities = registerCapabilitiesHandlers(rpc);
  const apiMachine = { ...createApiMachineTransportFixture(),
    setRPCHandlers: () => ({ hostCapabilities }), registerLiveStreamRelayRoutes: () => {}, connect: () => {},
    updateDaemonState: async () => {}, updateMachineMetadata: async () => {}, emitExternalSessionTranscriptUpdate: () => {},
    sendMachineTransferEnvelope: () => {}, sendTransferRelayV2Envelope: () => {}, sendMachineLiveStreamRelayEnvelope: () => {},
    getPeerMediationMachineRpcHandlerManager: () => rpc,
  } as unknown as ApiMachineClient;
  let runtime: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
  try {
    runtime = await bootstrapMachineSyncRuntime({ cliVersion: 'test', machineId,
      machine: { id: machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
      preferredHost: 'host.local', happyHomeDir: fixture.happyHomeDir, happyLibDir: fixture.happyHomeDir,
      filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false, isShuttingDown: () => false,
      createConnectedApiMachine: () => apiMachine, attachTransferRuntimeStatePublisher: async () => {},
      startAutomationWorkerForMachine: () => null, startMemoryWorkerForMachine: async () => null,
      spawnSessionForInternalResume: async () => ({ type: 'success', sessionId: 'member-session' }),
      spawnSession: async () => ({ type: 'success', sessionId: 'member-session' }), stopSession: async () => ({ status: 'stopped' }),
      isSessionAlreadyRunning: async () => false, loadLocalSessionMetadataForHandoff: async () => null,
      beforeShutdown: async () => {}, requestShutdown: () => {}, directPeerServerLifecycle: null,
      directTransferRegistryHost: createCliRegistryHostV1(), connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null,
      daemonServerWorkScheduler: {} as never, startVoiceInferenceWorkerForMachine: async () => null,
      getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: { providers: { enabled: true } } }) }),
      resolveManagedPurposeBindingIntentSelection: purposes.resolveBindingIntentSelection,
    });
    const services = runtime.providerOperationsProducer?.machineServices;
    if (!services) throw new Error('Expected Provider runtime services');
    const request = { machineId, source: { v: 1 as const, kind: 'connected_account' as const, target, credentialIncarnation: 'dummy-incarnation' },
      refreshPolicy: 'current_only' as const };
    const result = await services.readSourceModelCatalogs(request);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('Expected current source');
    expect(result.catalogs).toHaveLength(3);
    expect(result.catalogs.every(catalog => catalog.rows.length === 1
      && catalog.rows[0]?.descriptor.id === 'muse-spark-1.3-contributor' && catalog.rows[0]?.confidence === 'probe')).toBe(true);
    expect(nativeReads).toBe(1);
    const catalog = result.catalogs[0]!;
    const authority: ProviderBrokerRouteGrantPayloadV1 = {
      v: 1, grantId: 'home-admitted-member', aud: 'happier-provider-broker-route-v1', issuedAt: 100, expiresAt: 200,
      teamId: 'team', resourceId: 'shared-muse', sourceRevision: catalog.sourceRevision, brokerPlacementFingerprint: 'c'.repeat(64), initiatorTokenEpoch: 0,
      initiator: { accountId: 'member-b', machineId: 'member-own-machine', endpointId: 'a'.repeat(64) },
      target: { custodianAccountId: 'owner-a', machineId, endpointId: 'b'.repeat(64) },
      consumer: { kind: 'session', sessionId: 'member-pi-session' },
      application: { ...catalog.application, agentTargetKey: 'agent:happier.agent.pi/pi' },
    };
    const resource: TeamCredentialResourceSummaryV1 = {
      id: 'shared-muse', teamId: 'team', custodianAccountId: 'owner-a', sourceOwnerDisplayName: null,
      displayName: 'Shared Muse', enabled: true, revision: 0, deliveryPolicy: { preferredAllowedModes: ['brokered'] },
      sessionUsePolicy: 'personal_allowed', source: request.source,
      sourcePresentation: { kind: 'connected_service', service: target.account.service }, directExportSupport: 'unsupported',
      activeUsageLimitCount: 0, requestPolicy: null, brokerPlacement: { kind: 'machine', machineId },
      allMembersAllowedRoutes: ['brokered'], groupGrants: [], memberGrants: [], readiness: { kind: 'available' }, recoveryAction: null,
      brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
      capabilities: { manageAudience: false, managePolicy: false, manageLimits: false, updateBrokerPlacement: false, updateDeliveryPolicy: false,
        narrowDisclosure: false, widenDisclosure: false, refreshDirectMaterial: false, disable: false, enable: false, delete: false },
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    // Home resource storage is a boundary; the member's exact Pi application is
    // resolved by the real broker policy, source catalog and native RPC owners.
    const policy = await resolveTeamCredentialBrokerRequestPolicy({ machineId, authority, signal: new AbortController().signal,
      readResource: async () => resource, readSourceModelCatalogs: services.readSourceModelCatalogs });
    expect(policy?.modelCatalog.models).toEqual([{ id: 'muse-spark-1.3-contributor', name: 'Muse Spark' }]);
    expect(nativeReads).toBe(2);
    // The installed capability registration exposes the same host-owned
    // service. A malformed native selection reaches its real decoder rather
    // than being mistaken for requester execution before decoding.
    await expect(registeredHostCapabilities.invoke({ id: 'cli.muse', method: 'probeModels',
      params: { connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.muse/muse-account': { source: 'connected' } } } },
    })).resolves.toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
    // Recipient authority cannot turn a source selector into access to the custodian's private catalog.
    await expect(services.projectModels({ machineId, agentTargetKey: 'agent:happier.agent.pi/pi', sourceCatalog: true,
      connectedAccountTarget: target }, undefined, { signal: new AbortController().signal,
      machineAdmission: { actorAccountId: 'member-b', custodianAccountId: 'owner-a', machineId, installationId: 'install', role: 'use', encryptionMode: 'plain' },
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
    await expect(rpc.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, {}, { verifiedPeerAuthority: 'account_automation' }))
      .resolves.toMatchObject({ errorCode: 'agent_isolation_unavailable', effectAttempted: false });
    expect(nativeReads).toBe(2);
    nativeAvailable = false;
    await expect(services.readSourceModelCatalogs(request)).resolves.toMatchObject({ status: 'success', catalogs: [] });
    nativeAvailable = true;
    await expect(services.readSourceModelCatalogs(request)).resolves.toMatchObject({ status: 'success', catalogs: result.catalogs });
    expect(nativeReads).toBe(4);
  } finally {
    if (runtime) await retireMachineSyncRuntimeAttempt(runtime);
    await fixture.dispose();
  }
});
