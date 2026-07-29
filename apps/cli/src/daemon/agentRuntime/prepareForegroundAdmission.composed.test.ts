import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({
  lease: null as unknown,
  bridgeCleanup: vi.fn(async () => undefined),
  leaseRelease: vi.fn(async () => undefined),
  mutateDuringMaterialization: null as null | (() => void),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: async () =>
    boundaries.lease,
}));

vi.mock('@/daemon/spawn/prepareAgentRuntimeSessionBridge', () => ({
  prepareAgentRuntimeSessionBridgeForLease: async () => ({
    authorization: {
      tokenHash: 'sha256:test',
      tokenFilePath: '/private/foreground-token.json',
      descriptor: {
        v: 1,
        pluginId: 'happier.agent.codex',
        pluginVersion: '1.0.0',
        agentId: 'codex',
        backendId: 'codex',
        generation: 'generation-1',
        factoryControls: {
          continuation: false,
          goals: false,
          catalog: false,
          usageLimitRecovery: false,
        },
      },
    },
    childEnv: {
      HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE:
        '/private/foreground-token.json',
    },
    cleanupTokenFile: boundaries.bridgeCleanup,
  }),
}));

vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecisionForServer: async () => ({
    decision: { state: 'enabled' },
  }),
}));

vi.mock('@/daemon/spawn/resolveSpawnChildEnvironment', () => ({
  resolveSpawnChildEnvironment: async () => ({
    ok: true,
    cleanupOnFailure: null,
    cleanupOnExit: null,
  }),
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
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveProviderConnectionForMachine } from '@/providers/registry';

import { prepareForegroundAgentRuntimeAdmission } from './prepareForegroundAdmission';
import type { ForegroundAgentRuntimeAdmissionOwnerRequestV1 } from './foregroundAdmissionContract';

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
    agentTargetKey: 'backend:codex',
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

function encryptedSecret(id: string, value: string) {
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
    updatedAt: 1,
  };
}

function publishSettings(params: Readonly<{
  version: number;
  providerSettings?: ReturnType<typeof createProviderSettings>;
  corruptProfileSecret?: boolean;
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
        encryptedSecret('provider-secret', 'provider-plaintext'),
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
        'profile-1': { PROFILE_SECRET: 'profile-secret' },
      },
    } as never,
    settingsVersion: params.version,
    loadedAtMs: params.version,
    settingsSecretsReadKeys: [settingsSecretKey],
    scopeKey: 'scope-1',
  });
}

function request(
  overrides: Partial<ForegroundAgentRuntimeAdmissionOwnerRequestV1> = {},
): ForegroundAgentRuntimeAdmissionOwnerRequestV1 {
  return {
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
        agentTargetKey: 'backend:codex',
        providerConnectionId: connectionId,
        modelId: 'model-a',
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  resetActiveAccountSettingsSnapshotForTests();
  boundaries.bridgeCleanup.mockClear();
  boundaries.leaseRelease.mockClear();
  boundaries.mutateDuringMaterialization = null;
  const retirement = new AbortController();
  const registry = {
    contributes: {
      agentDefinitionsById: new Map([['codex', {
        id: 'codex',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
        provenance: 'first_party',
        source: { kind: 'bundled' },
        pluginId: 'happier.agent.codex',
        definition: {
          id: 'codex',
          kindVersion: 1,
          providerRequirements,
        },
      }]]),
      providersByContributionKey:
        new Map([[contributionKey, providerContribution]]),
    },
    agentRuntimesByAgentId: new Map([['codex', {
      pluginId: 'happier.agent.codex',
      pluginVersion: '1.0.0',
      agentId: 'codex',
      generation: 'generation-1',
      hasPrimaryRuntime: true,
      retirementSignal: retirement.signal,
      providerBinding: {
        v: 1,
        adapterVersion: 1,
        prepare: () => ({
          v: 1,
          materialization: 'spawnEnv',
          adapterBindingKey: 'gateway',
        }),
        materialize: async (input: Readonly<{
          credential: Readonly<{ kind: string; value?: string }>;
        }>) => {
          boundaries.mutateDuringMaterialization?.();
          return {
            v: 1,
            kind: 'spawnEnv',
            env: [{
              name: 'PROVIDER_KEY',
              value: input.credential.value ?? null,
              source: 'provider',
            }],
          };
        },
      },
      isCurrent: () => !retirement.signal.aborted,
      createRuntime: vi.fn(),
    }]]),
    activateContributionsOnDemand: async () => [],
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  boundaries.lease = {
    registry,
    source: 'active',
    release: boundaries.leaseRelease,
  } satisfies PluginRuntimeRegistryLease;
});

describe('foreground admission composed real Provider authorization seam', () => {
  it('revalidates Provider authorization before Profile decryption and returns no environment on staleness', async () => {
    publishSettings({ version: 1, corruptProfileSecret: true });
    const admitted = await prepareForegroundAgentRuntimeAdmission(request());
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.error.code);

    boundaries.mutateDuringMaterialization = () => {
      const current = getActiveAccountSettingsSnapshot();
      if (!current) throw new Error('Expected current settings');
      const currentSecrets: readonly unknown[] = Array.isArray(
        current.settings.secrets,
      )
        ? current.settings.secrets
        : [];
      setActiveAccountSettingsSnapshot({
        ...current,
        settings: {
          ...current.settings,
          secrets: currentSecrets.map((secret) =>
            typeof secret === 'object'
              && secret !== null
              && 'id' in secret
              && secret.id === 'provider-secret'
              ? {
                  ...encryptedSecret(
                    'provider-secret',
                    'provider-plaintext-rotated',
                  ),
                  updatedAt: 2,
                }
              : secret
          ),
        },
        settingsVersion: 2,
        loadedAtMs: 2,
      });
    };
    const claimed = await admitted.prepared.claim({
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

  it('binds Profile scope/version through final claim and redacts successful plaintext for admission lifetime', async () => {
    publishSettings({ version: 1 });
    const admitted = await prepareForegroundAgentRuntimeAdmission(request({
      selection: undefined,
    }));
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.error.code);

    publishSettings({ version: 2 });
    await expect(admitted.prepared.claim({
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
      foregroundSatisfiedProfileSecretRequirementNames: [],
    });
    expect(claimed).toMatchObject({
      ok: true,
      environment: {
        PROFILE_SECRET: 'profile-plaintext',
        PROVIDER_KEY: 'provider-plaintext',
      },
      sensitiveEnvironmentVariableNames: ['PROFILE_SECRET'],
    });
    expect(redactBugReportSensitiveText(
      'value=profile-plaintext',
    )).toBe('value=[REDACTED]');
    await successful.prepared.cleanup();
    expect(redactBugReportSensitiveText(
      'value=profile-plaintext',
    )).toBe('value=profile-plaintext');
  });
});
