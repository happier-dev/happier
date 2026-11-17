import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { ProviderConnectionIdSchema, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';

import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createMachineSharedProviderGatewayResolver } from '@/daemon/machine/bootstrapMachineSyncRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { prepareDaemonProviderLaunch } from '@/daemon/spawn/prepareDaemonProviderLaunch';
import { prepareDaemonSpawnChildEnvironment } from '@/daemon/spawn/prepareDaemonSpawnChildEnvironment';
import { createSpawnPluginRuntimeLease } from '@/daemon/spawn/spawnPluginRuntimeLease';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createDeferred } from '@/testkit/async/deferred';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { createNativeAgentRuntimeSessionPlanFixture, createNativeSessionClientTestPort,
  createSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { projectEngineRuntimeContributionFromAgent } from '@/agent/runtime/registry/engineRegistry/contributions';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { runHostSessionRuntime } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createAccountConnectionManagedConsumerSourceOpen, retireAccountConnectionBrokerSource } from '@/providers/broker/accountConnectionSource';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { startManagedProviderConsumerApplication } from '@/providers/broker/managedProviderConsumerApplication';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import { createProviderBrokerRouteGrantSigningInputV2, type ProviderBrokerAccountOpenResponseV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import tweetnacl from 'tweetnacl';
import { createDaemonMachineIrohRuntime } from '@/daemon/peer/iroh/daemonMachineIrohRuntime';
import { createProviderBrokerMachineCarrierTunnelOpen } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import { startPeerMediationLoopbackServer } from '@/daemon/peer/mediation/loopback/server';
import { openAccountConnectionProviderBrokerAccess, readAccountConnectionProviderBrokerFailureDiagnostic } from '@/providers/broker/accountConnectionClient';
import { startDaemonProviderBrokerRuntime } from '@/providers/broker/daemonProviderBrokerRuntime';
import { createTeamCredentialBrokerSourceOwner } from '@/providers/broker/teamCredentialBrokerSourceOwner';

import { createRuntimeProviderServices } from './runtimeServices';

it('admits signed-out Agent Sessions through the probed local gateway and chosen hub', async () => {
  let phase = 'fixture setup';
  const startedAt = performance.now();
  const phases: Array<Readonly<{ phase: string; elapsedMs: number }>> = [];
  const markPhase = (next: string) => {
    phase = next;
    phases.push({ phase, elapsedMs: Math.round(performance.now() - startedAt) });
  };
  onTestFailed(() => { console.error('Shared gateway composition failed during', phase,
    'after', Math.round(performance.now() - startedAt), 'ms'); });
  onTestFinished(() => { console.info('Shared gateway composition phases', JSON.stringify(phases)); });
  await withConfiguredDaemonTestHome({ prefix: 'shared-gateway-spawn-' }, async ({ homeDir }) => {
    let pauseTarget = false;
    let enterTarget = () => {};
    let releaseTarget = () => {};
    const entered = new Promise<void>(resolve => { enterTarget = resolve; });
    const released = new Promise<void>(resolve => { releaseTarget = resolve; });
    let targetSignal: AbortSignal | undefined;
    let carrierAdmissionPending = false;
    let sourceReadDuringCarrierAdmission = false;
    let pauseNextPeerSourceRead = false;
    const peerSourceEntered = createDeferred();
    const peerSourceReleased = createDeferred();
    let peerSourceSignal: AbortSignal | undefined;
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'),
      happyHomeDir: homeDir,
      controller: pluginReloadController, physicalGateway: true, probeCatalog: true,
      signedOutAgentCli: true,
      // Only the Home target transport stalls; purpose admission remains real.
      resolveAccountTarget: async (target, signal) => {
        sourceReadDuringCarrierAdmission ||= carrierAdmissionPending;
        if (pauseNextPeerSourceRead) {
          pauseNextPeerSourceRead = false;
          peerSourceSignal = signal;
          peerSourceEntered.resolve();
          await peerSourceReleased.promise;
        }
        if (pauseTarget) { targetSignal = signal; enterTarget(); await released; }
        signal.throwIfAborted();
        return target.kind === 'account' ? { account: target.account, displayName: 'Upstream' } : null;
      },
      catalogModels: [{ id: 'example', connectedAccountPurposes: [{
        consumer: { pluginId: 'acme.shared-registry', localId: 'gateway' }, purpose: 'upstream',
      }] }],
    });
    const launchResourceScope = createProviderLaunchResourceScope();
    const redaction = createProviderRedactionLease({ values: [] });
    try {
      writeExecutableShimSync({ dir: homeDir, fileName: process.platform === 'win32' ? 'managed-run-agent.cmd' : 'managed-run-agent',
        contents: process.platform === 'win32' ? '@echo off\r\necho 1.0.0\r\n' : '#!/bin/sh\necho 1.0.0\n' });
      const options = { directory: homeDir, machineId: fixture.machineId,
        backendTarget: { kind: 'backend' as const, backendId: fixture.agentId, sourceKind: 'built_in' as const } };
      const environmentInput = {
        options, resolvedAgentId: fixture.agentId, terminal: undefined, profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        pluginRuntimeRegistry: fixture.lease.registry,
        processEnv: { NODE_ENV: 'test', PATH: homeDir, HOME: homeDir, USERPROFILE: homeDir, HAPPIER_HOME_DIR: homeDir },
        connectedServiceAuth: null, connectedServiceMaterializationIdentity: null,
        providerDiagnosticRedactionLease: redaction, launchResourceScope,
      };
      const native = await prepareDaemonSpawnChildEnvironment({ ...environmentInput, effectiveModelSelection: undefined,
        providerBindingAttempt: null, providerAgentTargetKey: null });
      expect(native, JSON.stringify(native)).toMatchObject({ ok: false,
        result: { errorCode: 'agent_signed_out', agentId: fixture.agentId } });
      const hubMachineId = fixture.machineId;
      const peerMachineId = 'peer-worker';
      const base = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings, machineGrants: [],
        connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
          gatewayPlacement: { kind: 'machine', machineId: hubMachineId } })),
      });
      const connection = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: hubMachineId,
        providerSettings: base, registry: fixture.contributes, dnsEvidenceByEndpointUrl: new Map() });
      if (connection.status !== 'resolved') throw new Error('Expected exact hub connection');
      const settings = ProviderSettingsV1Schema.parse({ ...base, machineGrants: [peerMachineId, hubMachineId].map(machineId => ({
        v: 1, connectionId: 'run-gateway', machineId, confirmedAt: 1,
        connectionSecurityFingerprint: connection.record.connectionSecurityFingerprint,
        endpointSetFingerprint: connection.record.endpointSetFingerprint,
      })) });
      const snapshot = { ...fixture.snapshot, providerConnectionsCatalog: {
        status: 'ready' as const, revision: 2, catalog: splitProviderSettingsV1(settings).catalog,
      } };
      const services = createRuntimeProviderServices({ machineId: hubMachineId, happyHomeDir: fixture.happyHomeDir,
        featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => snapshot,
        resolveSharedGateway: createMachineSharedProviderGatewayResolver({ machineId: hubMachineId,
          readAccountId: () => 'account', readOrigin: async () => ({ serverIdentityId: 'home', machineId: hubMachineId }) }),
        resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
      });
      markPhase('catalog probe');
      const probed = await services.probe({ connectionId: 'run-gateway', machineId: hubMachineId });
      expect(probed, JSON.stringify(probed)).toMatchObject({ status: 'success', models: [{ id: 'example',
        connectedAccountPurposes: [{ consumer: fixture.gateway!.identity, purpose: 'upstream' }],
      }] });
      if (probed.status !== 'success') throw new Error('Expected gateway catalog');
      const modelSelection = { v: 1 as const, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey,
          providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: probed.models[0]!.id } };
      const hubModels = createRuntimeProviderModelManagementServices({ machineId: hubMachineId,
        happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
        getAccountSettingsSnapshot: () => snapshot,
        acquireRuntimeLease: () => acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: homeDir }),
        resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
        modelSettingsMutation: async (): Promise<never> => { throw new Error('No model mutations in launch admission'); },
      });
      for (const sessionMachineId of [hubMachineId, peerMachineId]) {
        markPhase(`launch admission ${sessionMachineId}`);
        const admitted = await prepareDaemonProviderLaunch({
          options: { ...options, machineId: sessionMachineId }, effectiveBackendTarget: options.backendTarget, catalogAgentId: fixture.agentId, modelSelection,
          profileEnvironmentVariables: {}, daemonSpawnHooks: null, persistedProviderBinding: null, normalizedExistingSessionId: '',
          pluginRuntimeLease: createSpawnPluginRuntimeLease(launchResourceScope), launchResourceScope,
          resolveProvidersFeatureEnabled: () => true, processEnv: environmentInput.processEnv,
          accountSettingsSnapshot: snapshot, providerRuntimeHomeDir: fixture.happyHomeDir,
          // The hub's RPC transport is the boundary; its real Account/catalog,
          // compatibility and strict response producer remain in the composition.
          readModelProjection: async request => {
            expect(request.machineId).toBe(hubMachineId);
            return await hubModels.projectModels(request);
          },
          resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
        });
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true });
        if (!admitted.ok) throw new Error('Expected Provider admission');
        const child = await prepareDaemonSpawnChildEnvironment({ ...environmentInput, options: admitted.options,
          effectiveModelSelection: modelSelection, providerBindingAttempt: admitted.attempt,
          providerAgentTargetKey: admitted.agentTargetKey });
        expect(child, JSON.stringify(child)).toMatchObject({ ok: true });
        if (child.ok && sessionMachineId === hubMachineId) {
          const agent = fixture.contributes.agentDefinitionsById.get(fixture.agentId);
          const registration = fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId);
          const attempt = admitted.attempt;
          if (!agent || !registration?.hasPrimaryRuntime || !attempt || !('materializeManagedEndpoint' in attempt)) {
            throw new Error('Expected the real managed Agent startup owners');
          }
          const sessionId = 'gateway-child-session';
          const peerSessionId = 'gateway-peer-session';
          const metadata = attempt.authorization.sessionBindingMetadata;
          const basis = metadata.runtimeBindingBasis;
          if (!basis || basis.deployment.kind !== 'managedLocal') throw new Error('Expected admitted managed basis');
          const deployment = basis.deployment;
          const signal = new AbortController().signal;
          const openSource = createAccountConnectionManagedConsumerSourceOpen({
            homeId: 'home', accountId: 'account', machineId: hubMachineId,
            expectedAccountSettingsScopeKey: snapshot.scopeKey!, getAccountSettingsSnapshot: () => snapshot,
            custody: createManagedProviderExplicitStartCustody({ machineId: hubMachineId,
              happyHomeDir: homeDir, controller: pluginReloadController }),
            withRegistry: async read => read(fixture.contributes),
            resolveBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
            // Authenticated Session currentness is the Home transport boundary.
            admitConsumer: async request => request.consumer.kind === 'session'
              && ((request.consumer.sessionId === sessionId && request.consumerMachineId === hubMachineId)
                || (request.consumer.sessionId === peerSessionId && request.consumerMachineId === peerMachineId)),
            projectModels: request => hubModels.projectModelsForAccount(request, { getAccountSettingsSnapshot: () => snapshot,
              resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
              signal, isCurrent: () => true }),
          });
          const consumerScope = createProviderLaunchResourceScope();
          const consumerLogs = vi.spyOn(logger, 'infoFile');
          try {
            markPhase('native session plan');
            const plan = await createNativeAgentRuntimeSessionPlanFixture({
              identity: registration, createRuntime: input => registration.createRuntime(input),
              backend: projectEngineRuntimeContributionFromAgent(agent, fixture.agentId), agent,
              authorizeNewTurn: async () => ({ status: 'admitted' }),
              createSessionHostServiceOwners,
              sessionInput: buildPluginSessionBindingInput({ credentials: { token: 'fixture-account', encryption: null },
                directory: homeDir, startedBy: 'daemon', backendTarget: options.backendTarget, modelSelection,
                environmentVariables: child.extraEnvForChild }),
              prepareManagedProviderBinding: async () => {
                const application = { agentTargetKey: basis.agentTargetKey, implementationIdentity: deployment.implementationIdentity,
                  endpointTemplateId: basis.endpoint.endpointTemplateId, protocol: basis.endpoint.protocol };
                const source = { kind: 'account_connection' as const, connectionId: basis.connectionId,
                  expectedConnectionSecurityFingerprint: basis.credentialAuthorization.connectionSecurityFingerprint,
                  expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({
                    implementationIdentity: deployment.implementationIdentity, managedRuntime: deployment.managedRuntime,
                    purposeBindings: deployment.purposeBindings }) };
                const openConsumer = async (id: string, consumerMachineId: string) => {
                  const opened = await openSource({ source, application,
                    consumer: { kind: 'session', sessionId: id }, consumerMachineId, signal });
                  if (!opened) throw new Error('Expected admitted Session gateway consumer');
                  consumerScope.register(async () => { await opened.retire(); await opened.cleanup(); });
                  const endpointUrl = opened.access.endpointUrl(application.endpointTemplateId);
                  if (!endpointUrl) throw new Error('Expected Session gateway endpoint');
                  const consumer = await startManagedProviderConsumerApplication({ signal, endpointUrl,
                    credentialTransport: basis.runtimeCredentialTransport,
                    request: async request => await opened.revalidate(request.signal)
                      ? { ok: true, response: await opened.access.request(request) } : { ok: false, reasonCode: 'resource_forbidden' } });
                  consumerScope.register(consumer.cleanup);
                  return { ...consumer, retire: () => opened.retire() };
                };
                markPhase('local consumer');
                const consumer = await openConsumer(sessionId, hubMachineId);
                const processFile = join(fixture.gateway!.directory, 'gateway-started');
                const localPid = await readFile(processFile, 'utf8');
                expect(Number(localPid)).toBeGreaterThan(0);
                // Exercise the actual peer carrier and hub application, not a
                // second local consumer that bypasses broker endpoint discovery.
                markPhase('native peer endpoints');
                const worker = await createDaemonMachineIrohRuntime({ happyHomeDir: homeDir, identity: 'ephemeral',
                  relayConfig: { relayPolicy: 'disabled', relayUrls: [] } });
                const hub = await createDaemonMachineIrohRuntime({ happyHomeDir: homeDir, identity: 'ephemeral',
                  relayConfig: { relayPolicy: 'disabled', relayUrls: [] } });
                consumerScope.register(worker.shutdown);
                consumerScope.register(hub.shutdown);
                if (!worker.available || !hub.available) throw new Error(`Expected native peer endpoints: worker=${worker.available ? 'ready' : worker.reason}, hub=${hub.available ? 'ready' : hub.reason}`);
                const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
                const trustRoots = [{ keyId: 'home', publicKey: Buffer.from(key.publicKey).toString('base64url') }];
                const custody = createManagedProviderExplicitStartCustody({ machineId: hubMachineId,
                  happyHomeDir: homeDir, controller: pluginReloadController });
                const broker = await startDaemonProviderBrokerRuntime({ machineId: hubMachineId,
                  resolveTrustRoots: () => trustRoots, nowMs: Date.now, createRequestId: () => 'peer-request',
                  accountConnection: { homeId: 'home', accountId: 'account',
                    open: async ({ authority, signal }) => await openSource({ source: authority.payload.source,
                      application: authority.payload.application, consumer: authority.payload.consumer,
                      consumerMachineId: authority.payload.initiator.machineId, signal }),
                    retire: async ({ authority }) => await retireAccountConnectionBrokerSource({
                      homeId: 'home', accountId: 'account', machineId: hubMachineId, custody, authority }),
                  },
                  sourceOwner: createTeamCredentialBrokerSourceOwner({ machineId: hubMachineId, custody,
                    selectConnectedServicesSourceMember: async () => null, openConnectedServicesSource: async () => null,
                    openProviderConnectionSource: async () => null }),
                  resolveRequestPolicy: async () => { throw new Error('Unexpected Team request'); },
                  admitRequest: async () => { throw new Error('Unexpected Team admission'); },
                  authorizeModelCatalog: async () => { throw new Error('Unexpected Team catalog'); },
                });
                consumerScope.register(broker.close);
                let forwarding = true;
                let refreshAllowed = true;
                const admission = await startPeerMediationLoopbackServer({ nowMs: Date.now,
                  expected: { accountId: 'account', machineId: hubMachineId, flowKind: 'machine_rpc',
                    routeKind: 'loopback_direct', endpointFingerprint: hub.endpoint.endpointId },
                  trustRoots, endpointExpiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel,
                  irohMachineAdmission: { localEndpointId: hub.endpoint.endpointId, role: 'acceptor', allowedFlows: [],
                    resolveApplicationTarget: async () => null,
                    resolveProviderBrokerApplicationTarget: async request => {
                      carrierAdmissionPending = true;
                      try { return forwarding ? await broker.resolveProviderBrokerApplicationTarget(request) : null; }
                      finally { carrierAdmissionPending = false; }
                    } },
                });
                consumerScope.register(admission.stop);
                await hub.startAttemptAcceptor({ admissionPort: Number(new URL(admission.url).port) });
                const openPeer = () => openAccountConnectionProviderBrokerAccess({ homeId: 'home', accountId: 'account',
                  initiatorMachineId: peerMachineId, targetMachineId: hubMachineId, connectionId: basis.connectionId,
                  expectedConnectionSecurityFingerprint: source.expectedConnectionSecurityFingerprint,
                  expectedManagedRuntimeBindingFingerprint: source.expectedManagedRuntimeBindingFingerprint,
                  consumer: { kind: 'session', sessionId: peerSessionId }, application, signal,
                  // Home signing/admission are the network boundary. Exact
                  // route verification, native carrier and hub custody stay real.
                  openBroker: async request => {
                    if (request.refreshAuthority && !refreshAllowed) return { ok: false, reasonCode: 'broker_unavailable' };
                    const issuedAt = Date.now();
                    const payload = { v: 2 as const, grantId: 'peer-grant', aud: 'happier-provider-broker-route-v2' as const,
                      issuedAt, expiresAt: issuedAt + DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel,
                      homeId: 'home', accountId: 'account', initiatorTokenEpoch: 0, source: request.source,
                      initiator: { accountId: 'account', machineId: peerMachineId, endpointId: worker.endpoint.endpointId },
                      target: { custodianAccountId: 'account', machineId: hubMachineId, endpointId: hub.endpoint.endpointId },
                      consumer: request.consumer, application: request.application };
                    return { ok: true, authority: { payload, signature: { alg: 'Ed25519', keyId: 'home',
                      valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(
                        createProviderBrokerRouteGrantSigningInputV2(payload)), key.secretKey)).toString('base64url') } },
                      target: { custodianAccountId: 'account', brokerMachineId: hubMachineId,
                        endpointId: hub.endpoint.endpointId, endpointRevision: 1, endpoint: hub.endpoint },
                    } satisfies ProviderBrokerAccountOpenResponseV2;
                  },
                  openTunnel: createProviderBrokerMachineCarrierTunnelOpen({ homeId: 'home', accountId: 'account',
                    localMachineId: peerMachineId, runtime: worker, resolveTrustRoots: () => trustRoots }),
                });
                const brokerWarnings = vi.spyOn(logger, 'warnLocalFile');
                try {
                  refreshAllowed = false;
                  markPhase('peer refresh refusal');
                  const refreshRefusal = await openPeer().then(() => { throw new Error('Expected refresh refusal'); }, (error: unknown) => error);
                  expect(readAccountConnectionProviderBrokerFailureDiagnostic(refreshRefusal)).toMatchObject({
                    reason: 'endpoint_discovery_failed', discoveryCause: 'broker_refresh_refused',
                  });
                  expect(brokerWarnings.mock.calls.filter(([label]) => label === '[ProviderBroker] Machine stream admission refused')).toEqual([]);
                  refreshAllowed = true;
                  forwarding = false;
                  markPhase('peer target refusal');
                  const refusal = await openPeer().then(() => { throw new Error('Expected peer refusal'); }, (error: unknown) => error);
                  expect(readAccountConnectionProviderBrokerFailureDiagnostic(refusal)).toMatchObject({
                    reason: 'endpoint_discovery_failed', discoveryCause: 'socket_closed',
                  });
                  expect(brokerWarnings.mock.calls).toContainEqual([
                    '[ProviderBroker] Machine stream admission refused', { reason: 'target_unavailable' },
                  ]);
                } finally {
                  brokerWarnings.mockRestore();
                  forwarding = true;
                  refreshAllowed = true;
                }
                pauseNextPeerSourceRead = true;
                markPhase('deferred peer Home source read');
                let peerOpenSettled = false;
                const pendingRemote = openPeer().then(remote => {
                  consumerScope.register(remote.cleanup);
                  return remote;
                }).finally(() => { peerOpenSettled = true; });
                try {
                  await Promise.race([peerSourceEntered.promise, pendingRemote]);
                  // Home source work starts after carrier admission and keeps
                  // endpoint discovery pending until the boundary is released.
                  // Rust's machine_http_tunnel_keeps_http_source_reads_alive_beyond_control_window
                  // separately proves the real HTTP-source/native-window contract.
                  expect(sourceReadDuringCarrierAdmission).toBe(false);
                  expect(peerOpenSettled).toBe(false);
                  expect(peerSourceSignal?.aborted).toBe(false);
                } finally {
                  peerSourceReleased.resolve();
                  await pendingRemote;
                }
                const remote = await pendingRemote;
                expect(sourceReadDuringCarrierAdmission).toBe(false);
                const remoteBinding = await remote.readHttpBinding();
                expect(new URL(remoteBinding.endpointUrl).port).not.toBe(new URL(consumer.endpointUrl).port);
                const peerApplication = await startManagedProviderConsumerApplication({ signal, endpointUrl: remoteBinding.endpointUrl,
                  credentialTransport: basis.runtimeCredentialTransport,
                  request: async request => ({ ok: true, response: await remote.access.request(request) }) });
                const peer = { ...peerApplication, retire: remote.cleanup };
                consumerScope.register(peer.cleanup);
                expect(await readFile(processFile, 'utf8')).toBe(localPid);
                expect(peer.credential).not.toBe(consumer.credential);
                for (const id of [sessionId, peerSessionId]) {
                  expect(consumerLogs.mock.calls).toContainEqual(['[managed-provider-consumer-claim]', {
                    action: 'claim', connectionId: basis.connectionId, machineId: hubMachineId,
                    instanceId: expect.any(String), consumerId: JSON.stringify({ kind: 'session', sessionId: id }),
                  }]);
                }
                const readModels = async (endpoint: Pick<typeof consumer, 'endpointUrl' | 'credential'>, credential = endpoint.credential) => {
                  const response = await fetch(`${endpoint.endpointUrl}/models`, {
                    headers: { authorization: `Bearer ${credential}` },
                  });
                  return { status: response.status, body: await response.text() };
                };
                markPhase('consumer isolation');
                const localModels = await readModels(consumer);
                expect(localModels.status, localModels.body).toBe(200);
                expect(JSON.parse(localModels.body)).toMatchObject({ data: [{ id: 'example' }] });
                expect(await readModels(peer)).toEqual(localModels);
                expect((await readModels(peer, consumer.credential)).status).toBe(403);
                expect((await readModels(consumer, peer.credential)).status).toBe(403);
                // Retiring the peer cannot revoke the local Session or stop its
                // physical gateway while that Session still holds its claim.
                markPhase('peer retirement');
                await peer.cleanup();
                markPhase('peer transport retirement');
                await peer.retire();
                markPhase('peer release observation');
                // Peer retirement crosses the real carrier; its hub cleanup
                // is observed asynchronously after the local tunnel closes.
                await vi.waitFor(() => expect(consumerLogs.mock.calls).toContainEqual(['[managed-provider-consumer-claim]', {
                  action: 'release', connectionId: basis.connectionId, machineId: hubMachineId,
                  instanceId: expect.any(String), consumerId: JSON.stringify({ kind: 'session', sessionId: peerSessionId }),
                }]));
                expect(await readModels(consumer)).toEqual(localModels);
                expect(await readFile(processFile, 'utf8')).toBe(localPid);
                markPhase('managed endpoint materialization');
                const materialized = await attempt.materializeManagedEndpoint({ normalizedUrl: consumer.endpointUrl,
                  downstreamBearer: consumer.credential });
                if (!materialized.ok) throw new Error(materialized.error.code);
                return { handoff: { v: 1, materialization: materialized.materialization.launchMaterialization,
                    sessionBindingMetadata: metadata }, environmentOverlay: materialized.materialization.providerEnvironmentOverlay,
                  additionalRedactionValues: materialized.redactionLease.values(),
                  transformAgentChildLaunchEnvironment: environment => environment, cleanup: null };
              },
            });
            // Execute the child ingress with only its OS identity observation replaced.
            // This must get beyond the pre-webhook handoff check without a foreground resolver.
            const osBoundary = new Error('fixture-process-identity-boundary');
            await expect(runHostSessionRuntime(plan.opts, plan.config, {
              readProcessIdentityByPidFn: async () => { throw osBoundary; },
            })).rejects.toBe(osBoundary);
            markPhase('native runtime binding');
            const session = createNativeSessionClientTestPort(sessionId);
            const created = await plan.config.createSessionRuntime({ directory: homeDir,
              metadata: {}, machineId: hubMachineId, session,
              transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
              getPermissionMode: () => 'default', setThinking: () => undefined,
              memoryRecallGuidanceEnabled: false,
            } as never);
            expect(created.admittedProviderBindingHandoff?.sessionBindingMetadata).toEqual(metadata);
            expect(created.admittedProviderBindingHandoff?.materialization.kind).toBe('spawnEnv');
            await created.operations.resetOrDisposeRuntime();
          } finally {
            markPhase('consumer scope cleanup');
            try { await consumerScope.release(); } finally { consumerLogs.mockRestore(); }
          }
        }
      }
      const logs = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
      try {
        markPhase('paused Home admission cancellation');
        pauseTarget = true;
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const caller = new AbortController();
        let settled = false;
        const pending = prepareDaemonProviderLaunch({ signal: caller.signal, options: { ...options, machineId: peerMachineId },
          effectiveBackendTarget: options.backendTarget, catalogAgentId: fixture.agentId, modelSelection,
          profileEnvironmentVariables: {}, daemonSpawnHooks: null, persistedProviderBinding: null, normalizedExistingSessionId: '',
          pluginRuntimeLease: createSpawnPluginRuntimeLease(launchResourceScope), launchResourceScope,
          resolveProvidersFeatureEnabled: () => true, processEnv: environmentInput.processEnv, accountSettingsSnapshot: snapshot,
          providerRuntimeHomeDir: homeDir, resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
          readModelProjection: request => hubModels.projectModels(request),
        }).then(result => { settled = true; return result; });
        await entered;
        await vi.advanceTimersByTimeAsync(30_000);
        // Session admission follows its caller's lifetime, not the endpoint
        // probe budget. Cancellation must still settle a stalled Home read.
        expect(settled).toBe(false);
        expect(targetSignal?.aborted).toBe(false);
        caller.abort();
        // Caller cancellation settles as a typed cancelled rejection,
        // never as catalog unavailability.
        await expect(pending).rejects.toMatchObject({
          name: 'ProviderOperationAbandonedError', reason: 'cancelled',
        });
        expect(targetSignal?.aborted).toBe(true);
        expect(logs.mock.calls).toContainEqual(['[PROVIDER] Spawn authorization phase', expect.objectContaining({
          phase: 'purpose_bindings', status: 'failed', reason: 'cancelled', connectionId: 'run-gateway', machineId: peerMachineId,
        })]);
      } finally { releaseTarget(); vi.useRealTimers(); logs.mockRestore(); }
    } finally {
      peerSourceReleased.resolve();
      markPhase('launch resource cleanup');
      redaction.close();
      await launchResourceScope.release();
      markPhase('fixture cleanup');
      await fixture.cleanup();
      markPhase('complete');
    }
  });
});
