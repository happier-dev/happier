import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

let runnerHome: string;

const h = vi.hoisted(() => {
  const sourceDispose = vi.fn();
  const sourceMaterial = { dispose: sourceDispose };
  return ({
    sourceDispose,
    sourceMaterial,
    machineServicesDispose: vi.fn(async () => undefined),
    machineClose: vi.fn(async () => undefined),
    machineConnect: vi.fn(async (_input?: { signal: AbortSignal }) => undefined),
    installSessionFollowWakeReceiver: vi.fn(() => vi.fn()),
    createMachineClient: vi.fn(),
    registerMachineServices: vi.fn(),
    registerSourceReceiver: vi.fn(),
    createSessionRuntime: vi.fn(),
    createScopedActionSettings: vi.fn(() => ({ getActionsSettings: () => ({ v: 1, actions: {} }) })),
    createProviderRuntime: vi.fn(),
    startMachineIrohIngress: vi.fn(),
    machineIrohIngressStop: vi.fn(async () => undefined),
    providerRuntimeShutdown: vi.fn(async () => undefined),
    openProviderBroker: vi.fn(),
    openExactProviderBinding: vi.fn(),
    providerBindingCleanup: vi.fn(async () => undefined),
    ordinarySessionStop: vi.fn(async () => undefined),
    runHostSessionRuntimePlan: vi.fn(),
    realizeWorkspaceCheckout: vi.fn(),
    runScmRoute: vi.fn(),
    connectedAccountsDispose: vi.fn(),
    fetchFeatures: vi.fn(),
    terminateMaterializedSession: vi.fn(async () => undefined),
    createRestrictedSessionBackendApiContextInitializer: vi.fn(() => vi.fn()),
  });
});

vi.mock('@/scm/workspace', () => ({
  realizeWorkspaceCheckoutWithScmWorkspaceSource: h.realizeWorkspaceCheckout,
}));

vi.mock('@/scm/rpc/dispatch', () => ({
  notRepositoryResponse: vi.fn(() => ({ success: false, errorCode: 'not_repository' })),
  runScmRoute: h.runScmRoute,
}));

vi.mock('@/daemon/peer/iroh/daemonMachineIrohRuntime', () => ({
  createDaemonMachineIrohRuntime: h.createProviderRuntime,
}));

vi.mock('./startRestrictedRunnerMachineIrohIngress', () => ({
  startRestrictedRunnerMachineIrohIngress: h.startMachineIrohIngress,
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: h.fetchFeatures,
}));

vi.mock('@/api/client/providerBrokerApi', () => ({
  openTeamCredentialProviderBroker: h.openProviderBroker,
}));

vi.mock('@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen', () => ({
  createProviderBrokerMachineCarrierTunnelOpen: vi.fn(() => vi.fn()),
}));

vi.mock('@/providers/broker/sessionTeamCredentialProviderBinding', () => ({
  openExactSessionTeamCredentialProviderBinding: h.openExactProviderBinding,
}));

vi.mock('./activationFile', () => ({
  readStrictEphemeralRunnerActivationDocument: vi.fn(async () => ({
    home: {
      v: 1,
      homeServerIdentityId: 'srv_runner_home',
      canonicalServerUrl: 'https://home.example.test',
      revision: 1,
      endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
    },
    activation: {
      creatorAccountId: 'account-1',
      artifact: {
        product: 'happier-runner',
        version: '0.3.0',
        target: 'linux-x64',
        sha256: 'a'.repeat(64),
      },
    },
  })),
}));

vi.mock('@/agent/runtime/session/follow/sessionFollowSourceMaterialResolver', () => ({
  createSessionFollowSourceMaterialResolver: vi.fn(() => h.sourceMaterial),
}));

vi.mock('./registerRestrictedRunnerMachineServices', () => ({
  registerRestrictedRunnerMachineServices: h.registerMachineServices,
}));

vi.mock('./registerRestrictedSessionFollowSourceKeyReceiver', () => ({
  registerRestrictedSessionFollowSourceKeyReceiver: h.registerSourceReceiver,
}));

vi.mock('./createRestrictedMachineRpcClient', () => ({
  createRestrictedMachineRpcClient: h.createMachineClient,
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  SessionHostBridge: class SessionHostBridge {
    createSessionRuntime = h.createSessionRuntime;
  },
}));

vi.mock('@/agent/runtime/session/loop/plan', () => ({
  runHostSessionRuntimePlan: h.runHostSessionRuntimePlan,
}));

// This suite starts from an already prepared Runner input and exercises only
// runtime resource custody. Keep plugin discovery/installation at its own
// boundary so ignored generated plugin artifacts are not a collection-time
// prerequisite on remote test targets.
vi.mock('./runnerPluginRuntimeLease', () => ({
  acquireReviewedRunnerPluginRuntimeLease: vi.fn(),
}));

vi.mock('@/packagedRuntime/managedTools/prepareManagedAgentCliLaunch', () => ({
  prepareManagedAgentCliLaunch: vi.fn(),
}));

vi.mock('@/api/client/serverHttpBaseUrl', () => ({
  runWithServerHttpBaseUrl: vi.fn(async (_origin: string, run: () => unknown) => await run()),
}));

vi.mock('@/settings/scopedRuntimeActionSettingsProvider', () => ({
  createScopedRuntimeActionSettingsProvider: h.createScopedActionSettings,
}));

vi.mock('./createRestrictedSessionBackendApi', () => ({
  createRestrictedSessionBackendApiContextInitializer: h.createRestrictedSessionBackendApiContextInitializer,
  terminateRestrictedMaterializedSession: h.terminateMaterializedSession,
}));

import { resolveRunnerMcpMaterialV1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { publishSessionFollowWakeInvalidation } from '@/agent/runtime/session/follow/sessionFollowWakeSignal';
import { createProductionEphemeralRunnerApplication } from './runtimeIntegrations';

function createReviewedMcpMaterial() {
  const resolved = resolveRunnerMcpMaterialV1({
    settings: {
      v: 1,
      strictMode: true,
      servers: [{
        id: 'reviewed', name: 'reviewed', transport: 'stdio',
        stdio: { command: '/runner/bin/reviewed-mcp', args: ['serve'] },
        env: { REVIEWED_SECRET: { t: 'savedSecret', secretId: 'mcp-secret' } },
        createdAt: 6, updatedAt: 7,
      }],
      bindings: [{
        id: 'all', serverId: 'reviewed', enabled: true,
        target: { t: 'allMachines' }, createdAt: 8, updatedAt: 9,
      }],
    },
    agentId: 'codex',
    agentAcceptsUserMcp: true,
    capabilitySelection: {
      mcp: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['reviewed'],
        forceExcludeServerIds: [],
      },
    },
    resolveSavedSecret: (secretId) => secretId === 'mcp-secret'
      ? { value: 'sealed-mcp-secret', revision: 5 }
      : null,
  });
  if (!resolved.ok) throw new Error(`fixture MCP failed: ${resolved.reason}`);
  return resolved.material;
}

function createStartInput(signal: AbortSignal, invalidate?: 'application' | 'deliveryMode', authoringPatch: Record<string, unknown> = {}, directory = '/workspace') {
  return {
    binding: {
      homeServerIdentityId: 'home-1',
      sessionId: 'session-1',
      machineId: 'machine-1',
    },
    manifest: {
      endpointFacts: { directory },
      credentialSelectionBinding: {
        v: 1, resourceId: 'resource-1', brokerMachineId: 'broker-1', revision: 3,
        application: {
          agentTargetKey: 'agent:codex/codex',
          implementationIdentity: { pluginId: 'provider', localId: 'provider' },
          endpointTemplateId: invalidate === 'application' ? 'different-endpoint' : 'responses',
          protocol: 'openai-responses',
        },
        sourceRevision: 'source-3',
      },
      reviewedProviderModel: {
        selection: { kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1', expectedResourceRevision: 3, deliveryMode: invalidate === 'deliveryMode' ? 'direct' : 'brokered', agentTargetKey: 'agent:codex/codex', modelId: 'dynamic-model' },
        descriptor: { id: 'dynamic-model', name: 'Dynamic Model' },
        application: { agentTargetKey: 'agent:codex/codex', implementationIdentity: { pluginId: 'provider', localId: 'provider' }, endpointTemplateId: 'responses', protocol: 'openai-responses' },
        sourceRevision: 'source-3', availability: 'available',
      },
      preparedAuthoring: {
        actionsSettings: {
          v: 1,
          actions: {
            'session.activity.get': { approvalRequiredSurfaces: [] },
          },
        },
        mcpMaterial: createReviewedMcpMaterial(),
        authoring: {
          executionTarget: {
            kind: 'temporary_computer',
            serverId: 'runner-home-profile',
            artifactTarget: 'linux-x64',
            workspace: { kind: 'choose_on_endpoint' },
          },
          agentTarget: { kind: 'agent', identity: { pluginId: 'codex', localId: 'codex' } },
          permissionMode: 'safe-yolo',
          profileId: 'work',
          environmentVariables: {
            HAPPIER_HOME_DIR: '/substituted-home',
            HOME: '/substituted-user-home',
            PATH: '/reviewed/bin',
            LANG: 'de_CH.UTF-8',
            RUNNER_PROFILE_TOKEN: 'sealed-secret',
          },
          checkoutCreationDraft: null,
          resumeSessionId: 'provider-session-reviewed',
          terminal: { mode: 'tmux', tmux: { sessionName: 'runner-reviewed', isolated: true, tmpDir: '/tmp/runner-reviewed' } },
          windowsRemoteSessionLaunchMode: null,
          windowsRemoteSessionConsole: null,
          windowsTerminalWindowName: null,
          ...authoringPatch,
          acpSessionModeId: 'plan',
          sessionConfigOptionOverrides: {
            v: 1,
            updatedAt: 456,
            overrides: { speed: { updatedAt: 456, value: 'fast' } },
          },
          primaryTeamId: null,
        },
      },
    },
    materialized: {
      runtimeOrigin: 'https://home.example.test',
      runtimeToken: 'runner-token',
      installationProof: {},
      bootstrap: { mode: 'plain' },
      principal: {
        kind: 'ephemeral_session_runner',
        authority: 'session_runtime',
        accountId: 'account-1',
        activationId: 'activation-1',
        sessionId: 'session-1',
        machineId: 'machine-1',
        installationId: 'installation-1',
        installationPublicKey: 'installation-public-key',
        creatorTokenEpoch: 1,
      },
      pluginRuntime: {
        selected: {
          agentId: 'codex', backendId: 'codex', pluginId: 'happier.agent.codex', localId: 'codex',
          immutableGenerationId: 'bundled:test',
        },
        lease: { registry: { contributes: { agentDefinitionsById: new Map() } } },
      },
      connectedAccountsAuthority: {
        owner: {},
        resolveSessionConnectedAccounts: () => [],
        dispose: h.connectedAccountsDispose,
      },
    },
    preparation: {
      managed: {
        launch: {
          source: 'managed',
          resolvedPath: join(runnerHome, 'agents', 'codex'),
          command: join(runnerHome, 'agents', 'codex'),
          args: [],
        },
      },
      pluginRuntime: {
        selected: { agentId: 'codex', backendId: 'codex' },
        lease: {},
      },
    },
    localState: {
      homeDirectory: runnerHome,
      environment: {
        HAPPIER_HOME_DIR: runnerHome,
        HOME: runnerHome,
        PATH: '/inherited/bin',
        LANG: 'en_US.UTF-8',
      },
      unsetEnvironmentVariables: [],
    },
    signal,
    onRuntimeStopReady: (stop: () => Promise<void>) => {
      if (signal.aborted) void stop();
    },
  } as never;
}

async function start(
  signal = new AbortController().signal,
  invalidate?: 'application' | 'deliveryMode',
  authoringPatch: Record<string, unknown> = {},
  directory = '/workspace',
) {
  const application = await createProductionEphemeralRunnerApplication({
    activationFilePath: '/runner.activation.json',
  });
  return await application.dependencies.startSession(createStartInput(signal, invalidate, authoringPatch, directory));
}

describe('production Runner pre-handle resource custody', () => {
  beforeEach(async () => {
    runnerHome = await createTempDir('happier-runner-custody-');
    vi.stubEnv('HAPPIER_HOME_CARRIER_POLICY', 'automatic');
    for (const mock of Object.values(h)) {
      if (typeof mock === 'function') mock.mockReset();
    }
    h.machineServicesDispose.mockResolvedValue(undefined);
    h.machineClose.mockResolvedValue(undefined);
    h.machineConnect.mockResolvedValue(undefined);
    h.providerRuntimeShutdown.mockResolvedValue(undefined);
    h.machineIrohIngressStop.mockResolvedValue(undefined);
    h.startMachineIrohIngress.mockResolvedValue({ stop: h.machineIrohIngressStop });
    h.providerBindingCleanup.mockResolvedValue(undefined);
    h.ordinarySessionStop.mockResolvedValue(undefined);
    h.terminateMaterializedSession.mockResolvedValue(undefined);
    h.fetchFeatures.mockResolvedValue({
      status: 'ready',
      provenance: 'authenticated',
      features: { capabilities: { machines: { peerMediation: { grantSigningKeys: [] } } } },
    });
    h.createScopedActionSettings.mockImplementation(() => ({
      getActionsSettings: () => ({ v: 1, actions: {} }),
    }));
    h.runScmRoute.mockResolvedValue({ success: true });
    h.createProviderRuntime.mockResolvedValue({
      available: true,
      endpoint: {
        endpointId: 'a'.repeat(64),
        relayUrls: ['https://relay.example.test'],
        directAddresses: ['192.0.2.10:443'],
      },
      startAttemptAcceptor: vi.fn(async () => undefined),
      stopAttemptAcceptor: vi.fn(async () => undefined),
      stopActiveTunnels: vi.fn(async () => undefined),
      openHttpTunnel: vi.fn(),
      shutdown: h.providerRuntimeShutdown,
    });
    h.registerMachineServices.mockReturnValue({
      ensureDirectTransferListening: vi.fn(async () => 47_001),
      dispose: h.machineServicesDispose,
    });
    h.createMachineClient.mockImplementation((input: { registerHandlers(rpc: object): void }) => {
      input.registerHandlers({ registerHandler: vi.fn() });
      return {
        rpc: { invokeLocal: vi.fn() },
        connect: h.machineConnect,
        close: h.machineClose,
        installSessionFollowWakeReceiver: h.installSessionFollowWakeReceiver,
      };
    });
    h.createSessionRuntime.mockResolvedValue({
      kind: 'hostSessionRuntimePlan',
      config: {},
    });
    h.openExactProviderBinding.mockResolvedValue({
      providerBinding: { source: { kind: 'team_resource', resourceId: 'resource-1', resourceRevision: 3 } },
      environmentOverlay: [],
      additionalRedactionValues: [],
      cleanup: h.providerBindingCleanup,
    });
    h.runHostSessionRuntimePlan.mockImplementation(async (plan: { config: { onRuntimeStopReady?(stop: () => Promise<void>): void } }) => {
      plan.config.onRuntimeStopReady?.(h.ordinarySessionStop);
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeTempDir(runnerHome);
  });

  it('does not create a native Provider Machine runtime after Standard-only is selected', async () => {
    vi.stubEnv('HAPPIER_HOME_CARRIER_POLICY', 'standard_only');

    await expect(start()).rejects.toThrow('runner_provider_machine_runtime_unavailable');
    expect(h.createProviderRuntime).not.toHaveBeenCalled();
    expect(h.createMachineClient).not.toHaveBeenCalled();
    expect(h.startMachineIrohIngress).not.toHaveBeenCalled();
    expect(h.terminateMaterializedSession).toHaveBeenCalledOnce();
  });

  it('publishes one persistent Iroh endpoint and opens the exact creator-reviewed Provider binding', async () => {
    h.createSessionRuntime.mockImplementationOnce(async (
      _backendId: string,
      options: { teamCredentialBindings: unknown; profileId?: string | null; sessionModeId?: string; sessionConfigOptionOverrides?: unknown; environmentVariables?: Record<string, string>; resume?: string; terminalRuntime?: unknown; initialAccess?: unknown },
      hostOptions: { prepareTeamCredentialProviderBinding(input: unknown): Promise<unknown> },
    ) => {
      expect(options.teamCredentialBindings).toEqual([{
        v: 1,
        slot: { kind: 'provider_model' },
        resourceId: 'resource-1',
        expectedResourceRevision: 3,
        deliveryMode: 'brokered',
      }]);
      expect(options.profileId).toBe('work');
      expect(options.sessionModeId).toBe('plan');
      expect(options.sessionConfigOptionOverrides).toEqual({
        v: 1,
        updatedAt: 456,
        overrides: { speed: { updatedAt: 456, value: 'fast' } },
      });
      expect(options.environmentVariables).toEqual({
        HAPPIER_HOME_DIR: runnerHome,
        HOME: runnerHome,
        PATH: '/reviewed/bin',
        LANG: 'de_CH.UTF-8',
        RUNNER_PROFILE_TOKEN: 'sealed-secret',
      });
      expect(options.resume).toBe('provider-session-reviewed');
      expect(options.terminalRuntime).toEqual({
        mode: 'tmux',
        requested: 'tmux',
        tmuxTarget: 'runner-reviewed',
        tmuxTmpDir: '/tmp/runner-reviewed',
      });
      expect(options).not.toHaveProperty('initialAccess');
      await hostOptions.prepareTeamCredentialProviderBinding({
        sessionId: 'session-1',
        resourceId: 'resource-1',
        expectedResourceRevision: 3,
        agentTargetKey: 'agent:codex/codex',
        modelId: 'dynamic-model',
        signal: new AbortController().signal,
      });
      return { kind: 'hostSessionRuntimePlan', config: {} };
    });

    const runtime = await start(new AbortController().signal, undefined, {
      access: {
        grants: [{
          subject: { kind: 'account', accountId: 'recipient-1' },
          accessLevel: 'view',
          canApprovePermissions: false,
        }],
      },
    });
    await runtime.terminal;

    expect(h.createProviderRuntime).toHaveBeenCalledWith({
      happyHomeDir: runnerHome,
      relayConfig: { relayPolicy: 'automatic', relayUrls: [], explicitlyConfigured: false },
    });
    expect(h.createMachineClient).toHaveBeenCalledWith(expect.objectContaining({
      irohEndpoint: {
        endpointId: 'a'.repeat(64),
        relayUrls: ['https://relay.example.test'],
        directAddresses: ['192.0.2.10:443'],
      },
    }));
    expect(h.startMachineIrohIngress).toHaveBeenCalledOnce();
    expect(h.startMachineIrohIngress.mock.invocationCallOrder[0])
      .toBeLessThan(h.machineConnect.mock.invocationCallOrder[0]!);
    expect(h.registerMachineServices).toHaveBeenCalledOnce();
    expect(h.registerSourceReceiver).toHaveBeenCalledOnce();
    expect(h.registerSourceReceiver).toHaveBeenCalledWith(expect.objectContaining({
      sourceMaterial: h.sourceMaterial,
      onSourceMaterialInstalled: publishSessionFollowWakeInvalidation,
    }));
    expect(h.runHostSessionRuntimePlan).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        sessionFollowSourceMaterialResolver: h.sourceMaterial,
      }),
    }));
    expect(h.openExactProviderBinding).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      machineId: 'machine-1',
      agentId: 'codex',
      selection: {
        resourceId: 'resource-1',
        brokerMachineId: 'broker-1',
        expectedResourceRevision: 3,
        agentTargetKey: 'agent:codex/codex',
        modelId: 'dynamic-model',
        descriptor: { id: 'dynamic-model', name: 'Dynamic Model' },
        application: {
          agentTargetKey: 'agent:codex/codex',
          implementationIdentity: { pluginId: 'provider', localId: 'provider' },
          endpointTemplateId: 'responses',
          protocol: 'openai-responses',
        },
        sourceRevision: 'source-3',
      },
    }));
    expect(h.openExactProviderBinding.mock.calls[0]?.[0]).not.toHaveProperty('revalidateSelection');
    expect(h.ordinarySessionStop).not.toHaveBeenCalled();
    expect(h.machineIrohIngressStop).toHaveBeenCalledOnce();
    expect(h.providerBindingCleanup).toHaveBeenCalledOnce();
    expect(h.providerRuntimeShutdown).toHaveBeenCalledOnce();
  });

  it('materializes the reviewed checkout through the canonical SCM owner and feeds its directory to Machine services and the Agent runtime', async () => {
    h.realizeWorkspaceCheckout.mockResolvedValueOnce({
      sourceRootPath: '/workspace/repository',
      realization: {
        targetPath: '/workspace/repository/.dev/worktree/runner-reviewed',
        branchName: 'runner-reviewed',
        created: true,
      },
    });

    h.createSessionRuntime.mockImplementationOnce(async (_backendId: string, options: { directory: string; resume?: string; terminalRuntime?: unknown }) => {
      expect(options.directory).toBe('/workspace/repository/.dev/worktree/runner-reviewed/packages/app');
      expect(options.resume).toBe('provider-session-checkout');
      expect(options.terminalRuntime).toEqual({ mode: 'plain', requested: 'plain' });
      expect(h.registerMachineServices).toHaveBeenCalledWith(expect.objectContaining({
        workingDirectory: options.directory,
      }));
      return { kind: 'hostSessionRuntimePlan', config: {} };
    });

    const runtime = await start(new AbortController().signal, undefined, {
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'runner-reviewed',
        baseRef: null,
        branchMode: 'new',
      },
      resumeSessionId: 'provider-session-checkout',
      terminal: { mode: 'plain' },
    }, '/workspace/repository/packages/app');
    await expect(runtime.terminal).resolves.toEqual({ status: 'completed' });
    expect(h.realizeWorkspaceCheckout).toHaveBeenCalledWith({
      sourcePath: '/workspace/repository/packages/app',
      checkoutCreation: {
        kind: 'git_worktree',
        displayName: 'runner-reviewed',
        baseRef: null,
        branchMode: 'new',
      },
    });
  });

  it('does not create a reviewed checkout after cancellation wins before preparation', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(start(controller.signal, undefined, {
      checkoutCreationDraft: { kind: 'git_worktree', displayName: 'must-not-exist', baseRef: null },
    }, '/workspace/repository')).rejects.toBeDefined();
    expect(h.realizeWorkspaceCheckout).not.toHaveBeenCalled();
    expect(h.createProviderRuntime).not.toHaveBeenCalled();
  });

  it('retains the prepared checkout when cancellation wins without exclusive checkout custody', async () => {
    const controller = new AbortController();
    const checkoutPath = join(runnerHome, '.dev', 'worktree', 'cancelled');
    await mkdir(checkoutPath, { recursive: true });
    const retainedFile = join(checkoutPath, 'accepted-by-another-consumer.txt');
    await writeFile(retainedFile, 'retained checkout contents');
    h.realizeWorkspaceCheckout.mockImplementationOnce(async () => {
      controller.abort(new Error('cancelled-during-checkout'));
      return {
        sourceRootPath: runnerHome,
        realization: {
          targetPath: checkoutPath,
          branchName: 'cancelled',
          created: true,
        },
      };
    });

    await expect(start(controller.signal, undefined, {
      checkoutCreationDraft: { kind: 'git_worktree', displayName: 'cancelled', baseRef: null },
    }, runnerHome)).rejects.toBeDefined();

    expect(h.runScmRoute).not.toHaveBeenCalled();
    await expect(readFile(retainedFile, 'utf8')).resolves.toBe('retained checkout contents');
    expect(h.createProviderRuntime).not.toHaveBeenCalled();
  });

  it('rejects a substituted Session before opening the sealed Provider selection', async () => {
    h.createSessionRuntime.mockImplementationOnce(async (
      _backendId: string,
      _options: unknown,
      hostOptions: { prepareTeamCredentialProviderBinding(input: unknown): Promise<unknown> },
    ) => {
      await hostOptions.prepareTeamCredentialProviderBinding({
        sessionId: 'session-other',
        resourceId: 'resource-1',
        expectedResourceRevision: 3,
        agentTargetKey: 'agent:codex/codex',
        modelId: 'dynamic-model',
        signal: new AbortController().signal,
      });
      return { kind: 'hostSessionRuntimePlan', config: {} };
    });

    await expect(start()).rejects.toThrow(
      'runner_provider_model_selection_changed',
    );
    expect(h.openExactProviderBinding).not.toHaveBeenCalled();
    expect(h.machineClose).toHaveBeenCalledOnce();
    expect(h.machineServicesDispose).toHaveBeenCalledOnce();
    expect(h.providerRuntimeShutdown).toHaveBeenCalledOnce();
  });

  it.each([
    ['resource', 'resource-other', 3],
    ['resource revision', 'resource-1', 4],
  ])('rejects a substituted Provider %s before opening the sealed selection', async (
    _label,
    resourceId,
    expectedResourceRevision,
  ) => {
    h.createSessionRuntime.mockImplementationOnce(async (
      _backendId: string,
      _options: unknown,
      hostOptions: { prepareTeamCredentialProviderBinding(input: unknown): Promise<unknown> },
    ) => {
      await hostOptions.prepareTeamCredentialProviderBinding({
        sessionId: 'session-1',
        resourceId,
        expectedResourceRevision,
        agentTargetKey: 'agent:codex/codex',
        modelId: 'dynamic-model',
        signal: new AbortController().signal,
      });
      return { kind: 'hostSessionRuntimePlan', config: {} };
    });

    await expect(start()).rejects.toThrow(
      'runner_provider_model_selection_changed',
    );
    expect(h.openExactProviderBinding).not.toHaveBeenCalled();
    expect(h.machineClose).toHaveBeenCalledOnce();
    expect(h.machineServicesDispose).toHaveBeenCalledOnce();
    expect(h.providerRuntimeShutdown).toHaveBeenCalledOnce();
  });

  it('rejects a non-brokered reviewed Provider route before creating runtime resources', async () => {
    await expect(start(new AbortController().signal, 'deliveryMode')).rejects.toThrow(
      'runner_provider_delivery_mode_changed',
    );
    expect(h.createProviderRuntime).not.toHaveBeenCalled();
    expect(h.createMachineClient).not.toHaveBeenCalled();
    expect(h.createSessionRuntime).not.toHaveBeenCalled();
  });

  it('rejects a sidecar application that differs from the sealed reviewed model', async () => {
    h.createSessionRuntime.mockImplementationOnce(async (
      _backendId: string,
      _options: unknown,
      hostOptions: { prepareTeamCredentialProviderBinding(input: unknown): Promise<unknown> },
    ) => {
      await hostOptions.prepareTeamCredentialProviderBinding({
        sessionId: 'session-1',
        resourceId: 'resource-1',
        expectedResourceRevision: 3,
        agentTargetKey: 'agent:codex/codex',
        modelId: 'dynamic-model',
        signal: new AbortController().signal,
      });
      return { kind: 'hostSessionRuntimePlan', config: {} };
    });

    await expect(start(new AbortController().signal, 'application')).rejects.toThrow(
      'runner_provider_model_selection_changed',
    );
    expect(h.openExactProviderBinding).not.toHaveBeenCalled();
    expect(h.machineClose).toHaveBeenCalledOnce();
    expect(h.machineServicesDispose).toHaveBeenCalledOnce();
    expect(h.providerRuntimeShutdown).toHaveBeenCalledOnce();
  });

  it('releases Follow and Iroh resources when persistent Provider runtime construction fails', async () => {
    h.createProviderRuntime.mockRejectedValueOnce(new Error('iroh-start-failed'));

    await expect(start()).rejects.toThrow('iroh-start-failed');
    expect(h.sourceDispose).toHaveBeenCalledOnce();
    expect(h.createMachineClient).not.toHaveBeenCalled();
  });

  it('releases source material when Machine-client construction fails', async () => {
    h.createMachineClient.mockImplementation(() => {
      throw new Error('machine-construction-failed');
    });

    await expect(start()).rejects.toThrow('machine-construction-failed');
    expect(h.sourceDispose).toHaveBeenCalledOnce();
    expect(h.providerRuntimeShutdown).toHaveBeenCalledOnce();
    expect(h.machineServicesDispose).not.toHaveBeenCalled();
    expect(h.machineClose).not.toHaveBeenCalled();
  });

  it('uses the exact creator-reviewed scoped Actions policy without ambient fallback', async () => {
    h.runHostSessionRuntimePlan.mockRejectedValueOnce(new Error('stop-after-policy-binding'));

    const runtime = await start();
    await expect(runtime.terminal).resolves.toMatchObject({
      status: 'failed',
      error: expect.objectContaining({ message: 'stop-after-policy-binding' }),
    });

    expect(h.createScopedActionSettings).toHaveBeenCalledWith({
      v: 1,
      actions: {
        'session.activity.get': { approvalRequiredSurfaces: [] },
      },
    });
    const scopedProvider = h.createScopedActionSettings.mock.results.at(-1)?.value;
    expect(scopedProvider).toBeDefined();
    expect(h.runHostSessionRuntimePlan).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        runtimeActionSettingsProvider: scopedProvider,
      }),
    }));
  });

  it('composes creator selection through the sealed manifest and endpoint materializer into the ordinary host bridge', async () => {
    const runtime = await start();
    await expect(runtime.terminal).resolves.toEqual({ status: 'completed' });

    expect(h.runHostSessionRuntimePlan).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        resolvedMcpServers: {
          reviewed: expect.objectContaining({
            env: expect.objectContaining({ HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: expect.any(String) }),
          }),
        },
      }),
    }));
    const plan: { config: { resolvedMcpServers: Record<string, { env: Record<string, string> }> } } =
      h.runHostSessionRuntimePlan.mock.calls[0]![0];
    const sidecarPath = plan.config.resolvedMcpServers.reviewed!.env.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE!;
    expect(sidecarPath).toContain(join(runnerHome, 'tmp'));
    expect(JSON.parse(await readFile(sidecarPath, 'utf8'))).toMatchObject({
      command: '/runner/bin/reviewed-mcp', args: ['serve'], env: { REVIEWED_SECRET: 'sealed-mcp-secret' },
    });
    expect(JSON.stringify(plan.config.resolvedMcpServers)).not.toContain('sealed-mcp-secret');
    // Secret material remains in the protected sidecar rather than transport
    // arguments or the host MCP launch environment.
    expect(h.createMachineClient.mock.calls[0]?.[0]).not.toHaveProperty('mcpMaterial');
    expect(h.createSessionRuntime.mock.calls[0]?.[1]).not.toHaveProperty('mcpMaterial');
    expect(h.machineClose).toHaveBeenCalledOnce();
  });

  it('publishes Runner ready through the ordinary committed Session event with Home owner delivery', async () => {
    const enqueueSessionEventCommitted = vi.fn(async () => ({ persisted: true, delivered: true }));
    h.runHostSessionRuntimePlan.mockImplementationOnce(async (plan: {
      config: {
        createSendReady(params: { session: unknown }): () => void | Promise<void>;
        onRuntimeStopReady?(stop: () => Promise<void>): void;
      };
    }) => {
      const sendReady = plan.config.createSendReady({
        session: { sessionId: 'session-1', enqueueSessionEventCommitted },
      });
      await sendReady();
      plan.config.onRuntimeStopReady?.(h.ordinarySessionStop);
    });

    const runtime = await start();
    await expect(runtime.terminal).resolves.toEqual({ status: 'completed' });
    expect(enqueueSessionEventCommitted).toHaveBeenCalledWith({
      type: 'ready',
      ownerActivityDelivery: 'home_required',
    });
  });

  it('releases already-created Machine services when later handler registration fails', async () => {
    h.registerSourceReceiver.mockImplementation(() => {
      throw new Error('receiver-registration-failed');
    });

    await expect(start()).rejects.toThrow('receiver-registration-failed');
    expect(h.machineServicesDispose).toHaveBeenCalledOnce();
    expect(h.sourceDispose).toHaveBeenCalledOnce();
    expect(h.providerRuntimeShutdown).toHaveBeenCalledOnce();
    expect(h.machineClose).not.toHaveBeenCalled();
  });

  it('closes every acquired Machine resource exactly once when required handlers are absent', async () => {
    h.registerMachineServices.mockReturnValue(null);

    await expect(start()).rejects.toThrow('runner_machine_services_not_registered');
    expect(h.machineClose).toHaveBeenCalledOnce();
    expect(h.sourceDispose).toHaveBeenCalledOnce();
    expect(h.providerRuntimeShutdown).toHaveBeenCalledOnce();
  });

  it('does not connect or publish Machine capabilities when Iroh ingress cannot start', async () => {
    h.startMachineIrohIngress.mockRejectedValueOnce(new Error('acceptor-start-failed'));

    await expect(start()).rejects.toThrow('acceptor-start-failed');
    expect(h.machineConnect).not.toHaveBeenCalled();
    expect(h.machineClose).toHaveBeenCalledOnce();
    expect(h.machineServicesDispose).toHaveBeenCalledOnce();
    expect(h.sourceDispose).toHaveBeenCalledOnce();
    expect(h.providerRuntimeShutdown).toHaveBeenCalledOnce();
  });

  it('rejects public feature fallback before it can authorize Provider Machine brokerage', async () => {
    h.fetchFeatures.mockResolvedValueOnce({
      status: 'ready',
      provenance: 'public',
      features: { capabilities: { machines: { peerMediation: { grantSigningKeys: [] } } } },
    });

    await expect(start()).rejects.toThrow('runner_provider_trust_roots_unavailable');
    expect(h.createMachineClient).not.toHaveBeenCalled();
    expect(h.startMachineIrohIngress).not.toHaveBeenCalled();
    expect(h.sourceDispose).toHaveBeenCalledOnce();
    expect(h.providerRuntimeShutdown).toHaveBeenCalledOnce();
  });

  it.each([
    ['Machine connection', () => h.machineConnect.mockRejectedValueOnce(new Error('connect-failed'))],
    ['Session runtime planning', () => h.createSessionRuntime.mockRejectedValueOnce(new Error('plan-failed'))],
  ])('closes every acquired resource exactly once after %s fails', async (_label, arrange) => {
    arrange();

    await expect(start()).rejects.toThrow();
    expect(h.machineServicesDispose).toHaveBeenCalledOnce();
    expect(h.machineClose).toHaveBeenCalledOnce();
    expect(h.sourceDispose).toHaveBeenCalledOnce();
    expect(h.machineClose.mock.invocationCallOrder[0]).toBeLessThan(
      h.machineServicesDispose.mock.invocationCallOrder[0]!,
    );
  });

  it('cancels startup after Machine connect and uses the pre-host ordinary Session terminal owner', async () => {
    const controller = new AbortController();
    h.machineConnect.mockImplementationOnce(async () => {
      controller.abort(new Error('cancelled-after-connect'));
    });

    await expect(start(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.runHostSessionRuntimePlan).not.toHaveBeenCalled();
    expect(h.terminateMaterializedSession).toHaveBeenCalledOnce();
    expect(h.ordinarySessionStop).not.toHaveBeenCalled();
    expect(h.machineServicesDispose).toHaveBeenCalledOnce();
    expect(h.machineClose).toHaveBeenCalledOnce();
    expect(h.sourceDispose).toHaveBeenCalledOnce();
  });

  it('terminalizes without creating startup resources when post-materialization start is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('materialization-response-arrived-after-stop'));

    await expect(start(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.createProviderRuntime).not.toHaveBeenCalled();
    expect(h.createSessionRuntime).not.toHaveBeenCalled();
    expect(h.runHostSessionRuntimePlan).not.toHaveBeenCalled();
    expect(h.terminateMaterializedSession).toHaveBeenCalledOnce();
    expect(h.ordinarySessionStop).not.toHaveBeenCalled();
    expect(h.machineServicesDispose).not.toHaveBeenCalled();
    expect(h.machineClose).not.toHaveBeenCalled();
    expect(h.sourceDispose).not.toHaveBeenCalled();
  });

  it('cancels pending post-materialization startup and terminalizes the ordinary Session before the host runtime exists', async () => {
    const featureSignal = { current: null as AbortSignal | null };
    h.fetchFeatures.mockImplementationOnce(async (input: { signal?: AbortSignal }) => {
      featureSignal.current = input.signal ?? null;
      return await new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('startup-cancelled'), { name: 'AbortError' }));
        input.signal?.addEventListener('abort', onAbort, { once: true });
      });
    });
    const stopOwner = { current: null as (() => Promise<void>) | null };
    const application = await createProductionEphemeralRunnerApplication({
      activationFilePath: '/runner.activation.json',
    });
    const starting = application.dependencies.startSession(Object.assign(
      createStartInput(new AbortController().signal),
      { onRuntimeStopReady: (stop: () => Promise<void>) => { stopOwner.current = stop; } },
    ));

    await vi.waitFor(() => expect(featureSignal.current).not.toBeNull());
    const publishedStopOwner = stopOwner.current;
    if (!publishedStopOwner) throw new Error('Runner did not publish its post-materialization Stop owner');
    await expect(publishedStopOwner()).resolves.toBeUndefined();
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });

    expect(featureSignal.current?.aborted).toBe(true);
    expect(h.createSessionRuntime).not.toHaveBeenCalled();
    expect(h.runHostSessionRuntimePlan).not.toHaveBeenCalled();
    expect(h.terminateMaterializedSession).toHaveBeenCalledOnce();
    expect(h.machineClose).not.toHaveBeenCalled();
    expect(h.sourceDispose).toHaveBeenCalledOnce();
    expect(h.providerRuntimeShutdown).toHaveBeenCalledOnce();
  });

  it('lets the registered restricted Machine Stop cancel startup before the host runtime exists', async () => {
    const machineConnectSignal = { current: null as AbortSignal | null };
    h.machineConnect.mockImplementationOnce(async (input?: { signal: AbortSignal }) => {
      if (!input) throw new Error('Runner Machine connection did not receive startup cancellation');
      machineConnectSignal.current = input.signal;
      return await new Promise<undefined>((_resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('startup-cancelled-by-machine-stop'), { name: 'AbortError' }));
        input.signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    const starting = start();
    await vi.waitFor(() => expect(h.registerMachineServices).toHaveBeenCalledOnce());
    const registered = h.registerMachineServices.mock.calls[0]?.[0] as
      | { stopSession(sessionId: string): Promise<{ status: 'requested' | 'stopped' | 'not_found' }> }
      | undefined;
    if (!registered) throw new Error('Runner did not register restricted Machine services');

    await expect(registered.stopSession('different-session')).resolves.toEqual({ status: 'not_found' });
    expect(machineConnectSignal.current?.aborted).toBe(false);
    await expect(Promise.race([
      registered.stopSession('session-1'),
      Promise.resolve({ status: 'handler_still_waiting' as const }),
    ])).resolves.toEqual({ status: 'requested' });
    await expect(registered.stopSession('session-1')).resolves.toEqual({ status: 'requested' });
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });

    expect(machineConnectSignal.current?.aborted).toBe(true);
    expect(h.createSessionRuntime).not.toHaveBeenCalled();
    expect(h.runHostSessionRuntimePlan).not.toHaveBeenCalled();
    expect(h.terminateMaterializedSession).toHaveBeenCalledOnce();
    expect(h.ordinarySessionStop).not.toHaveBeenCalled();
    expect(h.machineClose).toHaveBeenCalledOnce();
    expect(h.machineServicesDispose).toHaveBeenCalledOnce();
    expect(h.sourceDispose).toHaveBeenCalledOnce();
    expect(h.providerRuntimeShutdown).toHaveBeenCalledOnce();
  });

  it('acknowledges restricted Machine Stop without waiting for ready-runtime terminal cleanup', async () => {
    let finishOrdinaryStop!: () => void;
    h.ordinarySessionStop.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      finishOrdinaryStop = () => resolve(undefined);
    }));
    let finishHostRuntime!: () => void;
    h.runHostSessionRuntimePlan.mockImplementationOnce(async (
      plan: { config: { onRuntimeStopReady?(stop: () => Promise<void>): void } },
    ) => {
      plan.config.onRuntimeStopReady?.(h.ordinarySessionStop);
      await new Promise<void>((resolve) => {
        finishHostRuntime = resolve;
      });
    });

    const runtime = await start();
    const registered = h.registerMachineServices.mock.calls[0]?.[0] as
      | { stopSession(sessionId: string): Promise<{ status: 'requested' | 'stopped' | 'not_found' }> }
      | undefined;
    if (!registered) throw new Error('Runner did not register restricted Machine services');

    await expect(Promise.race([
      registered.stopSession('session-1'),
      Promise.resolve({ status: 'handler_waited_for_terminal_cleanup' as const }),
    ])).resolves.toEqual({ status: 'requested' });
    await vi.waitFor(() => expect(h.ordinarySessionStop).toHaveBeenCalledOnce());

    finishOrdinaryStop();
    finishHostRuntime();
    await expect(runtime.terminal).resolves.toEqual({ status: 'completed' });
    await expect(registered.stopSession('session-1')).resolves.toEqual({ status: 'stopped' });

    expect(h.ordinarySessionStop).toHaveBeenCalledOnce();
    expect(h.machineClose).toHaveBeenCalledOnce();
    expect(h.machineServicesDispose).toHaveBeenCalledOnce();
    expect(h.sourceDispose).toHaveBeenCalledOnce();
    expect(h.providerRuntimeShutdown).toHaveBeenCalledOnce();
  });

  it.each([
    ['startup coordinator', new Error('startup-coordinator-failed')],
    ['prompt loop', new Error('prompt-loop-failed')],
  ])('terminalizes the ordinary Session exactly once when the %s fails after materialization', async (_label, failure) => {
    h.runHostSessionRuntimePlan.mockImplementationOnce(async (
      plan: { config: { onRuntimeStopReady?(stop: () => Promise<void>): void } },
    ) => {
      plan.config.onRuntimeStopReady?.(h.ordinarySessionStop);
      throw failure;
    });

    const runtime = await start();
    await expect(runtime.terminal).resolves.toEqual({ status: 'failed', error: failure });
    await expect(runtime.stop()).resolves.toBeUndefined();

    expect(h.terminateMaterializedSession).not.toHaveBeenCalled();
    expect(h.ordinarySessionStop).toHaveBeenCalledOnce();
    expect(h.machineClose).toHaveBeenCalledOnce();
    expect(h.machineServicesDispose).toHaveBeenCalledOnce();
    expect(h.sourceDispose).toHaveBeenCalledOnce();
  });

  it('cancels startup after plan creation and uses the pre-host ordinary Session terminal owner', async () => {
    const controller = new AbortController();
    h.createSessionRuntime.mockImplementationOnce(async () => {
      controller.abort(new Error('cancelled-after-plan'));
      return { kind: 'hostSessionRuntimePlan', config: {} };
    });

    await expect(start(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.runHostSessionRuntimePlan).not.toHaveBeenCalled();
    expect(h.terminateMaterializedSession).toHaveBeenCalledOnce();
    expect(h.ordinarySessionStop).not.toHaveBeenCalled();
    expect(h.machineServicesDispose).toHaveBeenCalledOnce();
    expect(h.machineClose).toHaveBeenCalledOnce();
    expect(h.sourceDispose).toHaveBeenCalledOnce();
  });

  it('routes terminal restricted-Machine authentication loss through ordinary Session Stop', async () => {
    h.runHostSessionRuntimePlan.mockImplementationOnce(async (
      plan: { config: { onRuntimeStopReady?(stop: () => Promise<void>): void } },
    ) => {
      plan.config.onRuntimeStopReady?.(h.ordinarySessionStop);
      const machineInput = h.createMachineClient.mock.calls[0]?.[0] as
        | { onTerminalConnectionFailure?: () => void }
        | undefined;
      machineInput?.onTerminalConnectionFailure?.();
      await Promise.resolve();
    });

    const runtime = await start();
    await expect(runtime.terminal).resolves.toEqual({ status: 'completed' });

    expect(h.ordinarySessionStop).toHaveBeenCalledOnce();
    expect(h.machineClose).toHaveBeenCalledOnce();
    expect(h.sourceDispose).toHaveBeenCalledOnce();
  });
});
