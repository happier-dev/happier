import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '@/api/api';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as machineTransport from '@/session/transport/rpc/machineRpc';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createProjectDefinitionAction, registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import type { RpcHandlerContext } from '@/api/rpc/types';

import {
  type MachineLiveStreamFrameV1,
  type WorkspaceSyncRuntimeReadinessV1,
  type WorkspaceSyncStatusV1,
} from '@happier-dev/protocol';
import type { DaemonState } from '@/api/types';
import type { ApiMachineClient } from '@/api/apiMachine';
import { decryptLegacy, encryptLegacy } from '@/api/encryption';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import { createLocalServicesDaemonRuntime } from '../local/services/runtime';
import type { LocalServiceListenerFact } from '../local/services/inventory/scanner';

import type { MachineLiveStreamCaptureAdapter } from '../peer/mediation/stream/captureAdapter';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import type {
  AutomationWorkerHandle,
  startAutomationWorker,
} from '../automation/automationWorker';
import { cleanupAndShutdown } from '../lifecycle/cleanupAndShutdown';
import { createServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { isWorkflowRuntimeEnabled } from '../automation/workflowFeatureGate';
import type { WorkflowCoordinatorResult } from '../workflows/coordinator';

import { createDaemonMachineBootstrapRuntime, createProjectFiniteSourceManifestInspector } from './createDaemonMachineBootstrapRuntime';
import { createBeforeShutdownDrain } from '../lifecycle/createBeforeShutdownDrain';
import { createDaemonAdmissionDrain } from '../lifecycle/admissionDrain';
import { retireMachineSyncRuntimeAttempt } from '../machine/bootstrapMachineSyncRuntime';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { getMachineFinitePolicyV1 } from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

const automationWorkerMocks = vi.hoisted(() => ({
  startAutomationWorker: vi.fn(),
}));
const voiceInferenceWorkerMocks = vi.hoisted(() => ({
  startVoiceInferenceWorker: vi.fn(async () => ({ stop: vi.fn(async () => {}) })),
}));

vi.mock('../automation/automationWorker', () => ({
  startAutomationWorker: automationWorkerMocks.startAutomationWorker,
}));
vi.mock('../voiceInference/voiceInferenceWorker', () => ({
  startVoiceInferenceWorker: voiceInferenceWorkerMocks.startVoiceInferenceWorker,
}));

const deviceLocalSecretStorage = {
  sealJson: vi.fn(() => 'sealed'),
  openJson: vi.fn(() => null),
  deriveOpaqueIdentity: vi.fn(() => 'a'.repeat(64)),
} as never;

function createBaseRuntimeParams(overrides: Partial<Parameters<typeof createDaemonMachineBootstrapRuntime>[0]> = {}) {
  const workspaceSyncHandoffAdapter = {
    prepare: vi.fn(),
    finalize: vi.fn(),
    commit: vi.fn(),
    abort: vi.fn(),
  };
  return {
    // Test fixture boundary: this test only inspects returned PMS config; API methods are not invoked.
    api: {
      machineSyncClient: vi.fn(),
    } as never,
    credentials: {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    },
    deviceLocalSecretStorage,
    workspaceSyncHandoffAdapter,
    runtimeId: 'runtime_1',
    publicReleaseChannel: 'dev' as const,
    startupSource: 'manual',
    serviceLabel: undefined,
    transferRuntimeStatePublisher: null,
    spawnSession: vi.fn(),
    stopSession: vi.fn(),
    awaitAgentSessionOpen: vi.fn(),
    isSessionAlreadyRunning: vi.fn(),
    loadLocalSessionMetadataForHandoff: vi.fn(),
    beforeShutdown: vi.fn(),
    requestShutdown: vi.fn(),
    directPeerServerLifecycle: null,
    // Test fixture boundary: transfer registries are pass-through values and are not invoked by this test.
    directTransferPromptAssetAdapterRegistry: {} as never,
    directTransferPromptRegistryRegistry: {} as never,
    daemonServerWorkScheduler: {} as never,
    setDaemonServerWorkOnline: vi.fn(),
    onMachineConnectionOnline: vi.fn(),
    reconcileConnectedServicesProjection: vi.fn(),
    isShuttingDown: () => false,
    ...overrides,
  } satisfies Parameters<typeof createDaemonMachineBootstrapRuntime>[0];
}

describe('createDaemonMachineBootstrapRuntime', () => {
  it('retains failed-attachment finite custody before plugin disposal while attempt cleanup is still waiting', async () => {
    const credentials = { token: 'failed-attachment-token', encryption: null };
    const admissionDrain = createDaemonAdmissionDrain();
    const admission = createProjectWorkerAdmission({ machineId: 'attachment-worker', admissionDrain,
      readPolicy: () => getMachineFinitePolicyV1({ read: async () => ({ status: 'ready', metadataVersion: 1,
        metadata: { finitePolicyV1: { accepting: true, runAtMost: 1 } } }),
        compareAndSwap: async () => ({ status: 'unavailable' }) }),
    });
    // Home profile/publication and the process/peer-stop adapters are the only
    // controlled boundaries. Bootstrap, Api, registration, runner and drain stay real.
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'attachment-account' } });
    const bootstrap = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: await ApiClient.create(credentials), credentials, admissionDrain,
      workspaceSyncHandoffAdapter: undefined,
    }));
    const apiMachine = await bootstrap.createConnectedApiMachine({ id: 'attachment-worker',
      encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    });
    if (!apiMachine) throw new Error('Missing actual Machine client');
    apiMachine.setRPCHandlers({ spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      stopSession: async () => true, requestShutdown() {},
    }, { createProjectFiniteRuntime: async ports => ({ ...ports,
      serverId: 'home', machineId: 'attachment-worker', accountId: 'attachment-account', credentials,
      serverHttpBaseUrl: 'https://attachment-home.invalid', workerAdmission: admission,
      nativeIo: { resolveTool: async () => null }, resolveWorkspaceExecutionConfig: async () => null,
      environmentIo: { resolveTool: async () => null, run: async () => { throw new Error('No native evaluation selected'); } },
    }) });
    const events: string[] = [];
    let settleProcess!: () => void;
    const processSettled = new Promise<void>(resolve => { settleProcess = resolve; });
    let releasePeerStop!: () => void;
    const peerStopped = new Promise<void>(resolve => { releasePeerStop = resolve; });
    let attemptCleanup: Promise<void> | undefined;
    let shutdown: Promise<void> | undefined;
    try {
      expect(await apiMachine.observeActionExecution({ actionId: 'projects.compute.exec', input: {},
        actionRequestId: 'failed-attachment-exec', execute: operation => {
          if (!operation.operationAcceptance) throw new Error('Missing actual finite operation');
          return admission.execute({ operationId: operation.operationAcceptance.operationId,
            workspaceRefId: 'attachment-copy', signal: operation.signal,
            accept: handle => {
              operation.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'exec',
                serverId: 'home', machineId: 'attachment-worker', workspaceRefId: 'attachment-copy', cwd: '/project' } });
              operation.operationAcceptance?.accept(handle);
            }, run: async reservation => {
              reservation.phase('running');
              operation.operationOwnerUpdate.update({ state: 'running' });
              operation.operationCancellation?.onRequest(() => {
                events.push('stop-unconfirmed');
                operation.operationOwnerUpdate.update({ observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } });
              });
              await processSettled;
              events.push('process-settled');
              return { kind: 'process_settled', result: { ok: false, errorCode: 'cancelled', error: 'cancelled' } };
            },
          });
        },
      })).toMatchObject({ ok: true, result: { operation: { state: 'accepted' } } });
      await expect.poll(async () => (await admission.load()).running).toBe(1);
      // The failed handoff cleared the routing projection. Existing attempt
      // cleanup has not reached Api.shutdown because its peer stop is pending.
      attemptCleanup = retireMachineSyncRuntimeAttempt({ apiMachine, automationWorker: null,
        memoryWorker: null, voiceInferenceWorker: null, machineConnectionStateCleanup: null,
        disposeInactiveSessionUsageLimitRecovery: null, stopMachineIrohAcceptor: async () => await peerStopped,
        stopPeerMediationLoopbackServer: async () => {},
      });
      const beforeShutdown = createBeforeShutdownDrain({ admissionDrain,
        pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
        shutdownSpawnDrainGraceMs: 0, shutdownSpawnDrainPollMs: 10, getApiMachineForSessions: () => null,
        // Final shutdown consumes the same retained bootstrap owner, not the
        // cleared session-routing projection.
        retireFiniteExecution: bootstrap.retireProjectFiniteExecution,
        buildUnexpectedSpawnResult: errorMessage => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage }),
        disposePluginRuntimeRegistry: async () => { events.push('plugin-disposed'); },
      });
      shutdown = beforeShutdown();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(events).toEqual(['stop-unconfirmed']);
      expect(await admission.load()).toMatchObject({ running: 1 });
      settleProcess();
      await shutdown;
      expect(events).toEqual(['stop-unconfirmed', 'process-settled', 'plugin-disposed']);
    } finally {
      settleProcess();
      releasePeerStop();
      await Promise.all([attemptCleanup, shutdown]);
      await apiMachine.shutdown();
      vi.restoreAllMocks();
    }
  });
  it('reads the personal SOURCE manifest through the real exact-Home Action and refuses shared, unproved or retired credential custody', async () => {
    const root = await mkdtemp(join(tmpdir(), 'finite-source-inspection-'));
    const serverId = 'source-home';
    const serverHttpBaseUrl = 'https://source-home.invalid';
    const accountId = 'source-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const source = { id: 'source-ref', serverId, machineId: 'source-machine', rootPath: root, projectKey: 'project', createdAtMs: 1 };
    let current = true;
    let custodian: string | undefined = accountId;
    let retireDuringMachineRead = false;
    let retireDuringReply = false;
    let malformedReply = false;
    let issued = 0;
    try {
      await mkdir(join(root, '.happier'));
      await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
        scripts: { check: { source: { kind: 'command', command: 'must-not-run' }, execution: 'portable',
          memoryDemand: { bytes: 123, basis: { kind: 'declared' } } } } }));
      // Home HTTP and the exact Machine transport are genuine boundaries. The
      // Machine decoder, Action executor/registrar and manifest reader stay real.
      vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        expect(url).toMatch(/^https:\/\/source-home\.invalid\//);
        expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
        if (url.endsWith('/v2/account/settings')) {
          return { status: 200, data: { content: { t: 'plain', v: {} }, version: 0 } };
        }
        if (url.endsWith(`/v1/machines/${source.machineId}`)) {
          if (retireDuringMachineRead) current = false;
          return { status: 200, data: { machine: {
            id: source.machineId, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
            storageMode: 'plain', ...(custodian === undefined ? {} : { access: {
              custodian: { accountId: custodian, displayName: 'Source owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready',
            } }),
          } } };
        }
        return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      });
      const handlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
      registerProjectDefinitionHandlers({ machineId: source.machineId,
        rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
        actionExecutor: createActionExecutor({ projectDefinitionAction: createProjectDefinitionAction({
          serverId, machineId: source.machineId, workingDirectory: root,
          accessPolicy: { kind: 'restrictedRoots', roots: [root] },
        }) }),
      });
      vi.spyOn(machineTransport, 'callExactMachineRpc').mockImplementation(async request => {
        expect(resolveServerHttpBaseUrl()).toBe(serverHttpBaseUrl);
        expect(request.credentials).toEqual(credentials);
        expect(request.machineId).toBe(source.machineId);
        expect(request.authorityCeiling).toBe('account_automation');
        issued++;
        const handler = handlers.get(request.method);
        if (!handler) throw new Error('Wrong source Action transport');
        const result = await handler(request.request, { signal: request.signal ?? new AbortController().signal });
        if (retireDuringReply) current = false;
        return malformedReply ? { definition: result, detection: {}, extraAuthority: true } : result;
      });
      vi.spyOn(machineTransport, 'callMachineRpc').mockRejectedValue(new Error('Source inspection must not retarget'));
      const inspect = createProjectFiniteSourceManifestInspector({ api: await ApiClient.create(credentials),
        credentials, serverId, serverHttpBaseUrl, accountId,
        ingress: { signal: new AbortController().signal }, isCurrent: async () => current });
      const signal = new AbortController().signal;
      expect(await inspect({ source, signal })).toMatchObject({ document: { status: 'valid', manifest: {
        scripts: { check: { execution: 'portable', memoryDemand: { bytes: 123 } } },
      } } });
      expect(issued).toBe(1);
      for (const unproved of ['foreign-account', undefined]) {
        custodian = unproved;
        await expect(inspect({ source, signal })).rejects.toMatchObject({ code: 'project_requester_credentials_unavailable' });
      }
      custodian = accountId;
      await expect(inspect({ source: { ...source, serverId: 'wrong-home' }, signal })).rejects.toMatchObject({ code: 'target_mismatch' });
      current = false;
      await expect(inspect({ source, signal })).rejects.toMatchObject({ code: 'project_requester_credentials_unavailable' });
      expect(issued).toBe(1);
      current = true;
      retireDuringMachineRead = true;
      await expect(inspect({ source, signal })).rejects.toMatchObject({ code: 'project_requester_credentials_unavailable' });
      expect(issued).toBe(1);
      retireDuringMachineRead = false;
      current = true;
      malformedReply = true;
      await expect(inspect({ source, signal })).rejects.toMatchObject({ code: 'invalid_action_output' });
      malformedReply = false;
      retireDuringReply = true;
      await expect(inspect({ source, signal })).rejects.toMatchObject({ code: 'project_requester_credentials_unavailable' });
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes summary changes once and republishes on reconnect and API replacement', async () => {
    let scanListeners: readonly LocalServiceListenerFact[] = [];
    const scan = vi.fn(async () => ({ listeners: scanListeners, processes: new Map(), workspaces: [], diagnostics: [] }));
    const services = createLocalServicesDaemonRuntime({ machineId: 'machine-a', inventoryEnabled: () => true, scan, startLoop: false });
    const publications: unknown[] = [];
    const listeners = new Set<(state: ManagedConnectionState) => void>();
    let delayPublication = false;
    const pendingPublications: Array<() => void> = [];
    const stateFor = (phase: ManagedConnectionState['phase']): ManagedConnectionState => ({ phase, reason: null, attempt: 0, nextRetryAt: null, lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null });
    const apiMachine = () => {
      let state: DaemonState | null = null;
      return {
        onConnectionStateChange(listener: (state: ManagedConnectionState) => void) {
          listeners.add(listener);
          listener(stateFor('idle'));
          return () => { listeners.delete(listener); };
        },
        async updateDaemonState(handler: Parameters<ApiMachineClient['updateDaemonState']>[0]) {
          if (delayPublication) {
            await new Promise<void>((resolve) => pendingPublications.push(() => {
              state = handler(state);
              publications.push(state.localServices);
              resolve();
            }));
            return 'published' as const;
          }
          state = handler(state);
          publications.push(state.localServices);
          return 'published' as const;
        },
      };
    };
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      // API socket publication is the genuine external boundary; inventory and projection are real.
      api: { machineSyncClient: vi.fn(apiMachine) } as never,
      localServiceSummary: services,
    }));
    const connection = (phase: ManagedConnectionState['phase']) => { for (const listener of listeners) listener(stateFor(phase)); };
    await runtime.createConnectedApiMachine({ id: 'machine-a' } as never);
    expect(publications).toEqual([]);
    connection('online');
    await vi.waitFor(() => expect(publications.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 0 }));
    delayPublication = true;
    scanListeners = [{ address: '127.0.0.1', port: 5173, protocol: 'tcp' }];
    await services.refreshInventoryNow();
    scanListeners = [];
    await services.refreshInventoryNow();
    expect(pendingPublications).toHaveLength(2);
    // A transport/CAS attempt may execute after a newer scan. Even the older handler
    // must read the current owner rather than reverting the machine to its captured count.
    pendingPublications.shift()?.();
    expect(publications.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 0 });
    pendingPublications.shift()?.();
    delayPublication = false;
    const published = publications.length;
    await services.refreshInventoryNow();
    expect(publications).toHaveLength(published);
    connection('offline');
    connection('online');
    await vi.waitFor(() => expect(publications).toHaveLength(published + 1));
    await runtime.createConnectedApiMachine({ id: 'machine-a' } as never);
    connection('online');
    await vi.waitFor(() => expect(publications).toHaveLength(published + 2));
    expect(listeners.size).toBe(1);
    await runtime.beforeShutdown?.();
    expect(listeners.size).toBe(0);
    await services.stop();
  });
  it('authorizes the exact Runner broker readiness request before publishing the fixed application target', async () => {
    const request = {
      v: 1 as const,
      kind: 'provider_broker_readiness' as const,
      homeServerIdentityId: 'srv_home',
      activationId: '00000000-0000-4000-8000-000000000010',
      launchManifestCommitment: 'A'.repeat(43),
      resourceId: 'resource-1',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      protocol: 'openai-responses' as const,
      modelId: 'gpt-5',
      initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) },
      target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) },
      activationSignature: 'A'.repeat(86),
      installationSignature: 'A'.repeat(86),
    };
    const authorization = {
      v: 1 as const,
      binding: {
        homeServerIdentityId: request.homeServerIdentityId,
        activationId: request.activationId,
        launchManifestCommitment: request.launchManifestCommitment,
        resourceId: request.resourceId,
        agentTargetKey: request.agentTargetKey,
        protocol: request.protocol,
        modelId: request.modelId,
        initiator: request.initiator,
        target: request.target,
      },
      credentialSelectionBinding: {
        v: 1 as const,
        resourceId: request.resourceId,
        brokerMachineId: request.target.machineId,
        revision: 7,
        application: {
          agentTargetKey: request.agentTargetKey,
          implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
          endpointTemplateId: 'responses',
          protocol: request.protocol,
        },
        sourceRevision: 'source-revision-7',
      },
      readiness: { kind: 'available' as const },
    };
    const authorizeRunnerBrokerReadiness = vi.fn()
      .mockResolvedValueOnce(authorization)
      .mockResolvedValueOnce({
        ...authorization,
        binding: {
          ...authorization.binding,
          activationId: '00000000-0000-4000-8000-000000000011',
        },
      })
      .mockResolvedValueOnce({ ...authorization, readiness: { kind: 'resource_unavailable' as const } })
      .mockRejectedValueOnce(new Error('home unavailable'));
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: { machineSyncClient: vi.fn(), authorizeRunnerBrokerReadiness } as never,
    }));
    const resolve = runtime.peerMediationMachineRpc?.resolveRunnerBrokerReadinessApplicationTarget;
    expect(resolve).toBeDefined();
    const signal = new AbortController().signal;

    try {
      await expect(resolve?.({
        request,
        authenticatedRemoteEndpointId: request.initiator.endpointId,
        localEndpointId: request.target.endpointId,
        signal,
      } as never)).resolves.toEqual({ port: expect.any(Number) });
      expect(authorizeRunnerBrokerReadiness).toHaveBeenCalledWith(request, signal);
      await expect(resolve?.({
        request,
        authenticatedRemoteEndpointId: request.initiator.endpointId,
        localEndpointId: request.target.endpointId,
        signal,
      } as never)).resolves.toBeNull();
      await expect(resolve?.({
        request,
        authenticatedRemoteEndpointId: request.initiator.endpointId,
        localEndpointId: request.target.endpointId,
        signal,
      } as never)).resolves.toBeNull();
      await expect(resolve?.({
        request,
        authenticatedRemoteEndpointId: request.initiator.endpointId,
        localEndpointId: request.target.endpointId,
        signal,
      } as never)).resolves.toBeNull();
    } finally {
      await runtime.beforeShutdown();
    }
  });

  it('installs the broker application for the registered machine, advertises it only while live, and shuts it down', async () => {
    const resolveProviderBrokerApplicationTarget = vi.fn(async () => ({ port: 47_001, localCapability: 'local-capability' }));
    const resolveExternalProviderBrokerApplicationTarget = vi.fn(async () => ({ port: 47_002, localCapability: 'external-capability' }));
    const checkRunnerCredentialSelectionCurrentness = vi.fn(async () => 'available' as const);
    const close = vi.fn(async () => undefined);
    const setProviderBrokerIngressLive = vi.fn(async () => undefined);
    const startProviderBrokerApplication = vi.fn(async () => ({
      resolveProviderBrokerApplicationTarget,
      resolveExternalProviderBrokerApplicationTarget,
      checkRunnerCredentialSelectionCurrentness,
      close,
    }));
    const withOwner = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: {
        machineSyncClient: vi.fn(() => ({ setProviderBrokerIngressLive })),
      } as never,
      startProviderBrokerApplication,
    }));
    const input = {
      handshake: { v: 1, kind: 'provider_broker' },
      authority: {},
      authenticatedRemoteEndpointId: 'a'.repeat(64),
      localEndpointId: 'b'.repeat(64),
      signal: new AbortController().signal,
    } as never;
    await expect(withOwner.peerMediationMachineRpc?.resolveProviderBrokerApplicationTarget?.(input))
      .resolves.toBeNull();
    await withOwner.createConnectedApiMachine({ id: 'registered-machine' } as never);
    expect(startProviderBrokerApplication).toHaveBeenCalledWith({
      machineId: 'registered-machine',
      apiMachine: expect.anything(),
    });
    expect(setProviderBrokerIngressLive).toHaveBeenCalledWith(true);
    await expect(withOwner.peerMediationMachineRpc?.resolveProviderBrokerApplicationTarget?.(input))
      .resolves.toEqual({ port: 47_001, localCapability: 'local-capability' });
    expect(resolveProviderBrokerApplicationTarget).toHaveBeenCalledWith(input);
    const externalInput = { binding: { v: 1, requestId: 'request-1' } } as never;
    await expect(withOwner.peerMediationMachineRpc?.resolveExternalProviderBrokerApplicationTarget?.(externalInput))
      .resolves.toEqual({ port: 47_002, localCapability: 'external-capability' });
    expect(resolveExternalProviderBrokerApplicationTarget).toHaveBeenCalledWith(externalInput);
    await withOwner.beforeShutdown();
    expect(setProviderBrokerIngressLive).toHaveBeenLastCalledWith(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(setProviderBrokerIngressLive.mock.invocationCallOrder.at(-1))
      .toBeLessThan(close.mock.invocationCallOrder[0]!);

    const withoutOwner = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams());
    expect(withoutOwner.peerMediationMachineRpc?.resolveProviderBrokerApplicationTarget).toBeUndefined();
  });

  it('does not start the daemon inference worker while its canonical feature decision is disabled', async () => {
    const previous = process.env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED;
    delete process.env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED;
    try {
      const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams());
      await expect(runtime.startVoiceInferenceWorkerForMachine('machine_1', 'account_1'))
        .resolves.toBeNull();
      expect(voiceInferenceWorkerMocks.startVoiceInferenceWorker).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED;
      else process.env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED = previous;
    }
  });

  it('keeps daemon quiescence out of ownership metadata and forwards the daemon feature refresh owner as a lifecycle dependency', async () => {
    const machineSyncClient = vi.fn((
      _machine: unknown,
      _metadata: unknown,
      _lifecycleDependencies: Readonly<{
        resolveServerFeaturesSnapshot?: () => Promise<unknown>;
      }>,
    ) => ({}));
    const isShuttingDown = vi.fn(() => false);
    const workspaceSyncHandoffAdapter = {
      prepare: vi.fn(),
      finalize: vi.fn(),
      commit: vi.fn(),
      abort: vi.fn(),
    };
    const workspaceSync = {
      controller: {},
      readFileAtTarget: vi.fn(),
    } as never;
    const serverFeaturesSnapshot = { status: 'ready', features: { capabilities: {} } } as const;
    const refreshServerFeaturesSnapshot = vi.fn(async () => serverFeaturesSnapshot as never);
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      // Test fixture boundary: only machineSyncClient call arguments are observed.
      api: { machineSyncClient } as never,
      isShuttingDown,
      workspaceSyncHandoffAdapter,
      workspaceSync,
      getServerFeaturesSnapshot: () => serverFeaturesSnapshot as never,
      refreshServerFeaturesSnapshot,
    }));
    expect(runtime.deviceLocalSecretStorage).toBe(
      deviceLocalSecretStorage,
    );
    const machine = {
      id: 'machine_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy' as const,
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    runtime.createConnectedApiMachine(machine);

    expect(machineSyncClient).toHaveBeenCalledWith(
      machine,
      expect.not.objectContaining({ isDaemonQuiescing: expect.any(Function) }),
      {
        isDaemonQuiescing: isShuttingDown,
        workspaceSyncHandoffAdapter,
        workspaceSync,
        resolveServerFeaturesSnapshot: expect.any(Function),
      },
    );
    const lifecycleDependencies = machineSyncClient.mock.calls[0]?.[2];
    await expect(lifecycleDependencies?.resolveServerFeaturesSnapshot?.()).resolves.toBe(serverFeaturesSnapshot);
    expect(refreshServerFeaturesSnapshot).toHaveBeenCalledOnce();
  });

  it('constructs workspace sync from the registered machine identity before publishing the machine client', async () => {
    const updateDaemonState = vi.fn(async (_updater: (state: DaemonState | null) => DaemonState) => {});
    const machineSyncClient = vi.fn(() => ({ updateDaemonState }));
    const handoffAdapter = {
      prepare: vi.fn(),
      finalize: vi.fn(),
      commit: vi.fn(),
      abort: vi.fn(),
    };
    const workspaceSync = {
      controller: {},
      readFileAtTarget: vi.fn(),
    } as never;
    const createWorkspaceSyncRuntime = vi.fn(async ({ machineId, onReadinessPublished, onStatusPublished }: Readonly<{
      machineId: string;
      onReadinessPublished(readiness: WorkspaceSyncRuntimeReadinessV1): void;
      onStatusPublished(status: WorkspaceSyncStatusV1): void;
    }>) => {
      onReadinessPublished({
        engine: { state: 'ready' },
        carrier: { state: 'unavailable', errorCode: 'machine_carrier_unavailable' },
      });
      onStatusPublished({
        relationshipId: 'relationship_1',
        controllerMachineId: machineId,
        state: 'watching',
        alphaPath: '/alpha',
        betaPath: '/beta',
        mode: 'keep_synced',
        endpointStates: {
          alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
          beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        },
        conflictCount: 0,
        lastCycleObservedAtMs: null,
      });
      return {
        handoffAdapter,
        workspaceSync,
      };
    });
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: { machineSyncClient } as never,
      workspaceSyncHandoffAdapter: undefined,
      workspaceSync: undefined,
      createWorkspaceSyncRuntime,
    }));
    const machine = {
      id: 'registered-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy' as const,
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    await runtime.createConnectedApiMachine(machine);

    expect(createWorkspaceSyncRuntime).toHaveBeenCalledWith({
      machineId: 'registered-machine',
      onReadinessPublished: expect.any(Function),
      onStatusPublished: expect.any(Function),
    });
    expect(machineSyncClient).toHaveBeenCalledWith(
      machine,
      expect.any(Object),
      expect.objectContaining({
        workspaceSyncHandoffAdapter: handoffAdapter,
        workspaceSync,
      }),
    );
    await vi.waitFor(() => expect(updateDaemonState).toHaveBeenCalledOnce());
    const update = updateDaemonState.mock.calls[0]?.[0];
    // Inspect the entire decrypted shared blob, rather than a redacted UI view.
    const published = decryptLegacy(encryptLegacy(update?.(null), machine.encryptionKey), machine.encryptionKey);
    expect(published).toEqual({
      status: 'running',
      workspaceSync: {
        v: 1,
        readiness: {
          engine: { state: 'ready' },
          carrier: { state: 'unavailable', errorCode: 'machine_carrier_unavailable' },
        },
      },
    });
  });

  it('forwards the daemon-owned inventory snapshot reader without creating a second scanner', () => {
    const readLocalServiceInventorySnapshot = vi.fn();
    const getServerFeaturesSnapshot = vi.fn();
    const resolvePeerMediationTrustRoots = vi.fn(() => []);
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      readLocalServiceInventorySnapshot,
      getServerFeaturesSnapshot,
      resolvePeerMediationTrustRoots,
    }));
    expect(runtime.readLocalServiceInventorySnapshot).toBe(readLocalServiceInventorySnapshot);
    expect(runtime.getServerFeaturesSnapshot).toBe(getServerFeaturesSnapshot);
    expect(runtime.resolvePeerMediationTrustRoots).toBe(resolvePeerMediationTrustRoots);
  });

  it('forwards the durable connected-services projection reconciler into machine cursor composition', () => {
    const reconcileConnectedServicesProjection = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      reconcileConnectedServicesProjection,
    }));

    expect(runtime.reconcileConnectedServicesProjection).toBe(reconcileConnectedServicesProjection);
  });

  it('constructs one workflow recovery reader for the connected machine and forwards lifecycle triggers', async () => {
    const recover = vi.fn(async () => {});
    const createWorkflowRecoveryForMachine = vi.fn(() => recover);
    const enqueueSessionPendingByMachine = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: {
        machineSyncClient: vi.fn(() => ({ enqueueSessionPendingByMachine })),
      } as never,
      isWorkflowFeatureEnabled: () => true,
      createWorkflowRecoveryForMachine,
    }));
    const machine = {
      id: 'machine_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy' as const,
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    await runtime.createConnectedApiMachine(machine);
    await runtime.recoverWorkflowRuns?.('startup');

    expect(createWorkflowRecoveryForMachine).toHaveBeenCalledWith(expect.objectContaining({
      machineId: machine.id,
      machineAdmissionTransport: expect.any(Function),
    }));
    expect(recover).toHaveBeenCalledWith('startup');
  });

  it('forwards the daemon runtime-open attestation reader into machine bootstrap', () => {
    const awaitAgentSessionOpen = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      awaitAgentSessionOpen,
    }));

    expect(runtime.awaitAgentSessionOpen).toBe(awaitAgentSessionOpen);
  });

  it('connects the registered machine through the canonical API client', async () => {
    const apiMachine = { enqueueSessionPendingByMachine: vi.fn() };
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: { machineSyncClient: () => apiMachine } as never,
    }));
    const machine = {
      id: 'machine_1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const,
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    };
    expect(await runtime.createConnectedApiMachine(machine)).toBe(apiMachine);
  });

  it('publishes the worker to shutdown ownership before downstream bootstrap can continue', async () => {
    const worker: AutomationWorkerHandle = {
      stop: vi.fn(),
      refreshAssignments: vi.fn(async () => {}),
      pause: vi.fn(),
      resume: vi.fn(),
      handleServerUpdate: vi.fn(),
    };
    automationWorkerMocks.startAutomationWorker.mockReturnValueOnce(worker);
    let shutdownOwnedWorker: AutomationWorkerHandle | null = null;
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      onAutomationWorkerStarted: (startedWorker) => {
        shutdownOwnedWorker = startedWorker;
      },
    }));

    const startedWorker = runtime.startAutomationWorkerForMachine('machine_1');
    expect(startedWorker).toBe(worker);
    expect(shutdownOwnedWorker).toBe(worker);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(
      (() => undefined as never) as typeof process.exit,
    );
    try {
      // This is the barrier between factory publication and the next bootstrap
      // action (Memory/onMachineSyncRuntime). Shutdown must retain this exact
      // early handle rather than wait for the later runtime result.
      await cleanupAndShutdown({
        source: 'happier-cli',
        processEnv: {},
        resolvePositiveIntEnv: (_raw, fallback) => fallback,
        restartOnStaleVersionAndHeartbeat: null,
        connectedServiceRefreshLoopHandle: null,
        connectedServiceQuotasLoopHandle: null,
        apiMachine: null,
        machineConnectionStateCleanup: null,
        automationWorker: shutdownOwnedWorker,
        memoryWorker: null,
        voiceInferenceWorker: null,
        trackedSessionCount: 0,
        stopDirectPeerServer: async () => {},
        stopTailscaleTransferServeLifecycle: async () => {},
        stopControlServer: async () => {},
        stopCaffeinate: async () => {},
        daemonLockHandle: null,
        releaseDaemonLock: async () => {},
      });
      expect(worker.stop).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('injects the production workflow coordinator into the existing Automation worker after Machine sync exists', async () => {
    const enqueueSessionPendingByMachine = vi.fn();
    const apiMachine = { enqueueSessionPendingByMachine, dispatchSessionServerStart: vi.fn() } as never;
    const coordinateWorkflowRun = vi.fn();
    const createWorkflowRunCoordinatorForMachine = vi.fn(() => coordinateWorkflowRun);
    automationWorkerMocks.startAutomationWorker.mockReturnValueOnce({
      stop: vi.fn(), refreshAssignments: vi.fn(), pause: vi.fn(), resume: vi.fn(), handleServerUpdate: vi.fn(),
    });
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: { machineSyncClient: vi.fn(() => apiMachine) } as never,
      isWorkflowFeatureEnabled: () => true,
      createWorkflowRunCoordinatorForMachine,
    }));

    await runtime.createConnectedApiMachine({ id: 'machine_1' } as never);
    runtime.startAutomationWorkerForMachine('machine_1');

    expect(createWorkflowRunCoordinatorForMachine).toHaveBeenCalledWith({
      machineId: 'machine_1',
      machineAdmissionTransport: expect.any(Function),
      machineActionDirectTargetTransport: {
        machineId: 'machine_1',
        invoke: expect.any(Function),
      },
    });
    const workerParams = automationWorkerMocks.startAutomationWorker.mock.calls.at(-1)?.[0] as
      | Parameters<typeof startAutomationWorker>[0]
      | undefined;
    await expect(workerParams?.coordinateWorkflowRun?.({} as never)).resolves.toBeUndefined();
    expect(coordinateWorkflowRun).toHaveBeenCalledOnce();
  });

  it('uses the live server feature decision for the existing Workflow coordinator without restarting Automation', async () => {
    const enabledFeatures = {
      status: 'ready' as const,
      provenance: 'authenticated' as const,
      features: {
        features: {
          automations: { enabled: true },
          workflows: { enabled: true },
        },
        capabilities: {},
      },
    };
    const disabledFeatures = {
      ...enabledFeatures,
      features: {
        ...enabledFeatures.features,
        features: {
          automations: { enabled: true },
          workflows: { enabled: false },
        },
      },
    };
    const fetchSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error('Home unavailable'))
      .mockResolvedValueOnce(enabledFeatures)
      .mockResolvedValueOnce(disabledFeatures);
    const featureStore = createServerFeaturesSnapshotStore({ fetchSnapshot });
    const coordinatedOutcome: WorkflowCoordinatorResult = { state: 'succeeded' };
    const coordinateWorkflowRun = vi.fn(async () => coordinatedOutcome);
    const recoverWorkflowRuns = vi.fn(async () => {});
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: {
        machineSyncClient: vi.fn(() => ({
          enqueueSessionPendingByMachine: vi.fn(),
          dispatchSessionServerStart: vi.fn(),
        })),
      } as never,
      isWorkflowFeatureEnabled: () => isWorkflowRuntimeEnabled({}, featureStore.getSnapshot()),
      createWorkflowRunCoordinatorForMachine: vi.fn(() => coordinateWorkflowRun),
      createWorkflowRecoveryForMachine: vi.fn(() => recoverWorkflowRuns),
    }));
    automationWorkerMocks.startAutomationWorker.mockReturnValueOnce({
      stop: vi.fn(), refreshAssignments: vi.fn(), pause: vi.fn(), resume: vi.fn(), handleServerUpdate: vi.fn(),
    });

    await runtime.createConnectedApiMachine({ id: 'machine_1' } as never);
    runtime.startAutomationWorkerForMachine('machine_1');
    const workerParams = automationWorkerMocks.startAutomationWorker.mock.calls.at(-1)?.[0] as
      | Parameters<typeof startAutomationWorker>[0]
      | undefined;
    const coordinate = workerParams?.coordinateWorkflowRun;
    expect(coordinate).toBeDefined();

    await expect(coordinate?.({} as never)).rejects.toThrow('Workflow Run coordinator is unavailable');
    await runtime.recoverWorkflowRuns?.('startup');
    expect(recoverWorkflowRuns).not.toHaveBeenCalled();
    await featureStore.refresh();
    await expect(coordinate?.({} as never)).rejects.toThrow('Workflow Run coordinator is unavailable');
    await featureStore.refresh();
    await expect(coordinate?.({} as never)).resolves.toEqual(coordinatedOutcome);
    await runtime.recoverWorkflowRuns?.('reconnect');
    expect(coordinateWorkflowRun).toHaveBeenCalledOnce();
    expect(recoverWorkflowRuns).toHaveBeenCalledOnce();
    await featureStore.refresh();
    await expect(coordinate?.({} as never)).rejects.toThrow('Workflow Run coordinator is unavailable');
    await runtime.recoverWorkflowRuns?.('reconnect');
    expect(coordinateWorkflowRun).toHaveBeenCalledOnce();
    expect(recoverWorkflowRuns).toHaveBeenCalledOnce();
  });

  it('wires the production peer-mediation live-stream capture adapter into machine bootstrap config', () => {
    const cancelConnectedServiceRuntimeAuthRecovery = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      cancelConnectedServiceRuntimeAuthRecovery,
    }));

    expect(runtime.peerMediationMachineRpc?.stream?.captureAdapter).toEqual({
      start: expect.any(Function),
    });
    expect(runtime.cancelConnectedServiceRuntimeAuthRecovery).toBe(cancelConnectedServiceRuntimeAuthRecovery);
  });

  it('uses the shared PMS capture registry for relayed live-stream capture sources', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    const offeredFrames: MachineLiveStreamFrameV1[] = [];
    const sourceAdapter: MachineLiveStreamCaptureAdapter = {
      start: async (input) => {
        input.offerFrame({
          v: 1,
          streamId: input.streamId,
          sequence: 1,
          timestampMs: 1_000,
          payloadKind: 'image_keyframe',
          payloadEncoding: 'binary_base64',
          payloadBase64: 'AQID',
          payloadSizeBytes: 3,
        });
        return { ok: true, session: { stop: () => undefined } };
      },
    };
    registry.register({
      sourceId: 'ios-simulator:A1B2-C3D4:screen',
      streamFamily: 'ios-simulator:A1B2-C3D4:screen',
      adapter: sourceAdapter,
      capabilities: {
        v: 1,
        sourceId: 'ios-simulator:A1B2-C3D4:screen',
        sourceKind: 'simulator',
        supportedCodecs: ['image.mjpeg'],
        maxFramesPerSecond: 30,
        inputMode: 'exclusive',
        sidebands: ['capture_health'],
        health: { status: 'available' },
      },
    });

    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      liveStreamCaptureRegistry: registry,
    }));
    const captureAdapter = runtime.peerMediationMachineRpc?.stream?.captureAdapter;
    expect(captureAdapter).toBeDefined();
    if (!captureAdapter) throw new Error('expected live-stream capture adapter');

    const result = await captureAdapter.start({
      streamId: 'stream_1',
      streamFamily: 'ios-simulator:A1B2-C3D4:screen',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      caps: {
        maxBitrateBps: 64_000,
        maxFramesPerSecond: 12,
        maxFrameBytes: 8_192,
        maxDurationMs: 60_000,
        maxTotalBytes: 128_000,
      },
      startRequest: {
        v: 1,
        streamId: 'stream_1',
        streamFamily: 'ios-simulator:A1B2-C3D4:screen',
        routeKind: 'server_relay',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        maxBitrateBps: 64_000,
        maxFramesPerSecond: 12,
        maxFrameBytes: 8_192,
        maxDurationMs: 60_000,
        maxTotalBytes: 128_000,
      },
      startedAtMs: 1_000,
      expiresAtMs: 61_000,
      nowMs: () => 1_000,
      offerFrame: (frame) => {
        offeredFrames.push(frame);
        return { ok: true };
      },
      applyControl: () => ({ ok: true }),
      emitReceipt: () => undefined,
    });

    expect(result).toMatchObject({ ok: true });
    expect(offeredFrames.map((frame) => frame.sequence)).toEqual([1]);
  });
});
