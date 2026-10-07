import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const boundaries = vi.hoisted(() => ({
  lease: null as unknown,
  bridgeAgentId: 'codex',
  bridgePluginId: 'happier.agent.codex',
  bridgeCleanup: vi.fn(async () => undefined),
  bridgePrepared: vi.fn(() => undefined),
  providersFeatureEnabled: true,
  leaseRelease: vi.fn(async () => undefined),
  mutateDuringMaterialization: null as null | (() => void),
  providerMaterialization: 'spawnEnv' as 'spawnEnv' | 'configFile',
  providerSuppressedConnectedServiceIds: [] as string[],
  connectedServiceCleanupOnFailure: vi.fn(() => undefined),
  connectedServiceCleanupOnExit: vi.fn(() => undefined),
  reserveManagedDependencyRetention: vi.fn(),
  attachExactRunnerRetainedPluginGenerations: vi.fn(),
  processIdentityAvailable: true,
  connectedServiceChildEnvironmentMode:
    'requestAuth' as 'requestAuth' | 'authEnv',
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: async () =>
    boundaries.lease,
}));

vi.mock('@/daemon/spawn/prepareAgentRuntimeSessionBridge', () => ({
  prepareForegroundAgentRuntimeBootstrapForLease: async () => {
    // Records that bootstrap material was actually written, so a test can
    // prove a refusal landed before the bridge ran at all.
    boundaries.bridgePrepared();
    return ({
    authorization: {
      capabilityHash: 'sha256:test',
      foregroundAdmissionFilePath:
        '/private/foreground-admission.json',
      bootstrapFilePath: '/private/foreground-bootstrap.json',
      authorityFilePath: '/private/foreground-authority.json',
      descriptor: {
        v: 1,
        pluginId: boundaries.bridgePluginId,
        pluginVersion: '1.0.0',
        agentId: boundaries.bridgeAgentId,
        backendId: boundaries.bridgeAgentId,
        occurrenceId: 'occurrence:bridge-plugin:1',
        sourceCustody: {
          kind: 'managed',
          immutableGenerationId: 'generation-1',
          installSource: 'localPath',
        },
      },
    },
    childEnv: {},
    cleanupBootstrapFiles: boundaries.bridgeCleanup,
    });
  },
}));

vi.mock('@/daemon/processIdentity', () => ({
  readProcessIdentityByPid: async (pid: number) =>
    boundaries.processIdentityAvailable
      ? ({
          pid,
          processStartTimeMs: 1,
          command: ['happier', 'session-runner'],
        })
      : null,
}));

vi.mock('@/daemon/sessionRegistry', () => ({
  hashProcessCommand: () => 'command-hash',
}));

vi.mock('@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity', () => ({
  resolveSessionRunnerEntrypointIdentityFromProcessCommand: () => ({
    status: 'known',
    comparableId: 'runner-snapshot',
  }),
}));

vi.mock('@/plugins/store/registry/generationCustodyRetirement', () => ({
  attachExactRunnerRetainedPluginGenerations: (input: {
    attach(): Promise<boolean>;
  }) => boundaries.attachExactRunnerRetainedPluginGenerations(input),
}));

vi.mock('./sessionBridgeAuthorization', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sessionBridgeAuthorization')>(),
  publishAgentRuntimeDaemonServiceAuthority: async (input: {
    path: string;
    retainedAgent: unknown;
    runner: unknown;
  }) => ({
    path: input.path,
    capabilityDigest: 'capability-digest-1',
    document: {
      retainedAgent: input.retainedAgent,
      runner: input.runner,
    },
  }),
  removeAgentRuntimeDaemonServiceAuthorityIfOwned:
    async () => true,
}));

vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecisionForServer: async () => ({
    decision: {
      state: boundaries.providersFeatureEnabled ? 'enabled' : 'disabled',
    },
  }),
}));

vi.mock('@/daemon/spawn/resolveSpawnChildEnvironment', () => ({
  resolveSpawnChildEnvironment: async (input: Readonly<{
    connectedServiceAuth?: Readonly<{ env?: Record<string, string> }>;
  }>) => {
    return input.connectedServiceAuth
    ? ({
        ok: true,
        expandedEnvironmentVariables: {},
        extraEnvForChild:
          boundaries.connectedServiceChildEnvironmentMode === 'authEnv'
            ? { ...(input.connectedServiceAuth.env ?? {}) }
            : {
                HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH:
                  '/private/request-auth/capability.json',
                CONNECTED_TOKEN: 'materialized',
              },
        unsetEnvKeys:
          boundaries.connectedServiceChildEnvironmentMode === 'authEnv'
            ? []
            : ['OLD_CONNECTED_TOKEN'],
        cleanupOnFailure: boundaries.connectedServiceCleanupOnFailure,
        cleanupOnExit: boundaries.connectedServiceCleanupOnExit,
      })
    : ({
        ok: true,
        cleanupOnFailure: null,
        cleanupOnExit: null,
      });
  },
}));

vi.mock('@/providers/registry/dnsEvidence', () => ({
  collectProviderConnectionDnsEvidence: async () =>
    new Map([['https://gateway.example/v1', ['1.1.1.1']]]),
}));

vi.mock('@/providers/runtimeState', () => ({
  createProviderRuntimeStateStore: () => ({
    read: async () => null,
  }),
}));

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  createProviderErrorV1,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  redactBugReportSensitiveText,
  type AgentProviderRequirementsV1,
} from '@happier-dev/protocol';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import {
  createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveProviderConnectionForMachine } from '@/providers/registry';

import { prepareForegroundAgentRuntimeAdmission } from './prepareForegroundAdmission';
import { resolvePurposeTeamCredentialBindingIntentsFromHome } from '@/session/services/spawnConnectedServicesDefaults';
import { SavedSecretOperationAdmissionError } from '@/settings/secrets/hydrateSavedSecretCatalog';
import {
  ForegroundAgentRuntimeAdmissionRequestV1Schema,
  type ForegroundAgentRuntimeAdmissionOwnerRequestV1,
} from './foregroundAdmissionContract';
import { configuration } from '@/configuration';
import {
  consumeProviderBindingLaunchHandoffFromEnvironments,
} from '@/plugins/runtime/providerBindings/handoff';
import {
  createProviderBindingLaunchMaterializationCleanup,
} from '@/providers/spawn/compose';
import {
  createConnectedAccountPurposeBindingOwner,
  type ConnectedAccountPurposeBindingStore,
} from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import {
  createConnectedAccountRequestAuthService,
  type ConnectedAccountRequestAuthSubject,
} from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { resolveConnectedServiceMaterializedRootDir } from '@/daemon/connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
const contributionKey = 'acme.gateway/gateway';
const settingsSecretKey = deriveSettingsSecretsKeyV1(
  new Uint8Array(32).fill(5),
);

const providerDefinition = ProviderContributionV1Schema.parse({
  v: 1,
  id: 'gateway',
  name: 'Gateway',
  kind: 'cloud',
  endpointTemplates: [{
    id: 'responses',
    protocol: 'openai-responses',
    baseUrl: 'https://gateway.example/v1',
    capabilities: {
      streaming: 'supported',
      toolRoundTrips: 'supported',
      statefulResponses: 'supported',
      reasoningControls: 'supported',
    },
  }],
  credential: {
    kind: 'apiKey',
    required: true,
    transports: [{
      id: 'bearer',
      protocols: ['openai-responses'],
      uses: ['runtime'],
      destination: {
        kind: 'httpHeader',
        name: 'Authorization',
        format: 'bearer',
      },
    }],
  },
  catalog: {
    source: 'static',
    manualModelPolicy: 'allowed',
    staticModels: [{
      id: 'model-a',
      name: 'Model A',
      capabilities: { toolRoundTrips: 'supported' },
    }],
  },
  compatibilityOverrides: [{
    agentTargetKey: 'agent:happier.agent.codex/codex',
    protocol: 'openai-responses',
    status: 'verified',
    reason: 'integration proof',
    evidence: {
      sourceUrls: ['https://docs.example/provider'],
      verifiedAt: '2026-07-10',
      testIds: ['foreground-admission'],
    },
  }],
});

const providerContribution: ResolvedProviderContribution = {
  provenance: 'external',
  source: { kind: 'path' },
  pluginId: 'acme.gateway',
  identity: { pluginId: 'acme.gateway', localId: 'gateway' },
  definition: providerDefinition,
};

const providerRequirements: AgentProviderRequirementsV1 = {
  acceptsProtocols: ['openai-responses'],
  required: { streaming: true, toolRoundTrips: true },
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
  materialization: 'spawnEnv',
  applyPolicy: 'restart_session',
  supportsFreeformModelIds: true,
};

function createProviderSettings() {
  const initial = ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1,
      id: connectionId,
      source: { kind: 'contribution', contributionKey },
      role: 'default',
      displayName: 'Gateway',
      displayNameMode: 'automatic',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  const resolved = resolveProviderConnectionForMachine({
    connectionId,
    machineId: 'machine-1',
    accountSettings: { providerSettingsV1: initial },
    registry: {
      providersByContributionKey:
        new Map([[contributionKey, providerContribution]]),
    },
    dnsEvidenceByEndpointUrl:
      new Map([['https://gateway.example/v1', ['1.1.1.1']]]),
  });
  if (resolved.status !== 'resolved') {
    throw new Error('Expected Provider connection fixture to resolve');
  }
  return ProviderSettingsV1Schema.parse({
    ...initial,
    accountGrants: [{
      v: 1,
      connectionId,
      connectionSecurityFingerprint:
        resolved.record.connectionSecurityFingerprint,
      confirmedAt: 1,
    }],
    secretBindingsByConnectionId: {
      [connectionId]: { account: { apiKey: 'provider-secret' } },
    },
  });
}

function encryptedSecret(id: string, value: string, updatedAt = 1) {
  return {
    id,
    name: id,
    kind: 'apiKey',
    encryptedValue: {
      _isSecretValue: true,
      encryptedValue: encryptSecretStringV1(
        value,
        settingsSecretKey,
        (length) => new Uint8Array(length).fill(3),
      ),
    },
    createdAt: 1,
    updatedAt,
  };
}

function publishSettings(params: Readonly<{
  version: number;
  providerSettings?: ReturnType<typeof createProviderSettings>;
  corruptProfileSecret?: boolean;
  providerSecretValue?: string;
  providerSecretUpdatedAt?: number;
  profileSecretRef?: string;
}>) {
  const providerSettings =
    params.providerSettings ?? createProviderSettings();
  const profileSecret = params.corruptProfileSecret
    ? {
        id: 'profile-secret',
        name: 'profile-secret',
        kind: 'apiKey',
        encryptedValue: {
          _isSecretValue: true,
          encryptedValue: 'invalid',
        },
        createdAt: 1,
        updatedAt: 1,
      }
    : encryptedSecret('profile-secret', 'profile-plaintext');
  setActiveAccountSettingsSnapshot({
    source: 'network',
    settings: {
      providerSettingsV1: providerSettings,
      secrets: [
        encryptedSecret(
          'provider-secret',
          params.providerSecretValue ?? 'provider-plaintext',
          params.providerSecretUpdatedAt,
        ),
        profileSecret,
      ],
      profiles: [{
        id: 'profile-1',
        name: 'Profile',
        envVarRequirements: [{
          name: 'PROFILE_SECRET',
          kind: 'secret',
          required: true,
        }],
        environmentVariables: [],
        defaultPermissionModeByTargetKey: {},
        compatibilityByTargetKey: {},
        isBuiltIn: false,
        createdAt: 1,
        updatedAt: 1,
        version: '1.0.0',
      }],
      secretBindingsByProfileId: {
        'profile-1': { PROFILE_SECRET: params.profileSecretRef ?? 'profile-secret' },
      },
    } as never,
    settingsVersion: params.version,
    loadedAtMs: params.version,
    settingsSecretsReadKeys: [settingsSecretKey],
    scopeKey: 'scope-1',
  });
}

function request(
  overrides: Partial<
    z.input<typeof ForegroundAgentRuntimeAdmissionRequestV1Schema>
    & Readonly<{ machineId: string }>
  > = {},
): ForegroundAgentRuntimeAdmissionOwnerRequestV1 {
  const input = {
    v: 1,
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    foregroundPid: 123,
    directory: '/workspace',
    machineId: 'machine-1',
    agentId: 'codex',
    backendTarget: {
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    },
    profileId: 'profile-1',
    accountSettingsScopeKey: 'scope-1',
    accountSettingsVersion: 1,
    selection: {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: connectionId,
        modelId: 'model-a',
      },
    },
    ...overrides,
  };
  const { machineId, ...wireRequest } = input;
  return {
    ...ForegroundAgentRuntimeAdmissionRequestV1Schema.parse(wireRequest),
    machineId,
  };
}

beforeEach(() => {
  resetActiveAccountSettingsSnapshotForTests();
  boundaries.bridgeAgentId = 'codex';
  boundaries.bridgePluginId = 'happier.agent.codex';
  boundaries.bridgeCleanup.mockClear();
  boundaries.bridgePrepared.mockClear();
  boundaries.providersFeatureEnabled = true;
  boundaries.leaseRelease.mockClear();
  boundaries.mutateDuringMaterialization = null;
  boundaries.providerMaterialization = 'spawnEnv';
  boundaries.providerSuppressedConnectedServiceIds = [];
  boundaries.connectedServiceCleanupOnFailure.mockClear();
  boundaries.connectedServiceCleanupOnExit.mockClear();
  boundaries.reserveManagedDependencyRetention.mockReset();
  boundaries.reserveManagedDependencyRetention.mockResolvedValue({
    retention: {
      v: 1,
      sourceCustodies: [],
      qualifiedDependencyIds: [],
    },
    release: vi.fn(),
  });
  boundaries.attachExactRunnerRetainedPluginGenerations.mockReset();
  boundaries.attachExactRunnerRetainedPluginGenerations.mockImplementation(
    async (input: { attach(): Promise<boolean> }) => await input.attach(),
  );
  boundaries.processIdentityAvailable = true;
  boundaries.connectedServiceChildEnvironmentMode = 'requestAuth';
  const retirement = new AbortController();
  const registry = {
    contributes: {
      agentDefinitionsById: new Map([['codex', {
        id: 'codex',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
        richDefinition: {
          definition: {
            connectedAccounts: [{
              purpose: 'primary',
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              required: false,
              materializationKinds: ['files'],
            }],
          },
        },
        provenance: 'first_party',
        source: { kind: 'bundled' },
        pluginId: 'happier.agent.codex',
        definition: {
          id: 'codex',
          kindVersion: 1,
          providerRequirements: {
            ...providerRequirements,
            authIsolation: {
              ...providerRequirements.authIsolation,
              get suppressConnectedServiceIds() {
                return boundaries.providerSuppressedConnectedServiceIds;
              },
            },
            get materialization() {
              return boundaries.providerMaterialization;
            },
          },
        },
      }]]),
      catalogEntriesById: {
        codex: {
          id: 'codex',
          cliSubcommand: 'codex',
          vendorResumeSupport: 'unsupported',
          connectedServiceIds: ['openai-codex'],
        },
      },
      providersByContributionKey:
        new Map([[contributionKey, providerContribution]]),
    },
    agentRuntimesByAgentId: new Map([['codex', {
      pluginId: 'happier.agent.codex',
      pluginVersion: '1.0.0',
      agentId: 'codex',
      generation: 'generation-1',
      occurrenceId: 'occurrence:bridge-plugin:1',
      sourceCustody: {
        kind: 'managed',
        immutableGenerationId: 'generation-1',
        installSource: 'localPath',
      },
      hasPrimaryRuntime: true,
      retirementSignal: retirement.signal,
      providerBinding: {
        v: 1,
        adapterVersion: 1,
        prepare: () => ({
          v: 1,
          materialization: boundaries.providerMaterialization,
          adapterBindingKey: 'gateway',
        }),
        materialize: async (input: Readonly<{
          credential: Readonly<{ kind: string; value?: string }>;
        }>) => {
          boundaries.mutateDuringMaterialization?.();
          if (boundaries.providerMaterialization === 'configFile') {
            return {
              v: 1 as const,
              kind: 'configFile' as const,
              env: [{
                name: 'PROVIDER_KEY',
                value: input.credential.value ?? null,
                source: 'provider' as const,
              }],
              files: [{
                relativePath: 'provider.json',
                utf8: '{}',
              }],
            };
          }
          return {
            v: 1 as const,
            kind: 'spawnEnv' as const,
            env: [{
              name: 'PROVIDER_KEY',
              value: input.credential.value ?? null,
              source: 'provider',
            }],
          };
        },
      },
      get sessionRunnerFactoryBinding() {
        return createAgentSessionRunnerFactoryBinding({
          v: 1,
          pluginId: boundaries.bridgePluginId,
          pluginVersion: '1.0.0',
          agentId: boundaries.bridgeAgentId,
          localAgentId: boundaries.bridgeAgentId,
          sourceCustody: {
            kind: 'managed',
            immutableGenerationId: 'generation-1',
            installSource: 'localPath',
          },
          locator: {
            module: './agent/runtime.mjs',
            export: 'createRuntime',
            runtimeApiVersion: 1,
          },
          normalizedModulePath: 'agent/runtime.mjs',
          loadMode: 'immutable-js',
        });
      },
      isCurrent: () => !retirement.signal.aborted,
      createRuntime: vi.fn(),
    }]]),
    reserveManagedDependencyRetention:
      boundaries.reserveManagedDependencyRetention,
    activateContributionsOnDemand: async () => [],
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  boundaries.lease = {
    registry,
    source: 'active',
    durableRevision: registry.durableRevision ?? -1,
    release: boundaries.leaseRelease,
  } satisfies PluginRuntimeRegistryLease;
});

describe('foreground admission composed real Provider authorization seam', () => {
  it('refreshes a persisted shared Profile binding before creating Session bootstrap effects', async () => {
    const sharedRef = 'happier:shared-secret:v1:resource-profile-shared';
    publishSettings({ version: 1, profileSecretRef: sharedRef });
    const refreshSavedSecretCatalogForOperation = vi.fn(async () => {
      throw new SavedSecretOperationAdmissionError({
        reason: 'reference_stale',
        reference: sharedRef,
      });
    });

    const admitted = await prepareForegroundAgentRuntimeAdmission(
      request(),
      { refreshSavedSecretCatalogForOperation },
    );

    expect(refreshSavedSecretCatalogForOperation).toHaveBeenCalledExactlyOnceWith({
      expectedScopeKey: 'scope-1',
      references: [{ ref: sharedRef }],
    });
    expect(admitted).toEqual({
      ok: false,
      error: createProviderErrorV1('provider_binding_changed', {
        machineId: 'machine-1',
        sourceProfileId: 'profile-1',
      }),
    });
    expect(boundaries.bridgePrepared).not.toHaveBeenCalled();
    expect(boundaries.leaseRelease).not.toHaveBeenCalled();
  });

  it.each([
    'reference_forbidden',
    'reference_deleted',
    'reference_mode_incompatible',
    'reference_repair_required',
    'reference_corrupt',
  ] as const)('keeps an unusable %s Profile binding a missing-secret refusal', async (reason) => {
    const sharedRef = 'happier:shared-secret:v1:resource-profile-shared';
    publishSettings({ version: 1, profileSecretRef: sharedRef });
    const refreshSavedSecretCatalogForOperation = vi.fn(async () => {
      throw new SavedSecretOperationAdmissionError({ reason, reference: sharedRef });
    });

    const admitted = await prepareForegroundAgentRuntimeAdmission(
      request(),
      { refreshSavedSecretCatalogForOperation },
    );

    expect(admitted).toEqual({
      ok: false,
      error: createProviderErrorV1('provider_secret_missing', {
        machineId: 'machine-1',
        sourceProfileId: 'profile-1',
      }),
    });
    expect(boundaries.bridgePrepared).not.toHaveBeenCalled();
  });

  it('refreshes shared Saved Secret authorization before creating Session bootstrap effects', async () => {
    publishSettings({ version: 1 });
    const refreshSavedSecretCatalogForOperation = vi.fn(async () => {
      throw new Error('shared access was revoked without a delivered AccountChange');
    });

    const admitted = await prepareForegroundAgentRuntimeAdmission(request({
      secretReferenceOverlay: {
        v: 1,
        bindings: {
          PROFILE_SECRET: {
            ref: 'happier:shared-secret:v1:resource-revoked',
            revision: 4,
          },
        },
      },
    }), { refreshSavedSecretCatalogForOperation });

    expect(refreshSavedSecretCatalogForOperation).toHaveBeenCalledTimes(1);
    expect(admitted).toEqual({
      ok: false,
      error: createProviderErrorV1('provider_secret_unavailable', {
        machineId: 'machine-1',
        sourceProfileId: 'profile-1',
      }),
    });
    expect(boundaries.bridgePrepared).not.toHaveBeenCalled();
    expect(boundaries.leaseRelease).not.toHaveBeenCalled();
  });

  it('revalidates Provider authorization before Profile decryption and returns no environment on staleness', async () => {
    publishSettings({ version: 1, corruptProfileSecret: true });
    const admitted = await prepareForegroundAgentRuntimeAdmission(request());
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.error.code);
    boundaries.mutateDuringMaterialization = () => {
      publishSettings({
        version: 2,
        corruptProfileSecret: true,
        providerSecretValue: 'provider-plaintext-rotated',
        providerSecretUpdatedAt: 2,
      });
    };
    boundaries.mutateDuringMaterialization();
    boundaries.mutateDuringMaterialization = null;
    const claimed = await admitted.prepared.claim({
      canonicalSessionId: 'canonical-session-1',
      httpPort: 40123,
      foregroundSatisfiedProfileSecretRequirementNames: [],
    });

    expect(claimed).toEqual({
      ok: false,
      error: createProviderErrorV1(
        'provider_authorization_changed',
        { connectionId, machineId: 'machine-1' },
      ),
    });
    expect(claimed).not.toHaveProperty('environment');
    expect(claimed).not.toHaveProperty('profileSecretRecovery');
    await admitted.prepared.cleanup();
  });

  it('refuses a Provider-bound foreground admission at the feature gate before any Agent runtime bootstrap material exists', async () => {
    publishSettings({ version: 1 });
    boundaries.providersFeatureEnabled = false;

    const admitted = await prepareForegroundAgentRuntimeAdmission(request());

    expect(admitted).toEqual({
      ok: false,
      error: createProviderErrorV1('provider_feature_disabled', {
        connectionId,
        machineId: 'machine-1',
      }),
    });
    // Bootstrap files can be cleaned up, but an activated Agent runtime
    // contribution cannot be un-activated, so a refusal this owner can already
    // establish must land before the bridge runs at all.
    expect(boundaries.bridgePrepared).not.toHaveBeenCalled();
    expect(boundaries.bridgeCleanup).not.toHaveBeenCalled();
    expect(boundaries.leaseRelease).toHaveBeenCalledTimes(1);
  });

  it('refuses an orphaned previous Provider binding before foreground Agent bootstrap', async () => {
    publishSettings({ version: 1 });

    const admitted = await prepareForegroundAgentRuntimeAdmission(request({
      selection: undefined,
      previousBinding: {
        v: 1,
        connectionId,
        contributionKey,
        connectionRevision: 1,
        protocol: 'openai-responses',
        materialization: 'spawnEnv',
        adapterBindingKey: 'gateway',
        compatibilityFingerprint: 'compatibility:v1:one',
        bindingSecurityFingerprint: 'binding-security:v1:one',
        displaySnapshot: {
          providerName: 'Gateway',
          connectionName: 'Gateway',
          connectionRole: 'default',
          connectionDisplayNameMode: 'automatic',
        },
      },
    }));

    expect(admitted).toEqual({
      ok: false,
      error: createProviderErrorV1('provider_binding_changed', {
        connectionId,
        machineId: 'machine-1',
      }),
    });
    expect(boundaries.bridgePrepared).not.toHaveBeenCalled();
    expect(boundaries.bridgeCleanup).not.toHaveBeenCalled();
    expect(boundaries.leaseRelease).toHaveBeenCalledTimes(1);
  });

  it('binds Profile scope/version through final claim and redacts successful plaintext for admission lifetime', async () => {
    publishSettings({ version: 1 });
    const admitted = await prepareForegroundAgentRuntimeAdmission(request({
      selection: undefined,
    }));
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.error.code);

    publishSettings({ version: 2 });
    await expect(admitted.prepared.claim({
      canonicalSessionId: 'canonical-session-1',
      httpPort: 40123,
      foregroundSatisfiedProfileSecretRequirementNames: [],
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_authorization_changed' },
    });
    await admitted.prepared.cleanup();

    resetActiveAccountSettingsSnapshotForTests();
    publishSettings({ version: 1 });
    const successful = await prepareForegroundAgentRuntimeAdmission(request({
      attemptId: 'attempt-2',
    }));
    expect(successful.ok).toBe(true);
    if (!successful.ok) throw new Error(successful.error.code);
    const claimed = await successful.prepared.claim({
      canonicalSessionId: 'canonical-session-2',
      httpPort: 40123,
      foregroundSatisfiedProfileSecretRequirementNames: [],
    });
    expect(claimed).toMatchObject({
      ok: true,
      environment: {
        PROFILE_SECRET: 'profile-plaintext',
        PROVIDER_KEY: 'provider-plaintext',
      },
      invocationContext: {
        cwd: '/workspace',
        environment: {},
        providerBindingActive: false,
      },
      sensitiveEnvironmentVariableNames: ['PROFILE_SECRET'],
    });
    if (!claimed.ok) throw new Error(claimed.error.code);
    expect(claimed.environment).not.toHaveProperty(
      'HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE',
    );
    expect(claimed.environment).not.toHaveProperty(
      'HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE',
    );
    expect(claimed.environment).not.toHaveProperty(
      'HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE',
    );
    expect(redactBugReportSensitiveText(
      'value=profile-plaintext',
    )).toBe('value=[REDACTED]');
    await successful.prepared.cleanup();
    expect(redactBugReportSensitiveText(
      'value=profile-plaintext',
    )).toBe('value=profile-plaintext');
  });

  it('marks the exact Profile-only launch context as having no active Provider binding', async () => {
    publishSettings({ version: 1 });
    const admitted = await prepareForegroundAgentRuntimeAdmission(request({
      selection: undefined,
    }));
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.error.code);

    const claimed = await admitted.prepared.claim({
      canonicalSessionId: 'canonical-session-profile-only',
      httpPort: 40123,
      foregroundSatisfiedProfileSecretRequirementNames: [],
    });

    expect(claimed).toMatchObject({
      ok: true,
      invocationContext: {
        cwd: '/workspace',
        environment: {},
        providerBindingActive: false,
      },
    });
    await admitted.prepared.cleanup();
  });

  it('applies canonical Provider auth isolation before foreground Connected Account materialization', async () => {
    boundaries.providerSuppressedConnectedServiceIds = ['openai-codex'];
    publishSettings({ version: 1 });
    const resolveConnectedServiceAuthForSpawn = vi.fn(async () => null);
    const activateSessionPurposeBindings = vi.fn(() => ({
      subjectId: 'session:canonical-session-provider-isolated',
      isCurrent: () => true,
      resolvePurposeBinding: () => null,
      listPurposeBindings: () => [],
      dispose: vi.fn(),
    }));
    const admitted = await prepareForegroundAgentRuntimeAdmission(request({
      profileId: undefined,
      accountSettingsScopeKey: undefined,
      accountSettingsVersion: undefined,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'must-be-suppressed',
          },
        },
      },
    }), {
      activateSessionPurposeBindings,
      resolveConnectedServiceAuthForSpawn,
      resolveDaemonSpawnHooks: async () => null,
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.error.code);
    expect(resolveConnectedServiceAuthForSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedServicesBindingsRaw: {
          v: 2,
          bindingsByServiceId: {},
        },
      }),
    );

    const claimed = await admitted.prepared.claim({
      canonicalSessionId: 'canonical-session-provider-isolated',
      httpPort: 40123,
      foregroundSatisfiedProfileSecretRequirementNames: [],
    });
    if (!claimed.ok) {
      throw new Error(JSON.stringify(claimed.error));
    }
    expect(claimed.ok).toBe(true);
    expect(activateSessionPurposeBindings).toHaveBeenCalledWith(
      expect.objectContaining({ bindings: [] }),
    );
    await admitted.prepared.cleanup();
  });

  it('relinquishes config-file cleanup to retained runner custody before ordinary generation cleanup', async () => {
    boundaries.providerMaterialization = 'configFile';
    publishSettings({ version: 1 });
    const admitted = await prepareForegroundAgentRuntimeAdmission(request());
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.error.code);

    const claimed = await admitted.prepared.claim({
      canonicalSessionId: 'canonical-session-retained',
      httpPort: 40123,
      foregroundSatisfiedProfileSecretRequirementNames: [],
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error(claimed.error.code);
    const handoff = consumeProviderBindingLaunchHandoffFromEnvironments([
      { ...claimed.environment },
    ]);
    if (handoff?.materialization.kind !== 'configFile') {
      throw new Error('Expected config-file Provider handoff');
    }

    claimed.authority.transferCleanupOwnership();
    await admitted.prepared.cleanup();
    expect(await stat(handoff.materialization.rootPath)).toBeDefined();

    const retainedCleanup =
      createProviderBindingLaunchMaterializationCleanup({
        materialization: handoff.materialization,
        materializationBaseDir: join(
          configuration.happyHomeDir,
          'providers',
          'materialized',
        ),
      });
    retainedCleanup?.();
    await expect(stat(handoff.materialization.rootPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reserves managed dependencies through the exact retained-Agent registry owner', async () => {
    publishSettings({ version: 1 });
    const admitted = await prepareForegroundAgentRuntimeAdmission(request());
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.error.code);

    const claimed = await admitted.prepared.claim({
      canonicalSessionId: 'canonical-session-managed-retention',
      httpPort: 40123,
      foregroundSatisfiedProfileSecretRequirementNames: [],
    });

    expect(claimed.ok).toBe(true);
    expect(boundaries.reserveManagedDependencyRetention).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'happier.agent.codex',
        agentId: 'codex',
        sourceCustody: {
          kind: 'managed',
          immutableGenerationId: 'generation-1',
          installSource: 'localPath',
        },
      }),
    );
    expect(boundaries.attachExactRunnerRetainedPluginGenerations)
      .toHaveBeenCalledWith(expect.objectContaining({
        immutableGenerationIds: ['generation-1'],
        attach: expect.any(Function),
      }));
    await admitted.prepared.cleanup();
  });

  it('activates the Codex projected Connected Account snapshot only for the exact canonical session and retires it with admission cleanup', async () => {
    const currentLease = boundaries.lease as PluginRuntimeRegistryLease;
    const currentRegistry = currentLease.registry;
    const contribution = currentRegistry.contributes.agentDefinitionsById.get('codex');
    if (!contribution?.richDefinition) {
      throw new Error('Expected canonical Agent fixture');
    }
    const agentDefinitionsById = new Map<string, typeof contribution>(
      currentRegistry.contributes.agentDefinitionsById.entries(),
    );
    agentDefinitionsById.set('codex', {
      ...contribution,
      richDefinition: {
        ...contribution.richDefinition,
        definition: {
          ...contribution.richDefinition.definition,
          connectedAccounts: [{
            purpose: 'primary',
            service: {
              pluginId: 'happier.agent.codex',
              localId: 'openai-codex',
            },
            required: false,
            materializationKinds: ['httpHeaders'],
          }],
        },
      },
      catalogEntry: {
        id: 'codex',
        cliSubcommand: 'codex',
        vendorResumeSupport: 'unsupported',
        connectedAccountRequestAuthUses: [{
          purpose: 'primary',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://chatgpt.com',
            headerNames: ['authorization'],
          },
        }],
      },
    });
    boundaries.lease = {
      ...currentLease,
      registry: {
        ...currentRegistry,
        contributes: {
          ...currentRegistry.contributes,
          agentDefinitionsById,
        },
        agentRuntimesByAgentId: currentRegistry.agentRuntimesByAgentId,
      },
    } satisfies PluginRuntimeRegistryLease;

    const dispose = vi.fn();
    const expectedBinding = {
      purpose: {
        consumer: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
        purpose: 'primary',
      },
      target: {
        kind: 'account' as const,
        account: {
          service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          },
          accountId: 'foreground-explicit',
        },
      },
    };
    const activateSessionPurposeBindings = vi.fn(() => ({
      subjectId: 'session:canonical-session-connected',
      isCurrent: () => true,
      resolvePurposeBinding: () => expectedBinding,
      listPurposeBindings: () => [expectedBinding],
      dispose,
    }));
    const resolveConnectedServiceAuthForSpawn = vi.fn(async () => ({
      env: { CONNECTED_RAW: 'raw' },
      cleanupOnFailure: vi.fn(),
      cleanupOnExit: vi.fn(),
      connectedServicesBindings: {
        v: 2 as const,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'connected' as const,
            selection: 'profile' as const,
            profileId: 'foreground-explicit',
          },
        },
      },
      requestAuthMaterializedRoot: '/private/request-auth',
      requestAuthPurposeBindings: [expectedBinding],
      qualifiedPurposeBindingSnapshot: {
        purposes: [expectedBinding.purpose],
        bindings: [expectedBinding],
        requestAuthUses: [{
          purpose: expectedBinding.purpose,
          materialization: {
            kind: 'httpHeaders' as const,
            origin: 'https://chatgpt.com',
            headerNames: ['authorization'],
          },
        }],
      },
    }));
    let activatedRequestAuthUseCount = 0;
    const requestAuthDescriptor = {
      path: '/private/request-auth/capability.json',
      materializationId: 'session-1',
      subjectScopeDigest: 'a'.repeat(64),
      capabilityDigest: 'b'.repeat(64),
    };
    const connectedAccountRequestAuthRegistry = {
      activate: vi.fn(async (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
      }>) => {
        expect(input.subject.legacyServiceKeyedCompatibility).toBe(true);
        activatedRequestAuthUseCount = input.subject.listPurposeUses().length;
        return requestAuthDescriptor;
      }),
      retire: vi.fn(async () => undefined),
    };
    const admitted = await prepareForegroundAgentRuntimeAdmission(request({
      profileId: undefined,
      accountSettingsScopeKey: undefined,
      accountSettingsVersion: undefined,
      selection: undefined,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'foreground-explicit',
          },
        },
      },
    }), {
      activateSessionPurposeBindings,
      resolveConnectedServiceAuthForSpawn,
      resolveDaemonSpawnHooks: async () => null,
      connectedAccountRequestAuthRegistry,
      resolveConnectedAccountRequestAuthHttpPort: () => 43123,
    });
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.error));
    expect(admitted.ok).toBe(true);
    expect(activateSessionPurposeBindings).not.toHaveBeenCalled();
    expect(connectedAccountRequestAuthRegistry.activate).not.toHaveBeenCalled();

    const claimed = await admitted.prepared.claim({
      canonicalSessionId: 'canonical-session-connected',
      httpPort: 40123,
      foregroundSatisfiedProfileSecretRequirementNames: [],
    });

    expect(claimed).toMatchObject({
      ok: true,
      environment: {
        HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH:
          '/private/request-auth/capability.json',
        CONNECTED_TOKEN: 'materialized',
      },
      unsetEnvironmentVariableNames: ['OLD_CONNECTED_TOKEN'],
    });
    expect(activateSessionPurposeBindings).toHaveBeenCalledWith({
      sessionId: 'canonical-session-connected',
      purposes: [{
        consumer: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
        purpose: 'primary',
      }],
      bindings: [expectedBinding],
    });
    expect(resolveConnectedServiceAuthForSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'codex',
        materializationKey: 'session-1',
        sessionId: undefined,
      }),
    );
    expect(connectedAccountRequestAuthRegistry.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        materializationId: 'session-1',
        materializedRootDir: '/private/request-auth',
        httpPort: 43123,
      }),
    );
    expect(activatedRequestAuthUseCount).toBe(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(boundaries.connectedServiceCleanupOnExit).not.toHaveBeenCalled();

    await admitted.prepared.cleanup();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(connectedAccountRequestAuthRegistry.retire)
      .toHaveBeenCalledWith(requestAuthDescriptor);
    expect(boundaries.connectedServiceCleanupOnExit).toHaveBeenCalledTimes(1);
    expect(boundaries.connectedServiceCleanupOnFailure).not.toHaveBeenCalled();
  });

  it('reuses a legacy materializer-owned native home without duplicate projection or cleanup custody', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-legacy-native-home-'));
    try {
      boundaries.connectedServiceChildEnvironmentMode = 'authEnv';
      const lease = boundaries.lease as PluginRuntimeRegistryLease;
      const registry = lease.registry;
      boundaries.lease = {
        ...lease,
        registry: {
          ...registry,
          contributes: {
            ...registry.contributes,
            catalogEntriesById: {
              ...registry.contributes.catalogEntriesById,
              codex: {
                ...registry.contributes.catalogEntriesById.codex,
                getConnectedServiceStateSharingDescriptor: async () => ({
                  providerId: 'codex',
                  providerSupportStatus: 'supported',
                  config: { supported: true, modes: ['copied'], entries: [] },
                  state: {
                    supported: true,
                    modes: ['isolated'],
                    entries: [],
                    symlinkUnavailableDegradePolicy: 'degrade_to_isolated',
                  },
                  authIsolation: {
                    mode: 'materialized_home',
                    secretEntries: ['auth.json'],
                  },
                  nativeHome: {
                    environmentKey: 'CODEX_HOME',
                    defaultRelativePath: '.codex',
                  },
                } as const),
              },
            },
          },
        },
      } satisfies PluginRuntimeRegistryLease;
      const purpose = {
        consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
        purpose: 'primary',
      } as const;
      const binding = {
        purpose,
        target: {
          kind: 'account' as const,
          account: {
            service: {
              pluginId: 'happier.agent.codex',
              localId: 'openai-codex',
            },
            accountId: 'legacy-account',
          },
        },
      };
      const admitted = await prepareForegroundAgentRuntimeAdmission(request({
        profileId: undefined,
        accountSettingsScopeKey: undefined,
        accountSettingsVersion: undefined,
        selection: undefined,
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'legacy-account',
            },
          },
        },
      }), {
        activateSessionPurposeBindings: () => ({
          subjectId: 'session:legacy-root',
          isCurrent: () => true,
          resolvePurposeBinding: () => binding,
          listPurposeBindings: () => [binding],
          dispose() {},
        }),
        resolveConnectedServiceAuthForSpawn: async () => ({
          env: {
            [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: root,
            CODEX_HOME: root,
          },
          cleanupOnFailure: boundaries.connectedServiceCleanupOnFailure,
          cleanupOnExit: boundaries.connectedServiceCleanupOnExit,
          connectedServicesBindings: {
            v: 2,
            bindingsByServiceId: {
              'happier.agent.codex/openai-codex': {
                source: 'connected',
                selection: 'profile',
                profileId: 'legacy-account',
              },
            },
          },
          qualifiedPurposeBindingSnapshot: {
            purposes: [purpose],
            bindings: [binding],
          },
        }),
        resolveDaemonSpawnHooks: async () => null,
      });
      if (!admitted.ok) throw new Error(JSON.stringify(admitted.error));
      expect(admitted.ok).toBe(true);
      const claimed = await admitted.prepared.claim({
        canonicalSessionId: 'canonical-legacy-root',
        httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(claimed).toMatchObject({
        ok: true,
        environment: { CODEX_HOME: root },
      });
      await admitted.prepared.cleanup();
      await expect(stat(root)).resolves.toMatchObject({ mode: expect.any(Number) });
      expect(boundaries.connectedServiceCleanupOnExit).toHaveBeenCalledTimes(1);
      expect(boundaries.connectedServiceCleanupOnFailure).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'a novel service',
      service: {
        pluginId: 'acme.connected-account',
        localId: 'credential',
      },
    },
    {
      label: 'a legacy-mapped service',
      service: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      },
    },
  ] as const)(
  'activates an external Agent request-auth capability for $label through the qualified selection owner without host-issued compatibility provenance',
  async ({ service: serviceInput }) => {
    const externalAgentId = 'acme-agent';
    const externalPluginId = 'acme.agent';
    const externalService = {
      pluginId: serviceInput.pluginId,
      localId: serviceInput.localId,
    } as const;
    boundaries.bridgeAgentId = externalAgentId;
    boundaries.bridgePluginId = externalPluginId;
    const lease = boundaries.lease as PluginRuntimeRegistryLease;
    const registry = lease.registry;
    const codexContribution = registry.contributes.agentDefinitionsById.get('codex');
    const codexRuntime = registry.agentRuntimesByAgentId.get('codex');
    if (!codexContribution?.richDefinition || !codexRuntime) {
      throw new Error('Expected canonical Agent fixtures');
    }
    const agentDefinitionsById = new Map<string, typeof codexContribution>(
      registry.contributes.agentDefinitionsById.entries(),
    );
    agentDefinitionsById.set(externalAgentId, {
      ...codexContribution,
      id: externalAgentId,
      pluginId: externalPluginId,
      identity: {
        pluginId: externalPluginId,
        localId: externalAgentId,
      },
      richDefinition: {
        ...codexContribution.richDefinition,
        definition: {
          ...codexContribution.richDefinition.definition,
          connectedAccounts: [{
            purpose: 'primary',
            service: externalService,
            required: false,
            materializationKinds: ['httpHeaders'],
          }],
        },
      },
      catalogEntry: {
        id: externalAgentId,
        cliSubcommand: externalAgentId,
        vendorResumeSupport: 'unsupported',
        connectedAccountRequestAuthUses: [{
          purpose: 'primary',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
          },
        }],
      },
    });
    const agentRuntimesByAgentId = new Map<string, typeof codexRuntime>(
      registry.agentRuntimesByAgentId.entries(),
    );
    agentRuntimesByAgentId.set(externalAgentId, {
      ...codexRuntime,
      pluginId: externalPluginId,
      agentId: externalAgentId,
    });
    boundaries.lease = {
      ...lease,
      registry: {
        ...registry,
        contributes: {
          ...registry.contributes,
          agentDefinitionsById,
        },
        agentRuntimesByAgentId,
      },
    } satisfies PluginRuntimeRegistryLease;
    const expectedExternalBinding = {
      purpose: {
        consumer: {
          pluginId: externalPluginId,
          localId: externalAgentId,
        },
        purpose: 'primary',
      },
      target: {
        kind: 'account' as const,
        account: {
          service: {
            pluginId: externalService.pluginId,
            localId: externalService.localId,
          },
          accountId: 'external-account',
        },
      },
    };
    const requestAuthRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const requestAuthStore: ConnectedAccountPurposeBindingStore = {
      read: async () => ({ v: 1, bindings: [expectedExternalBinding] }),
      update: async (mutate) => mutate({ v: 1, bindings: [expectedExternalBinding] }),
      subscribe: () => ({ dispose() {} }),
    };
    const qualifiedPurposeOwner = createConnectedAccountPurposeBindingOwner({
      store: requestAuthStore,
      selectTarget: async () => {
        throw new Error('selection is not part of foreground request-auth lookup');
      },
      resolveTarget: async (target) => target.kind === 'account'
        ? {
            displayName: `External ${target.account.accountId}`,
            account: target.account,
          }
        : null,
      materializeAccount: async ({ account, credentialRevisionBasis, request }) => {
        if (request.kind !== 'httpHeaders') {
          throw new Error('expected manifest-qualified http-header materialization');
        }
        credentialRevisionBasis?.captureCredentialRevision(requestAuthRevision);
        return {
          kind: 'httpHeaders',
          headers: {
            authorization: `Bearer ${account.accountId}-${requestAuthRevision}`,
          },
        };
      },
      async projectTargetAccounts() {
        throw new Error('target-scoped listing is outside foreground request-auth admission');
      },
      async assertTargetAccountMaterializable() {
        throw new Error('listed-account materialization is outside foreground request-auth admission');
      },
      resolveCredentialRevision: async () => requestAuthRevision,
    });
    const activateSessionPurposeBindings = vi.fn(
      (input: Parameters<typeof qualifiedPurposeOwner.activateSessionPurposeBindings>[0]) =>
        qualifiedPurposeOwner.activateSessionPurposeBindings(input),
    );
    const qualifiedLease = boundaries.lease as PluginRuntimeRegistryLease;
    boundaries.lease = {
      ...qualifiedLease,
      registry: {
        ...qualifiedLease.registry,
        resolveConnectedAccountPurposeBindingOwner: () => qualifiedPurposeOwner,
      },
    } satisfies PluginRuntimeRegistryLease;
    const requestAuthDescriptor = {
      path: '/unused/test-descriptor-path',
      materializationId: 'session-1',
      subjectScopeDigest: 'c'.repeat(64),
      capabilityDigest: 'd'.repeat(64),
    };
    const activatedRequestAuthSubject: {
      current: ConnectedAccountRequestAuthSubject | null;
    } = { current: null };
    const connectedAccountRequestAuthRegistry = {
      activate: vi.fn(async (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
      }>) => {
        activatedRequestAuthSubject.current = input.subject;
        return requestAuthDescriptor;
      }),
      retire: vi.fn(async () => undefined),
    };
    const requestAuthBroker = createConnectedAccountRequestAuthService({
      resolveCurrentBinding: async ({ subject, binding }) =>
        await qualifiedPurposeOwner.resolveCurrentRequestAuthBinding({
          subjectId: subject.subjectId,
          binding,
          signal: new AbortController().signal,
        }),
      materializeBearer: async ({ subject, binding, resolved, materialization }) =>
        await qualifiedPurposeOwner.materializeRequestAuthBearer({
          subjectId: subject.subjectId,
          binding,
          resolved,
          materialization,
          signal: new AbortController().signal,
        }),
      refreshAfterAuthFailure: async () => ({ status: 'current_unchanged' }),
      reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
    });
    const connectedServicesMaterializationBaseDir = join(
      configuration.happyHomeDir,
      'external-qualified-request-auth',
      `${externalService.pluginId}-${externalService.localId}`
        .replace(/[^a-zA-Z0-9._-]/g, '_'),
    );
    const resolveExternalAgentSessionPurposeBindingSnapshot = vi.fn(async () => ({
      purposes: [expectedExternalBinding.purpose],
      bindings: [expectedExternalBinding],
      directMaterialOrigins: [],
      teamResourceSelections: [],
    }));
    const resolveConnectedServiceAuthForSpawn = vi.fn(async () => null);
    const resolveDaemonSpawnHooks = vi.fn(async () => null);

    const admitted = await prepareForegroundAgentRuntimeAdmission(request({
      agentId: externalAgentId,
      backendTarget: {
        kind: 'backend',
        backendId: externalAgentId,
      },
      profileId: undefined,
      accountSettingsScopeKey: undefined,
      accountSettingsVersion: undefined,
      selection: undefined,
      connectedServices: undefined,
    }), {
      activateSessionPurposeBindings,
      resolveExternalAgentSessionPurposeBindingSnapshot,
      resolveConnectedServiceAuthForSpawn,
      resolveDaemonSpawnHooks,
      connectedAccountRequestAuthRegistry,
      resolveConnectedAccountRequestAuthHttpPort: () => 43123,
      connectedServicesMaterializationBaseDir,
    });

    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.error.code);
    expect(resolveExternalAgentSessionPurposeBindingSnapshot)
      .toHaveBeenCalledWith(expect.objectContaining({
        agentId: externalAgentId,
        authorizedPurposes: [{
          purpose: expectedExternalBinding.purpose,
          serviceRefs: [{
            pluginId: externalService.pluginId,
            localId: externalService.localId,
          }],
        }],
      }));
    expect(resolveConnectedServiceAuthForSpawn).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnHooks).not.toHaveBeenCalled();
    const claimed = await admitted.prepared.claim({
      canonicalSessionId: 'canonical-session-external',
      httpPort: 40123,
      foregroundSatisfiedProfileSecretRequirementNames: [],
    });

    expect(claimed).toMatchObject({
      ok: true,
      environment: {
        HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH:
          expect.stringContaining('qualified-request-auth'),
      },
    });
    expect(JSON.stringify(claimed)).not.toContain(requestAuthRevision);
    expect(activateSessionPurposeBindings).toHaveBeenCalledWith({
      sessionId: 'canonical-session-external',
      purposes: [{
        consumer: {
          pluginId: externalPluginId,
          localId: externalAgentId,
        },
        purpose: 'primary',
      }],
      bindings: [expectedExternalBinding],
    });
    expect(connectedAccountRequestAuthRegistry.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        materializationId: 'session-1',
        httpPort: 43123,
        materializedRootDir: expect.stringContaining(
          'qualified-request-auth',
        ),
      }),
    );
    const requestAuthSubject = activatedRequestAuthSubject.current;
    if (!requestAuthSubject) {
      throw new Error('Expected activated request-auth subject');
    }
    expect(requestAuthSubject.legacyServiceKeyedCompatibility)
      .toBeUndefined();
    expect(requestAuthSubject.subjectId).toBe(
      'agent-session:canonical-session-external',
    );
    await expect(requestAuthBroker.lookupRequestAuth({
      subject: requestAuthSubject,
      purpose: expectedExternalBinding.purpose,
    })).resolves.toMatchObject({
      accessToken: `external-account-${requestAuthRevision}`,
      credentialContext: {
        account: expectedExternalBinding.target.account,
        credentialRevision: requestAuthRevision,
      },
    });
    await admitted.prepared.cleanup();
    expect(connectedAccountRequestAuthRegistry.retire)
      .toHaveBeenCalledWith(requestAuthDescriptor);
    await expect(requestAuthBroker.lookupRequestAuth({
      subject: requestAuthSubject,
      purpose: expectedExternalBinding.purpose,
    })).rejects.toMatchObject({ code: 'request_auth_not_active' });
  });

  it('admits a durable Team default and hands its Team slot binding to Session creation', async () => {
    const externalAgentId = 'acme-team-agent';
    const externalPluginId = 'acme.team-agent';
    const externalService = { pluginId: 'acme.connected-account', localId: 'credential' } as const;
    boundaries.bridgeAgentId = externalAgentId;
    boundaries.bridgePluginId = externalPluginId;
    const lease = boundaries.lease as PluginRuntimeRegistryLease;
    const registry = lease.registry;
    const codexContribution = registry.contributes.agentDefinitionsById.get('codex');
    const codexRuntime = registry.agentRuntimesByAgentId.get('codex');
    if (!codexContribution?.richDefinition || !codexRuntime) {
      throw new Error('Expected canonical Agent fixtures');
    }
    const agentDefinitionsById = new Map<string, typeof codexContribution>(
      registry.contributes.agentDefinitionsById.entries(),
    );
    agentDefinitionsById.set(externalAgentId, {
      ...codexContribution,
      id: externalAgentId,
      pluginId: externalPluginId,
      identity: { pluginId: externalPluginId, localId: externalAgentId },
      richDefinition: {
        ...codexContribution.richDefinition,
        definition: {
          ...codexContribution.richDefinition.definition,
          connectedAccounts: [{
            purpose: 'primary',
            service: externalService,
            required: false,
            materializationKinds: ['environment'],
          }],
        },
      },
      catalogEntry: {
        id: externalAgentId,
        cliSubcommand: externalAgentId,
        vendorResumeSupport: 'unsupported',
      },
    });
    const agentRuntimesByAgentId = new Map<string, typeof codexRuntime>(
      registry.agentRuntimesByAgentId.entries(),
    );
    agentRuntimesByAgentId.set(externalAgentId, {
      ...codexRuntime,
      pluginId: externalPluginId,
      agentId: externalAgentId,
    });
    boundaries.lease = {
      ...lease,
      registry: {
        ...registry,
        contributes: { ...registry.contributes, agentDefinitionsById },
        agentRuntimesByAgentId,
      },
    } satisfies PluginRuntimeRegistryLease;
    const purpose = {
      consumer: { pluginId: externalPluginId, localId: externalAgentId },
      purpose: 'primary',
    } as const;
    const selection = {
      source: 'team_resource' as const,
      resourceId: 'resource-acme',
      deliveryMode: 'direct' as const,
      disclosedMember: { service: externalService, accountId: 'source-member' },
    };
    // The durable Agent default, exactly as the Agent page persists it: the
    // canonical Team selection, never a Team purpose target (lane 10 child 02
    // :271, child 06 :506). Only the Account Settings boundary is in memory;
    // the real purpose-binding owner reads it.
    const durableDefaults = {
      v: 1 as const,
      bindings: [],
      teamResourceSelections: [{ purpose, teamId: 'team-acme', selection }],
    };
    const teamDefaultOwner = createConnectedAccountPurposeBindingOwner({
      store: {
        read: async () => durableDefaults,
        update: async (mutate) => mutate(durableDefaults),
        subscribe: () => ({ dispose() {} }),
      },
      selectTarget: async () => {
        throw new Error('selection is not part of foreground admission');
      },
      resolveTarget: async () => {
        throw new Error('a Team default is never resolved against the personal inventory');
      },
      materializeAccount: async () => {
        throw new Error('admission does not materialize');
      },
      async projectTargetAccounts() {
        throw new Error('listing is outside foreground admission');
      },
      async assertTargetAccountMaterializable() {
        throw new Error('listed-account materialization is outside foreground admission');
      },
    });
    const resource = {
      id: 'resource-acme', teamId: 'team-acme', displayName: 'Acme credential',
      resourceRevision: 4, readiness: { kind: 'available' as const }, recoveryAction: null,
      mayBroker: false, mayReceiveDirect: true, directMaterialState: 'current' as const,
      sessionUsePolicy: 'personal_allowed' as const, providerModels: [],
      connectedServiceSelections: [selection],
      sourcePresentation: { kind: 'connected_service' as const, service: externalService },
    };
    // The only fake is the Home catalog read (network boundary); the canonical
    // defaults owner turns the durable target into the Session's slot binding.
    const admit = async (
      attemptId: string,
      resources: readonly (typeof resource)[],
      withResolver = true,
    ) => await prepareForegroundAgentRuntimeAdmission(request({
      attemptId,
      agentId: externalAgentId,
      backendTarget: { kind: 'backend', backendId: externalAgentId },
      profileId: undefined,
      accountSettingsScopeKey: undefined,
      accountSettingsVersion: undefined,
      selection: undefined,
      connectedServices: undefined,
    }), {
      activateSessionPurposeBindings: vi.fn(),
      resolveExternalAgentSessionPurposeBindingSnapshot: async ({ authorizedPurposes, signal }) =>
        await teamDefaultOwner.resolveCurrentSessionPurposeBindingSnapshot({ authorizedPurposes, signal }),
      ...(withResolver
        ? {
            resolveSessionTeamCredentialBindingIntents: async ({ teamResourceSelections }) =>
              await resolvePurposeTeamCredentialBindingIntentsFromHome({
                teamResourceSelections,
                resolveTeamCredentialResourceCatalog: async () => ({
                  serverId: 'home-a', accountId: 'recipient', resources,
                }),
              }),
          }
        : {}),
    });

    const admitted = await admit('attempt-team-slot', [resource]);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.error.code);
    expect(admitted.prepared.teamCredentialBindings).toEqual([{
      v: 1,
      slot: { kind: 'connected_service_purpose', purpose },
      resourceId: 'resource-acme',
      expectedResourceRevision: 4,
      deliveryMode: 'direct',
      teamId: 'team-acme',
    }]);
    await admitted.prepared.cleanup();

    await expect(admit('attempt-team-slot-withdrawn', [])).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_binding_changed' },
    });
    await expect(admit('attempt-team-slot-no-home', [resource], false)).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_agent_runtime_unsupported' },
    });
  });

  it('materializes exact-account opaque credentials into an isolated native home and removes it without touching the persistent home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-foreground-native-home-'));
    const sourceRoot = join(root, 'persistent-home');
    const ambientSourceRoot = join(root, 'ambient-home');
    const materializationRoot = join(root, 'materialized');
    const previousCodexHome = process.env.CODEX_HOME;
    const persistentAuth = new Uint8Array([11, 22, 33, 44]);
    const selectedAuth = new Uint8Array([0, 255, 17, 99]);
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(ambientSourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'auth.json'), persistentAuth);
    await writeFile(join(sourceRoot, 'config.toml'), 'profile-source\n');
    await writeFile(join(ambientSourceRoot, 'config.toml'), 'ambient-source\n');
    process.env.CODEX_HOME = ambientSourceRoot;
    publishSettings({ version: 1 });
    try {
      const externalAgentId = 'acme-native-home-agent';
      const externalPluginId = 'acme.native-home';
      const externalService = {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      } as const;
      boundaries.bridgeAgentId = externalAgentId;
      boundaries.bridgePluginId = externalPluginId;
      const lease = boundaries.lease as PluginRuntimeRegistryLease;
      const registry = lease.registry;
      const codexContribution = registry.contributes.agentDefinitionsById.get('codex');
      const codexRuntime = registry.agentRuntimesByAgentId.get('codex');
      if (!codexContribution?.richDefinition || !codexRuntime) {
        throw new Error('Expected canonical Agent fixtures');
      }
      const purpose = {
        consumer: { pluginId: externalPluginId, localId: externalAgentId },
        purpose: 'primary',
      } as const;
      const account = {
        service: externalService,
        accountId: 'selected-account',
      } as const;
      const binding = {
        purpose,
        target: { kind: 'account' as const, account },
      };
      const replacementBinding = {
        purpose,
        target: {
          kind: 'account' as const,
          account: { service: externalService, accountId: 'replacement-account' },
        },
      };
      const agentDefinitionsById = new Map(registry.contributes.agentDefinitionsById);
      agentDefinitionsById.set(externalAgentId, {
        ...codexContribution,
        id: externalAgentId,
        pluginId: externalPluginId,
        identity: { pluginId: externalPluginId, localId: externalAgentId },
        richDefinition: {
          ...codexContribution.richDefinition,
          definition: {
            ...codexContribution.richDefinition.definition,
            connectedAccounts: [{
              purpose: 'primary',
              service: externalService,
              required: false,
              materializationKinds: ['files'],
            }],
          },
        },
      });
      const agentRuntimesByAgentId = new Map(registry.agentRuntimesByAgentId);
      agentRuntimesByAgentId.set(externalAgentId, {
        ...codexRuntime,
        pluginId: externalPluginId,
        agentId: externalAgentId,
      });
      let durableBinding: typeof binding | typeof replacementBinding = binding;
      let replaceDuringMaterialization = false;
      const storeListeners = new Set<() => void>();
      const purposeStore: ConnectedAccountPurposeBindingStore = {
        read: async () => ({ v: 1, bindings: [durableBinding] }),
        update: async (mutate) => {
          const next = mutate({ v: 1, bindings: [durableBinding] });
          durableBinding = next.bindings[0] as typeof durableBinding;
          for (const listener of storeListeners) listener();
          return next;
        },
        subscribe: (listener) => {
          storeListeners.add(listener);
          return {
            dispose: () => {
              storeListeners.delete(listener);
            },
          };
        },
      };
      const materializedAccounts: string[] = [];
      const purposeOwner = createConnectedAccountPurposeBindingOwner({
        store: purposeStore,
        selectTarget: async () => binding.target,
        resolveTarget: async (target) => target.kind === 'account'
          ? { displayName: target.account.accountId, account: target.account }
          : null,
        materializeAccount: async ({ account: selected, request }) => {
          materializedAccounts.push(selected.accountId);
          expect(request).toEqual({ kind: 'files', fileIds: ['auth.json'] });
          if (replaceDuringMaterialization) {
            durableBinding = replacementBinding;
            for (const listener of storeListeners) listener();
          }
          return { kind: 'files', files: { 'auth.json': selectedAuth } };
        },
        async projectTargetAccounts() {
          throw new Error('listing is outside native-home launch');
        },
        async assertTargetAccountMaterializable() {
          throw new Error('listed materialization is outside native-home launch');
        },
      });
      boundaries.lease = {
        ...lease,
        registry: {
          ...registry,
          contributes: {
            ...registry.contributes,
            agentDefinitionsById,
            catalogEntriesById: {
              ...registry.contributes.catalogEntriesById,
              [externalAgentId]: {
                id: externalAgentId,
                cliSubcommand: externalAgentId,
                vendorResumeSupport: 'unsupported',
                getConnectedServiceStateSharingDescriptor: async () => ({
                  providerId: externalAgentId,
                  providerSupportStatus: 'supported',
                  config: {
                    supported: true,
                    modes: ['copied'],
                    entries: [{ path: 'config.toml', mode: 'force_copied' }],
                  },
                  state: {
                    supported: true,
                    modes: ['isolated'],
                    entries: [],
                    symlinkUnavailableDegradePolicy: 'degrade_to_isolated',
                  },
                  authIsolation: {
                    mode: 'materialized_home',
                    secretEntries: ['auth.json'],
                  },
                  nativeHome: {
                    environmentKey: 'CODEX_HOME',
                    defaultRelativePath: '.codex',
                  },
                } as const),
              },
            },
          },
          agentRuntimesByAgentId,
          resolveConnectedAccountPurposeBindingOwner: () => purposeOwner,
        },
      } satisfies PluginRuntimeRegistryLease;
      const admitted = await prepareForegroundAgentRuntimeAdmission(request({
        agentId: externalAgentId,
        backendTarget: { kind: 'backend', backendId: externalAgentId },
        selection: undefined,
        connectedServices: undefined,
      }), {
        activateSessionPurposeBindings: (input) =>
          purposeOwner.activateSessionPurposeBindings(input),
        resolveExternalAgentSessionPurposeBindingSnapshot: async () => ({
          purposes: [purpose],
          bindings: [binding],
          directMaterialOrigins: [],
          teamResourceSelections: [],
        }),
        connectedServicesMaterializationBaseDir: materializationRoot,
      });
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      const claimed = await admitted.prepared.claim({
        canonicalSessionId: 'canonical-native-home',
        httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
        nativeHomeSourceEnvironmentValue: sourceRoot,
      });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) throw new Error(claimed.error.code);
      const targetRoot = claimed.environment.CODEX_HOME;
      expect(targetRoot).toBeTruthy();
      await expect(readFile(join(targetRoot!, 'auth.json')))
        .resolves.toEqual(Buffer.from(selectedAuth));
      await expect(readFile(join(targetRoot!, 'config.toml'), 'utf8'))
        .resolves.toBe('profile-source\n');
      await expect(readFile(join(sourceRoot, 'auth.json')))
        .resolves.toEqual(Buffer.from(persistentAuth));
      expect(materializedAccounts).toEqual(['selected-account']);

      await admitted.prepared.cleanup();
      await expect(stat(targetRoot!)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(sourceRoot, 'auth.json')))
        .resolves.toEqual(Buffer.from(persistentAuth));

      durableBinding = binding;
      replaceDuringMaterialization = true;
      const invalidated = await prepareForegroundAgentRuntimeAdmission(request({
        attemptId: 'attempt-native-home-invalidated',
        agentId: externalAgentId,
        backendTarget: { kind: 'backend', backendId: externalAgentId },
        selection: undefined,
        connectedServices: undefined,
      }), {
        activateSessionPurposeBindings: (input) =>
          purposeOwner.activateSessionPurposeBindings(input),
        resolveExternalAgentSessionPurposeBindingSnapshot: async () => ({
          purposes: [purpose],
          bindings: [binding],
          directMaterialOrigins: [],
          teamResourceSelections: [],
        }),
        connectedServicesMaterializationBaseDir: materializationRoot,
      });
      expect(invalidated.ok).toBe(true);
      if (!invalidated.ok) throw new Error(invalidated.error.code);
      await expect(invalidated.prepared.claim({
        canonicalSessionId: 'canonical-native-home-invalidated',
        httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'provider_agent_runtime_unsupported' },
      });
      await invalidated.prepared.cleanup();
      const invalidatedTargetRoot = resolveConnectedServiceMaterializedRootDir({
        baseDir: materializationRoot,
        agentId: externalAgentId,
        materializationKey: 'session-1',
      });
      await expect(stat(invalidatedTargetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(sourceRoot, 'auth.json')))
        .resolves.toEqual(Buffer.from(persistentAuth));

      replaceDuringMaterialization = false;
      durableBinding = binding;
      const nativeUnbound = await prepareForegroundAgentRuntimeAdmission(request({
        attemptId: 'attempt-native-home-unbound',
        agentId: externalAgentId,
        backendTarget: { kind: 'backend', backendId: externalAgentId },
        selection: undefined,
        connectedServices: undefined,
      }), {
        activateSessionPurposeBindings: (input) =>
          purposeOwner.activateSessionPurposeBindings(input),
        resolveExternalAgentSessionPurposeBindingSnapshot: async () => ({
          purposes: [purpose],
          bindings: [],
          directMaterialOrigins: [],
          teamResourceSelections: [],
        }),
        connectedServicesMaterializationBaseDir: materializationRoot,
      });
      expect(nativeUnbound.ok).toBe(true);
      if (!nativeUnbound.ok) throw new Error(nativeUnbound.error.code);
      const nativeUnboundClaim = await nativeUnbound.prepared.claim({
        canonicalSessionId: 'canonical-native-home-unbound',
        httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(nativeUnboundClaim.ok).toBe(true);
      if (!nativeUnboundClaim.ok) throw new Error(nativeUnboundClaim.error.code);
      expect(nativeUnboundClaim.environment).not.toHaveProperty('CODEX_HOME');
      await nativeUnbound.prepared.cleanup();
      await expect(readFile(join(sourceRoot, 'auth.json')))
        .resolves.toEqual(Buffer.from(persistentAuth));
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('admits an external catalog Agent through its declared legacy Connected Service and invokes its daemon spawn hooks', async () => {
    const externalAgentId = 'acme-agent';
    const externalPluginId = 'acme.agent';
    boundaries.bridgeAgentId = externalAgentId;
    boundaries.bridgePluginId = externalPluginId;
    const lease = boundaries.lease as PluginRuntimeRegistryLease;
    const registry = lease.registry;
    const codexContribution = registry.contributes.agentDefinitionsById.get('codex');
    const codexRuntime = registry.agentRuntimesByAgentId.get('codex');
    if (!codexContribution?.richDefinition || !codexRuntime) {
      throw new Error('Expected canonical Agent fixtures');
    }
    const agentDefinitionsById = new Map<string, typeof codexContribution>(
      registry.contributes.agentDefinitionsById.entries(),
    );
    const externalCatalogEntry = {
      id: externalAgentId,
      cliSubcommand: externalAgentId,
      vendorResumeSupport: 'unsupported' as const,
      connectedServiceIds: ['openai-codex'] as const,
    };
    agentDefinitionsById.set(externalAgentId, {
      ...codexContribution,
      id: externalAgentId,
      pluginId: externalPluginId,
      identity: {
        pluginId: externalPluginId,
        localId: externalAgentId,
      },
      richDefinition: {
        ...codexContribution.richDefinition,
        definition: {
          ...codexContribution.richDefinition.definition,
          connectedAccounts: [{
            purpose: 'primary',
            service: {
              pluginId: 'happier.agent.codex',
              localId: 'openai-codex',
            },
            required: false,
            materializationKinds: ['files'],
          }],
        },
      },
      catalogEntry: externalCatalogEntry,
    });
    const agentRuntimesByAgentId = new Map<string, typeof codexRuntime>(
      registry.agentRuntimesByAgentId.entries(),
    );
    agentRuntimesByAgentId.set(externalAgentId, {
      ...codexRuntime,
      pluginId: externalPluginId,
      agentId: externalAgentId,
    });
    boundaries.lease = {
      ...lease,
      registry: {
        ...registry,
        contributes: {
          ...registry.contributes,
          agentDefinitionsById,
          catalogEntriesById: {
            ...registry.contributes.catalogEntriesById,
            [externalAgentId]: externalCatalogEntry,
          },
        },
        agentRuntimesByAgentId,
      },
    } satisfies PluginRuntimeRegistryLease;

    const activateSessionPurposeBindings = vi.fn(() => ({
      subjectId: 'session:external-legacy-service',
      isCurrent: () => true,
      resolvePurposeBinding: () => null,
      listPurposeBindings: () => [],
      dispose: vi.fn(),
    }));
    const resolveConnectedServiceAuthForSpawn = vi.fn(async (input) => {
      const connectedServicesBindings = input.connectedServicesBindingsRaw;
      return {
        env: { CONNECTED_RAW: 'raw' },
        cleanupOnFailure: vi.fn(),
        cleanupOnExit: vi.fn(),
        connectedServicesBindings,
        qualifiedPurposeBindingSnapshot:
          input.resolveQualifiedPurposeBindingSnapshot?.(
            connectedServicesBindings,
          ) ?? null,
      };
    });
    const resolveDaemonSpawnHooks = vi.fn(async () => null);

    const admitted = await prepareForegroundAgentRuntimeAdmission(request({
      agentId: externalAgentId,
      backendTarget: {
        kind: 'backend',
        backendId: externalAgentId,
      },
      profileId: undefined,
      accountSettingsScopeKey: undefined,
      accountSettingsVersion: undefined,
      selection: undefined,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'external-profile',
          },
        },
      },
    }), {
      activateSessionPurposeBindings,
      resolveConnectedServiceAuthForSpawn,
      resolveDaemonSpawnHooks,
    });

    if (!admitted.ok) throw new Error(JSON.stringify(admitted.error));
    expect(admitted.ok).toBe(true);
    expect(resolveConnectedServiceAuthForSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: externalAgentId,
        connectedServicesBindingsRaw: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'external-profile',
            },
          },
        },
      }),
    );
    expect(resolveDaemonSpawnHooks).toHaveBeenCalledWith(externalAgentId);
    if (admitted.ok) {
      await admitted.prepared.cleanup();
    }
  });

  it('releases prepared Connected Account materialization through failure cleanup when claim currentness fails', async () => {
    const purposeBindingLeaseDispose = vi.fn();
    const activateSessionPurposeBindings = vi.fn(() => ({
      subjectId: 'session:must-not-activate',
      isCurrent: () => true,
      resolvePurposeBinding: () => null,
      listPurposeBindings: () => [],
      dispose: purposeBindingLeaseDispose,
    }));
    const admitted = await prepareForegroundAgentRuntimeAdmission(request({
      profileId: undefined,
      accountSettingsScopeKey: undefined,
      accountSettingsVersion: undefined,
      selection: undefined,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'foreground-explicit',
          },
        },
      },
    }), {
      activateSessionPurposeBindings,
      resolveConnectedServiceAuthForSpawn: async (input) => {
        const connectedServicesBindings = {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'foreground-explicit',
            },
          },
        } as const;
        const qualifiedPurposeBindingSnapshot =
          input.resolveQualifiedPurposeBindingSnapshot?.(
            connectedServicesBindings,
          ) ?? null;
        return {
          env: { CONNECTED_RAW: 'raw' },
          cleanupOnFailure: vi.fn(),
          cleanupOnExit: vi.fn(),
          connectedServicesBindings,
          qualifiedPurposeBindingSnapshot,
        };
      },
      resolveDaemonSpawnHooks: async () => null,
    });
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.error));
    expect(admitted.ok).toBe(true);

    boundaries.processIdentityAvailable = false;
    await expect(admitted.prepared.claim({
      canonicalSessionId: 'canonical-session-stale',
      httpPort: 40123,
      foregroundSatisfiedProfileSecretRequirementNames: [],
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_agent_runtime_unsupported' },
    });

    expect(activateSessionPurposeBindings).toHaveBeenCalledTimes(1);
    expect(boundaries.connectedServiceCleanupOnFailure).toHaveBeenCalledTimes(1);
    expect(boundaries.connectedServiceCleanupOnExit).not.toHaveBeenCalled();
    await admitted.prepared.cleanup();
    expect(purposeBindingLeaseDispose).toHaveBeenCalledTimes(1);
    expect(boundaries.connectedServiceCleanupOnFailure).toHaveBeenCalledTimes(1);
    expect(boundaries.connectedServiceCleanupOnExit).not.toHaveBeenCalled();
  });

  it('refuses a Connected Services admission whose selected service is missing from the leased manifest projection', async () => {
    const activateSessionPurposeBindings = vi.fn(() => ({
      subjectId: 'session:must-not-activate',
      isCurrent: () => true,
      resolvePurposeBinding: () => null,
      listPurposeBindings: () => [],
      dispose: vi.fn(),
    }));

    const admitted = await prepareForegroundAgentRuntimeAdmission(request({
      profileId: undefined,
      accountSettingsScopeKey: undefined,
      accountSettingsVersion: undefined,
      selection: undefined,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          gemini: {
            source: 'connected',
            selection: 'profile',
            profileId: 'must-not-be-dropped',
          },
        },
      },
    }), {
      activateSessionPurposeBindings,
    });

    expect(admitted).toEqual({
      ok: false,
      error: createProviderErrorV1(
        'provider_agent_runtime_unsupported',
        { machineId: 'machine-1' },
      ),
    });
    expect(activateSessionPurposeBindings).not.toHaveBeenCalled();
  });
});
