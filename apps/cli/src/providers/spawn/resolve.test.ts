import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import * as persistence from '@/persistence';
// Composed first-party test: exercise the native materializer, not a replacement
// for the internal binding logic. No production host/plugin import is introduced.
import { OPENCODE_PROVIDER_BINDING_ADAPTER_V1 } from '../../../../../packages/plugins/opencode/src/agent/providerBinding/adapter';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  AccountSettingsSchema,
  FeaturesResponseSchema,
  sealSavedSecretResourceStoredContentV1,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderRuntimeStateFileV1Schema,
  ProviderSettingsV1Schema,
  createProviderAccountGrantFingerprintV1,
  createProviderCatalogFingerprintV1,
  createProviderMachineGrantFingerprintV1,
  createProviderManagedProbeRequestFingerprintV1,
  createProviderObservationAuthorizationFingerprintV1,
  createProviderProbeRequestFingerprintV1,
  encryptSecretStringV1,
  resolveProviderManagedRuntimeDeclarationV1,
  setProviderExperimentalConfirmationV1,
  type AgentProviderRequirementsV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';
import {
  resolveExecutablePluginRuntimeRegistry,
  type ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type {
  ResolvedContributionRegistry,
  ResolvedManagedProviderRuntime,
  ResolvedProviderContribution,
} from '@/plugins/projection/registry/types';
import {
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { hydrateSavedSecretCatalog } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type {
  ResolveManagedProviderPurposeBindingIntent,
} from '@/providers/managed/resolvePurposeBindingSnapshot';
import { composeProviderSettingsV1, DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { prepareProviderConnectionImportV1 } from '@happier-dev/protocol/providers/connections/providerConnectionsCatalogV1';
import { normalizeCustomProviderTemplateV1 } from '@happier-dev/protocol/providers/connections/normalizeCustomTemplateV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';

import { resolveProviderConnectionForMachine } from '../registry';
import { resolveProviderModelCompatibility } from '../catalog/compatibility';
import { createProviderCatalogRefreshFingerprint } from '../probe/catalog';
import {
  createRuntimeProviderSpawnAuthorizationAttempt,
} from './authorize';
import {
  resolveProviderModelLoadAuthorization,
  resolveProviderProbeAuthorization,
  resolveProviderSpawnDefinitiveRejection,
  resolveProviderSpawnAuthorization,
} from './resolve';
import { collectProviderConnectionDnsEvidence } from '../registry/dnsEvidence';

const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
const contributionKey = 'acme.gateway/gateway';
const canonicalContributionKey = contributionKey;
const key = new Uint8Array(32).fill(5);

const definition = ProviderContributionV1Schema.parse({
  v: 1,
  id: 'gateway',
  name: 'Gateway',
  kind: 'cloud',
  endpointTemplates: [{
    id: 'responses',
    protocol: 'openai-responses',
    baseUrl: 'https://gateway.example/v1',
    capabilities: {
      streaming: 'supported', toolRoundTrips: 'supported',
      statefulResponses: 'supported', reasoningControls: 'supported',
    },
  }],
  credential: {
    kind: 'apiKey',
    required: true,
    transports: [{
      id: 'bearer', protocols: ['openai-responses'], uses: ['probe', 'runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }],
  },
  catalog: {
    source: 'static+probe', manualModelPolicy: 'allowed',
    staticModels: [{ id: 'model-a', name: 'Model A', capabilities: { toolRoundTrips: 'supported' } }],
    probes: [{ endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' }],
  },
  compatibilityOverrides: [{
    agentTargetKey: 'agent:happier.agent.codex/codex', protocol: 'openai-responses', status: 'verified', reason: 'integration proof',
    evidence: { sourceUrls: ['https://docs.example/provider'], verifiedAt: '2026-07-10', testIds: ['codex-start'] },
  }],
});

const contribution: ResolvedProviderContribution = {
  provenance: 'external',
  source: { kind: 'path' },
  pluginId: 'acme.gateway',
  identity: { pluginId: 'acme.gateway', localId: 'gateway' },
  definition,
};

const authoritativeContribution: ResolvedProviderContribution = {
  ...contribution,
  definition: ProviderContributionV1Schema.parse({
    ...definition,
    catalog: {
      ...definition.catalog,
      membershipPolicy: 'probe-authoritative',
    },
  }),
};

const registry = { providersByContributionKey: new Map([[canonicalContributionKey, contribution]]) };
const authoritativeRegistry = {
  providersByContributionKey: new Map([[canonicalContributionKey, authoritativeContribution]]),
};
const dns = new Map([['https://gateway.example/v1', ['1.1.1.1']]]);

const managedContribution: ResolvedProviderContribution = {
  ...contribution,
  provenance: 'first_party',
  source: { kind: 'bundled' },
  definition: ProviderContributionV1Schema.parse({
    ...definition,
    catalog: {
      ...definition.catalog,
      sourceRegistryVersion: 'gateway-registry:v1',
    },
    managedRuntime: {
      kind: 'managed',
      endpointTemplateIds: ['responses'],
      connectedAccounts: [{
        purpose: 'upstream',
        service: {
          pluginId: 'happier.connected-account.example',
          localId: 'example',
        },
        required: true,
        materializationKinds: ['httpHeaders'],
      }],
      requestAuthUses: [{
        purpose: 'upstream',
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://api.example.test',
          headerNames: ['authorization'],
        },
      }],
    },
  }),
};
const managedRegistry = {
  providersByContributionKey: new Map([[canonicalContributionKey, managedContribution]]),
};

function providerSettings(): ProviderSettingsV1 {
  return ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1, id: connectionId, source: { kind: 'contribution', contributionKey }, role: 'default',
      displayName: 'Gateway', displayNameMode: 'automatic', revision: 7, createdAt: 1, updatedAt: 1,
    }],
  });
}

function grantedSettings(
  providerRegistry: typeof registry = registry,
): ProviderSettingsV1 {
  const initial = providerSettings();
  const resolution = resolveProviderConnectionForMachine({
    connectionId, machineId: 'machine-a', providerSettings: initial,
    registry: providerRegistry, dnsEvidenceByEndpointUrl: dns,
  });
  if (resolution.status !== 'resolved') throw new Error('Expected connection');
  return ProviderSettingsV1Schema.parse({
    ...initial,
    accountGrants: [{
      v: 1,
      connectionId,
      connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      confirmedAt: 1,
    }],
    secretBindingsByConnectionId: { pc_gateway: { account: { apiKey: 'secret-a' } } },
  });
}

function grantedSettingsForConnection(connectionIdOverride: string): ProviderSettingsV1 {
  const parsedConnectionId = ProviderConnectionIdSchema.parse(connectionIdOverride);
  const initial = ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1, id: parsedConnectionId, source: { kind: 'contribution', contributionKey }, role: 'default',
      displayName: 'Gateway', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
    }],
  });
  const resolution = resolveProviderConnectionForMachine({
    connectionId: parsedConnectionId,
    machineId: 'machine-a',
    providerSettings: initial,
    registry,
    dnsEvidenceByEndpointUrl: dns,
  });
  if (resolution.status !== 'resolved') throw new Error('Expected connection');
  return ProviderSettingsV1Schema.parse({
    ...initial,
    accountGrants: [{
      v: 1,
      connectionId: parsedConnectionId,
      connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      confirmedAt: 1,
    }],
    secretBindingsByConnectionId: {
      [parsedConnectionId]: { account: { apiKey: 'secret-a' } },
    },
  });
}

function managedGrantedSettings(
  providerRegistry: Readonly<{
    providersByContributionKey:
      ReadonlyMap<string, ResolvedProviderContribution>;
  }> = managedRegistry,
  gatewayMachineId?: string,
): ProviderSettingsV1 {
  const initial = ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1,
      id: connectionId,
      source: { kind: 'contribution', contributionKey },
      role: 'default',
      displayName: 'Gateway',
      displayNameMode: 'automatic',
      deployment: { kind: 'managedLocal' },
      ...(gatewayMachineId ? { gatewayPlacement: { kind: 'machine', machineId: gatewayMachineId } } : {}),
      purposeBindingDefaults: {
        upstream: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      },
      revision: 7,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  const resolution = resolveProviderConnectionForMachine({
    connectionId,
    machineId: 'machine-a',
    providerSettings: initial,
    registry: providerRegistry,
    dnsEvidenceByEndpointUrl: new Map(),
  });
  if (resolution.status !== 'resolved') throw new Error('Expected managed connection');
  return ProviderSettingsV1Schema.parse({
    ...initial,
    machineGrants: [{
      v: 1,
      connectionId,
      machineId: 'machine-a',
      connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      endpointSetFingerprint: resolution.record.endpointSetFingerprint,
      confirmedAt: 1,
    }],
  });
}

function agentProviderSupport(
  supportsFreeformModelIds = true,
  applyPolicy: 'live' | 'restart_session' | 'unsupported' = 'restart_session',
  supportsNoAuth = false,
): AgentProviderRequirementsV1 {
  return {
    acceptsProtocols: ['openai-responses'],
    required: { streaming: true, toolRoundTrips: true },
    credentialSupport: {
      supportsNoAuth,
      apiKeyTransports: [{
        protocol: 'openai-responses',
        destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] },
      }],
    },
    authIsolation: { suppressConnectedServiceIds: ['openai-codex'], ownedEnvKeys: ['PROVIDER_KEY'] },
    materialization: 'engineConfig', applyPolicy, supportsFreeformModelIds,
  };
}

function exactManagedProviderRuntime(
  isCurrent: () => boolean = () => true,
): ResolvedManagedProviderRuntime {
  return Object.freeze({
    runtime: Object.freeze({
      async start() {
        throw new Error('Managed Provider runtime is not invoked by authorization');
      },
    }),
    activationOccurrenceId: 'managed-provider-generation-p',
    sourceCustody: {
      kind: 'managed' as const,
      immutableGenerationId: 'managed-provider-generation-p',
      installSource: 'localPath' as const,
    },
    isCurrent,
  });
}

function lease(
  prepare = vi.fn(() => ({ v: 1 as const, materialization: 'engineConfig' as const, adapterBindingKey: 'gateway' })),
  supportsFreeformModelIds = true,
  applyPolicy: 'live' | 'restart_session' | 'unsupported' = 'restart_session',
  providersByContributionKey: ReadonlyMap<string, ResolvedProviderContribution> =
    registry.providersByContributionKey,
  supportsNoAuth = false,
  retainedGenerationCurrent: () => boolean = () => true,
  supportsClaudeHelperModels = false,
): PluginRuntimeRegistryLease {
  const support = agentProviderSupport(
    supportsFreeformModelIds,
    applyPolicy,
    supportsNoAuth,
  );
  const registryRuntime = {
    contributes: {
      agentDefinitionsById: new Map([['codex', {
        definition: { id: 'codex', kindVersion: 1, providerRequirements: support },
      }]]),
      providersByContributionKey,
    },
    agentRuntimesByAgentId: new Map([['codex', {
      pluginId: 'happier.agent.codex',
      pluginVersion: '1.0.0',
      agentId: 'codex',
      generation: 'fixture-generation',
      providerBinding: {
        v: 1, adapterVersion: 3, prepare,
        ...(supportsClaudeHelperModels ? { supportsClaudeHelperModels: true } : {}),
        materialize: vi.fn(async () => ({ v: 1, kind: 'engineConfig', env: [], engineConfig: {} })),
      },
      isCurrent: () => true,
      retirementSignal: new AbortController().signal,
      createRuntime: vi.fn(),
    }]]),
    acquireManagedProviderRuntime: vi.fn(async (ref) => {
      const candidate = [...providersByContributionKey.values()].find(
        (provider) => (
          provider.identity.pluginId === ref.pluginId
          && provider.identity.localId === ref.localId
        ),
      );
      return candidate?.definition.managedRuntime?.kind === 'managed'
        ? exactManagedProviderRuntime(
            retainedGenerationCurrent,
          )
        : null;
    }),
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  return {
    registry: registryRuntime,
    source: 'active',
    durableRevision: -1,
    release: vi.fn(async () => undefined),
  };
}

function accountSettings(settings: unknown) {
  const encryptedValue = encryptSecretStringV1('secret-value', key, (length) => new Uint8Array(length).fill(2));
  return {
    providerSettingsV1: settings,
    secrets: [{ id: 'secret-a', encryptedValue: { _isSecretValue: true, encryptedValue } }],
  };
}

/**
 * A probe-less Provider: its manifest is the complete set of model ids, so the
 * cold phase can prove an unlisted id invalid without any runtime observation.
 *
 * This is the shape shipped by static Providers such as Z.AI and MiniMax, which
 * still allow manual model ids — so the two-sided freeform policy, not catalog
 * membership, decides whether an unlisted id exists here.
 */
const probelessContribution: ResolvedProviderContribution = {
  ...contribution,
  definition: ProviderContributionV1Schema.parse({
    ...definition,
    catalog: {
      source: 'static',
      manualModelPolicy: 'allowed',
      staticModels: [{ id: 'model-a', name: 'Model A', capabilities: { toolRoundTrips: 'supported' } }],
    },
  }),
};

/** The same probe-less Provider with the freeform side the Provider owns closed. */
const probelessCatalogOnlyContribution: ResolvedProviderContribution = {
  ...probelessContribution,
  definition: ProviderContributionV1Schema.parse({
    ...probelessContribution.definition,
    catalog: { ...probelessContribution.definition.catalog, manualModelPolicy: 'catalog-only' },
  }),
};

/**
 * The definitive-rejection phase sees only the cold manifest projection.  It
 * deliberately has no executable provider-binding adapter, DNS evidence, or
 * grant proof to consult before a launch is allowed to activate anything.
 */
function staticPreflightRegistry(
  providersByContributionKey: ReadonlyMap<string, ResolvedProviderContribution> =
    registry.providersByContributionKey,
  supportsFreeformModelIds = false,
): Pick<ResolvedContributionRegistry, 'agentDefinitionsById' | 'providersByContributionKey'> {
  // Reuse the one lease fixture's cold contributions so the two phases cannot
  // disagree about the Agent's declared provider requirements.  Narrowing to the
  // cold projection is what keeps the executable runtime out of this phase.
  return lease(
    undefined,
    supportsFreeformModelIds,
    undefined,
    providersByContributionKey,
  ).registry.contributes;
}

function definitiveSelection(modelId = 'model-a') {
  return {
    agentTargetKey: 'agent:happier.agent.codex/codex',
    providerConnectionId: connectionId,
    modelId,
  };
}

describe('provider spawn authorization resolver', () => {
  const executableRegistries: ResolvedExecutablePluginRuntimeRegistry[] = [];

  afterEach(async () => {
    await Promise.all(executableRegistries.splice(0).map(async (registry) => {
      await registry.dispose();
    }));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it.each(['no Profile', 'Provider-only shared binding'])(
    'refuses a newly revoked shared Provider credential at launch with %s and no AccountChange', async (profileCase) => {
      const token = 'provider-admission-account';
      const resourceId = 'provider-admission-resource';
      const ref = `happier:shared-secret:v1:${resourceId}`;
      const providerSettings = ProviderSettingsV1Schema.parse({
        ...grantedSettings(), secretBindingsByConnectionId: { pc_gateway: { account: { apiKey: ref } } },
      });
      const settings = AccountSettingsSchema.parse({
        providerDefaultModelSelectionsByAgentTargetKeyV1: providerSettings.defaultsByAgentTargetKey,
        // An unrelated Profile contributes no shared refs. Provider admission
        // must own its credential independently of Profile selection.
        ...(profileCase === 'Provider-only shared binding'
          ? { secretBindingsByProfileId: { unrelated: { OTHER_KEY: 'personal-other' } } }
          : {}),
      });
      setActiveAccountSettingsSnapshot({
        source: 'network', settings, settingsVersion: 1, loadedAtMs: 1,
        providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(providerSettings).catalog },
        settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(token),
      });
      const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} });
      vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token, encryption: null });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features))));
      const materialResponse = (revision: number, value: string) => ({
        status: 200, data: { resources: [{
          resourceId, encryptionMode: 'plain', recipientEnvelope: null,
          storedContent: sealSavedSecretResourceStoredContentV1({
            resourceId, mode: 'plain', content: { v: 1, name: 'Provider key', kind: 'apiKey', value },
          }),
          entry: {
            ref, source: 'shared_resource', relationship: 'recipient', name: 'Provider key', kind: 'apiKey',
            ownerAccountId: 'owner', revision, materialStatus: 'ready',
            capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
          },
        }] },
      });
      const get = vi.spyOn(axios, 'get').mockResolvedValue(materialResponse(1, 'revoked-value'));
      await hydrateSavedSecretCatalog({ token, serverFeatures: features });
      expect(getActiveAccountSettingsSnapshot()?.savedSecretResources).toMatchObject([{ resourceId, revision: 1 }]);
      get.mockClear();
      get.mockResolvedValue({ status: 200, data: { resources: [] } });

      const admit = () => createRuntimeProviderSpawnAuthorizationAttempt({
        selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'model-a' } },
        machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', agentId: 'codex', lease: lease(),
        getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
        resolveAddresses: async () => ['1.1.1.1'], materializationBaseDir: '/unused', sessionId: 'shared-admission',
      });
      const result = await admit();
      expect(result).toMatchObject({ ok: false, error: { code: 'provider_secret_missing' } });
      expect(getActiveAccountSettingsSnapshot()?.savedSecretResources).toEqual([]);
      expect(get).toHaveBeenCalledTimes(1);

      get.mockResolvedValue(materialResponse(2, 'restored-value'));
      const restored = await admit();
      expect(restored.ok).toBe(true);
      if (!restored.ok) throw new Error('Expected restored Provider admission');
      expect(restored.attempt.authorization.ticket.selectedSecretBindingId).toBe(ref);
      expect(get).toHaveBeenCalledTimes(2);
      get.mockResolvedValue(materialResponse(3, 'rotated-value'));
      const rotated = await admit();
      expect(rotated.ok).toBe(true);
      if (!rotated.ok) throw new Error('Expected rotated Provider admission');
      expect(rotated.attempt.authorization.ticket.selectedSecretRecordFingerprint)
        .not.toBe(restored.attempt.authorization.ticket.selectedSecretRecordFingerprint);
      // Already admitted attempts keep their exact material fingerprint: the
      // fresh admission cannot silently replace an earlier attempt's value.
      await expect(restored.attempt.revalidateBeforeEffect()).resolves.toMatchObject({
        ok: false, error: { code: 'provider_authorization_changed' },
      });
      await expect(rotated.attempt.revalidateBeforeEffect()).resolves.toEqual({ ok: true });
      expect(get).toHaveBeenCalledTimes(3);
    },
  );

  describe('definitive pre-launch rejection', () => {
    it.each([
      ['missing', ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1 })],
      ['deleted', ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connectionTombstones: [{
          v: 1,
          id: connectionId,
          contributionKey,
          lastDisplayName: 'Gateway',
          deletedAt: 1,
        }],
      })],
    ] as const)('rejects a %s Provider connection before activation', (_kind, settings) => {
      const result = resolveProviderSpawnDefinitiveRejection({
        selection: definitiveSelection(),
        agentTargetKey: 'agent:happier.agent.codex/codex',
        agentId: 'codex',
        providerSettings: settings,
        registry: staticPreflightRegistry(),
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'provider_connection_not_found' },
      });
    });

    it('rejects a catalog-invalid model without consulting grant or runtime state', () => {
      const result = resolveProviderSpawnDefinitiveRejection({
        selection: definitiveSelection('not-in-the-static-catalog'),
        agentTargetKey: 'agent:happier.agent.codex/codex',
        agentId: 'codex',
        providerSettings: providerSettings(),
        // The Agent refuses ids it cannot verify against a catalog, so the
        // two-sided freeform policy is closed and membership is decisive.
        registry: staticPreflightRegistry(
          new Map([[canonicalContributionKey, probelessContribution]]),
        ),
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'provider_model_not_found' },
      });
    });

    // The cold phase must not become a second, stricter answer to the question
    // the picker already asked. A Provider allowing manual ids plus an Agent
    // accepting unverifiable ids makes an unlisted id a real selection, and the
    // picker offers exactly that entry for static Providers such as Z.AI.
    it('admits an unlisted model id the two-sided freeform policy makes real', () => {
      const result = resolveProviderSpawnDefinitiveRejection({
        selection: definitiveSelection('glm-5.3-preview'),
        agentTargetKey: 'agent:happier.agent.codex/codex',
        agentId: 'codex',
        providerSettings: providerSettings(),
        registry: staticPreflightRegistry(
          new Map([[canonicalContributionKey, probelessContribution]]),
          true,
        ),
      });

      expect(result).toEqual({ ok: true });
    });

    it('rejects an unlisted model id when the Provider refuses manual ids', () => {
      const result = resolveProviderSpawnDefinitiveRejection({
        selection: definitiveSelection('glm-5.3-preview'),
        agentTargetKey: 'agent:happier.agent.codex/codex',
        agentId: 'codex',
        providerSettings: providerSettings(),
        registry: staticPreflightRegistry(
          new Map([[canonicalContributionKey, probelessCatalogOnlyContribution]]),
          true,
        ),
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'provider_model_not_found' },
      });
    });

    it('admits a configured manual model of a probe-less Provider', () => {
      const settings = ProviderSettingsV1Schema.parse({
        ...providerSettings(),
        manualModelsByConnectionId: {
          [connectionId]: [{ id: 'manual-only', name: 'Manual Only', addedAt: 2 }],
        },
      });
      const result = resolveProviderSpawnDefinitiveRejection({
        selection: definitiveSelection('manual-only'),
        agentTargetKey: 'agent:happier.agent.codex/codex',
        agentId: 'codex',
        providerSettings: settings,
        registry: staticPreflightRegistry(
          new Map([[canonicalContributionKey, probelessContribution]]),
        ),
      });

      expect(result).toEqual({ ok: true });
    });

    it('keeps an unlisted model of a probe-capable Provider eligible for the launch owner', () => {
      const result = resolveProviderSpawnDefinitiveRejection({
        selection: definitiveSelection('probe-only'),
        agentTargetKey: 'agent:happier.agent.codex/codex',
        agentId: 'codex',
        providerSettings: providerSettings(),
        // The Gateway declares a catalog probe, so its live catalog can report a
        // model the manifest never listed.  Even with the two-sided freeform
        // policy refused, this cold phase has proven nothing about that id.
        registry: staticPreflightRegistry(),
      });

      expect(result).toEqual({ ok: true });
    });

    it('keeps a static catalog model eligible when authorization is deferred', () => {
      const result = resolveProviderSpawnDefinitiveRejection({
        selection: definitiveSelection(),
        agentTargetKey: 'agent:happier.agent.codex/codex',
        agentId: 'codex',
        providerSettings: providerSettings(),
        registry: staticPreflightRegistry(),
      });

      expect(result).toEqual({ ok: true });
    });
  });

  it('preserves exact Ollama catalog capabilities through authorization and Codex materialization', async () => {
    const ollamaContributionKey = 'happier.provider.ollama/ollama';
    const ollamaConnectionId = ProviderConnectionIdSchema.parse('pc_ollama');
    const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
      pluginIds: ['happier.agent.codex', 'happier.provider.ollama'],
      resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
        kind: 'development',
        registeredRootId: `provider-spawn-fixture:${pluginId}`,
        canonicalRoot: rootPath,
        observedRevision: 1,
      }),
    });
    executableRegistries.push(runtimeRegistry);
    const ollamaRegistry = {
      providersByContributionKey:
        runtimeRegistry.contributes.providersByContributionKey ?? new Map(),
    };
    const ollamaContribution =
      ollamaRegistry.providersByContributionKey.get(ollamaContributionKey);
    if (
      !ollamaContribution
      || ollamaContribution.provenance !== 'first_party'
      || ollamaContribution.source.kind !== 'bundled'
    ) {
      throw new Error('Expected the bundled Ollama Provider contribution');
    }
    const activation = await runtimeRegistry.activateContributionsOnDemand([{
      pluginId: 'happier.agent.codex',
      family: 'agents',
      localId: 'codex',
    }]);
    expect(activation).toEqual([{
      pluginId: 'happier.agent.codex',
      diagnostics: [],
    }]);
    const codexDefinition =
      runtimeRegistry.contributes.agentDefinitionsById.get('codex');
    const codexBinding =
      runtimeRegistry.agentRuntimesByAgentId.get('codex')?.providerBinding;
    if (!codexDefinition?.definition.providerRequirements || !codexBinding) {
      throw new Error('Expected the activated Codex Provider binding');
    }
    const initialSettings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: ollamaConnectionId,
        source: {
          kind: 'contribution',
          contributionKey: ollamaContributionKey,
        },
        role: 'default',
        displayName: 'Ollama',
        displayNameMode: 'automatic',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    const localCandidateUrlsByConnectionId = new Map([
      [ollamaConnectionId, new Map([
        ['ollama-native', 'http://localhost:11434'],
        ['ollama-openai-chat', 'http://localhost:11434/v1'],
        ['ollama-openai-responses', 'http://localhost:11434/v1'],
      ])],
    ]);
    const dnsEvidence = await collectProviderConnectionDnsEvidence({
      connectionId: ollamaConnectionId,
      machineId: 'machine-a',
      providerSettings: initialSettings,
      registry: ollamaRegistry,
      resolveAddresses: async () => ['127.0.0.1'],
      lifetime: { wallDeadlineAtMs: Date.now() + 60_000 },
    });
    const ungranted = resolveProviderConnectionForMachine({
      connectionId: ollamaConnectionId,
      machineId: 'machine-a',
      providerSettings: initialSettings,
      registry: ollamaRegistry,
      dnsEvidenceByEndpointUrl: dnsEvidence,
      localCandidateUrlsByConnectionId,
    });
    if (ungranted.status !== 'resolved') {
      throw new Error(`Expected the Ollama connection to resolve, received ${JSON.stringify(ungranted)}`);
    }
    const grantedSettings = ProviderSettingsV1Schema.parse({
      ...initialSettings,
      machineGrants: [{
        v: 1,
        connectionId: ollamaConnectionId,
        machineId: 'machine-a',
        endpointSetFingerprint: ungranted.record.endpointSetFingerprint,
        connectionSecurityFingerprint:
          ungranted.record.connectionSecurityFingerprint,
        confirmedAt: 1,
      }],
    });
    const resolved = resolveProviderConnectionForMachine({
      connectionId: ollamaConnectionId,
      machineId: 'machine-a',
      providerSettings: grantedSettings,
      registry: ollamaRegistry,
      dnsEvidenceByEndpointUrl: dnsEvidence,
      localCandidateUrlsByConnectionId,
    });
    if (resolved.status !== 'resolved' || !resolved.record.authorization.authorized) {
      throw new Error('Expected the Ollama connection to be authorized');
    }
    const catalog = ollamaContribution.definition.catalog;
    if (!('probes' in catalog)) throw new Error('Expected an Ollama probe catalog');
    const catalogFallback =
      ollamaContribution.definition.discovery?.catalogFallback;
    if (!catalogFallback) throw new Error('Expected the Ollama catalog fallback');
    const catalogFingerprint = createProviderCatalogRefreshFingerprint({
      endpoints: resolved.record.endpoints,
      probes: catalog.probes,
      catalogFallback,
    });
    const currentAuthorization =
      createProviderObservationAuthorizationFingerprintV1({
        selectedSecretBindingId: null,
        selectedSecretRecordFingerprint: null,
        credential: null,
      });
    const model = {
      id: 'qwen2.5-coder:7b',
      name: 'qwen2.5-coder:7b',
      capabilities: {
        toolRoundTrips: 'supported' as const,
        reasoningControls: 'unsupported' as const,
      },
    };
    const compatibility = resolveProviderModelCompatibility({
      record: resolved.record,
      providerSettings: grantedSettings,
      agentTargetKey: 'agent:happier.agent.codex/codex',
      support: codexDefinition.definition.providerRequirements,
      adapterVersion: codexBinding.adapterVersion,
      model,
    });
    if (compatibility.result.status !== 'experimental') {
      throw new Error('Expected the current Ollama/Codex binding to require confirmation');
    }
    const ollamaSettings = setProviderExperimentalConfirmationV1(
      grantedSettings,
      {
        connectionId: ollamaConnectionId,
        agentTargetKey: 'agent:happier.agent.codex/codex',
        modelId: compatibility.result.confirmationScope.kind === 'model'
          ? model.id
          : null,
        compatibilityFingerprint: compatibility.compatibilityFingerprint,
        confirmedAt: 1,
      },
    );
    const runtimeState = ProviderRuntimeStateFileV1Schema.parse({
      v: 1,
      machineId: 'machine-a',
      endpointHealth: [],
      catalogs: [{
        key: {
          machineId: 'machine-a',
          connectionId: ollamaConnectionId,
          catalogFingerprint,
          observationAuthorizationFingerprint: currentAuthorization,
        },
        state: {
          catalogObservationId: 'ollama-current',
          snapshot: {
            models: [model],
            observedAt: 20,
            stale: false,
          },
          staleProbeModels: [],
        },
        lastAccessedAt: 20,
      }],
      installationChecks: [],
      modelLoadStates: [],
    });
    const runtimeLease: PluginRuntimeRegistryLease = {
      registry: runtimeRegistry,
      source: 'ephemeral',
      durableRevision: runtimeRegistry.durableRevision ?? -1,
      release: vi.fn(async () => undefined),
    };
    const snapshot: ActiveAccountSettingsSnapshot = {
      source: 'network',
      settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: ollamaSettings.defaultsByAgentTargetKey }),
      providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(ollamaSettings).catalog },
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: 'account-a',
    };
    const authorize = (state: typeof runtimeState) =>
      createRuntimeProviderSpawnAuthorizationAttempt({
        selection: {
          v: 1,
          updatedAt: 1,
          ref: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: ollamaConnectionId,
            modelId: model.id,
          },
        },
        machineId: 'machine-a',
        agentTargetKey: 'agent:happier.agent.codex/codex',
        agentId: 'codex',
        lease: runtimeLease,
        getAccountSettingsSnapshot: () => snapshot,
        runtimeStateStore: { read: async () => state },
        localCandidateUrlsByConnectionId,
        resolveAddresses: async () => ['127.0.0.1'],
        materializationBaseDir: '/unused',
        sessionId: 'ollama-capabilities',
      });

    const result = await authorize(runtimeState);
    if (!result.ok) {
      throw new Error(`Expected Ollama authorization, received ${result.error.code}`);
    }
    if (!('materializeAfterHooks' in result.attempt)) {
      throw new Error('Expected an external Ollama authorization');
    }
    expect(result.attempt.authorization.binding.selection.model).toEqual(model);
    expect(result.attempt.authorization.sessionBindingMetadata.model).toEqual(model);
    const materialized = await result.attempt.materializeAfterHooks();
    expect(materialized).toMatchObject({
      ok: true,
      materialization: {
        launchMaterialization: {
          engineConfig: {
            config: { model_reasoning_effort: 'none' },
          },
        },
      },
    });
    result.attempt.cleanupOnFailure();

    const mismatchedAuthorization =
      `${currentAuthorization.slice(0, -1)}${currentAuthorization.endsWith('a') ? 'b' : 'a'}` as typeof currentAuthorization;
    const mismatchedState = ProviderRuntimeStateFileV1Schema.parse({
      ...runtimeState,
      catalogs: [{
        ...runtimeState.catalogs[0]!,
        key: {
          ...runtimeState.catalogs[0]!.key,
          observationAuthorizationFingerprint: mismatchedAuthorization,
        },
      }],
    });
    await expect(authorize(mismatchedState)).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_compatibility_unverified' },
    });
  });

  it('carries connection-owned model settings through authorization into native config and refuses an unsupported adapter', async () => {
    const base = grantedSettings();
    const settings = ProviderSettingsV1Schema.parse({ ...base, connections: base.connections.map(connection => ({
      ...connection, modelSettings: { 'model-a': { temperature: 0.4, maxTokens: 2048 },
        'other-model': { temperature: 0.8, maxTokens: 4096 } },
    })) });
    const runtimeLease = lease();
    const native = runtimeLease.registry.agentRuntimesByAgentId.get('codex')!;
    const definition = runtimeLease.registry.contributes.agentDefinitionsById.get('codex')!;
    const nativeLease: PluginRuntimeRegistryLease = { ...runtimeLease, registry: {
      ...runtimeLease.registry,
      agentRuntimesByAgentId: new Map([['codex', { ...native, providerBinding: OPENCODE_PROVIDER_BINDING_ADAPTER_V1 }]]),
      contributes: { ...runtimeLease.registry.contributes, agentDefinitionsById: new Map([['codex', {
        ...definition, definition: { ...definition.definition, providerRequirements: {
          ...definition.definition.providerRequirements!, materialization: 'configFile' as const,
        } },
      }]]) },
    } };
    const input = {
      selection: { v: 1 as const, updatedAt: 1, ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'model-a',
      } },
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', agentId: 'codex',
      accountSettings: accountSettings(settings), providerSettings: settings, registry, dnsEvidenceByEndpointUrl: dns,
    };
    expect(resolveProviderSpawnAuthorization({ ...input, lease: runtimeLease })).toMatchObject({
      ok: false, error: { code: 'provider_incompatible_with_agent' },
    });
    const resolved = resolveProviderSpawnAuthorization({ ...input, lease: nativeLease });
    if (!resolved.ok || resolved.authorization.deployment.kind !== 'external') throw new Error('expected native binding authorization');
    const { binding, prepared } = resolved.authorization;
    const endpoint = binding.endpoint;
    if (!('normalizedUrl' in endpoint) || typeof endpoint.normalizedUrl !== 'string') throw new Error('expected external endpoint');
    expect(binding.modelSettings).toEqual({ temperature: 0.4, maxTokens: 2048 });
    const output = await OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize({
      v: 1, binding: { ...binding, endpoint: { ...endpoint, normalizedUrl: endpoint.normalizedUrl } }, prepared, credential: {
        kind: 'apiKey', transport: binding.runtimeCredentialTransport!, value: 'test-provider-key',
      },
    });
    if (output.kind !== 'configFile') throw new Error('expected native config file');
    expect(JSON.parse(output.files[0]!.utf8)).toMatchObject({
      agent: { build: { temperature: 0.4 }, plan: { temperature: 0.4 } },
      provider: { [prepared.adapterBindingKey!]: { models: { 'model-a': { limit: { output: 2048 } } } } },
    });
  });

  it('keeps a same-id static descriptor authoritative over a runtime probe descriptor', () => {
    const settings = grantedSettings();
    const result = resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: 'model-a',
        },
      },
      runtimeModelDescriptor: {
        id: 'model-a',
        name: 'Probe Model A',
        capabilities: {
          toolRoundTrips: 'unsupported',
          reasoningControls: 'unsupported',
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: dns,
      lease: lease(),
    });

    expect(result).toMatchObject({
      ok: true,
      authorization: {
        binding: {
          selection: {
            model: {
              id: 'model-a',
              name: 'Model A',
              capabilities: { toolRoundTrips: 'supported' },
            },
          },
        },
      },
    });
  });

  it('does not resurrect static metadata after an authoritative snapshot omits the model', () => {
    const settings = grantedSettings(authoritativeRegistry);
    const result = resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: 'model-a',
        },
      },
      runtimeCatalogSnapshotExists: true,
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry: authoritativeRegistry,
      dnsEvidenceByEndpointUrl: dns,
      lease: lease(),
    });

    expect(result).toMatchObject({
      ok: false,
      // The existing two-sided freeform policy still admits the literal id,
      // but without static capabilities it remains unverified and cannot launch.
      error: { code: 'provider_compatibility_unverified' },
    });
  });

  it('uses authoritative probe capabilities for a same-id static model at spawn', () => {
    const settings = grantedSettings(authoritativeRegistry);
    const result = resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: 'model-a',
        },
      },
      runtimeModelDescriptor: {
        id: 'model-a',
        name: 'API Model A',
        capabilities: {
          toolRoundTrips: 'unsupported',
          reasoningControls: 'unsupported',
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry: authoritativeRegistry,
      dnsEvidenceByEndpointUrl: dns,
      lease: lease(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'provider_incompatible_with_agent' },
    });
  });

  it('keeps a same-id manual descriptor authoritative over a runtime probe descriptor', () => {
    const settings = ProviderSettingsV1Schema.parse({
      ...grantedSettings(),
      manualModelsByConnectionId: {
        pc_gateway: [{
          id: 'manual-model',
          name: 'Manual model',
          addedAt: 1,
        }],
      },
    });
    const result = resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: 'manual-model',
        },
      },
      runtimeModelDescriptor: {
        id: 'manual-model',
        name: 'Probe manual model',
        capabilities: {
          toolRoundTrips: 'supported',
          reasoningControls: 'unsupported',
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: dns,
      lease: lease(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'provider_compatibility_unverified' },
    });
  });

  it('admits advisory unloaded models but blocks verified unloaded required-preflight models', async () => {
    const authorizeWithPolicy = async (
      preflightPolicy: 'advisory' | 'required',
    ) => {
      const localDefinition = ProviderContributionV1Schema.parse({
        ...definition,
        kind: 'local',
        endpointTemplates: [{
          id: 'responses',
          protocol: 'openai-responses',
          localUrlCandidates: ['http://127.0.0.1:1234/v1'],
          capabilities: {
            streaming: 'supported',
            toolRoundTrips: 'supported',
            statefulResponses: 'supported',
            reasoningControls: 'supported',
          },
        }],
        credential: undefined,
        catalog: {
          source: 'static+probe',
          manualModelPolicy: 'catalog-only',
          staticModels: [{
            id: 'model-a',
            name: 'Model A',
            capabilities: { toolRoundTrips: 'supported' },
          }],
          probes: [{
            endpointTemplateId: 'responses',
            path: '/models',
            parser: 'lmstudio-native-models',
          }],
        },
        modelLoad: {
          endpointTemplateId: 'responses',
          path: '/models/load',
          request: 'json-model-id-v1',
          confirmation: 'refresh-catalog-load-state',
          preflightPolicy,
        },
      });
      const localContribution: ResolvedProviderContribution = {
        ...contribution,
        definition: localDefinition,
      };
      const localRegistry = {
        providersByContributionKey: new Map([
          [canonicalContributionKey, localContribution],
        ]),
      };
      const initial = providerSettings();
      const ungranted = resolveProviderConnectionForMachine({
        connectionId,
        machineId: 'machine-a',
        providerSettings: initial,
        registry: localRegistry,
        dnsEvidenceByEndpointUrl: new Map(),
      });
      if (ungranted.status !== 'resolved') {
        throw new Error('Expected local Provider connection');
      }
      const settings = ProviderSettingsV1Schema.parse({
        ...initial,
        machineGrants: [{
          v: 1,
          connectionId,
          machineId: 'machine-a',
          connectionSecurityFingerprint:
            ungranted.record.connectionSecurityFingerprint,
          endpointSetFingerprint: ungranted.record.endpointSetFingerprint,
          confirmedAt: 1,
        }],
      });
      const authorizedConnection = resolveProviderConnectionForMachine({
        connectionId,
        machineId: 'machine-a',
        providerSettings: settings,
        registry: localRegistry,
        dnsEvidenceByEndpointUrl: new Map(),
      });
      if (authorizedConnection.status !== 'resolved') {
        throw new Error('Expected authorized local Provider connection');
      }
      const endpoint = authorizedConnection.record.endpoints.find(
        (candidate) => candidate.endpointTemplateId === 'responses',
      );
      if (!endpoint) throw new Error('Expected local Provider endpoint');
      const probeRequestFingerprint = createProviderProbeRequestFingerprintV1({
        method: 'GET',
        endpointUrl: endpoint.normalizedUrl,
        path: '/models',
        parser: 'lmstudio-native-models',
        publicHeaders: endpoint.publicHeaders,
      });
      const observationAuthorizationFingerprint =
        createProviderObservationAuthorizationFingerprintV1({
          selectedSecretBindingId: null,
          selectedSecretRecordFingerprint: null,
          credential: null,
        });
      const runtimeState = ProviderRuntimeStateFileV1Schema.parse({
        v: 1,
        machineId: 'machine-a',
        endpointHealth: [],
        catalogs: [{
          key: {
            machineId: 'machine-a',
            connectionId,
            catalogFingerprint: createProviderCatalogFingerprintV1({
              probeRequestFingerprints: [probeRequestFingerprint],
            }),
            observationAuthorizationFingerprint,
          },
          state: {
            catalogObservationId: `current-${preflightPolicy}`,
            snapshot: {
              models: [{
                id: 'model-a',
                name: 'Model A',
                capabilities: { toolRoundTrips: 'supported' },
              }],
              observedAt: 20,
              stale: false,
            },
            staleProbeModels: [],
          },
          lastAccessedAt: 20,
        }],
        installationChecks: [],
        modelLoadStates: [{
          key: {
            machineId: 'machine-a',
            connectionId,
            catalogObservationId: `current-${preflightPolicy}`,
            modelId: 'model-a',
          },
          loadState: 'unloaded',
          observedAt: 20,
          lastAccessedAt: 20,
        }],
      });
      const snapshot: ActiveAccountSettingsSnapshot = {
        source: 'network',
        settings: AccountSettingsSchema.parse(accountSettings(settings)),
        providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(settings).catalog },
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [key],
        scopeKey: 'account-a',
      };
      return await createRuntimeProviderSpawnAuthorizationAttempt({
        selection: {
          v: 1,
          updatedAt: 1,
          ref: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: connectionId,
            modelId: 'model-a',
          },
        },
        machineId: 'machine-a',
        agentTargetKey: 'agent:happier.agent.codex/codex',
        agentId: 'codex',
        lease: lease(
          undefined,
          true,
          'restart_session',
          localRegistry.providersByContributionKey,
          true,
        ),
        getAccountSettingsSnapshot: () => snapshot,
        runtimeStateStore: { read: async () => runtimeState },
        resolveAddresses: async () => ['127.0.0.1'],
        materializationBaseDir: '/unused',
        sessionId: `model-load-${preflightPolicy}`,
      });
    };

    const required = await authorizeWithPolicy('required');
    expect(required).toMatchObject({
      ok: false,
      error: {
        code: 'provider_model_unloaded',
        connectionId,
        machineId: 'machine-a',
        action: 'load_model',
      },
    });

    const advisory = await authorizeWithPolicy('advisory');
    expect(advisory.ok).toBe(true);
    if (advisory.ok) advisory.attempt.cleanupOnFailure();
  });

  it('classifies live model changes from exact current and next authorized binding dimensions', () => {
    const settings = grantedSettings();
    const runtimeLease = lease(undefined, true, 'live');
    const authorize = (modelId: string) => resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId,
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: dns,
      lease: runtimeLease,
      runtimeModelDescriptor: {
        id: modelId,
        name: modelId,
        capabilities: { toolRoundTrips: 'supported' },
      },
    });
    const current = authorize('model-a');
    const next = authorize('model-b');
    if (!current.ok || !next.ok) throw new Error('Expected exact Provider authorizations');

  });

  it.each([
    { claudeHelperModels: { fast: 'model-a', default: 'model-a' }, accepted: true, consumesHelpers: true },
    { claudeHelperModels: {}, accepted: true, consumesHelpers: true },
    { claudeHelperModels: { fast: 'probe-helper' }, accepted: true, consumesHelpers: true },
    { claudeHelperModels: { fast: 'missing-helper' }, accepted: false, consumesHelpers: true },
    { claudeHelperModels: { fast: 'missing-helper' }, accepted: true, consumesHelpers: false },
  ])('admits managed helper models with the existing model catalog: %j', ({ claudeHelperModels, accepted, consumesHelpers }) => {
    const settings = managedGrantedSettings();
    settings.connections[0] = { ...settings.connections[0]!, claudeHelperModels };
    const result = resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: 'model-a',
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: { providerSettingsV1: settings },
      providerSettings: settings,
      registry: managedRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
      lease: lease(undefined, false, undefined, undefined, undefined, undefined, consumesHelpers),
      runtimeCatalogSnapshotExists: true,
      runtimeAdditionalModelDescriptors: [{ id: 'probe-helper', name: 'Probe helper' }],
      managedProviderRuntime: exactManagedProviderRuntime(),
      managedPurposeBindingSnapshot: {
        v: 1,
        bindings: [{
          purpose: {
            consumer: { pluginId: 'acme.gateway', localId: 'gateway' },
            purpose: 'upstream',
          },
          target: {
            kind: 'account',
            account: {
              service: {
                pluginId: 'happier.connected-account.example',
                localId: 'example',
              },
              accountId: 'account-a',
            },
          },
        }],
      },
    });

    if (!accepted) {
      expect(result).toMatchObject({ ok: false, error: { code: 'provider_model_not_found' } });
      return;
    }
    expect(result).toMatchObject({
      ok: true,
      authorization: {
        deployment: {
          kind: 'managedLocal',
          contribution: {
            provenance: 'first_party',
            source: { kind: 'bundled' },
          },
          implementation: {
            kind: 'managedLocal',
            purposeBindings: {
              bindings: [{
                purpose: {
                  consumer: { pluginId: 'acme.gateway', localId: 'gateway' },
                  purpose: 'upstream',
                },
                target: {
                  kind: 'account',
                  account: { accountId: 'account-a' },
                },
              }],
            },
          },
        },
        binding: {
          ...(consumesHelpers ? { claudeHelperModels } : {}),
          selection: {
            connectionId,
            model: expect.objectContaining({ id: 'model-a', name: 'Model A' }),
          },
          endpoint: {
            endpointTemplateId: 'responses',
            protocol: 'openai-responses',
          },
          runtimeCredentialTransport: {
            id: 'bearer',
            destination: {
              kind: 'httpHeader',
              name: 'authorization',
              format: 'bearer',
            },
          },
        },
        credentialReference: { kind: 'none' },
        ticket: {
          selectedSecretBindingId: null,
          selectedSecretRecordFingerprint: null,
        },
        sessionBindingMetadata: {
          runtimeBindingBasis: {
            v: 1,
            deployment: {
              kind: 'managedLocal',
              purposeBindings: {
                bindings: [{
                  target: {
                    kind: 'account',
                    account: { accountId: 'account-a' },
                  },
                }],
              },
            },
            connectionId,
            credentialAuthorization: {
              connectionSecurityFingerprint: expect.any(String),
              grantFingerprint: expect.any(String),
            },
          },
        },
      },
    });
    if (result.ok && !consumesHelpers) expect(result.authorization.binding.claudeHelperModels).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
    expect(JSON.stringify(result)).not.toContain('localhost');
  });

  it.each([
    { consumesHelpers: false, helperState: 'incompatible' },
    { consumesHelpers: false, helperState: 'stale' },
    { consumesHelpers: true, helperState: 'incompatible' },
    { consumesHelpers: true, helperState: 'stale' },
  ] as const)('observes only consumed helper models during remote hub authorization: %j', async ({ consumesHelpers, helperState }) => {
    const sharedContribution: ResolvedProviderContribution = {
      ...managedContribution,
      definition: ProviderContributionV1Schema.parse({
        ...managedContribution.definition,
        managedRuntime: { ...managedContribution.definition.managedRuntime, sharing: 'connectionMachine' },
      }),
    };
    const sharedRegistry = {
      providersByContributionKey: new Map([[canonicalContributionKey, sharedContribution]]),
    };
    const settings = managedGrantedSettings(sharedRegistry, 'machine-hub');
    settings.connections[0] = { ...settings.connections[0]!, claudeHelperModels: { fast: 'helper-model' } };
    const resolution = resolveProviderConnectionForMachine({
      connectionId, machineId: 'machine-a', providerSettings: settings,
      registry: sharedRegistry, dnsEvidenceByEndpointUrl: new Map(),
    });
    if (resolution.status !== 'resolved') throw new Error('Expected remote gateway connection');
    const snapshot: ActiveAccountSettingsSnapshot = {
      source: 'network', settings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
      providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(settings).catalog },
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'account-a',
    };
    const result = await createRuntimeProviderSpawnAuthorizationAttempt({
      selection: { v: 1, updatedAt: 1, ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'model-a',
      } },
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', agentId: 'codex',
      lease: lease(undefined, false, undefined, sharedRegistry.providersByContributionKey, false, undefined, consumesHelpers),
      getAccountSettingsSnapshot: () => snapshot,
      materializationBaseDir: '/unused',
      resolveManagedPurposeBindingIntent: async (input) => ({ purpose: input.purpose, target: input.target }),
      // The hub RPC is the system boundary; compatibility and admission remain real.
      readModelProjection: async (request, signal) => {
        signal.throwIfAborted();
        expect(request).toMatchObject({ machineId: 'machine-hub', refreshPolicy: 'current_only' });
        const rows = [
          { id: 'model-a', name: 'Model A', capabilities: { toolRoundTrips: 'supported' as const } },
          { id: 'helper-model', name: 'Helper model', capabilities: {
            toolRoundTrips: helperState === 'incompatible' ? 'unsupported' as const : 'supported' as const,
          } },
        ].map((descriptor) => {
          const compatibility = resolveProviderModelCompatibility({
            record: resolution.record, providerSettings: settings, agentTargetKey: request.agentTargetKey,
            support: agentProviderSupport(false), model: descriptor, adapterVersion: 3,
          });
          return {
            ref: { agentTargetKey: request.agentTargetKey, providerConnectionId: connectionId, modelId: descriptor.id },
            descriptor, compatibility,
            ...(compatibility.result.status !== 'incompatible' ? {
              application: { agentTargetKey: request.agentTargetKey, implementationIdentity: sharedContribution.identity,
                endpointTemplateId: 'responses', protocol: compatibility.result.selectedProtocol },
            } : {}),
            sources: { manual: false, static: false, probe: true }, confidence: 'probe',
            endpointHealth: 'not_checked', catalog: { stale: descriptor.id === 'helper-model' && helperState === 'stale' },
            loadState: 'unknown', visibility: 'visible',
          };
        });
        return DaemonProviderModelProjectionResponseV1Schema.parse({
          status: 'success', agentTargetKey: request.agentTargetKey,
          groups: [{ connectionId, providerName: 'Gateway', connectionName: 'Gateway', connectionRole: 'default',
            connectionDisplayNameMode: 'automatic', connectionRevision: 7,
            sourceAuthority: { provider: { identity: sharedContribution.identity, definitionRevision: 1 },
              connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint },
            authorization: { authorized: true }, modelLoadAction: 'descriptor_absent', manualModelPolicy: 'allowed',
            supportsFreeformModelIds: false, suppressedConnectedServiceIds: [], rows }],
        });
      },
    });
    if (consumesHelpers) {
      expect(result).toMatchObject({ ok: false, error: { code: 'provider_endpoint_unavailable' } });
    } else {
      expect(result).toMatchObject({ ok: true, attempt: { authorization: {
        binding: { selection: { model: { id: 'model-a' } } },
      } } });
      if (result.ok) {
        expect(result.attempt.authorization.binding.claudeHelperModels).toBeUndefined();
        result.attempt.cleanupOnFailure();
      }
    }
  });

  it('authorizes a credential-free managed Provider without fabricating a bearer', () => {
    const credentialFreeContribution: ResolvedProviderContribution = {
      ...managedContribution,
      definition: ProviderContributionV1Schema.parse({
        ...managedContribution.definition,
        credential: undefined,
      }),
    };
    const credentialFreeRegistry = {
      providersByContributionKey: new Map([[canonicalContributionKey, credentialFreeContribution]]),
    };
    const settings = managedGrantedSettings(credentialFreeRegistry);
    const result = resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: 'model-a',
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: { providerSettingsV1: settings },
      providerSettings: settings,
      registry: credentialFreeRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
      lease: lease(
        undefined,
        true,
        'restart_session',
        credentialFreeRegistry.providersByContributionKey,
        true,
      ),
      managedProviderRuntime: exactManagedProviderRuntime(),
      managedPurposeBindingSnapshot: {
        v: 1,
        bindings: [{
          purpose: {
            consumer: { pluginId: 'acme.gateway', localId: 'gateway' },
            purpose: 'upstream',
          },
          target: {
            kind: 'account',
            account: {
              service: {
                pluginId: 'happier.connected-account.example',
                localId: 'example',
              },
              accountId: 'account-a',
            },
          },
        }],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      authorization: {
        binding: { runtimeCredentialTransport: null },
        credentialReference: { kind: 'none' },
        sessionBindingMetadata: {
          runtimeBindingBasis: { runtimeCredentialTransport: null },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('managed-runtime-bearer');
  });

  it('carries a managed endpoint template public header into the authorized Agent binding', () => {
    const headerManagedContribution: ResolvedProviderContribution = {
      ...managedContribution,
      definition: ProviderContributionV1Schema.parse({
        ...managedContribution.definition,
        endpointTemplates: managedContribution.definition.endpointTemplates.map((template) => ({
          ...template,
          publicHeaders: { 'x-route': 'tenant-a' },
        })),
      }),
    };
    const declaredHeaders = headerManagedContribution.definition.endpointTemplates[0]?.publicHeaders;
    expect(declaredHeaders).toBeTruthy();
    const headerManagedRegistry = {
      providersByContributionKey: new Map([[canonicalContributionKey, headerManagedContribution]]),
    };
    const settings = managedGrantedSettings(headerManagedRegistry);
    const result = resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: 'model-a',
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: { providerSettingsV1: settings },
      providerSettings: settings,
      registry: headerManagedRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
      lease: lease(),
      managedProviderRuntime: exactManagedProviderRuntime(),
      managedPurposeBindingSnapshot: {
        v: 1,
        bindings: [{
          purpose: {
            consumer: { pluginId: 'acme.gateway', localId: 'gateway' },
            purpose: 'upstream',
          },
          target: {
            kind: 'account',
            account: {
              service: {
                pluginId: 'happier.connected-account.example',
                localId: 'example',
              },
              accountId: 'account-a',
            },
          },
        }],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      authorization: {
        binding: {
          endpoint: {
            endpointTemplateId: 'responses',
            publicHeaders: declaredHeaders,
          },
        },
      },
    });
  });

  it.each([
    ['development', { kind: 'path' } as const],
    ['installed', { kind: 'package' } as const],
  ])('authorizes an exact current public managed Provider runtime from a %s plugin', async (_kind, source) => {
    const externalManagedContribution: ResolvedProviderContribution = {
      provenance: 'external',
      source,
      pluginId: managedContribution.pluginId,
      identity: managedContribution.identity,
      definition: managedContribution.definition,
    };
    const providersByContributionKey = new Map([
      [canonicalContributionKey, externalManagedContribution],
    ]);
    const externalManagedRegistry = { providersByContributionKey };
    const settings = managedGrantedSettings(externalManagedRegistry);
    const managedPurposeBindingSnapshot = {
      v: 1 as const,
      bindings: [{
        purpose: {
          consumer: { pluginId: 'acme.gateway', localId: 'gateway' },
          purpose: 'upstream',
        },
        target: {
          kind: 'account' as const,
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      }],
    };
    const snapshot: ActiveAccountSettingsSnapshot = {
      source: 'network',
      settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: settings.defaultsByAgentTargetKey }),
      providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(settings).catalog },
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: 'account-a',
    };
    const acquireManagedProviderRuntime = vi.fn(
      async () => exactManagedProviderRuntime(),
    );
    const runtimeLease = lease(
      undefined,
      true,
      'restart_session',
      providersByContributionKey,
    );
    Object.assign(runtimeLease.registry, { acquireManagedProviderRuntime });

    const authorizationInput = {
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: 'model-a',
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      lease: runtimeLease,
      getAccountSettingsSnapshot: () => snapshot,
      managedPurposeBindingSnapshot,
      materializationBaseDir: '/unused',
      sessionId: `managed-${_kind}`,
    } satisfies Parameters<
      typeof createRuntimeProviderSpawnAuthorizationAttempt
    >[0];
    const result = await createRuntimeProviderSpawnAuthorizationAttempt(
      authorizationInput,
    );

    expect(acquireManagedProviderRuntime).toHaveBeenCalledWith({
      pluginId: 'acme.gateway',
      localId: 'gateway',
    });
    expect(result).toMatchObject({
      ok: true,
      attempt: {
        authorization: {
          deployment: {
            kind: 'managedLocal',
            contribution: {
              provenance: 'external',
              source,
            },
            implementation: {
              implementationIdentity: {
                pluginId: 'acme.gateway',
                localId: 'gateway',
              },
              managedRuntime: {
                kind: 'managed',
                endpointTemplateIds: ['responses'],
              },
            },
          },
          sessionBindingMetadata: {
            runtimeBindingBasis: {
              deployment: {
                kind: 'managedLocal',
                implementationIdentity: {
                  pluginId: 'acme.gateway',
                  localId: 'gateway',
                },
                managedRuntime: {
                  kind: 'managed',
                  endpointTemplateIds: ['responses'],
                },
              },
            },
          },
        },
      },
    });

    for (const unavailableRuntime of [
      null,
      exactManagedProviderRuntime(
        () => false,
      ),
    ]) {
      Object.assign(runtimeLease.registry, {
        acquireManagedProviderRuntime: vi.fn(
          async () => unavailableRuntime,
        ),
      });
      await expect(
        createRuntimeProviderSpawnAuthorizationAttempt(
          authorizationInput,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'provider_connection_invalid' },
      });
    }

    const {
      managedPurposeBindingSnapshot: _omittedPurposeBindings,
      ...withoutPurposeBindings
    } = authorizationInput;
    await expect(
      createRuntimeProviderSpawnAuthorizationAttempt(
        withoutPurposeBindings,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_connection_invalid' },
    });
  });

  it('reauthorizes an active managed binding from its immutable snapshot without calling C', async () => {
    const settings = managedGrantedSettings();
    const managedPurposeBindingSnapshot = {
      v: 1 as const,
      bindings: [{
        purpose: {
          consumer: { pluginId: 'acme.gateway', localId: 'gateway' },
          purpose: 'upstream',
        },
        target: {
          kind: 'account' as const,
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      }],
    };
    const currentSnapshot: ActiveAccountSettingsSnapshot = {
      source: 'network',
      settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: settings.defaultsByAgentTargetKey }),
      providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(settings).catalog },
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: 'account-a',
    };

    const result = await createRuntimeProviderSpawnAuthorizationAttempt({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: 'model-a',
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      lease: lease(
        undefined,
        true,
        'restart_session',
        managedRegistry.providersByContributionKey,
      ),
      getAccountSettingsSnapshot: () => currentSnapshot,
      managedPurposeBindingSnapshot,
      materializationBaseDir: '/unused',
      sessionId: 'managed-active-snapshot',
    });

    expect(result).toMatchObject({
      ok: true,
      attempt: {
        authorization: {
          deployment: {
            implementation: {
              purposeBindings: managedPurposeBindingSnapshot,
            },
          },
        },
      },
    });
  });

  it('separates exact managed effect custody from transferred lifetime currentness', async () => {
    const experimentalDefinition = ProviderContributionV1Schema.parse({
      ...managedContribution.definition,
      compatibilityOverrides: [],
    });
    const experimentalContribution: ResolvedProviderContribution = {
      ...managedContribution,
      definition: experimentalDefinition,
    };
    const providersByContributionKey = new Map([
      [canonicalContributionKey, experimentalContribution],
    ]);
    const experimentalRegistry = { providersByContributionKey };
    const unconfirmedSettings = managedGrantedSettings(experimentalRegistry);
    const resolution = resolveProviderConnectionForMachine({
      connectionId,
      machineId: 'machine-a',
      providerSettings: unconfirmedSettings,
      registry: experimentalRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (resolution.status !== 'resolved') {
      throw new Error('Expected experimental managed connection');
    }
    if (!('staticModels' in experimentalDefinition.catalog)) {
      throw new Error('Expected static managed model');
    }
    const model = experimentalDefinition.catalog.staticModels[0]!;
    const compatibility = resolveProviderModelCompatibility({
      record: resolution.record,
      providerSettings: unconfirmedSettings,
      agentTargetKey: 'agent:happier.agent.codex/codex',
      support: agentProviderSupport(),
      adapterVersion: 3,
      model,
    });
    expect(compatibility.result.status).toBe('experimental');
    if (compatibility.result.status !== 'experimental') {
      throw new Error('Expected experimental compatibility');
    }
    const confirmedSettings = setProviderExperimentalConfirmationV1(
      unconfirmedSettings,
      {
        connectionId,
        agentTargetKey: 'agent:happier.agent.codex/codex',
        modelId: compatibility.result.confirmationScope.kind === 'model'
          ? model.id
          : null,
        compatibilityFingerprint: compatibility.compatibilityFingerprint,
        confirmedAt: 1,
      },
    );
    const snapshot = (
      settings: ProviderSettingsV1,
      settingsVersion: number,
    ): ActiveAccountSettingsSnapshot => ({
      source: 'network',
      settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: settings.defaultsByAgentTargetKey }),
      providerConnectionsCatalog: { status: 'ready', revision: settingsVersion, catalog: splitProviderSettingsV1(settings).catalog },
      settingsVersion,
      loadedAtMs: settingsVersion,
      settingsSecretsReadKeys: [],
      scopeKey: 'account-a',
    });
    let currentSnapshot = snapshot(confirmedSettings, 1);
    const resolveBindingIntent = vi.fn<
      ResolveManagedProviderPurposeBindingIntent
    >(async (input) => ({
      purpose: input.purpose,
      target: input.target,
    }));
    const runtimeLease = lease(
      undefined,
      true,
      'restart_session',
      providersByContributionKey,
    );
    const result = await createRuntimeProviderSpawnAuthorizationAttempt({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: model.id,
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      lease: runtimeLease,
      getAccountSettingsSnapshot: () => currentSnapshot,
      resolveManagedPurposeBindingIntent: resolveBindingIntent,
      materializationBaseDir: '/unused',
      sessionId: 'managed-currentness',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(resolveBindingIntent).toHaveBeenCalledTimes(1);

    currentSnapshot = snapshot(unconfirmedSettings, 2);
    expect(result.attempt.isAuthorizationCurrent()).toBe(true);
    await expect(result.attempt.revalidateBeforeCommit()).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_authorization_changed' },
    });
    expect(resolveBindingIntent).toHaveBeenCalledTimes(1);

    currentSnapshot = snapshot(ProviderSettingsV1Schema.parse({
      ...unconfirmedSettings,
      machineGrants: [],
    }), 3);
    expect(result.attempt.isAuthorizationCurrent()).toBe(false);

    currentSnapshot = snapshot(confirmedSettings, 4);
    const revisionAttempt = await createRuntimeProviderSpawnAuthorizationAttempt({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: model.id,
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      lease: runtimeLease,
      getAccountSettingsSnapshot: () => currentSnapshot,
      subscribeAccountSettingsSnapshot: () => () => undefined,
      resolveManagedPurposeBindingIntent: resolveBindingIntent,
      materializationBaseDir: '/unused',
      sessionId: 'managed-revision-currentness',
    });
    expect(revisionAttempt.ok).toBe(true);
    if (!revisionAttempt.ok) throw new Error(revisionAttempt.error.code);
    await expect(revisionAttempt.attempt.revalidateBeforeCommit()).resolves.toMatchObject({
      ok: true,
    });
    const transferredCleanup = revisionAttempt.attempt.takeCleanupOnExit();
    expect(transferredCleanup).toBeTypeOf('function');
    currentSnapshot = snapshot(ProviderSettingsV1Schema.parse({
      ...confirmedSettings,
      connections: confirmedSettings.connections.map((connection) => (
        connection.id === connectionId
          ? {
              ...connection,
              displayName: 'Renamed gateway',
              revision: connection.revision + 1,
              updatedAt: connection.updatedAt + 1,
            }
          : connection
      )),
    }), 5);
    expect(revisionAttempt.attempt.isAuthorizationCurrent()).toBe(true);
    await expect(revisionAttempt.attempt.revalidateBeforeEffect()).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_authorization_changed' },
    });
    await expect(revisionAttempt.attempt.revalidateBeforeCommit()).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_authorization_changed' },
    });
    transferredCleanup?.();

    currentSnapshot = snapshot(confirmedSettings, 6);
    const generationAttempt = await createRuntimeProviderSpawnAuthorizationAttempt({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: model.id,
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      lease: runtimeLease,
      getAccountSettingsSnapshot: () => currentSnapshot,
      resolveManagedPurposeBindingIntent: resolveBindingIntent,
      materializationBaseDir: '/unused',
      sessionId: 'managed-facet-currentness',
    });
    expect(generationAttempt.ok).toBe(true);
    if (!generationAttempt.ok) throw new Error(generationAttempt.error.code);
    const isExactRetainedRuntimeCurrent = () => true;
    expect(generationAttempt.attempt.isAuthorizationCurrent()).toBe(true);
    expect(generationAttempt.attempt.isRetainedAuthorizationCurrent({
      isExactRetainedRuntimeCurrent,
    })).toBe(true);
    providersByContributionKey.delete(canonicalContributionKey);
    expect(generationAttempt.attempt.isRetainedAuthorizationCurrent({})).toBe(true);
    await expect(createRuntimeProviderSpawnAuthorizationAttempt({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: model.id,
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      lease: runtimeLease,
      getAccountSettingsSnapshot: () => currentSnapshot,
      resolveManagedPurposeBindingIntent: resolveBindingIntent,
      materializationBaseDir: '/unused',
      sessionId: 'managed-new-claim-after-removal',
    })).resolves.toMatchObject({ ok: false });

    currentSnapshot = snapshot(ProviderSettingsV1Schema.parse({
      ...confirmedSettings,
      machineGrants: [],
    }), 7);
    expect(generationAttempt.attempt.isRetainedAuthorizationCurrent({})).toBe(false);
  });

  it('never reads inherited machine override rows for legal prototype-name machine ids', async () => {
    const base = providerSettings();
    const settings = ProviderSettingsV1Schema.parse({
      ...base,
      connections: [{
        ...base.connections[0],
        endpointOverridesByMachineId: {
          'machine-other': [{ endpointTemplateId: 'responses', baseUrl: 'https://other.example/v1' }],
        },
      }],
    });

    await expect(collectProviderConnectionDnsEvidence({
      connectionId,
      machineId: 'toString',
      providerSettings: settings,
      registry,
      resolveAddresses: async () => ['1.1.1.1'],
      lifetime: { wallDeadlineAtMs: Date.now() + 60_000 },
    })).resolves.toBeInstanceOf(Map);
  });

  it('collects DNS evidence for bracketed IPv6 endpoints through the unwrapped hostname', async () => {
    const base = providerSettings();
    const settings = ProviderSettingsV1Schema.parse({
      ...base,
      connections: [{
        ...base.connections[0],
        endpointOverrides: [{
          endpointTemplateId: 'responses',
          baseUrl: 'https://[::1]:4873/v1',
        }],
      }],
    });
    const resolvedHostnames: string[] = [];

    const evidence = await collectProviderConnectionDnsEvidence({
      connectionId,
      machineId: 'machine-a',
      providerSettings: settings,
      registry,
      resolveAddresses: async (hostname) => {
        resolvedHostnames.push(hostname);
        return hostname === '::1' ? ['::1'] : ['1.1.1.1'];
      },
      lifetime: { wallDeadlineAtMs: Date.now() + 60_000 },
    });

    expect(resolvedHostnames).toContain('::1');
    expect(resolvedHostnames).not.toContain('[::1]');
    expect(evidence.get('https://[::1]:4873/v1')).toEqual(['::1']);
  });

  it('resolves one exact connection/model/endpoint/transport and mints a non-secret ticket', () => {
    const settings = grantedSettings();
    const prepare = vi.fn(() => ({ v: 1 as const, materialization: 'engineConfig' as const, adapterBindingKey: 'gateway' }));
    const result = resolveProviderSpawnAuthorization({
      selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'model-a' } },
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', agentId: 'codex', accountSettings: accountSettings(settings),
      providerSettings: settings, registry, dnsEvidenceByEndpointUrl: dns, lease: lease(prepare),
    });

    expect(result).toMatchObject({
      ok: true,
      authorization: {
        binding: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          selection: {
            connectionId,
            model: expect.objectContaining({ id: 'model-a', name: 'Model A' }),
          },
          endpoint: { endpointTemplateId: 'responses', protocol: 'openai-responses' },
          runtimeCredentialTransport: { id: 'bearer' },
        },
        support: { authIsolation: { suppressConnectedServiceIds: ['openai-codex'] } },
        credentialReference: { kind: 'apiKey', secretId: 'secret-a' },
        ticket: { connectionRevision: 7, selectedSecretBindingId: 'secret-a' },
        sessionBindingMetadata: {
          v: 1,
          connectionId,
          contributionKey,
          connectionRevision: 7,
          protocol: 'openai-responses',
          materialization: 'engineConfig',
          adapterBindingKey: 'gateway',
          compatibilityFingerprint: expect.any(String),
          bindingSecurityFingerprint: expect.any(String),
          runtimeBindingBasis: {
            v: 1,
            deployment: { kind: 'external' },
            agentTargetKey: 'agent:happier.agent.codex/codex',
            connectionId,
            endpoint: {
              endpointTemplateId: 'responses',
              normalizedUrl: 'https://gateway.example/v1',
              protocol: 'openai-responses',
            },
            credentialAuthorization: {
              connectionSecurityFingerprint: expect.any(String),
              grantFingerprint: expect.any(String),
              selectedSecretBindingId: 'secret-a',
              selectedSecretRecordFingerprint: expect.any(String),
            },
          },
          displaySnapshot: {
            providerName: 'Gateway',
            connectionName: 'Gateway',
            connectionRole: 'default',
            connectionDisplayNameMode: 'automatic',
          },
        },
      },
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('keeps a tools-capable non-reasoning model launchable and carries only the reasoning fact to materialization', () => {
    const settings = grantedSettings();
    const result = resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: 'probe-non-reasoning',
        },
      },
      runtimeModelDescriptor: {
        id: 'probe-non-reasoning',
        name: 'Probe non-reasoning',
        capabilities: {
          toolRoundTrips: 'supported',
          reasoningControls: 'unsupported',
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: dns,
      lease: lease(),
    });

    expect(result).toMatchObject({
      ok: true,
      authorization: {
        binding: {
          selection: {
            connectionId,
            model: expect.objectContaining({
              id: 'probe-non-reasoning',
              capabilities: expect.objectContaining({ reasoningControls: 'unsupported' }),
            }),
          },
        },
      },
    });
  });

  it('refuses a selected model that explicitly lacks the Agent-required tool capability', () => {
    const settings = grantedSettings();
    const result = resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: connectionId,
          modelId: 'probe-no-tools',
        },
      },
      runtimeModelDescriptor: {
        id: 'probe-no-tools',
        name: 'Probe no tools',
        capabilities: {
          toolRoundTrips: 'unsupported',
          reasoningControls: 'unsupported',
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: dns,
      lease: lease(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'provider_incompatible_with_agent' },
    });
  });

  it('refuses stale grants before adapter preparation or secret decryption', () => {
    const prepare = vi.fn(() => ({ v: 1 as const, materialization: 'engineConfig' as const }));
    const settings = providerSettings();
    const result = resolveProviderSpawnAuthorization({
      selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'model-a' } },
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', agentId: 'codex', accountSettings: accountSettings(settings),
      providerSettings: settings, registry, dnsEvidenceByEndpointUrl: dns, lease: lease(prepare),
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'provider_connection_disabled' } });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps imported predecessor Voice Chat models ungranted for executable OpenCode admission', async () => {
    // Genuine predecessor fields: ../0.2 OpenAiCompatVoiceAgentClient reads
    // chatBaseUrl/chatApiKey and directly sends chatModel/commitModel over HTTP.
    // This vector is shared with the Protocol explicit-import owner regression.
    const legacyChat = { chatBaseUrl: 'https://chat.compatibility.test/v1',
      chatModel: 'compatibility-chat', commitModel: 'compatibility-commit' };
    const id = ProviderConnectionIdSchema.parse('voice-openai-compatible-chat');
    const imported = prepareProviderConnectionImportV1(DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, {
      connection: { v: 1, id, role: 'named', displayName: 'Voice OpenAI-compatible Chat',
        displayNameMode: 'custom', deployment: { kind: 'external' }, revision: 0, createdAt: 0, updatedAt: 0,
        source: { kind: 'custom', template: normalizeCustomProviderTemplateV1({
          name: 'Voice OpenAI-compatible Chat', protocol: 'openai-chat', baseUrl: legacyChat.chatBaseUrl,
          credentialStyle: 'bearer', catalog: 'manual',
        }) } },
      secretBindings: { account: { apiKey: formatSharedSavedSecretRefV1('legacy-chat-resource') } },
      manualModels: [legacyChat.chatModel, legacyChat.commitModel].map(modelId => ({ id: modelId, addedAt: 0 })),
    });
    expect(imported.status).toBe('prepared');
    if (imported.status !== 'prepared') throw new Error('Expected the canonical Chat import');
    const providerSettings = composeProviderSettingsV1(imported.catalog, {});
    expect(providerSettings.accountGrants).toEqual([]);
    expect(providerSettings.machineGrants).toEqual([]);
    const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
      pluginIds: ['happier.agent.opencode'],
      resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
        kind: 'development', registeredRootId: `provider-spawn-fixture:${pluginId}`,
        canonicalRoot: rootPath, observedRevision: 1,
      }),
    });
    executableRegistries.push(runtimeRegistry);
    const agentTargetKey = 'agent:happier.agent.opencode/opencode';
    for (const modelId of [legacyChat.chatModel, legacyChat.commitModel]) {
      expect(resolveProviderSpawnAuthorization({
        selection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: id, modelId } },
        machineId: 'machine-a', agentTargetKey, agentId: 'opencode', accountSettings: {}, providerSettings,
        registry: { providersByContributionKey: runtimeRegistry.contributes.providersByContributionKey ?? new Map() },
        dnsEvidenceByEndpointUrl: new Map([[legacyChat.chatBaseUrl, ['1.1.1.1']]]),
        lease: { registry: runtimeRegistry, source: 'active', durableRevision: -1, release: async () => {} },
      })).toMatchObject({ ok: false, error: { code: 'provider_connection_disabled' } });
    }
  });

  it('uses the canonical account grant fingerprint in the ticket', () => {
    const settings = grantedSettings();
    const result = resolveProviderSpawnAuthorization({
      selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'model-a' } },
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', agentId: 'codex', accountSettings: accountSettings(settings),
      providerSettings: settings, registry, dnsEvidenceByEndpointUrl: dns, lease: lease(),
    });
    if (!result.ok) throw new Error('Expected authorization');
    expect(result.authorization.ticket.grantFingerprint)
      .toBe(createProviderAccountGrantFingerprintV1(settings.accountGrants[0]!));
  });

  it('authorizes a current probe descriptor without granting missing catalog-only models freeform authority', () => {
    const catalogOnlyContribution: ResolvedProviderContribution = {
      ...contribution,
      definition: ProviderContributionV1Schema.parse({
        ...definition,
        catalog: { ...definition.catalog, manualModelPolicy: 'catalog-only' },
      }),
    };
    const catalogOnlyRegistry = {
      providersByContributionKey: new Map([[canonicalContributionKey, catalogOnlyContribution]]),
    };
    const settings = grantedSettings(catalogOnlyRegistry);
    const nonFreeformLease = lease(undefined, false);
    const base = {
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry: catalogOnlyRegistry,
      dnsEvidenceByEndpointUrl: dns,
      lease: nonFreeformLease,
    } as const;

    const active = resolveProviderSpawnAuthorization({
      ...base,
      selection: {
        v: 1,
        updatedAt: 1,
        ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'probe-only' },
      },
      runtimeModelDescriptor: {
        id: 'probe-only',
        name: 'Probe only',
        capabilities: { toolRoundTrips: 'supported' },
      },
    });
    if (!active.ok) throw new Error(`Expected current probe authorization, received ${active.error.code}`);
    expect(active).toMatchObject({
      ok: true,
      authorization: {
        binding: {
          selection: {
            connectionId,
            model: expect.objectContaining({ id: 'probe-only', name: 'Probe only' }),
          },
        },
      },
    });

    const missing = resolveProviderSpawnAuthorization({
      ...base,
      selection: {
        v: 1,
        updatedAt: 1,
        ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'disappeared' },
      },
    });
    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'provider_model_not_found', action: 'choose_model' },
    });
  });

  it('preserves configured manual and two-sided freeform model authority', () => {
    const settings = ProviderSettingsV1Schema.parse({
      ...grantedSettings(),
      manualModelsByConnectionId: {
        pc_gateway: [{ id: 'manual-model', name: 'Manual model', addedAt: 1 }],
      },
    });
    const authorize = (modelId: string) => resolveProviderSpawnAuthorization({
      selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId } },
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', agentId: 'codex', accountSettings: accountSettings(settings),
      providerSettings: settings, registry, dnsEvidenceByEndpointUrl: dns, lease: lease(),
    });

    expect(authorize('manual-model')).toMatchObject({
      ok: false,
      error: { code: 'provider_compatibility_unverified' },
    });
    expect(authorize('freeform-model')).toMatchObject({
      ok: false,
      error: { code: 'provider_compatibility_unverified' },
    });
  });

  it('never reads inherited manual-model rows for legal prototype-name connection ids', () => {
    const inheritedNameConnectionId = ProviderConnectionIdSchema.parse('toString');
    const settings = grantedSettingsForConnection(inheritedNameConnectionId);

    expect(() => resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: inheritedNameConnectionId,
          modelId: 'freeform-model',
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: dns,
      lease: lease(),
    })).not.toThrow();
  });

  it('refuses an exact configured target mismatch even when both targets share one runtime agent adapter', () => {
    const settings = grantedSettings();
    const result = resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'backend:codex:configured:work',
          providerConnectionId: connectionId,
          modelId: 'model-a',
        },
      },
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex:configured:personal',
      agentId: 'codex',
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: dns,
      lease: lease(),
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'provider_incompatible_with_agent' } });
  });
});

describe('shared provider probe authorization resolver', () => {
  it.each(['machine-a', 'machine-b'])('G1 authorizes the managed catalog only on the saved gateway machine %s', gatewayMachineId => {
    const settings = managedGrantedSettings(managedRegistry, gatewayMachineId);
    const purposeBindings = {
      v: 1 as const,
      bindings: [{
        purpose: {
          consumer: { pluginId: 'acme.gateway', localId: 'gateway' },
          purpose: 'upstream',
        },
        target: {
          kind: 'account' as const,
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      }],
    };
    const managedRuntime = resolveProviderManagedRuntimeDeclarationV1({
      implementationIdentity: managedContribution.identity,
      managedRuntime: managedContribution.definition.managedRuntime!,
    });
    const request = {
      deployment: 'managedLocal' as const,
      connectionId,
      machineId: 'machine-a',
      implementationIdentity: managedContribution.identity,
      managedRuntime,
      purposeBindings,
      endpointTemplateId: 'responses',
      protocol: 'openai-responses' as const,
      sourceRegistryVersion: 'gateway-registry:v1',
      path: '/models',
      parser: 'openai-models' as const,
      probeRequestFingerprint: createProviderManagedProbeRequestFingerprintV1({
        implementationIdentity: managedContribution.identity,
        managedRuntime,
        purposeBindings,
        endpointTemplateId: 'responses',
        protocol: 'openai-responses',
        sourceRegistryVersion: 'gateway-registry:v1',
        method: 'GET',
        path: '/models',
        parser: 'openai-models',
        publicHeaders: {},
      }),
    };
    const result = resolveProviderProbeAuthorization({
      request,
      accountSettings: { providerSettingsV1: settings },
      providerSettings: settings,
      registry: managedRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
      managedPurposeBindingSnapshot: purposeBindings,
    });

    if (gatewayMachineId !== request.machineId) {
      expect(result).toMatchObject({ ok: false, error: { code: 'provider_not_enabled_on_machine' } });
      return;
    }

    expect(result).toMatchObject({
      ok: true,
      ticket: {
        deployment: 'managedLocal',
        connectionId,
        connectionRevision: 7,
        machineId: 'machine-a',
        endpointTemplateId: 'responses',
        implementationIdentity: managedContribution.identity,
        managedRuntime,
      },
      credentialRef: null,
      observationAuthorizationFingerprint: expect.stringMatching(
        /^observation-authorization:v1:/,
      ),
    });
    expect(result).not.toHaveProperty('ticket.endpointUrl');
  });

  it('binds the declared managed endpoint public header into the expected probe request fingerprint', () => {
    const headerManagedContribution: ResolvedProviderContribution = {
      ...managedContribution,
      definition: ProviderContributionV1Schema.parse({
        ...managedContribution.definition,
        endpointTemplates: managedContribution.definition.endpointTemplates.map((template) => ({
          ...template,
          publicHeaders: { 'x-route': 'tenant-a' },
        })),
      }),
    };
    const declaredHeaders = headerManagedContribution.definition.endpointTemplates[0]?.publicHeaders;
    if (!declaredHeaders) throw new Error('Expected the fixture to declare public headers');
    const headerManagedRegistry = {
      providersByContributionKey: new Map([[canonicalContributionKey, headerManagedContribution]]),
    };
    const settings = managedGrantedSettings(headerManagedRegistry);
    const purposeBindings = {
      v: 1 as const,
      bindings: [{
        purpose: {
          consumer: { pluginId: 'acme.gateway', localId: 'gateway' },
          purpose: 'upstream',
        },
        target: {
          kind: 'account' as const,
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      }],
    };
    const managedRuntime = resolveProviderManagedRuntimeDeclarationV1({
      implementationIdentity: headerManagedContribution.identity,
      managedRuntime: headerManagedContribution.definition.managedRuntime!,
    });
    const request = (publicHeaders: Readonly<Record<string, string>>) => ({
      deployment: 'managedLocal' as const,
      connectionId,
      machineId: 'machine-a',
      implementationIdentity: headerManagedContribution.identity,
      managedRuntime,
      purposeBindings,
      endpointTemplateId: 'responses',
      protocol: 'openai-responses' as const,
      sourceRegistryVersion: 'gateway-registry:v1',
      path: '/models',
      parser: 'openai-models' as const,
      probeRequestFingerprint: createProviderManagedProbeRequestFingerprintV1({
        implementationIdentity: headerManagedContribution.identity,
        managedRuntime,
        purposeBindings,
        endpointTemplateId: 'responses',
        protocol: 'openai-responses',
        sourceRegistryVersion: 'gateway-registry:v1',
        method: 'GET',
        path: '/models',
        parser: 'openai-models',
        publicHeaders,
      }),
    });
    const authorize = (publicHeaders: Readonly<Record<string, string>>) =>
      resolveProviderProbeAuthorization({
        request: request(publicHeaders),
        accountSettings: { providerSettingsV1: settings },
        providerSettings: settings,
        registry: headerManagedRegistry,
        dnsEvidenceByEndpointUrl: new Map(),
        managedPurposeBindingSnapshot: purposeBindings,
      });

    expect(authorize(declaredHeaders)).toMatchObject({ ok: true });
    expect(authorize({})).toMatchObject({
      ok: false,
      error: { code: 'provider_probe_authorization_invalid' },
    });
  });

  it('uses the same connection grant and SavedSecret identity without requiring an agent', () => {
    const settings = grantedSettings();
    const result = resolveProviderProbeAuthorization({
      request: {
        connectionId,
        machineId: 'machine-a',
        endpointTemplateId: 'responses',
        endpointUrl: 'https://gateway.example/v1',
        protocol: 'openai-responses',
        path: '/models',
        parser: 'openai-models',
        probeRequestFingerprint: createProviderProbeRequestFingerprintV1({
          method: 'GET', endpointUrl: 'https://gateway.example/v1', path: '/models',
          parser: 'openai-models', publicHeaders: {},
        }),
      },
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: dns,
    });

    expect(result).toMatchObject({
      ok: true,
      ticket: {
        connectionId,
        connectionRevision: 7,
        endpointTemplateId: 'responses',
        selectedSecretBindingId: 'secret-a',
      },
      credentialRef: { reference: { kind: 'apiKey', secretId: 'secret-a' }, transport: { id: 'bearer' } },
      observationAuthorizationFingerprint: expect.stringMatching(/^observation-authorization:v1:/),
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it.each([
    {
      label: 'an undeclared path and parser request',
      path: '/other-models',
      parser: 'ollama-tags' as const,
      fingerprintPath: '/other-models',
      fingerprintParser: 'ollama-tags' as const,
    },
    {
      label: 'a supplied fingerprint that does not match the declared request',
      path: '/models',
      parser: 'openai-models' as const,
      fingerprintPath: '/different',
      fingerprintParser: 'openai-models' as const,
    },
  ])('refuses $label before returning a credential reference', ({ path, parser, fingerprintPath, fingerprintParser }) => {
    const settings = grantedSettings();
    const result = resolveProviderProbeAuthorization({
      request: {
        connectionId,
        machineId: 'machine-a',
        endpointTemplateId: 'responses',
        endpointUrl: 'https://gateway.example/v1',
        protocol: 'openai-responses',
        path,
        parser,
        probeRequestFingerprint: createProviderProbeRequestFingerprintV1({
          method: 'GET',
          endpointUrl: 'https://gateway.example/v1',
          path: fingerprintPath,
          parser: fingerprintParser,
          publicHeaders: {},
        }),
      },
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: dns,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'provider_probe_authorization_invalid' },
    });
    expect(result).not.toHaveProperty('credentialRef');
  });

  it('fails closed instead of choosing the first of multiple matching probe transports', () => {
    const ambiguousDefinition = ProviderContributionV1Schema.parse({
      ...definition,
      credential: {
        ...definition.credential,
        transports: [
          ...definition.credential!.transports,
          {
            id: 'second-bearer',
            protocols: ['openai-responses'],
            uses: ['probe'],
            destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
          },
        ],
      },
    });
    const ambiguousRegistry = {
      providersByContributionKey: new Map([[canonicalContributionKey, { ...contribution, definition: ambiguousDefinition }]]),
    };
    const initial = providerSettings();
    const ungranted = resolveProviderConnectionForMachine({
      connectionId,
      machineId: 'machine-a',
      providerSettings: initial,
      registry: ambiguousRegistry,
      dnsEvidenceByEndpointUrl: dns,
    });
    if (ungranted.status !== 'resolved') throw new Error('Expected ambiguous connection');
    const settings = ProviderSettingsV1Schema.parse({
      ...initial,
      accountGrants: [{
        v: 1,
        connectionId,
        connectionSecurityFingerprint: ungranted.record.connectionSecurityFingerprint,
        confirmedAt: 1,
      }],
      secretBindingsByConnectionId: { pc_gateway: { account: { apiKey: 'secret-a' } } },
    });
    const result = resolveProviderProbeAuthorization({
      request: {
        connectionId,
        machineId: 'machine-a',
        endpointTemplateId: 'responses',
        endpointUrl: 'https://gateway.example/v1',
        protocol: 'openai-responses',
        path: '/models',
        parser: 'openai-models',
        probeRequestFingerprint: createProviderProbeRequestFingerprintV1({
          method: 'GET', endpointUrl: 'https://gateway.example/v1', path: '/models',
          parser: 'openai-models', publicHeaders: {},
        }),
      },
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry: ambiguousRegistry,
      dnsEvidenceByEndpointUrl: dns,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'provider_credential_transport_unavailable' },
    });
  });
});

describe('provider model-load authorization resolver', () => {
  const localContributionKey = 'happier.provider.lmstudio/lmstudio';
  const canonicalLocalContributionKey = 'happier.provider.lmstudio/lmstudio';
  const localDefinition = ProviderContributionV1Schema.parse({
    v: 1,
    id: 'lmstudio',
    name: 'LM Studio',
    kind: 'local',
    endpointTemplates: [{
      id: 'openai',
      protocol: 'openai-chat',
      localUrlCandidates: ['http://127.0.0.1:1234/'],
      capabilities: {
        streaming: 'unknown', toolRoundTrips: 'unknown',
        statefulResponses: 'unknown', reasoningControls: 'unknown',
      },
    }],
    credential: {
      kind: 'apiKey',
      required: false,
      transports: [{
        id: 'management-bearer',
        protocols: ['openai-chat'],
        uses: ['management'],
        destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
      }],
    },
    catalog: {
      source: 'probe',
      manualModelPolicy: 'allowed',
      probes: [{ endpointTemplateId: 'openai', path: '/api/v1/models', parser: 'lmstudio-native-models' }],
    },
    modelLoad: {
      endpointTemplateId: 'openai',
      path: '/api/v1/models/load',
      request: 'json-model-id-v1',
      confirmation: 'refresh-catalog-load-state',
      preflightPolicy: 'advisory',
    },
  });
  const localContribution: ResolvedProviderContribution = {
      provenance: 'external',
      source: { kind: 'path' },
      pluginId: 'happier.provider.lmstudio',
      identity: { pluginId: 'happier.provider.lmstudio', localId: 'lmstudio' },
      definition: localDefinition,
  };
  const localRegistry = {
    providersByContributionKey: new Map([[canonicalLocalContributionKey, localContribution]]),
  };

  function localGrantedSettings(): ProviderSettingsV1 {
    const initial = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: 'pc_local',
        source: { kind: 'contribution', contributionKey: localContributionKey },
        role: 'default',
        displayName: 'LM Studio',
        displayNameMode: 'automatic',
        revision: 11,
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    const resolution = resolveProviderConnectionForMachine({
      connectionId: 'pc_local',
      machineId: 'machine-a',
      providerSettings: initial,
      registry: localRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (resolution.status !== 'resolved') throw new Error('Expected local connection');
    const grant = {
      v: 1 as const,
      machineId: 'machine-a',
      connectionId: ProviderConnectionIdSchema.parse('pc_local'),
      endpointSetFingerprint: resolution.record.endpointSetFingerprint,
      connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      confirmedAt: 1,
    };
    expect(createProviderMachineGrantFingerprintV1(grant)).toMatch(/^machine-grant:v1:/);
    return ProviderSettingsV1Schema.parse({ ...initial, machineGrants: [grant] });
  }

  it('authorizes only a trusted local contribution descriptor and exact management transport', () => {
    const settings = localGrantedSettings();
    const result = resolveProviderModelLoadAuthorization({
      request: { connectionId: 'pc_local', machineId: 'machine-a', modelId: 'model-a' },
      accountSettings: { providerSettingsV1: settings },
      providerSettings: settings,
      registry: localRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
    });

    expect(result).toMatchObject({
      status: 'authorized',
      authorization: {
        source: 'trusted_local_contribution',
        descriptor: { endpointTemplateId: 'openai', path: '/api/v1/models/load' },
        endpoint: { endpointTemplateId: 'openai', endpointUrl: 'http://127.0.0.1:1234/' },
        ticket: { connectionId: 'pc_local', connectionRevision: 11, machineId: 'machine-a', modelId: 'model-a' },
        credentialRef: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('returns unavailable without minting a fake trusted-local authorization for non-local sources', () => {
    const settings = grantedSettings();
    expect(resolveProviderModelLoadAuthorization({
      request: { connectionId, machineId: 'machine-a', modelId: 'model-a' },
      accountSettings: accountSettings(settings),
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: dns,
    })).toEqual({ status: 'unavailable' });
  });
});
