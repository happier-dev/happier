import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  createProviderErrorV1,
  isConnectedServiceUxDiagnosticSpawnErrorDetail,
  type ConnectedServiceBindingsV1,
  type ProviderRuntimeBindingBasisV1,
} from '@happier-dev/protocol';
import type { VendorResumeSupportParams } from '@/agent/catalog/types';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServices/connectedServiceChildEnvironment';
import { consumeProviderBindingLaunchHandoffFromEnvironments } from '@/plugins/runtime/providerBindings/handoff';
import type { ProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';

const HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY =
  'HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON';

type MockEnsureSessionDirectoryResult =
  | { ok: true; directoryCreated: boolean }
  | {
      ok: false;
      response: {
        type: string;
        errorCode: string;
        errorMessage: string;
      };
    };

const hoisted = vi.hoisted(() => {
  const vendorResumeSupport = vi.fn((_: VendorResumeSupportParams) => false);
  const resolveSpawnBackendIdentity = vi.fn();
  const getVendorResumeSupport = vi.fn(async () => vendorResumeSupport);
  const requireCatalogEntry = vi.fn();
  const refreshAccountSettingsForMinimumVersion = vi.fn();
  const acquireAuthoritativePluginRuntimeRegistryLease = vi.fn();
  const resolveMergedContributionRegistry = vi.fn();
  const createRuntimeProviderSpawnAuthorizationAttempt = vi.fn();
  const prepareDaemonManagedProviderBinding = vi.fn();
  const getActiveAccountSettingsSnapshot = vi.fn<() => unknown>(() => null);
  const ensureSessionDirectory = vi.fn<() => Promise<MockEnsureSessionDirectoryResult>>(async () => ({
    ok: false,
    response: {
      type: 'error',
      errorCode: 'directory_setup_failed',
      errorMessage: 'Directory setup failed.',
    },
  }));

  return {
    vendorResumeSupport,
    resolveSpawnBackendIdentity,
    getVendorResumeSupport,
    requireCatalogEntry,
    refreshAccountSettingsForMinimumVersion,
    acquireAuthoritativePluginRuntimeRegistryLease,
    resolveMergedContributionRegistry,
    createRuntimeProviderSpawnAuthorizationAttempt,
    prepareDaemonManagedProviderBinding,
    getActiveAccountSettingsSnapshot,
    ensureSessionDirectory,
  };
});

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

vi.mock('@/session/runtime/catalogHooks', () => ({
  getVendorResumeSupport: hoisted.getVendorResumeSupport,
}));

vi.mock('@/agent/catalog/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/catalog/registry')>();
  return {
    ...actual,
    requireCatalogEntry: hoisted.requireCatalogEntry,
  };
});

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/tmp/happier-home',
    activeServerDir: '/tmp/happier-home/servers/active',
    activeServerId: 'dev-local',
    serverUrl: 'http://dev-public.example.test',
    apiServerUrl: 'http://127.0.0.1:53288',
    publicServerUrl: 'http://dev-public.example.test',
    webappUrl: 'http://dev-web.example.test',
  },
}));

vi.mock('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion', () => ({
  refreshAccountSettingsForMinimumVersion: hoisted.refreshAccountSettingsForMinimumVersion,
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
  getActiveAccountSettingsSnapshot: hoisted.getActiveAccountSettingsSnapshot,
}));

vi.mock('@/terminal/runtime/terminalConfig', () => ({
  resolveTerminalRequestFromSpawnOptions: vi.fn(() => null),
}));

vi.mock('@/terminal/runtime/envVarSanitization', () => ({
  validateEnvVarRecordStrict: vi.fn(() => ({ ok: true, env: {} })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@/session/backendTargets/resolveConcreteBackendTargetRefs', () => ({
  resolveConcreteCompatBackendTargetRefs: vi.fn(),
  resolveConcreteBackendTargetRefV2: vi.fn(),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: hoisted.acquireAuthoritativePluginRuntimeRegistryLease,
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>();
  return {
    ...actual,
    resolveMergedContributionRegistry: hoisted.resolveMergedContributionRegistry,
  };
});

vi.mock('../spawn/resolveSpawnBackendIdentity', () => ({
  resolveSpawnBackendIdentity: hoisted.resolveSpawnBackendIdentity,
}));

vi.mock('../spawn/resolveSpawnChildEnvironment', () => ({
  resolveSpawnChildEnvironment: vi.fn(),
}));

vi.mock('@/providers/spawn/authorize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/spawn/authorize')>();
  return {
    ...actual,
    createRuntimeProviderSpawnAuthorizationAttempt: hoisted.createRuntimeProviderSpawnAuthorizationAttempt,
  };
});

vi.mock('../spawn/prepareDaemonManagedProviderBinding', () => ({
  prepareDaemonManagedProviderBinding: hoisted.prepareDaemonManagedProviderBinding,
}));

vi.mock('../spawn/resolveStackProcessKindOverrideForSessionSpawn', () => ({
  resolveStackProcessKindOverrideForSessionSpawn: vi.fn(),
}));

vi.mock('../spawn/createSpawnLifecycleCallbacks', () => ({
  createSpawnLifecycleCallbacks: vi.fn(),
}));

vi.mock('../spawn/routeSpawnModeAndWaitForWebhook', () => ({
  routeSpawnModeAndWaitForWebhook: vi.fn(),
}));

vi.mock('../spawn/resolveSpawnBackendIdentity', () => ({
  resolveSpawnBackendIdentity: hoisted.resolveSpawnBackendIdentity,
}));

vi.mock('../connectedServices/resolveConnectedServiceAuthForSpawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../connectedServices/resolveConnectedServiceAuthForSpawn')>();
  return {
    ...actual,
    resolveConnectedServiceAuthForSpawn: vi.fn(),
  };
});

vi.mock('../connectedServices/shouldResolveConnectedServiceAuthForSpawn', () => ({
  shouldResolveConnectedServiceAuthForSpawn: vi.fn(() => false),
}));

vi.mock('./ensureSessionDirectory', () => ({
  ensureSessionDirectory: hoisted.ensureSessionDirectory,
}));

vi.mock('../sessionAttachFile', () => ({
  createSessionAttachFile: vi.fn(),
}));

vi.mock('../processSupervision/sessionRunnerRespawnDescriptor', () => ({
  SessionRunnerRespawnDescriptorV1Schema: z.any(),
  buildTrackedSessionRespawnEnvironmentVariables: vi.fn(),
}));

function createParams() {
  return {
    options: {
      directory: '/tmp/project',
      sessionId: 'session-1',
      resume: 'vendor-session-1',
      experimentalCodexAcp: true,
    },
    credentials: {
      token: 'token-1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array([1, 2, 3]),
      },
    },
    api: {} as never,
    loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
    connectedServicesMaterializationBaseDir: '/tmp/connected-services',
    connectedServiceRefreshCoordinator: null,
    connectedServiceQuotasCoordinator: null,
    connectedServiceRuntimeRegistry: { registerTarget: vi.fn() },
    pidToTrackedSession: new Map(),
    pidToAwaiter: new Map(),
    pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(),
    resolveCanonicalTrackedSessionId: vi.fn(() => 'tracked-session-1'),
    onChildExited: vi.fn(),
    spawnResourceCleanupByPid: new Map(),
    sessionAttachCleanupByPid: new Map(),
    processEnv: {},
  } as const;
}

function createRegistryWithBackendOwners(ownersByBackendId: Record<string, string>) {
  return {
    agentDefinitionsById: new Map(
      Object.entries(ownersByBackendId).map(([agentId, pluginId]) => [
        agentId,
        {
          pluginId,
          definition: { id: agentId },
        },
      ]),
    ),
    agentRuntimeDefinitionsById: new Map(
      Object.entries(ownersByBackendId).map(([backendId, pluginId]) => [
        backendId,
        {
          id: backendId,
          agentId: backendId,
          pluginId,
        },
      ]),
    ),
  };
}

async function configureProviderBoundExistingSessionSpawn(input: Readonly<{
  providerCleanupFailure?: Error;
}> = {}) {
  const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
  const runtimeBindingBasis = {
    v: 1,
    deployment: { kind: 'external' },
    agentTargetKey: 'backend:codex',
    connectionId,
    contributionKey: 'plugin.gateway/gateway',
    endpoint: {
      endpointTemplateId: 'responses',
      normalizedUrl: 'https://provider.example/v1',
      protocol: 'openai-responses',
      publicHeaders: {},
    },
    runtimeCredentialTransport: {
      id: 'bearer',
      protocols: ['openai-responses'],
      uses: ['runtime'],
      destination: {
        kind: 'httpHeader',
        name: 'authorization',
        format: 'bearer',
      },
    },
    prepared: {
      v: 1,
      materialization: 'engineConfig',
      adapterBindingKey: 'gateway',
    },
    adapterVersion: 1,
    credentialAuthorization: {
      connectionSecurityFingerprint: 'connection-security',
      grantFingerprint: 'grant',
      selectedSecretBindingId: 'secret-a',
      selectedSecretRecordFingerprint: 'secret-record-a',
    },
    agentSupport: {
      acceptsProtocols: ['openai-responses'],
      required: { streaming: true },
      credentialSupport: {
        supportsNoAuth: false,
        apiKeyTransports: [{
          protocol: 'openai-responses',
          destination: {
            kind: 'httpHeader',
            names: ['authorization'],
            formats: ['bearer'],
          },
        }],
      },
      authIsolation: {
        suppressConnectedServiceIds: [],
        ownedEnvKeys: ['PROVIDER_KEY'],
      },
      materialization: 'engineConfig',
      applyPolicy: 'live',
      supportsFreeformModelIds: true,
    },
  } satisfies ProviderRuntimeBindingBasisV1;
  const sessionBindingMetadata = {
    v: 1 as const,
    connectionId,
    contributionKey: 'plugin.gateway/gateway',
    connectionRevision: 2,
    protocol: 'openai-responses' as const,
    materialization: 'engineConfig' as const,
    adapterBindingKey: 'gateway',
    compatibilityFingerprint: 'compatibility-v1',
    bindingSecurityFingerprint: 'security-v1',
    runtimeBindingBasis,
    displaySnapshot: {
      providerName: 'Gateway',
      connectionName: 'Work',
      connectionRole: 'named' as const,
      connectionDisplayNameMode: 'custom' as const,
    },
  };
  const attachCleanup = vi.fn(async () => undefined);
  const providerCleanupOnFailure = vi.fn(async () => {
    if (input.providerCleanupFailure) {
      throw input.providerCleanupFailure;
    }
  });
  const providerCleanupOnExit = vi.fn(async () => undefined);
  const releaseRuntimeRegistryLease = vi.fn(async () => undefined);
  const revalidateBeforeCommit = vi.fn<ProviderSpawnAuthorizationAttempt['revalidateBeforeCommit']>(
    async () => ({ ok: true }),
  );

  hoisted.requireCatalogEntry.mockReturnValue({});
  hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
    ok: true,
    normalizedExistingSessionId: 'existing-session-1',
    effectiveResume: '',
    effectiveBackendTargetV2: {
      kind: 'backend',
      sourceKind: 'built_in',
      backendId: 'codex',
    },
    sessionAttachPayload: { v: 2, encryptionMode: 'plain' },
    catalogAgentId: 'codex',
  });
  hoisted.ensureSessionDirectory.mockResolvedValueOnce({ ok: true, directoryCreated: false });
  hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValueOnce({
    registry: {
      contributes: createRegistryWithBackendOwners({ codex: 'happier.agent.codex' }),
      agentRuntimesByAgentId: new Map(),
    },
    source: 'active',
    release: releaseRuntimeRegistryLease,
  });
  hoisted.createRuntimeProviderSpawnAuthorizationAttempt.mockResolvedValueOnce({
    ok: true,
    attempt: {
      deployment: { kind: 'external' },
      authorization: {
        ticket: { connectionId },
        binding: { selection: { model: { id: 'model-a', name: 'Model A' } } },
        support: {
          authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['PROVIDER_KEY'] },
        },
        sessionBindingMetadata,
      },
      materializeAfterHooks: vi.fn(async () => ({
        ok: true as const,
        materialization: {
          providerEnvironmentOverlay: [
            { name: 'PROVIDER_KEY', value: 'secret', source: 'provider' as const },
          ],
          launchMaterialization: {
            v: 1 as const,
            kind: 'engineConfig' as const,
            engineConfig: { provider: 'gateway' },
          },
          additionalRedactionValues: [],
          cleanup: null,
        },
        redactionLease: {
          redact: (value: string) => value.replaceAll('secret', '[REDACTED]'),
          values: () => ['secret'],
          add: () => undefined,
          snapshotRedactor: () => (value: string) => value.replaceAll('secret', '[REDACTED]'),
          createStreamingSanitizer: () => ({
            push: (value: string | Uint8Array) => String(value).replaceAll('secret', '[REDACTED]'),
            flush: () => '',
          }),
          close: vi.fn(),
        },
      })),
      revalidateBeforeCommit,
      cleanupOnFailure: providerCleanupOnFailure,
      takeCleanupOnExit: () => providerCleanupOnExit,
    },
  });

  const { createSessionAttachFile } = await import('../sessionAttachFile');
  const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
  vi.mocked(createSessionAttachFile).mockResolvedValueOnce({
    filePath: '/tmp/happier-home/attach/existing-session-1.json',
    cleanup: attachCleanup,
  });
  vi.mocked(resolveSpawnChildEnvironment).mockImplementation(
    async (input): ReturnType<typeof resolveSpawnChildEnvironment> => {
      if (input.providerBindingPrerequisitesOnly) {
        return {
          ok: true,
          cleanupOnFailure: null,
          cleanupOnExit: null,
          expandedEnvironmentVariables: {},
          extraEnvForChild: {},
        };
      }
      const late = await input.materializeProviderBindingAfterHooks?.();
      if (!late?.ok) throw new Error('Expected successful late Provider materialization');
      return {
        ok: true,
        cleanupOnFailure: null,
        cleanupOnExit: null,
        expandedEnvironmentVariables: {},
        extraEnvForChild: { PROVIDER_KEY: 'secret' },
        providerEnvKeys: ['PROVIDER_KEY'],
        providerBindingLaunchHandoff: late.providerBindingLaunchHandoff,
      };
    },
  );

  return {
    attachCleanup,
    connectionId,
    providerCleanupOnExit,
    providerCleanupOnFailure,
    releaseRuntimeRegistryLease,
    revalidateBeforeCommit,
    sessionBindingMetadata,
  };
}

describe('executeSpawnSessionRequest', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const [
      { resolveSpawnChildEnvironment },
      { routeSpawnModeAndWaitForWebhook },
      { resolveConnectedServiceAuthForSpawn },
      { shouldResolveConnectedServiceAuthForSpawn },
      { createSessionAttachFile },
      { buildTrackedSessionRespawnEnvironmentVariables },
    ] = await Promise.all([
      import('../spawn/resolveSpawnChildEnvironment'),
      import('../spawn/routeSpawnModeAndWaitForWebhook'),
      import('../connectedServices/resolveConnectedServiceAuthForSpawn'),
      import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn'),
      import('../sessionAttachFile'),
      import('../processSupervision/sessionRunnerRespawnDescriptor'),
    ]);
    vi.mocked(resolveSpawnChildEnvironment).mockReset();
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockReset();
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockReset();
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReset().mockReturnValue(false);
    vi.mocked(createSessionAttachFile).mockReset();
    vi.mocked(buildTrackedSessionRespawnEnvironmentVariables).mockReset();
    hoisted.vendorResumeSupport.mockReset();
    hoisted.resolveSpawnBackendIdentity.mockReset();
    hoisted.getVendorResumeSupport.mockClear();
    hoisted.requireCatalogEntry.mockReset();
    hoisted.refreshAccountSettingsForMinimumVersion.mockReset();
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockReset();
    hoisted.resolveMergedContributionRegistry.mockReset();
    hoisted.createRuntimeProviderSpawnAuthorizationAttempt.mockReset();
    hoisted.prepareDaemonManagedProviderBinding.mockReset();
    hoisted.getActiveAccountSettingsSnapshot.mockReset();
    hoisted.getActiveAccountSettingsSnapshot.mockReturnValue(null);
    hoisted.ensureSessionDirectory.mockClear();
    hoisted.getVendorResumeSupport.mockResolvedValue(hoisted.vendorResumeSupport);
    hoisted.resolveSpawnBackendIdentity.mockResolvedValue({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: 'vendor-session-1',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      catalogAgentId: 'codex',
    });
    hoisted.refreshAccountSettingsForMinimumVersion.mockResolvedValue(null);
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockImplementation(async () => ({
      registry: {
        contributes: createRegistryWithBackendOwners({
          codex: 'happier.agent.codex',
          claude: 'happier.agent.claude',
        }),
        agentRuntimesByAgentId: new Map(),
      },
      source: 'active',
      release: vi.fn(async () => {}),
    }));
    hoisted.resolveMergedContributionRegistry.mockImplementation(async () => createRegistryWithBackendOwners({
      codex: 'happier.agent.codex',
      claude: 'happier.agent.claude',
    }));
  });

  it('refuses a present-invalid persisted Provider binding before hooks, secrets, or child work', async () => {
    const getDaemonSpawnHooks = vi.fn(async () => ({}));
    hoisted.requireCatalogEntry.mockReturnValue({ getDaemonSpawnHooks });
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: 'session-1',
      effectiveResume: '',
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      sessionAttachPayload: {
        v: 2,
        encryptionMode: 'plain',
        snapshot: {
          metadata: {
            providerBindingV1: { v: 1, connectionId: 'pc_gateway' },
          },
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
        },
      },
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockResolvedValueOnce({ ok: true, directoryCreated: false });

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSessionAttachFile } = await import('../sessionAttachFile');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    vi.mocked(createSessionAttachFile).mockResolvedValueOnce({
      filePath: '/tmp/session-attach.json',
      cleanup: vi.fn(async () => undefined),
    });
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        ...createParams().options,
        resume: undefined,
        existingSessionId: 'session-1',
      },
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'provider_binding_changed',
      errorDetail: {
        kind: 'provider_error',
        providerError: { code: 'provider_binding_changed', connectionId: 'pc_gateway' },
      },
    });
    expect(getDaemonSpawnHooks).not.toHaveBeenCalled();
    expect(hoisted.ensureSessionDirectory).not.toHaveBeenCalled();
    expect(hoisted.acquireAuthoritativePluginRuntimeRegistryLease).not.toHaveBeenCalled();
    expect(resolveSpawnChildEnvironment).not.toHaveBeenCalled();
    expect(routeSpawnModeAndWaitForWebhook).not.toHaveBeenCalled();
  });

  it('prepares a restart proposal independently from the previous active Provider binding', async () => {
    const previousBinding = {
      v: 1 as const,
      connectionId: ProviderConnectionIdSchema.parse('pc_previous'),
      contributionKey: 'provider.test',
      connectionRevision: 1,
      model: { id: 'old-model', name: 'Old model' },
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      compatibilityFingerprint: 'compatibility:previous',
      bindingSecurityFingerprint: 'security:previous',
      displaySnapshot: {
        providerName: 'Previous',
        connectionName: 'Previous',
        connectionRole: 'default' as const,
        connectionDisplayNameMode: 'automatic' as const,
      },
    };
    const proposal = {
      v: 1 as const,
      updatedAt: 42,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_next'),
        modelId: 'next-model',
      },
    };
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: 'session-1',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: {
        v: 2,
        encryptionMode: 'plain',
        snapshot: {
          metadata: {
            providerBindingV1: previousBinding,
            modelSelectionIntentV1: {
              v: 1,
              updatedAt: proposal.updatedAt,
              selection: proposal.ref,
            },
          },
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
        },
      },
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockResolvedValueOnce({
      ok: true,
      directoryCreated: false,
    });

    const { prepareExecuteSpawnSessionRequest } = await import(
      './prepareExecuteSpawnSessionRequest'
    );
    const prepared = await prepareExecuteSpawnSessionRequest({
      request: {
        options: {
          ...createParams().options,
          resume: undefined,
          existingSessionId: 'session-1',
          backendTarget: {
            kind: 'backend',
            sourceKind: 'built_in',
            backendId: 'codex',
          },
        },
        credentials: createParams().credentials,
        loadLocalHandoffMetadataByVendorResumeId:
          createParams().loadLocalHandoffMetadataByVendorResumeId,
      },
      validateEnvVarRecordStrict: () => ({ ok: true, env: {} }),
    });

    expect(prepared).toMatchObject({
      modelSelection: proposal,
      persistedProviderResumeState: {
        selection: proposal,
        binding: previousBinding,
      },
    });
  });

  it('tracks the exact persisted Provider resume selection sent to the child when the request omits it', async () => {
    const setup = await configureProviderBoundExistingSessionSpawn();
    const proposal = {
      v: 1 as const,
      updatedAt: 42,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: setup.connectionId,
        modelId: 'model-a',
      },
    };
    hoisted.resolveSpawnBackendIdentity.mockReset().mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: 'existing-session-1',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: {
        v: 2,
        encryptionMode: 'plain',
        snapshot: {
          metadata: {
            providerBindingV1: setup.sessionBindingMetadata,
            modelSelectionIntentV1: {
              v: 1,
              updatedAt: proposal.updatedAt,
              selection: proposal.ref,
            },
          },
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
        },
      },
      catalogAgentId: 'codex',
    });
    const {
      resolveDaemonSessionModelTransitionAuthority,
    } = await import(
      '@/providers/sessions/authorizeSessionModelTransitionTarget'
    );
    const { executeSpawnSessionRequest } = await import(
      './executeSpawnSessionRequest'
    );
    const { routeSpawnModeAndWaitForWebhook } = await import(
      '../spawn/routeSpawnModeAndWaitForWebhook'
    );
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockImplementationOnce(
      async (input) => {
        expect(input.modelSelection).toEqual(proposal);
        expect(input.trackedSpawnOptions.modelSelection).toEqual(proposal);
        expect(resolveDaemonSessionModelTransitionAuthority({
          trackedAgentId: 'codex',
          trackedSelection:
            input.trackedSpawnOptions.modelSelection?.ref ?? null,
          trackedSessionBindingMetadata:
            input.trackedSpawnOptions.providerBindingMetadataV1 ?? null,
          requestAgentId: 'codex',
          requestedSelection: proposal.ref,
        }).input.selection).toEqual(proposal.ref);
        return {
          type: 'success',
          sessionId: 'existing-session-1',
        };
      },
    );

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      resolveProvidersFeatureEnabled: async () => true,
      options: {
        ...createParams().options,
        resume: undefined,
        existingSessionId: 'existing-session-1',
        machineId: 'machine-a',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
      },
    });

    expect(result).toEqual({
      type: 'success',
      sessionId: 'existing-session-1',
    });
  });

  it('rejects a synced V2 profile that claims a third-party agent-owned key before child/config creation', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      sessionAttachPayload: null,
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockResolvedValueOnce({ ok: true, directoryCreated: false });
    hoisted.getActiveAccountSettingsSnapshot.mockReturnValue({
      settings: {
        profiles: [{
          v: 2, id: 'focused', name: 'Focused',
          extraEnvironmentVariables: [{ name: 'THIRD_PARTY_AUTH', value: 'attacker-value' }],
          defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
          createdAt: 1, updatedAt: 1,
        }],
      },
    });
    const release = vi.fn(async () => undefined);
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValueOnce({
      registry: {
        contributes: { agentDefinitionsById: new Map([['codex', { definition: {
          id: 'codex', kindVersion: 1,
          providerRequirements: {
            acceptsProtocols: ['openai-responses'],
            required: { streaming: true, toolRoundTrips: true },
            credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
            authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['THIRD_PARTY_AUTH'] },
            materialization: 'engineConfig', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
          },
        } }]]) },
        agentRuntimesByAgentId: new Map(),
      },
      source: 'active',
      release,
    });
    const { validateEnvVarRecordStrict } = await import('@/terminal/runtime/envVarSanitization');
    vi.mocked(validateEnvVarRecordStrict).mockReturnValueOnce({ ok: true, env: { THIRD_PARTY_AUTH: 'attacker-value' } });
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: { ...createParams().options, resume: '', profileId: 'focused', environmentVariables: { THIRD_PARTY_AUTH: 'attacker-value' } },
    });
    expect(result).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES });
    expect(resolveSpawnChildEnvironment).not.toHaveBeenCalled();
    expect(routeSpawnModeAndWaitForWebhook).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('uses static support without an adapter for a safe native V2 profile and releases after spawn commit', async () => {
    const events: string[] = [];
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      sessionAttachPayload: null,
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockResolvedValueOnce({ ok: true, directoryCreated: false });
    hoisted.getActiveAccountSettingsSnapshot.mockReturnValue({
      settings: {
        profiles: [{
          v: 2, id: 'focused', name: 'Focused',
          extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: '1' }],
          defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
          createdAt: 1, updatedAt: 1,
        }],
      },
    });
    const release = vi.fn(async () => { events.push('release'); });
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValueOnce({
      registry: {
        contributes: { agentDefinitionsById: new Map([['codex', { definition: {
          id: 'codex', kindVersion: 1,
          providerRequirements: {
            acceptsProtocols: ['openai-responses'],
            required: { streaming: true, toolRoundTrips: true },
            credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
            authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['THIRD_PARTY_AUTH'] },
            materialization: 'engineConfig', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
          },
        } }]]) },
        agentRuntimesByAgentId: new Map(),
      },
      source: 'active',
      release,
    });
    const { validateEnvVarRecordStrict } = await import('@/terminal/runtime/envVarSanitization');
    vi.mocked(validateEnvVarRecordStrict).mockReturnValueOnce({ ok: true, env: { TEAM_FLAG: '1' } });
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true, cleanupOnFailure: null, cleanupOnExit: null,
      expandedEnvironmentVariables: {}, extraEnvForChild: {},
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockImplementationOnce(async () => {
      events.push('spawn');
      return { type: 'success', sessionId: 'session-1' };
    });

    await expect(executeSpawnSessionRequest({
      ...createParams(),
      options: { ...createParams().options, resume: '', profileId: 'focused', environmentVariables: { TEAM_FLAG: '1' } },
    })).resolves.toMatchObject({ type: 'success' });
    expect(events).toEqual(['spawn', 'release']);
    expect(release).toHaveBeenCalledTimes(1);
    expect(hoisted.createRuntimeProviderSpawnAuthorizationAttempt).not.toHaveBeenCalled();
  });

  it('rejects a stale deterministic legacy overlay after its terminal migration outcome', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true, normalizedExistingSessionId: '', effectiveResume: '',
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'claude' },
      sessionAttachPayload: null, catalogAgentId: 'claude',
    });
    hoisted.ensureSessionDirectory.mockResolvedValueOnce({ ok: true, directoryCreated: false });
    hoisted.getActiveAccountSettingsSnapshot.mockReturnValue({ settings: {
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        migration: {
          v: 1,
          completedSources: [{ sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_deepseek' }],
          pendingCustomProfileIds: [], migratedAt: 2,
        },
      },
    } });
    const release = vi.fn(async () => undefined);
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValueOnce({
      registry: { contributes: { agentDefinitionsById: new Map([['claude', { definition: { id: 'claude', kindVersion: 1 } }]]) }, agentRuntimesByAgentId: new Map() },
      source: 'active', release,
    });
    const { validateEnvVarRecordStrict } = await import('@/terminal/runtime/envVarSanitization');
    vi.mocked(validateEnvVarRecordStrict).mockReturnValueOnce({ ok: true, env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } });
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: { ...createParams().options, resume: '', profileId: 'deepseek', environmentVariables: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } },
    });
    expect(result).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES });
    expect(resolveSpawnChildEnvironment).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('authorizes provider bindings before connected services, suppresses conflicting auth, and revalidates before commit', async () => {
    const events: string[] = [];
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      sessionAttachPayload: null,
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockResolvedValueOnce({ ok: true, directoryCreated: false });
    hoisted.getActiveAccountSettingsSnapshot.mockReturnValue({
      settings: {
        profiles: [{
          v: 2, id: 'focused', name: 'Focused', extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: '1' }],
          defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
          createdAt: 1, updatedAt: 1,
        }],
      },
    });
    const acceptedLease = {
      registry: {
        contributes: { agentDefinitionsById: new Map([['codex', {
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          definition: {
            id: 'codex', kindVersion: 1,
            providerRequirements: {
              acceptsProtocols: ['openai-responses'], required: { streaming: true, toolRoundTrips: true },
              credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
              authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['PROVIDER_KEY'] },
              materialization: 'engineConfig', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
            },
          },
          richDefinition: {
            definition: {
              connectedAccounts: [{
                purpose: 'generation-b-anthropic-request',
                service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
              }],
            },
          },
          catalogEntry: {
            connectedAccountRequestAuthUses: [{
              purpose: 'generation-b-anthropic-request',
              materialization: {
                kind: 'httpHeaders',
                origin: 'https://api.anthropic.com',
                headerNames: ['authorization'],
              },
            }],
          },
        }]]) },
        agentRuntimesByAgentId: new Map(),
      },
      source: 'active' as const,
      release: vi.fn(async () => undefined),
    };
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValueOnce(acceptedLease);
    const cleanupOnFailure = vi.fn();
    const cleanupOnExit = vi.fn();
    const managedPurposeBinding = {
      purpose: {
        consumer: {
          pluginId: 'happier.provider.cliproxyapi',
          localId: 'cliproxyapi',
        },
        purpose: 'openai-upstream',
      },
      target: {
        kind: 'account' as const,
        account: {
          service: {
            pluginId: 'happier.connected-account.openai',
            localId: 'codex',
          },
          accountId: 'work',
        },
      },
    };
    const materializeAfterHooks = vi.fn(async () => {
      events.push('provider-materialize');
      return {
        ok: true as const,
        materialization: {
          providerEnvironmentOverlay: [{ name: 'PROVIDER_KEY', value: 'secret', source: 'provider' as const }],
          launchMaterialization: { v: 1 as const, kind: 'engineConfig' as const, engineConfig: { provider: 'gateway' } },
          additionalRedactionValues: [],
          cleanup: null,
        },
        redactionLease: {
          redact: (value: string) => value.replaceAll('secret', '[REDACTED]'),
          values: () => ['secret'],
          add: () => {},
          snapshotRedactor: () => (value: string) => value.replaceAll('secret', '[REDACTED]'),
          createStreamingSanitizer: () => ({
            push: (value: string | Uint8Array) => String(value).replaceAll('secret', '[REDACTED]'),
            flush: () => '',
          }),
          close: vi.fn(),
        },
      };
    });
    const revalidateBeforeCommit = vi.fn(async () => {
      events.push('provider-commit-check');
      return { ok: true as const };
    });
    const sessionBindingMetadata = {
      v: 1 as const,
      connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
      contributionKey: 'plugin.gateway/gateway',
      connectionRevision: 2,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'gateway',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      displaySnapshot: {
        providerName: 'Gateway', connectionName: 'Work', connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    };
    hoisted.createRuntimeProviderSpawnAuthorizationAttempt.mockImplementationOnce(async (input) => {
      expect(input.lease).toBe(acceptedLease);
      events.push('provider-authorize');
      return {
        ok: true,
        attempt: {
          deployment: { kind: 'external' },
          authorization: {
            ticket: { connectionId: ProviderConnectionIdSchema.parse('pc_gateway') },
            binding: { selection: { model: { id: 'model-a', name: 'Model A' } } },
            support: {
              authIsolation: { suppressConnectedServiceIds: ['openai-codex'], ownedEnvKeys: ['PROVIDER_KEY'] },
            },
            sessionBindingMetadata,
          },
          materializeAfterHooks,
          revalidateBeforeCommit,
          cleanupOnFailure,
          takeCleanupOnExit: () => cleanupOnExit,
        },
      };
    });

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { validateEnvVarRecordStrict } = await import('@/terminal/runtime/envVarSanitization');
    vi.mocked(validateEnvVarRecordStrict).mockReturnValueOnce({ ok: true, env: { TEAM_FLAG: '1' } });
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { resolveConnectedServiceAuthForSpawn } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValueOnce(true);
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockImplementationOnce(async (input) => {
      events.push('connected-services');
      expect(input.connectedServicesBindingsRaw).toEqual({
        v: 1,
        bindingsByServiceId: {
          github: { source: 'connected', selection: 'profile', profileId: 'github-work' },
          anthropic: { source: 'connected', selection: 'profile', profileId: 'anthropic-work' },
        },
      });
      expect(input.resolveRequestAuthPurposeBindings?.(input.connectedServicesBindingsRaw as ConnectedServiceBindingsV1)).toEqual([{
        purpose: {
          consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
          purpose: 'generation-b-anthropic-request',
        },
        target: {
          kind: 'account',
          account: {
            service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
            accountId: 'anthropic-work',
          },
        },
      }]);
      return null;
    });
    vi.mocked(resolveSpawnChildEnvironment).mockImplementation(async (input) => {
      expect((input as { pluginRuntimeRegistry?: unknown }).pluginRuntimeRegistry).toBe(
        acceptedLease.registry,
      );
      if (input.providerBindingPrerequisitesOnly) {
        expect(input.providerBindingContext?.agentTargetKey).toBe('backend:codex');
        events.push('provider-preflight');
        return {
          ok: true,
          cleanupOnFailure: null,
          cleanupOnExit: null,
          expandedEnvironmentVariables: {},
          extraEnvForChild: {} as Record<string, string>,
        };
      }
      expect(input.providerBindingContext?.agentTargetKey).toBe('backend:codex');
      events.push('generic-hooks');
      const late = await input.materializeProviderBindingAfterHooks?.();
      if (!late) throw new Error('Expected late provider materialization');
      if (!late.ok) throw new Error(late.errorMessage);
      return {
        ok: true,
        cleanupOnFailure: null,
        cleanupOnExit: null,
        expandedEnvironmentVariables: {},
        extraEnvForChild: { PROVIDER_KEY: 'secret' } as Record<string, string>,
        providerEnvKeys: ['PROVIDER_KEY'],
        providerBindingLaunchHandoff: late.providerBindingLaunchHandoff,
      };
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockImplementationOnce(async (input) => {
      const commitRefusal = await input.revalidateBeforeCommit?.() ?? null;
      expect(commitRefusal).toBeNull();
      events.push('child-commit');
      expect(input.sanitizeDiagnosticText?.('child echoed secret')).toBe('child echoed [REDACTED]');
      expect(input.trackedSpawnOptions).toMatchObject({ providerBindingMetadataV1: sessionBindingMetadata });
      expect(input.trackedSpawnOptions).not.toHaveProperty('providerBindingSecurityChangeConfirmationV1');
      const handoff = consumeProviderBindingLaunchHandoffFromEnvironments([{ ...input.extraEnvForChildWithMessage }]);
      expect(handoff).toMatchObject({ sessionBindingMetadata });
      return { type: 'success', sessionId: 'session-1' };
    });

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      resolveProvidersFeatureEnabled: async () => true,
      activateSessionPurposeBindings: () => ({
        subjectId: 'agent-session:session-1',
        isCurrent: () => true,
        resolvePurposeBinding: () => null,
        listPurposeBindings: () => [],
        dispose: vi.fn(),
      }),
      options: {
        ...createParams().options,
        resume: undefined,
        profileId: 'focused',
        environmentVariables: { TEAM_FLAG: '1' },
        machineId: 'machine-a',
        modelSelection: {
          v: 1,
          updatedAt: 1,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
            modelId: 'model-a',
          },
        },
        providerBindingSecurityChangeConfirmationV1: {
          v: 1,
          sessionId: 'session-1',
          connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
          previousBindingSecurityFingerprint: 'security-old',
          nextBindingSecurityFingerprint: 'security-v1',
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'codex-work' },
            github: { source: 'connected', selection: 'profile', profileId: 'github-work' },
            anthropic: { source: 'connected', selection: 'profile', profileId: 'anthropic-work' },
          },
        },
      },
    });

    expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
    expect(events).toEqual([
      'provider-authorize',
      'provider-preflight',
      'connected-services',
      'generic-hooks',
      'provider-materialize',
      'provider-commit-check',
      'child-commit',
    ]);
    expect(materializeAfterHooks).toHaveBeenCalledTimes(1);
    expect(revalidateBeforeCommit).toHaveBeenCalledTimes(1);
    expect(hoisted.acquireAuthoritativePluginRuntimeRegistryLease).toHaveBeenCalledTimes(1);
  });

  it('runs the daemon-owned managed endpoint transaction after Connected Services and before Agent endpoint exposure', async () => {
    const events: string[] = [];
    const connectionId = ProviderConnectionIdSchema.parse('pc_managed_gateway');
    const managedPurposeBinding = {
      purpose: {
        consumer: {
          pluginId: 'happier.provider.cliproxyapi',
          localId: 'cliproxyapi',
        },
        purpose: 'openai-upstream',
      },
      target: {
        kind: 'account' as const,
        account: {
          service: {
            pluginId: 'happier.connected-account.openai',
            localId: 'codex',
          },
          accountId: 'managed-work',
        },
      },
    };
    const sessionBindingMetadata = {
      v: 1 as const,
      connectionId,
      contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
      connectionRevision: 1,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'cliproxyapi',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'managed-binding-security-v1',
      displaySnapshot: {
        providerName: 'CLIProxyAPI',
        connectionName: 'CLIProxyAPI managed',
        connectionRole: 'default' as const,
        connectionDisplayNameMode: 'automatic' as const,
      },
    };
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: 'managed-session-1',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockResolvedValueOnce({
      ok: true,
      directoryCreated: false,
    });
    const acceptedLease = {
      registry: {
        contributes: {
          agentDefinitionsById: new Map([['codex', {
            definition: {
              id: 'codex',
              kindVersion: 1,
              providerRequirements: {
                acceptsProtocols: ['openai-responses'],
                required: { streaming: true, toolRoundTrips: true },
                credentialSupport: { supportsNoAuth: false, apiKeyTransports: [] },
                authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
                materialization: 'engineConfig',
                applyPolicy: 'restart_session',
                supportsFreeformModelIds: true,
              },
            },
          }]]),
        },
        agentRuntimesByAgentId: new Map(),
      },
      source: 'active' as const,
      release: vi.fn(async () => undefined),
    };
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValueOnce(acceptedLease);
    const cleanupOnFailure = vi.fn();
    const cleanupOnExit = vi.fn();
    const revalidateBeforeCommit = vi.fn(async () => {
      events.push('provider-commit-check');
      return { ok: true as const };
    });
    const managedAttempt = {
      deployment: { kind: 'managedLocal' as const },
      authorization: {
        deployment: {
          kind: 'managedLocal' as const,
          contribution: {
            identity: {
              pluginId: 'happier.provider.cliproxyapi',
              localId: 'cliproxyapi',
            },
            definition: { name: 'CLIProxyAPI' },
          },
          implementation: {
            implementationIdentity:
              managedPurposeBinding.purpose.consumer,
            facet: {
              requestAuthUses: [{
                purpose:
                  managedPurposeBinding.purpose.purpose,
                materialization: {
                  kind: 'httpHeaders' as const,
                  origin: 'https://chatgpt.com',
                  headerNames: [
                    'authorization',
                    'chatgpt-account-id',
                  ],
                },
              }],
            },
            purposeBindings: {
              v: 1 as const,
              bindings: [managedPurposeBinding],
            },
          },
        },
        ticket: { connectionId, machineId: 'machine-a' },
        binding: {
          selection: { model: { id: 'model-a' } },
        },
        support: {
          authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
        },
        sessionBindingMetadata,
      },
      isAuthorizationCurrent: () => true,
      revalidateBeforeEffect: vi.fn(async () => ({ ok: true as const })),
      revalidateBeforeCommit,
      materializeManagedEndpoint: vi.fn(),
      cleanupOnFailure,
      takeCleanupOnExit: () => cleanupOnExit,
    };
    hoisted.createRuntimeProviderSpawnAuthorizationAttempt.mockImplementationOnce(async () => {
      events.push('provider-authorize');
      return { ok: true, attempt: managedAttempt };
    });
    hoisted.prepareDaemonManagedProviderBinding.mockImplementationOnce(async (input) => {
      events.push('managed-capability');
      expect(input.attempt).toBe(managedAttempt);
      expect(input.context).toMatchObject({
        sessionId: 'managed-session-1',
      });
      expect(input.requestAuthSubject).toMatchObject({
        subjectId: expect.stringContaining(
          'agent-session:managed-session-1/managed-provider:',
        ),
      });
      expect(input.requestAuthHttpPort).toBe(18_765);
      events.push('managed-materialize');
      return {
        ok: true as const,
        materialization: {
          providerEnvironmentOverlay: [],
          launchMaterialization: {
            v: 1 as const,
            kind: 'engineConfig' as const,
            engineConfig: { endpoint: 'runtime-only' },
          },
          additionalRedactionValues: [],
          cleanup: null,
        },
        redactionLease: {
          redact: (value: string) => value,
          values: () => [],
          add: () => undefined,
          snapshotRedactor: () => (value: string) => value,
          createStreamingSanitizer: () => ({
            push: (value: string | Uint8Array) => String(value),
            flush: () => '',
          }),
          close: vi.fn(),
        },
        sessionBindingMetadata,
        activateManagedProviderRequestAuth: vi.fn(async () => undefined),
      };
    });

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { resolveConnectedServiceAuthForSpawn } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { createSessionAttachFile } = await import('../sessionAttachFile');
    vi.mocked(createSessionAttachFile).mockResolvedValueOnce({
      filePath: '/tmp/managed-session-1-attach.json',
      cleanup: vi.fn(async () => undefined),
    });
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValueOnce(true);
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockImplementationOnce(async () => {
      events.push('connected-services');
      return null;
    });
    vi.mocked(resolveSpawnChildEnvironment).mockImplementationOnce(async (input) => {
      events.push('generic-hooks');
      const late = await input.materializeProviderBindingAfterHooks?.();
      expect(late).toMatchObject({ ok: true });
      return {
        ok: true,
        cleanupOnFailure: null,
        cleanupOnExit: null,
        expandedEnvironmentVariables: {},
        extraEnvForChild: {},
        providerBindingLaunchHandoff: late?.ok
          ? late.providerBindingLaunchHandoff
          : undefined,
      };
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockImplementationOnce(async (input) => {
      expect(await input.revalidateBeforeCommit?.()).toBeNull();
      events.push('child-commit');
      return { type: 'success', sessionId: 'managed-session-1' };
    });

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      connectedAccountRequestAuthHttpPort: 18_765,
      managedProviderEndpointRuntime: {
        resolveManagedLocalServicesEnabled: async () => {
          events.push('local-services-gate');
          return true;
        },
      } as never,
      resolveProvidersFeatureEnabled: async () => true,
      activateSessionPurposeBindings: vi.fn(() => {
        events.push('lease');
        return {
          subjectId: 'agent-session:managed-session-1',
          isCurrent: () => true,
          resolvePurposeBinding: () => managedPurposeBinding,
          listPurposeBindings: () => [managedPurposeBinding],
          dispose: vi.fn(),
        };
      }),
      options: {
        ...createParams().options,
        existingSessionId: 'managed-session-1',
        resume: undefined,
        machineId: 'machine-a',
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'csm_managed_session_1',
          createdAt: 1,
          source: 'first_spawn',
        },
        modelSelection: {
          v: 1,
          updatedAt: 1,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: connectionId,
            modelId: 'model-a',
          },
        },
      },
    });

    expect(result).toEqual({ type: 'success', sessionId: 'managed-session-1' });
    expect(events).toEqual([
      'provider-authorize',
      'connected-services',
      'lease',
      'generic-hooks',
      'local-services-gate',
      'managed-capability',
      'managed-materialize',
      'provider-commit-check',
      'child-commit',
    ]);
    expect(cleanupOnFailure).not.toHaveBeenCalled();
  });

  it('removes a pending session-attach file when final Provider commit revalidation refuses the spawn', async () => {
    const setup = await configureProviderBoundExistingSessionSpawn();
    setup.revalidateBeforeCommit.mockResolvedValueOnce({
      ok: false,
      error: createProviderErrorV1('provider_authorization_changed', {
        connectionId: setup.connectionId,
        machineId: 'machine-a',
      }),
    });
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockImplementationOnce(async (input) => {
      const refusal = await input.revalidateBeforeCommit?.() ?? null;
      if (!refusal) throw new Error('Expected final Provider commit refusal');
      return refusal;
    });

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      resolveProvidersFeatureEnabled: async () => true,
      options: {
        ...createParams().options,
        resume: undefined,
        existingSessionId: 'existing-session-1',
        machineId: 'machine-a',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        modelSelection: {
          v: 1,
          updatedAt: 1,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: setup.connectionId,
            modelId: 'model-a',
          },
        },
        providerBindingMetadataV1: setup.sessionBindingMetadata,
      },
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'provider_authorization_changed',
    });
    expect(setup.attachCleanup).toHaveBeenCalledTimes(1);
    expect(setup.providerCleanupOnFailure).toHaveBeenCalledTimes(1);
    expect(setup.providerCleanupOnExit).not.toHaveBeenCalled();
    expect(setup.releaseRuntimeRegistryLease).toHaveBeenCalledTimes(1);
  });

  it('retains launch resources when tmux cannot reconcile an untracked possibly-live child', async () => {
    const setup = await configureProviderBoundExistingSessionSpawn();
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockImplementationOnce(async (input) => {
      const commitRefusal = await input.revalidateBeforeCommit?.() ?? null;
      expect(commitRefusal).toBeNull();
      const lifecycleInput = input as typeof input & { onUntrackedTmuxChild?: () => void };
      lifecycleInput.onUntrackedTmuxChild?.();
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: 'tmux client outcome could not be reconciled',
      };
    });

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      resolveProvidersFeatureEnabled: async () => true,
      options: {
        ...createParams().options,
        resume: undefined,
        existingSessionId: 'existing-session-1',
        machineId: 'machine-a',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        modelSelection: {
          v: 1,
          updatedAt: 1,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: setup.connectionId,
            modelId: 'model-a',
          },
        },
        providerBindingMetadataV1: setup.sessionBindingMetadata,
      },
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
    });
    expect(setup.attachCleanup).not.toHaveBeenCalled();
    expect(setup.providerCleanupOnFailure).not.toHaveBeenCalled();
    expect(setup.providerCleanupOnExit).not.toHaveBeenCalled();
    expect(setup.releaseRuntimeRegistryLease).not.toHaveBeenCalled();
  });

  it('sanitizes a post-attach downstream throw and cleans the attach and Provider resources exactly once', async () => {
    const setup = await configureProviderBoundExistingSessionSpawn();
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockRejectedValueOnce(
      new Error('downstream failure echoed secret'),
    );

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      resolveProvidersFeatureEnabled: async () => true,
      options: {
        ...createParams().options,
        resume: undefined,
        existingSessionId: 'existing-session-1',
        machineId: 'machine-a',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        modelSelection: {
          v: 1,
          updatedAt: 1,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: setup.connectionId,
            modelId: 'model-a',
          },
        },
        providerBindingMetadataV1: setup.sessionBindingMetadata,
      },
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: 'Failed to spawn session: downstream failure echoed [REDACTED]',
    });
    expect(setup.attachCleanup).toHaveBeenCalledTimes(1);
    expect(setup.providerCleanupOnFailure).toHaveBeenCalledTimes(1);
    expect(setup.providerCleanupOnExit).not.toHaveBeenCalled();
    expect(setup.releaseRuntimeRegistryLease).toHaveBeenCalledTimes(1);
  });

  it('returns one typed incomplete-retirement result when precommit Provider cleanup fails', async () => {
    const setup = await configureProviderBoundExistingSessionSpawn({
      providerCleanupFailure: new Error('managed_provider_stop_unavailable'),
    });
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockRejectedValueOnce(
      new Error('marker publication failed'),
    );

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      resolveProvidersFeatureEnabled: async () => true,
      options: {
        ...createParams().options,
        resume: undefined,
        existingSessionId: 'existing-session-1',
        machineId: 'machine-a',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
        modelSelection: {
          v: 1,
          updatedAt: 1,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: setup.connectionId,
            modelId: 'model-a',
          },
        },
        providerBindingMetadataV1: setup.sessionBindingMetadata,
      },
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage:
        'startup_retirement_incomplete:exit_cleanup_incomplete',
    });
    expect(setup.providerCleanupOnFailure).toHaveBeenCalledTimes(1);
    expect(setup.providerCleanupOnExit).not.toHaveBeenCalled();
    expect(setup.releaseRuntimeRegistryLease).not.toHaveBeenCalled();
  });

  it('fails provider-bound spawn closed at the root feature gate before provider preflight or authorization', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: 'session-1',
      effectiveResume: '',
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      sessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockResolvedValueOnce({ ok: true, directoryCreated: false });
    hoisted.getActiveAccountSettingsSnapshot.mockReturnValue({
      settings: { profiles: [{
        v: 2, id: 'focused', name: 'Focused', extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: '1' }],
        defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
        createdAt: 1, updatedAt: 1,
      }] },
    });
    const release = vi.fn(async () => undefined);
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValueOnce({
      registry: { contributes: { agentDefinitionsById: new Map([['codex', { definition: { id: 'codex', kindVersion: 1 } }]]) }, agentRuntimesByAgentId: new Map() },
      source: 'active', release,
    });
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { validateEnvVarRecordStrict } = await import('@/terminal/runtime/envVarSanitization');
    vi.mocked(validateEnvVarRecordStrict).mockReturnValueOnce({ ok: true, env: { TEAM_FLAG: '1' } });

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      resolveProvidersFeatureEnabled: async () => false,
      options: {
        ...createParams().options,
        resume: undefined,
        profileId: 'focused',
        environmentVariables: { TEAM_FLAG: '1' },
        machineId: 'machine-a',
        modelSelection: {
          v: 1,
          updatedAt: 1,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
            modelId: 'model-a',
          },
        },
      },
    } as never);

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'provider_feature_disabled',
      errorDetail: {
        kind: 'provider_error',
        providerError: {
          v: 1,
          code: 'provider_feature_disabled',
          connectionId: 'pc_gateway',
          machineId: 'machine-a',
          retryable: false,
          action: 'review_features',
        },
      },
    });
    expect(resolveSpawnChildEnvironment).not.toHaveBeenCalled();
    expect(hoisted.createRuntimeProviderSpawnAuthorizationAttempt).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases a profile-validation lease when a provider-bound request lacks a machine id', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true, normalizedExistingSessionId: '', effectiveResume: '',
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      sessionAttachPayload: null, catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockResolvedValueOnce({ ok: true, directoryCreated: false });
    hoisted.getActiveAccountSettingsSnapshot.mockReturnValue({ settings: { profiles: [{
      v: 2, id: 'focused', name: 'Focused', extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: '1' }],
      defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1,
    }] } });
    const release = vi.fn(async () => undefined);
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValueOnce({
      registry: { contributes: { agentDefinitionsById: new Map([['codex', { definition: { id: 'codex', kindVersion: 1 } }]]) }, agentRuntimesByAgentId: new Map() },
      source: 'active', release,
    });
    const { validateEnvVarRecordStrict } = await import('@/terminal/runtime/envVarSanitization');
    vi.mocked(validateEnvVarRecordStrict).mockReturnValueOnce({ ok: true, env: { TEAM_FLAG: '1' } });
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const result = await executeSpawnSessionRequest({
      ...createParams(), resolveProvidersFeatureEnabled: async () => true,
      options: {
        ...createParams().options, resume: undefined, profileId: 'focused', environmentVariables: { TEAM_FLAG: '1' },
        modelSelection: {
          v: 1, updatedAt: 1,
          ref: { agentTargetKey: 'backend:codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_gateway'), modelId: 'model-a' },
        },
      },
    } as never);
    expect(result).toMatchObject({ type: 'error', errorMessage: 'provider_incompatible_with_agent' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(hoisted.createRuntimeProviderSpawnAuthorizationAttempt).not.toHaveBeenCalled();
  });

  it('refuses an unseen security change after a different exact transition was confirmed', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true, normalizedExistingSessionId: '', effectiveResume: '',
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      sessionAttachPayload: null, catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockResolvedValueOnce({ ok: true, directoryCreated: false });
    const previousBinding = {
      v: 1 as const, connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
      contributionKey: 'plugin.gateway/gateway', connectionRevision: 1,
      protocol: 'openai-responses' as const, materialization: 'engineConfig' as const,
      adapterBindingKey: 'gateway', compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-a',
      displaySnapshot: { providerName: 'Gateway', connectionName: 'Gateway', connectionRole: 'default' as const, connectionDisplayNameMode: 'automatic' as const },
    };
    const materializeAfterHooks = vi.fn();
    hoisted.createRuntimeProviderSpawnAuthorizationAttempt.mockResolvedValueOnce({
      ok: true,
      attempt: {
        deployment: { kind: 'external' },
        authorization: {
          ticket: { connectionId: previousBinding.connectionId },
          binding: { selection: { model: { id: 'model-a', name: 'Model A' } } },
          support: { authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] } },
          sessionBindingMetadata: { ...previousBinding, connectionRevision: 3, bindingSecurityFingerprint: 'security-c' },
        },
        materializeAfterHooks,
        revalidateBeforeCommit: vi.fn(),
        cleanupOnFailure: vi.fn(),
        takeCleanupOnExit: vi.fn(),
      },
    });
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true, cleanupOnFailure: null, cleanupOnExit: null,
      expandedEnvironmentVariables: {}, extraEnvForChild: {},
    });

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      resolveProvidersFeatureEnabled: async () => true,
      options: {
        ...createParams().options,
        machineId: 'machine-a', resume: undefined,
        providerBindingMetadataV1: previousBinding,
        providerBindingSecurityChangeConfirmationV1: {
          v: 1,
          sessionId: 'session-1',
          connectionId: previousBinding.connectionId,
          previousBindingSecurityFingerprint: 'security-a',
          nextBindingSecurityFingerprint: 'security-b',
        },
        modelSelection: {
          v: 1, updatedAt: 1,
          ref: { agentTargetKey: 'backend:codex', providerConnectionId: previousBinding.connectionId, modelId: 'model-a' },
        },
      },
    });

    expect(result).toMatchObject({
      type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'provider_binding_changed',
    });
    expect(materializeAfterHooks).not.toHaveBeenCalled();
    expect(routeSpawnModeAndWaitForWebhook).not.toHaveBeenCalled();
  });

  it('uses account settings version hints only for daemon freshness refresh', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      catalogAgentId: 'codex',
    });
    hoisted.refreshAccountSettingsForMinimumVersion.mockResolvedValueOnce(null);
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSessionAttachFile } = await import('../sessionAttachFile');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });
    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        ...createParams().options,
        resume: undefined,
        accountSettingsVersionHint: 42,
      },
    });

    expect(result).toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
    expect(hoisted.ensureSessionDirectory).toHaveBeenCalled();
    expect(hoisted.refreshAccountSettingsForMinimumVersion).toHaveBeenCalledWith(expect.objectContaining({
      minSettingsVersion: 42,
    }));
    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.not.objectContaining({
      accountSettingsVersionHint: expect.any(Number),
    }));
    expect(resolveSpawnChildEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      happyHomeDir: '/tmp/happier-home',
    }));
  });

  it('injects daemon-owned server selection into spawned session child env', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'claude',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'claude',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockClear();
    vi.mocked(resolveSpawnChildEnvironment).mockClear();
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {
        HAPPIER_HOME_DIR: '/tmp/stale-home',
        HAPPIER_ACTIVE_SERVER_ID: 'stale-server',
        HAPPIER_SERVER_URL: 'http://stale-public.example.test',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:52753',
        HAPPIER_PUBLIC_SERVER_URL: 'http://stale-public.example.test',
        HAPPIER_WEBAPP_URL: 'http://stale-web.example.test',
      },
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        ...createParams().options,
        resume: undefined,
      },
      processEnv: {},
    });

    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      extraEnvForChildWithMessage: expect.objectContaining({
        HAPPIER_HOME_DIR: '/tmp/happier-home',
        HAPPIER_ACTIVE_SERVER_ID: 'dev-local',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID:
          process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID ?? 'dev-local',
        HAPPIER_SERVER_URL: 'http://dev-public.example.test',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:53288',
        HAPPIER_PUBLIC_SERVER_URL: 'http://dev-public.example.test',
        HAPPIER_WEBAPP_URL: 'http://dev-web.example.test',
      }),
    }));
  });

  it.each([
    {
      name: 'OhMyPi no-models spawn gate',
      requestBackendTarget: undefined,
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'ohMyPi',
        sourceKind: 'built_in',
      },
      catalogAgentId: 'ohMyPi',
    },
    {
      name: 'Antigravity localharness spawn gate',
      requestBackendTarget: {
        kind: 'backend',
        backendId: 'antigravity',
        sourceKind: 'built_in',
      },
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'antigravity-localharness',
        configuredBackendId: 'antigravity-localharness',
        sourceKind: 'configured',
      },
      catalogAgentId: null,
    },
    {
      name: 'Codex allowed control',
      requestBackendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      catalogAgentId: 'codex',
    },
  ] as const)('uses the effective concrete backend target for $name child spawn ingress', async ({
    requestBackendTarget,
    effectiveBackendTargetV2,
    catalogAgentId,
  }) => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2,
      sessionAttachPayload: null,
      catalogAgentId,
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockClear();
    vi.mocked(resolveSpawnChildEnvironment).mockClear();
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        ...(requestBackendTarget ? { backendTarget: requestBackendTarget } : {}),
      },
      processEnv: {},
    });

    expect(result).toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
    expect(resolveSpawnChildEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        backendTarget: effectiveBackendTargetV2,
      }),
    }));
    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        backendTarget: effectiveBackendTargetV2,
      }),
      trackedSpawnOptions: expect.objectContaining({
        backendTarget: effectiveBackendTargetV2,
      }),
      effectiveBackendTargetV2,
    }));
  });

  it('issues local-services bridge authorization through a token file and never passes the raw token in child env', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    await executeSpawnSessionRequest({
      ...createParams(),
      processEnv: {},
    });

    const spawnParams = vi.mocked(routeSpawnModeAndWaitForWebhook).mock.calls.at(-1)?.[0] as any;
    expect(spawnParams.extraEnvForChildWithMessage).toEqual(expect.objectContaining({
      HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE: expect.stringContaining('/tmp/happier-home/tmp/'),
    }));
    expect(spawnParams.extraEnvForChildWithMessage).not.toHaveProperty(
      'HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN',
    );
    expect(spawnParams.unsetEnvKeys).toEqual(expect.arrayContaining([
      'HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN',
      'HAPPIER_SESSION_ATTACH_FILE',
      'HAPPIER_STACK_PROCESS_KIND',
      'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON',
      'HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON',
      'HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT',
    ]));
    expect(spawnParams.unsetEnvKeys).not.toContain(
      'HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE',
    );
    expect(spawnParams.localServicesBridgeAuthorization).toEqual({
      tokenHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      pluginId: 'happier.agent.codex',
      contributionId: 'codex',
      tokenFilePath: expect.stringContaining('/tmp/happier-home/tmp/'),
    });
  });

  it('uses bundled plugin metadata for built-in local-services bridge ownership while the Agent bridge acquires its runtime lease', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    const effectiveBackendTargetV2 = {
      kind: 'backend',
      sourceKind: 'built_in',
      backendId: 'opencode',
    } as const;
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2,
      sessionAttachPayload: null,
      catalogAgentId: 'opencode',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValueOnce({
      registry: {
        contributes: createRegistryWithBackendOwners({
          opencode: 'happier.agent.opencode',
        }),
        agentRuntimesByAgentId: new Map(),
      },
      source: 'active',
      release: vi.fn(async () => undefined),
    });
    const { resolveConcreteBackendTargetRefV2 } = await import('@/session/backendTargets/resolveConcreteBackendTargetRefs');
    vi.mocked(resolveConcreteBackendTargetRefV2).mockReturnValueOnce(effectiveBackendTargetV2);
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      processEnv: {},
    });

    expect(result).toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
    const spawnParams = vi.mocked(routeSpawnModeAndWaitForWebhook).mock.calls.at(-1)?.[0] as {
      localServicesBridgeAuthorization?: { pluginId?: string; contributionId?: string };
    };
    expect(spawnParams.localServicesBridgeAuthorization).toEqual(expect.objectContaining({
      pluginId: 'happier.agent.opencode',
      contributionId: 'opencode',
    }));
    expect(hoisted.acquireAuthoritativePluginRuntimeRegistryLease).toHaveBeenCalledTimes(1);
  });

  it('resolves configured local-services bridge ownership from the authoritative plugin runtime registry lease', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'configured',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
      },
      sessionAttachPayload: null,
      catalogAgentId: null,
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );
    const releaseRuntimeRegistryLease = vi.fn(async () => {});
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValueOnce({
      registry: {
        contributes: createRegistryWithBackendOwners({
          'review-bot': 'active.plugin.review-bot',
        }),
        agentRuntimesByAgentId: new Map(),
      },
      source: 'active',
      release: releaseRuntimeRegistryLease,
    });
    hoisted.resolveMergedContributionRegistry.mockResolvedValueOnce(createRegistryWithBackendOwners({
      'review-bot': 'stale.plugin.review-bot',
    }));
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    await executeSpawnSessionRequest({
      ...createParams(),
      processEnv: {},
    });

    const spawnParams = vi.mocked(routeSpawnModeAndWaitForWebhook).mock.calls.at(-1)?.[0] as {
      localServicesBridgeAuthorization?: { pluginId?: string };
    };
    expect(spawnParams.localServicesBridgeAuthorization?.pluginId).toBe('active.plugin.review-bot');
    expect(hoisted.acquireAuthoritativePluginRuntimeRegistryLease).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happier-home',
    });
    expect(releaseRuntimeRegistryLease).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveMergedContributionRegistry).not.toHaveBeenCalled();
  });

  it('uses an explicit initial transcript cursor only for the attach payload', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: 'session-1',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 99 },
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSessionAttachFile } = await import('../sessionAttachFile');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(createSessionAttachFile).mockResolvedValueOnce({
      filePath: '/tmp/session-attach.json',
      cleanup: vi.fn(),
    });
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        ...createParams().options,
        resume: undefined,
        existingSessionId: 'session-1',
        initialTranscriptAfterSeq: 36,
      },
    });

    expect(result).toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
    expect(createSessionAttachFile).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'session-1',
      payload: expect.objectContaining({
        encryptionMode: 'plain',
        lastObservedMessageSeq: 36,
        initialTranscriptAfterSeq: 36,
      }),
    }));
    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      trackedSpawnOptions: expect.not.objectContaining({
        initialTranscriptAfterSeq: expect.any(Number),
      }),
    }));
  });

  it('passes connected-service child selections into the spawn lifecycle wiring', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSpawnLifecycleCallbacks } = await import('../spawn/createSpawnLifecycleCallbacks');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[{"kind":"group","serviceId":"openai-codex"}]',
      },
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        ...createParams().options,
        resume: undefined,
      },
    });

    expect(createSpawnLifecycleCallbacks).toHaveBeenCalledWith(expect.objectContaining({
      connectedServiceSelectionsEnvRaw: '[{"kind":"group","serviceId":"openai-codex"}]',
    }));
  });

  it('activates one canonical Agent session lease before spawn and retires it on launch refusal', async () => {
    const events: string[] = [];
    const agentPurpose = {
      consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
      purpose: 'openai-codex-model-request',
    };
    const agentPurposeBinding = {
      purpose: agentPurpose,
      target: {
        kind: 'account' as const,
        account: {
          service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          },
          accountId: 'codex-work',
        },
      },
    };
    const agentRequestAuthUse = {
      purpose: agentPurpose,
      materialization: {
        kind: 'httpHeaders' as const,
        origin: 'https://chatgpt.com',
        headerNames: ['authorization', 'chatgpt-account-id'],
      },
    };
    const managedPurpose = {
      consumer: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      purpose: 'openai-upstream',
    };
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: 'session-1',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'pi',
      },
      sessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      catalogAgentId: 'pi',
    });
    hoisted.ensureSessionDirectory.mockResolvedValueOnce({
      ok: true,
      directoryCreated: false,
    });
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValueOnce({
      registry: {
        contributes: {
          ...createRegistryWithBackendOwners({ pi: 'happier.agent.pi' }),
          agentDefinitionsById: new Map([['pi', {
            identity: { pluginId: 'happier.agent.pi', localId: 'pi' },
            richDefinition: {
              definition: {
                connectedAccounts: [{
                  purpose: 'openai-codex-model-request',
                  service: {
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                  },
                }],
              },
            },
            catalogEntry: {
              connectedAccountRequestAuthUses: [{
                purpose: agentPurpose.purpose,
                materialization: agentRequestAuthUse.materialization,
              }],
            },
          }]]),
        },
        agentRuntimesByAgentId: new Map(),
      },
      source: 'active',
      release: vi.fn(async () => undefined),
    });

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { resolveConnectedServiceAuthForSpawn } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    const { createSessionAttachFile } = await import('../sessionAttachFile');
    vi.mocked(createSessionAttachFile).mockResolvedValueOnce({
      filePath: '/tmp/session-1-attach.json',
      cleanup: vi.fn(async () => undefined),
    });
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockResolvedValueOnce({
      env: {},
      targetMaterializedRoot: '/tmp/pi-materialized',
      cleanupOnFailure: null,
      cleanupOnExit: null,
      connectedServicesBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'codex-work',
          },
        },
      },
      requestAuthPurposeBindings: [agentPurposeBinding],
    });
    vi.mocked(resolveSpawnChildEnvironment).mockImplementationOnce(async () => {
      events.push('child-environment');
      return {
        ok: true,
        cleanupOnFailure: null,
        cleanupOnExit: null,
        expandedEnvironmentVariables: {},
        extraEnvForChild: {},
      };
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockImplementationOnce(async () => {
      events.push('spawn');
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: 'fixture launch refusal',
      };
    });
    const descriptor = {
      path: '/tmp/pi-materialized/.happier/request-auth-capability.json',
      materializationId: 'csm_pi_request_auth',
      subjectScopeDigest: 'a'.repeat(64),
      capabilityDigest: 'b'.repeat(64),
    };
    const requestAuthRegistry = {
      activate: vi.fn(async (input) => {
        events.push('activate');
        expect(input.subject.resolvePurposeUse(agentPurpose)).toEqual({
          binding: agentPurposeBinding,
          use: agentRequestAuthUse,
        });
        expect(input.subject.resolvePurposeUse(managedPurpose)).toBeNull();
        expect(input.subject.listPurposeUses()).toEqual([{
          binding: agentPurposeBinding,
          use: agentRequestAuthUse,
        }]);
        return descriptor;
      }),
      retire: vi.fn(async () => undefined),
    };
    const sessionPurposeBindingSubject = {
      subjectId: 'agent-session:session-1',
      isCurrent: () => true,
      resolvePurposeBinding: (purpose: typeof agentPurpose) => (
        purpose.consumer.pluginId === agentPurpose.consumer.pluginId
        && purpose.consumer.localId === agentPurpose.consumer.localId
        && purpose.purpose === agentPurpose.purpose
          ? agentPurposeBinding
          : null
      ),
      listPurposeBindings: () => [agentPurposeBinding],
      dispose: vi.fn(),
    };
    const activateSessionPurposeBindings = vi.fn(() => {
      events.push('lease');
      return sessionPurposeBindingSubject;
    });

    await expect(executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        existingSessionId: 'session-1',
        backendTarget: {
          kind: 'backend',
          backendId: 'pi',
          sourceKind: 'built_in',
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex-work',
            },
          },
        },
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'csm_pi_request_auth',
          createdAt: 1,
          source: 'first_spawn',
        },
      },
      connectedAccountRequestAuthRegistry: requestAuthRegistry,
      connectedAccountRequestAuthHttpPort: 18_765,
      activateSessionPurposeBindings,
    })).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: 'fixture launch refusal',
    });

    expect(events.slice(0, 4)).toEqual([
      'lease',
      'activate',
      'child-environment',
      'spawn',
    ]);
    expect(activateSessionPurposeBindings).toHaveBeenCalledWith({
      sessionId: 'session-1',
      purposes: [agentPurpose],
      bindings: [agentPurposeBinding],
    });
    expect(requestAuthRegistry.activate).toHaveBeenCalledWith({
      subject: expect.objectContaining({
        subjectId: 'agent-session:session-1/agent:pi',
      }),
      materializedRootDir: '/tmp/pi-materialized',
      materializationId: 'csm_pi_request_auth',
      httpPort: 18_765,
    });
    expect(requestAuthRegistry.retire).toHaveBeenCalledWith(descriptor);
    expect(sessionPurposeBindingSubject.dispose).toHaveBeenCalledTimes(1);
  });

  it('defers one fresh Agent + managed Provider lease and both scoped capabilities until the canonical server session id', async () => {
    const events: string[] = [];
    const managedConnectionId =
      ProviderConnectionIdSchema.parse('pc_fresh_managed');
    const managedPurposeBinding = {
      purpose: {
        consumer: {
          pluginId: 'happier.provider.cliproxyapi',
          localId: 'cliproxyapi',
        },
        purpose: 'openai-upstream',
      },
      target: {
        kind: 'account' as const,
        account: {
          service: {
            pluginId: 'happier.connected-account.openai',
            localId: 'codex',
          },
          accountId: 'managed-work',
        },
      },
    };
    const managedRequestAuthUse = {
      purpose: managedPurposeBinding.purpose,
      materialization: {
        kind: 'httpHeaders' as const,
        origin: 'https://chatgpt.com',
        headerNames: ['authorization', 'chatgpt-account-id'],
      },
    };
    const managedSessionBindingMetadata = {
      v: 1 as const,
      connectionId: managedConnectionId,
      contributionKey:
        'happier.provider.cliproxyapi/cliproxyapi',
      connectionRevision: 1,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'cliproxyapi',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      displaySnapshot: {
        providerName: 'CLIProxyAPI',
        connectionName: 'CLIProxyAPI',
        connectionRole: 'default' as const,
        connectionDisplayNameMode: 'automatic' as const,
      },
    };
    const managedAttempt = {
      deployment: { kind: 'managedLocal' as const },
      authorization: {
        deployment: {
          kind: 'managedLocal' as const,
          contribution: {
            identity: {
              pluginId: 'happier.provider.cliproxyapi',
              localId: 'cliproxyapi',
            },
            definition: { name: 'CLIProxyAPI' },
          },
          implementation: {
            implementationIdentity: managedPurposeBinding.purpose.consumer,
            facet: {
              requestAuthUses: [{
                purpose: managedPurposeBinding.purpose.purpose,
                materialization: managedRequestAuthUse.materialization,
              }],
            },
            purposeBindings: {
              v: 1 as const,
              bindings: [managedPurposeBinding],
            },
          },
        },
        ticket: {
          connectionId: managedConnectionId,
          machineId: 'machine-a',
        },
        binding: {
          selection: { model: { id: 'model-a' } },
        },
        support: {
          authIsolation: {
            suppressConnectedServiceIds: [],
            ownedEnvKeys: [],
          },
        },
        sessionBindingMetadata: managedSessionBindingMetadata,
      },
      isAuthorizationCurrent: () => true,
      revalidateBeforeEffect: vi.fn(async () => ({ ok: true as const })),
      revalidateBeforeCommit: vi.fn(async () => ({ ok: true as const })),
      materializeManagedEndpoint: vi.fn(),
      cleanupOnFailure: vi.fn(),
      takeCleanupOnExit: () => null,
    } as unknown as ProviderSpawnAuthorizationAttempt;
    hoisted.createRuntimeProviderSpawnAuthorizationAttempt.mockResolvedValueOnce({
      ok: true,
      attempt: managedAttempt,
    });
    const agentPurpose = {
      consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
      purpose: 'openai-codex-model-request',
    };
    const agentPurposeBinding = {
      purpose: agentPurpose,
      target: {
        kind: 'account' as const,
        account: {
          service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          },
          accountId: 'codex-work',
        },
      },
    };
    const agentRequestAuthUse = {
      purpose: agentPurpose,
      materialization: {
        kind: 'httpHeaders' as const,
        origin: 'https://chatgpt.com',
        headerNames: ['authorization', 'chatgpt-account-id'],
      },
    };
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'pi',
      },
      sessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      catalogAgentId: 'pi',
    });
    hoisted.ensureSessionDirectory.mockResolvedValueOnce({
      ok: true,
      directoryCreated: false,
    });
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValueOnce({
      registry: {
        contributes: {
          ...createRegistryWithBackendOwners({ pi: 'happier.agent.pi' }),
          agentDefinitionsById: new Map([['pi', {
            identity: { pluginId: 'happier.agent.pi', localId: 'pi' },
            richDefinition: {
              definition: {
                connectedAccounts: [{
                  purpose: 'openai-codex-model-request',
                  service: {
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                  },
                }],
              },
            },
            catalogEntry: {
              connectedAccountRequestAuthUses: [{
                purpose: agentPurpose.purpose,
                materialization: agentRequestAuthUse.materialization,
              }],
            },
          }]]),
        },
        agentRuntimesByAgentId: new Map(),
      },
      source: 'active',
      release: vi.fn(async () => undefined),
    });

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSpawnLifecycleCallbacks } = await import('../spawn/createSpawnLifecycleCallbacks');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { resolveConnectedServiceAuthForSpawn } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockResolvedValueOnce({
      env: {},
      targetMaterializedRoot: '/tmp/pi-materialized',
      cleanupOnFailure: null,
      cleanupOnExit: null,
      connectedServicesBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'codex-work',
          },
        },
      },
      requestAuthPurposeBindings: [agentPurposeBinding],
    });
    const activateManagedProviderRequestAuth = vi.fn(async (subject) => {
      events.push('managed-capability');
      expect(subject.resolvePurposeUse(managedPurposeBinding.purpose)).toEqual({
        binding: managedPurposeBinding,
        use: managedRequestAuthUse,
      });
      expect(subject.resolvePurposeUse(agentPurpose)).toBeNull();
      expect(subject.listPurposeUses()).toEqual([{
        binding: managedPurposeBinding,
        use: managedRequestAuthUse,
      }]);
    });
    hoisted.prepareDaemonManagedProviderBinding.mockImplementationOnce(
      async (input) => {
        events.push('wrapper-start');
        expect(input.context).toMatchObject({
          operationId: 'fresh-managed-spawn-nonce',
        });
        expect(input.requestAuthSubject).toBeUndefined();
        return {
          ok: true as const,
          materialization: {
            providerEnvironmentOverlay: [],
            launchMaterialization: {
              v: 1 as const,
              kind: 'engineConfig' as const,
              engineConfig: { endpoint: 'runtime-only' },
            },
            additionalRedactionValues: [],
            cleanup: null,
          },
          redactionLease: {
            redact: (value: string) => value,
            values: () => [],
            add: () => undefined,
            snapshotRedactor: () => (value: string) => value,
            createStreamingSanitizer: () => ({
              push: (value: string | Uint8Array) => String(value),
              flush: () => '',
            }),
            close: vi.fn(),
          },
          sessionBindingMetadata: managedSessionBindingMetadata,
          activateManagedProviderRequestAuth,
        };
      },
    );
    vi.mocked(resolveSpawnChildEnvironment).mockImplementationOnce(async (input) => {
      events.push('child-environment');
      const late = await input.materializeProviderBindingAfterHooks?.();
      expect(late).toMatchObject({ ok: true });
      return {
        ok: true,
        cleanupOnFailure: null,
        cleanupOnExit: null,
        expandedEnvironmentVariables: {},
        extraEnvForChild: {},
        providerBindingLaunchHandoff:
          late?.ok ? late.providerBindingLaunchHandoff : undefined,
      };
    });
    const descriptor = {
      path: '/tmp/pi-materialized/.happier/request-auth-capability.json',
      materializationId: 'csm_pi_request_auth_fresh',
      subjectScopeDigest: 'a'.repeat(64),
      capabilityDigest: 'b'.repeat(64),
    };
    const requestAuthRegistry = {
      activate: vi.fn(async (input) => {
        events.push('activate');
        expect(input.subject.resolvePurposeUse(agentPurpose)).toEqual({
          binding: agentPurposeBinding,
          use: agentRequestAuthUse,
        });
        expect(input.subject.resolvePurposeUse(managedPurposeBinding.purpose))
          .toBeNull();
        expect(input.subject.listPurposeUses()).toEqual([{
          binding: agentPurposeBinding,
          use: agentRequestAuthUse,
        }]);
        return descriptor;
      }),
      retire: vi.fn(async () => undefined),
    };
    const sessionPurposeBindingSubject = {
      subjectId: 'agent-session:session-from-server',
      isCurrent: () => true,
      resolvePurposeBinding: (purpose: typeof agentPurpose) => {
        if (
          purpose.consumer.pluginId === agentPurpose.consumer.pluginId
          && purpose.consumer.localId === agentPurpose.consumer.localId
          && purpose.purpose === agentPurpose.purpose
        ) {
          return agentPurposeBinding;
        }
        if (
          purpose.consumer.pluginId
            === managedPurposeBinding.purpose.consumer.pluginId
          && purpose.consumer.localId
            === managedPurposeBinding.purpose.consumer.localId
          && purpose.purpose === managedPurposeBinding.purpose.purpose
        ) {
          return managedPurposeBinding;
        }
        return null;
      },
      listPurposeBindings: () => [
        agentPurposeBinding,
        managedPurposeBinding,
      ],
      dispose: vi.fn(),
    };
    const activateSessionPurposeBindings = vi.fn(() => {
      events.push('lease');
      return sessionPurposeBindingSubject;
    });
    let lifecycleInput:
      Parameters<typeof createSpawnLifecycleCallbacks>[0]
      | null = null;
    const lifecycleCallbacks = {
      persistAcceptedSpawnMarker: vi.fn(async () => undefined),
      removeAcceptedSpawnMarkerIfOwned:
        vi.fn(async () => true),
      consumeSessionAttachCleanupForPid: vi.fn(),
      cleanupPendingSessionAttach: vi.fn(async () => undefined),
      registerSpawnResourceCleanupForPid: vi.fn(),
      registerConnectedServiceSpawnTarget: vi.fn(),
    };
    vi.mocked(createSpawnLifecycleCallbacks).mockImplementationOnce((input) => {
      lifecycleInput = input;
      return lifecycleCallbacks;
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockImplementationOnce(async () => {
      events.push('spawn');
      expect(events).toEqual(['child-environment', 'wrapper-start', 'spawn']);
      expect(activateSessionPurposeBindings).not.toHaveBeenCalled();
      expect(requestAuthRegistry.activate).not.toHaveBeenCalled();
      expect(activateManagedProviderRequestAuth).not.toHaveBeenCalled();
      const activateAfterCanonicalSession =
        lifecycleInput
          ?.activateConnectedAccountSessionBindingOnCanonicalSession;
      expect(activateAfterCanonicalSession).toEqual(expect.any(Function));
      await expect(
        activateAfterCanonicalSession?.('session-from-server'),
      ).resolves.toBeNull();
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: 'fixture launch refusal',
      };
    });

    await expect(executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        sessionId: 'caller-reservation',
        spawnNonce: 'fresh-managed-spawn-nonce',
        machineId: 'machine-a',
        backendTarget: {
          kind: 'backend',
          backendId: 'pi',
          sourceKind: 'built_in',
        },
        modelSelection: {
          v: 1,
          updatedAt: 1,
          ref: {
            agentTargetKey: 'backend:pi',
            providerConnectionId: managedConnectionId,
            modelId: 'model-a',
          },
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex-work',
            },
          },
        },
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'csm_pi_request_auth_fresh',
          createdAt: 1,
        },
      },
      managedProviderEndpointRuntime: {
        resolveManagedLocalServicesEnabled: async () => true,
      } as never,
      resolveProvidersFeatureEnabled: async () => true,
      connectedAccountRequestAuthRegistry: requestAuthRegistry,
      connectedAccountRequestAuthHttpPort: 18_765,
      activateSessionPurposeBindings,
    })).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: 'fixture launch refusal',
    });

    expect(events.slice(0, 6)).toEqual([
      'child-environment',
      'wrapper-start',
      'spawn',
      'lease',
      'activate',
      'managed-capability',
    ]);
    expect(resolveConnectedServiceAuthForSpawn).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.anything() }),
    );
    expect(activateSessionPurposeBindings).toHaveBeenCalledWith({
      sessionId: 'session-from-server',
      purposes: [agentPurpose, managedPurposeBinding.purpose],
      bindings: [agentPurposeBinding, managedPurposeBinding],
    });
    expect(requestAuthRegistry.activate).toHaveBeenCalledWith({
      subject: expect.objectContaining({
        subjectId: expect.stringContaining(
          'agent-session:session-from-server/agent:',
        ),
      }),
      materializedRootDir: '/tmp/pi-materialized',
      materializationId: 'csm_pi_request_auth_fresh',
      httpPort: 18_765,
    });
    expect(activateManagedProviderRequestAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: expect.stringContaining(
          'agent-session:session-from-server/managed-provider:',
        ),
      }),
    );
    expect(requestAuthRegistry.retire).toHaveBeenCalledWith(descriptor);
    expect(sessionPurposeBindingSubject.dispose).toHaveBeenCalledTimes(1);
  });

   it('uses one generated connected-service materialization identity for first-spawn materialization and tracked re-entry state', async () => {
    const ambientMaterializationIdentity = {
      v: 1,
      id: 'csm_ambient_daemon_process_env',
      createdAt: 123,
      source: 'daemon_process_env',
    };
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSpawnLifecycleCallbacks } = await import('../spawn/createSpawnLifecycleCallbacks');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { resolveConnectedServiceAuthForSpawn } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    const { buildTrackedSessionRespawnEnvironmentVariables } = await import('../processSupervision/sessionRunnerRespawnDescriptor');
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockResolvedValueOnce({
      env: {},
      cleanupOnFailure: null,
      cleanupOnExit: null,
      connectedServicesBindings: { v: 1, bindingsByServiceId: {} },
    });
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(buildTrackedSessionRespawnEnvironmentVariables).mockReturnValueOnce({});
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'work',
            },
          },
        },
      },
      processEnv: {
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]:
          JSON.stringify(ambientMaterializationIdentity),
      },
    });

    const materializationKey = vi.mocked(resolveConnectedServiceAuthForSpawn).mock.calls[0]?.[0].materializationKey;
    expect(materializationKey).toEqual(expect.stringMatching(/^csm_/));
    expect(materializationKey).not.toBe(ambientMaterializationIdentity.id);
    expect(materializationKey).not.toEqual(expect.stringMatching(/^spawn-/));
    expect(resolveSpawnChildEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        connectedServiceMaterializationIdentityV1: expect.objectContaining({
          id: materializationKey,
          source: 'first_spawn',
        }),
      }),
    }));
    expect(createSpawnLifecycleCallbacks).toHaveBeenCalledWith(expect.objectContaining({
      materializationKey,
    }));
    expect(buildTrackedSessionRespawnEnvironmentVariables).toHaveBeenCalledWith(expect.objectContaining({
      extraEnvForChild: expect.objectContaining({
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: expect.stringContaining(String(materializationKey)),
      }),
    }));
    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      trackedSpawnOptions: expect.objectContaining({
        connectedServiceMaterializationIdentityV1: expect.objectContaining({
          id: materializationKey,
        }),
      }),
      extraEnvForChildWithMessage: expect.objectContaining({
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: expect.stringContaining(String(materializationKey)),
      }),
    }));
  });

  it('propagates canonicalized connected-service group bindings into the spawn environment and tracked state', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSpawnLifecycleCallbacks } = await import('../spawn/createSpawnLifecycleCallbacks');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { resolveConnectedServiceAuthForSpawn } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    const { buildTrackedSessionRespawnEnvironmentVariables } = await import('../processSupervision/sessionRunnerRespawnDescriptor');
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockResolvedValueOnce({
      env: {},
      cleanupOnFailure: null,
      cleanupOnExit: null,
      connectedServicesBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'codex4',
          },
        },
      },
    });
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(buildTrackedSessionRespawnEnvironmentVariables).mockReturnValueOnce({});
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'we-are',
            },
          },
        },
      },
    });

    expect(resolveSpawnChildEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'codex4',
            },
          },
        },
      }),
    }));
    expect(createSpawnLifecycleCallbacks).toHaveBeenCalledWith(expect.objectContaining({
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'codex4',
          },
        },
      },
    }));
    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      trackedSpawnOptions: expect.objectContaining({
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'codex4',
            },
          },
        },
      }),
    }));
  });

  it('uses a daemon-certified materialization identity repair for existing connected-service spawns', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.vendorResumeSupport.mockReturnValue(true);
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: 'sess-claude-repair',
      effectiveResume: 'claude-vendor-session-1',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'claude',
      },
      sessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      catalogAgentId: 'claude',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSessionAttachFile } = await import('../sessionAttachFile');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { resolveConnectedServiceAuthForSpawn } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(createSessionAttachFile).mockResolvedValueOnce({
      filePath: '/tmp/session-attach.json',
      cleanup: vi.fn(),
    });
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockResolvedValueOnce({
      env: {},
      cleanupOnFailure: null,
      cleanupOnExit: null,
      connectedServicesBindings: { v: 1, bindingsByServiceId: {} },
    });
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'sess-claude-repair',
    });
    const repairedIdentity = {
      v: 1 as const,
      id: 'csm_repaired_claude',
      createdAt: 123,
      source: 'first_spawn',
    };
    const repairMissingConnectedServiceMaterializationIdentityForSpawn = vi.fn(async () => repairedIdentity);

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        existingSessionId: 'sess-claude-repair',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected',
              selection: 'profile',
              profileId: 'claude-work',
            },
          },
        },
      },
      repairMissingConnectedServiceMaterializationIdentityForSpawn,
    });

    expect(result).toEqual({
      type: 'success',
      sessionId: 'sess-claude-repair',
    });
    expect(repairMissingConnectedServiceMaterializationIdentityForSpawn).toHaveBeenCalledWith({
      sessionId: 'sess-claude-repair',
      agentId: 'claude',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'claude-work',
          },
        },
      },
      vendorResumeId: 'claude-vendor-session-1',
    });
    expect(resolveConnectedServiceAuthForSpawn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-claude-repair',
      materializationKey: repairedIdentity.id,
    }));
    expect(resolveSpawnChildEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        connectedServiceMaterializationIdentityV1: repairedIdentity,
      }),
    }));
  });

  it('returns a structured connected-service ux diagnostic when an existing connected-service spawn has no materialization identity', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.vendorResumeSupport.mockReturnValue(true);
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: 'sess-missing-identity',
      effectiveResume: 'codex-vendor-session-1',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );
    const providerCleanupOnFailure = vi.fn();
    hoisted.createRuntimeProviderSpawnAuthorizationAttempt.mockResolvedValueOnce({
      ok: true,
      attempt: {
        deployment: { kind: 'external' },
        authorization: {
          ticket: { connectionId: ProviderConnectionIdSchema.parse('pc_gateway') },
          binding: { selection: { model: { id: 'model-a', name: 'Model A' } } },
          support: { authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] } },
          sessionBindingMetadata: {
            v: 1,
            connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
            contributionKey: 'plugin.gateway/gateway',
            connectionRevision: 1,
            protocol: 'openai-responses',
            materialization: 'engineConfig',
            adapterBindingKey: 'gateway',
            compatibilityFingerprint: 'compatibility-v1',
            bindingSecurityFingerprint: 'security-v1',
            displaySnapshot: {
              providerName: 'Gateway', connectionName: 'Gateway', connectionRole: 'default',
              connectionDisplayNameMode: 'automatic',
            },
          },
        },
        materializeAfterHooks: vi.fn(),
        revalidateBeforeCommit: vi.fn(),
        cleanupOnFailure: providerCleanupOnFailure,
        takeCleanupOnExit: vi.fn(),
      },
    });

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockClear();

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        existingSessionId: 'sess-missing-identity',
        machineId: 'machine-a',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        modelSelection: {
          v: 1,
          updatedAt: 1,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
            modelId: 'model-a',
          },
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex-work',
            },
          },
        },
      },
      repairMissingConnectedServiceMaterializationIdentityForSpawn: vi.fn(async () => null),
      resolveProvidersFeatureEnabled: async () => true,
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
    });
    if (result.type !== 'error') throw new Error('expected spawn error');
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected connected-service ux diagnostic detail');
    }
    expect(result.errorDetail.uxDiagnostic).toMatchObject({
      code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
      failurePhase: 'materialization',
      source: 'spawn_resume',
      agentId: 'codex',
      retryable: false,
      diagnostics: {
        reason: 'missing_identity_and_resume_state',
      },
    });
    expect(routeSpawnModeAndWaitForWebhook).not.toHaveBeenCalled();
    expect(providerCleanupOnFailure).toHaveBeenCalledTimes(1);
  });

  it('returns a structured connected-service ux diagnostic when connected-service materialization is blocked before spawn', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'claude',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'claude',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { resolveConnectedServiceAuthForSpawn } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { ConnectedServiceMaterializationBlockedError } = await import('../connectedServices/materialize/materializeConnectedServicesForSpawn');
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockRejectedValueOnce(
      new ConnectedServiceMaterializationBlockedError([{
        code: 'claude_subscription_missing_claude_code_scope',
        providerId: 'claude',
        serviceId: 'claude-subscription',
        severity: 'blocking',
        reason: 'missing_required_scope',
        entryName: 'user:sessions:claude_code',
      }]),
    );

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected',
              selection: 'profile',
              profileId: 'claude-work',
            },
          },
        },
      },
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'claude_subscription_missing_claude_code_scope',
    });
    if (result.type !== 'error') throw new Error('expected spawn error');
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected connected-service ux diagnostic detail');
    }
    expect(result.errorDetail.uxDiagnostic).toMatchObject({
      code: 'claude_subscription_missing_claude_code_scope',
      failurePhase: 'materialization',
      source: 'spawn_resume',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      retryable: false,
      diagnostics: {
        reason: 'missing_required_scope',
        materializationCode: 'claude_subscription_missing_claude_code_scope',
        entryName: 'user:sessions:claude_code',
      },
    });
    expect(routeSpawnModeAndWaitForWebhook).not.toHaveBeenCalled();
  });

  it('tracks connected-service materialization diagnostics on tracked spawn options for downstream switch surfaces', async () => {
    const diagnostics = [{
      code: 'state_sharing_degraded',
      providerId: 'claude',
      serviceId: 'anthropic',
      requestedStateMode: 'shared',
      effectiveStateMode: 'isolated',
      reason: 'provider_state_unavailable',
    }] as const;
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'claude',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'claude',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
      materializationDiagnostics: diagnostics,
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
    });

    expect(result).toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      trackedSpawnOptions: expect.objectContaining({
        materializationDiagnostics: diagnostics,
      }),
    }));
  });

  it('canonicalizes legacy runtime descriptors before vendor resume support reads spawn runtime selection', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({
      id: 'codex',
      vendorResumeSupport: 'experimental',
    });
    hoisted.vendorResumeSupport.mockImplementation((params: VendorResumeSupportParams & {
      runtimeDescriptorV1?: unknown;
      agentRuntimeDescriptorV1?: unknown;
    }) => {
      expect(params).toMatchObject({
        codexBackendMode: 'appServer',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'legacy-thread',
          },
        },
      });
      expect(params).not.toHaveProperty('agentRuntimeDescriptorV1');
      return params.codexBackendMode === 'appServer';
    });

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const baseParams = createParams();

    const result = await executeSpawnSessionRequest({
      ...baseParams,
      options: {
        ...baseParams.options,
        experimentalCodexAcp: undefined,
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'legacy-thread',
          },
        },
      },
    });

    expect(hoisted.vendorResumeSupport).toHaveBeenCalledWith(expect.objectContaining({ codexBackendMode: 'appServer' }));
    expect(result).not.toEqual(
      expect.objectContaining({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
      }),
    );
  });

  it('delegates legacy codex resume compat through canonical spawn runtime selection without daemon hooks', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({
      id: 'codex',
      vendorResumeSupport: 'experimental',
    });
    hoisted.vendorResumeSupport.mockImplementation((params: VendorResumeSupportParams) => params.codexBackendMode === 'appServer');

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');

    const baseParams = createParams();
    const result = await executeSpawnSessionRequest({
      ...baseParams,
      options: {
        ...baseParams.options,
        codexBackendMode: 'appServer',
      },
    });

    expect(hoisted.vendorResumeSupport).toHaveBeenCalledWith(expect.objectContaining({ codexBackendMode: 'appServer' }));
    expect(result).not.toEqual(
      expect.objectContaining({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
      }),
    );
  });

	  it('fails fast for macOS background-service spawns targeting protected home directories', async () => {
	    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
	      throw new Error('Expected process.platform to be configurable for this test');
	    }
	    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

    const startupSourceOriginal = process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    const homeOriginal = process.env.HOME;
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'background-service';
    process.env.HOME = '/Users/tester';

	    try {
	      hoisted.requireCatalogEntry.mockReturnValue({
	        id: 'codex',
	        vendorResumeSupport: 'experimental',
	      });
	      hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
	        ok: true,
	        normalizedExistingSessionId: '',
	        effectiveResume: '',
	        effectiveBackendTargetV2: {
	          kind: 'backend',
	          sourceKind: 'built_in',
	          backendId: 'codex',
	        },
	        sessionAttachPayload: null,
	        catalogAgentId: 'codex',
	      });
	      hoisted.ensureSessionDirectory.mockImplementationOnce(
	        async () => ({ ok: true, directoryCreated: false } as const),
	      );

      const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');

      const result = await executeSpawnSessionRequest({
        ...createParams(),
        options: {
          ...createParams().options,
          directory: '/Users/tester/Documents/project',
          resume: undefined,
        },
      });

      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: expect.stringContaining('background-service'),
      });
      expect(String((result as { errorMessage?: string }).errorMessage ?? '')).toContain('/Users/tester/Documents/project');
    } finally {
      if (startupSourceOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
      } else {
        process.env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSourceOriginal;
      }
      if (homeOriginal === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = homeOriginal;
      }
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
  });

  it('does not synthesize codex resume compat params when no canonical runtime selection exists', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({
      id: 'codex',
      vendorResumeSupport: 'experimental',
    });
    hoisted.vendorResumeSupport.mockImplementation((params: VendorResumeSupportParams) => {
      expect(params).toEqual({});
      return false;
    });

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');

    const baseParams = createParams();
    const result = await executeSpawnSessionRequest({
      ...baseParams,
      options: {
        ...baseParams.options,
        experimentalCodexAcp: undefined,
      },
    });

    expect(hoisted.vendorResumeSupport).toHaveBeenCalledWith({});
    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
      errorMessage: "Resume is not supported for agent 'codex' (experimental and not enabled).",
    });
  });
});
