import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  AgentProviderRequirementsV1Schema,
  ProviderConnectionIdSchema,
  ProviderSettingsV1Schema,
  createProviderAccountGrantFingerprintV1,
  encryptSecretStringV1,
  resolveProviderBindingCompatibilityWithFingerprintV1,
  type AgentProviderRequirementsV1,
  type ProviderModelDescriptorV1,
} from '@happier-dev/protocol';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '@happier-dev/plugins-cliproxyapi';
import {
  CLAUDE_PROVIDER_BINDING_ADAPTER_V1,
  PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-claude';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { materializeLeasedAgentProviderBinding } from '@/plugins/runtime/providerBindings/adapter';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { resolveProviderConnectionForMachine } from '../registry';
import { createProviderSpawnAuthorizationAttempt } from './authorize';
import { resolveProviderCredentialPlaintext } from './credentials';
import { resolveProviderSpawnAuthorization } from './resolve';

const contributionKey = 'happier.provider.cliproxyapi/cliproxyapi';
const connectionId = ProviderConnectionIdSchema.parse('pc_cliproxyapi_remote');
const agentTargetKey = 'agent:codex';
const model: ProviderModelDescriptorV1 = {
  id: 'catalog-codex-model',
  name: 'Catalog Codex Model',
  capabilities: {
    toolRoundTrips: 'supported',
    reasoningControls: 'supported',
  },
};
const dnsEvidenceByEndpointUrl = new Map([
  ['https://gateway.example/v1', ['1.1.1.1']],
  ['https://gateway.example/', ['1.1.1.1']],
]);
const support: AgentProviderRequirementsV1 = {
  acceptsProtocols: ['openai-responses'],
  required: { streaming: true, toolRoundTrips: true },
  credentialSupport: {
    supportsNoAuth: true,
    apiKeyTransports: [{
      protocol: 'openai-responses',
      destination: {
        kind: 'httpHeader',
        names: 'anyValidated',
        formats: ['raw', 'bearer'],
      },
    }],
  },
  authIsolation: {
    suppressConnectedServiceIds: ['openai-codex', 'openai'],
    ownedEnvKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY'],
  },
  materialization: 'engineConfig',
  applyPolicy: 'restart_session',
  supportsFreeformModelIds: true,
};
const contribution: ResolvedProviderContribution = {
  provenance: 'first_party',
  source: { kind: 'bundled' },
  pluginId: 'happier.provider.cliproxyapi',
  identity: {
    pluginId: 'happier.provider.cliproxyapi',
    localId: 'cliproxyapi',
  },
  definition: CLIPROXYAPI_PROVIDER_CONTRIBUTION,
};
const registry = {
  providersByContributionKey: new Map([[contributionKey, contribution]]),
};

function lease(input: Readonly<{
  support: AgentProviderRequirementsV1;
  prepare: ReturnType<typeof vi.fn>;
}>): PluginRuntimeRegistryLease {
  const registry = {
    contributes: {
      agentDefinitionsById: new Map([[
        'codex',
        {
          definition: {
            id: 'codex',
            kindVersion: 1,
            providerRequirements: input.support,
          },
        },
      ]]),
    },
    agentRuntimesByAgentId: new Map([[
      'codex',
      {
        pluginId: 'happier.agent.codex',
        pluginVersion: '1.0.0',
        agentId: 'codex',
        generation: 'cliproxyapi-test-generation',
        providerBinding: {
          v: 1,
          adapterVersion: 3,
          prepare: input.prepare,
          materialize: vi.fn(async () => ({
            v: 1,
            kind: 'engineConfig',
            env: [],
            engineConfig: {},
          })),
        },
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        createRuntime: vi.fn(),
      },
    ]]),
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  return {
    registry,
    source: 'active',
    release: vi.fn(async () => undefined),
  };
}

function claudeLease(): PluginRuntimeRegistryLease {
  const definition = (CLAUDE_PLUGIN_MANIFEST.contributes.agents ?? [])[0];
  if (!definition) throw new Error('Claude Agent definition is unavailable');
  const registry = {
    contributes: {
      agentDefinitionsById: new Map([['claude', { definition }]]),
    },
    agentRuntimesByAgentId: new Map([[
      'claude',
      {
        pluginId: 'happier.agent.claude',
        pluginVersion: '1.0.0',
        agentId: 'claude',
        generation: 'cliproxyapi-external-anthropic-test-generation',
        providerBinding: CLAUDE_PROVIDER_BINDING_ADAPTER_V1,
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        createRuntime: vi.fn(),
      },
    ]]),
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  return {
    registry,
    source: 'active',
    release: vi.fn(async () => undefined),
  };
}

describe('CLIProxyAPI ordinary Provider binding', () => {
  it('launches a catalog model through the real contribution and exact Codex binding', () => {
    expect(contribution.definition).toMatchObject({
      id: 'cliproxyapi',
      kind: 'aggregator',
    });

    const initialSettings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: connectionId,
        source: { kind: 'contribution', contributionKey },
        role: 'default',
        displayName: 'Remote CLIProxyAPI',
        displayNameMode: 'custom',
        endpointOverrides: [
          {
            endpointTemplateId: 'cliproxyapi-openai-responses',
            baseUrl: 'https://gateway.example/v1',
          },
          {
            endpointTemplateId: 'cliproxyapi-openai-chat',
            baseUrl: 'https://gateway.example/v1',
          },
          {
            endpointTemplateId: 'cliproxyapi-anthropic',
            baseUrl: 'https://gateway.example',
          },
        ],
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    const initialResolution = resolveProviderConnectionForMachine({
      connectionId,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: initialSettings },
      registry,
      dnsEvidenceByEndpointUrl,
    });
    if (initialResolution.status !== 'resolved') {
      throw new Error(`Expected CLIProxyAPI connection resolution, received ${initialResolution.status}`);
    }

    const compatibility = resolveProviderBindingCompatibilityWithFingerprintV1({
      agentTargetKey,
      adapterVersion: 3,
      endpoints: CLIPROXYAPI_PROVIDER_CONTRIBUTION.endpointTemplates,
      credential: CLIPROXYAPI_PROVIDER_CONTRIBUTION.credential,
      agent: support,
      model,
    });
    expect(compatibility.result).toMatchObject({
      status: 'experimental',
      selectedProtocol: 'openai-responses',
      confirmationScope: { kind: 'connection' },
    });

    const settings = ProviderSettingsV1Schema.parse({
      ...initialSettings,
      accountGrants: [{
        v: 1,
        connectionId,
        connectionSecurityFingerprint: initialResolution.record.connectionSecurityFingerprint,
        confirmedAt: 2,
      }],
      experimentalBindingConfirmations: [{
        v: 1,
        connectionId,
        agentTargetKey,
        modelId: null,
        compatibilityFingerprint: compatibility.compatibilityFingerprint,
        confirmedAt: 2,
      }],
    });
    const prepare = vi.fn(() => ({
      v: 1 as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'cliproxyapi',
    }));

    const result = resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 2,
        ref: {
          agentTargetKey,
          providerConnectionId: connectionId,
          modelId: model.id,
        },
      },
      runtimeModelDescriptor: model,
      machineId: 'machine-a',
      agentTargetKey,
      agentId: 'codex',
      accountSettings: { providerSettingsV1: settings },
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl,
      lease: lease({ support, prepare }),
    });

    expect(result).toMatchObject({
      ok: true,
      authorization: {
        binding: {
          agentTargetKey,
          selection: {
            connectionId,
            model: {
              id: model.id,
              name: model.name,
            },
          },
          endpoint: {
            endpointTemplateId: 'cliproxyapi-openai-responses',
            protocol: 'openai-responses',
            normalizedUrl: 'https://gateway.example/v1',
          },
        },
        credentialReference: { kind: 'none' },
        support: { materialization: 'engineConfig' },
        sessionBindingMetadata: {
          connectionId,
          contributionKey,
          protocol: 'openai-responses',
          materialization: 'engineConfig',
          adapterBindingKey: 'cliproxyapi',
        },
      },
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(createProviderAccountGrantFingerprintV1(settings.accountGrants[0]!))
      .toBe(result.ok ? result.authorization.ticket.grantFingerprint : '');
  });

  it('keeps external Anthropic on ordinary endpoint and Saved Secret materialization without managed request auth', async () => {
    const claudeDefinition = (CLAUDE_PLUGIN_MANIFEST.contributes.agents ?? [])[0];
    if (!claudeDefinition?.providerRequirements) {
      throw new Error('Claude Provider requirements are unavailable');
    }
    const claudeSupport = AgentProviderRequirementsV1Schema.parse(
      claudeDefinition.providerRequirements,
    );
    const claudeModel: ProviderModelDescriptorV1 = {
      id: 'claude-sonnet-through-external-cliproxyapi',
      name: 'Claude Sonnet through external CLIProxyAPI',
      capabilities: {
        toolRoundTrips: 'supported',
        reasoningControls: 'supported',
      },
    };
    const settingsSecretReadKey = new Uint8Array(32).fill(7);
    const encryptedValue = encryptSecretStringV1(
      'external-anthropic-secret',
      settingsSecretReadKey,
      (length) => new Uint8Array(length).fill(3),
    );
    const secrets = [{
      id: 'secret-external-anthropic',
      encryptedValue: { _isSecretValue: true as const, encryptedValue },
    }];
    const initialSettings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: connectionId,
        source: { kind: 'contribution', contributionKey },
        role: 'default',
        displayName: 'External CLIProxyAPI',
        displayNameMode: 'custom',
        endpointOverrides: [
          {
            endpointTemplateId: 'cliproxyapi-openai-responses',
            baseUrl: 'https://gateway.example/v1',
          },
          {
            endpointTemplateId: 'cliproxyapi-openai-chat',
            baseUrl: 'https://gateway.example/v1',
          },
          {
            endpointTemplateId: 'cliproxyapi-anthropic',
            baseUrl: 'https://gateway.example',
          },
        ],
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
      secretBindingsByConnectionId: {
        [connectionId]: {
          account: { apiKey: 'secret-external-anthropic' },
        },
      },
    });
    const initialResolution = resolveProviderConnectionForMachine({
      connectionId,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: initialSettings, secrets },
      registry,
      dnsEvidenceByEndpointUrl,
    });
    if (initialResolution.status !== 'resolved') {
      throw new Error(`Expected external CLIProxyAPI resolution, received ${initialResolution.status}`);
    }
    const compatibility = resolveProviderBindingCompatibilityWithFingerprintV1({
      agentTargetKey: 'agent:claude',
      adapterVersion: CLAUDE_PROVIDER_BINDING_ADAPTER_V1.adapterVersion,
      endpoints: CLIPROXYAPI_PROVIDER_CONTRIBUTION.endpointTemplates,
      credential: CLIPROXYAPI_PROVIDER_CONTRIBUTION.credential,
      agent: claudeSupport,
      model: claudeModel,
    });
    expect(compatibility.result).toMatchObject({
      selectedProtocol: 'anthropic',
    });
    const settings = ProviderSettingsV1Schema.parse({
      ...initialSettings,
      accountGrants: [{
        v: 1,
        connectionId,
        connectionSecurityFingerprint:
          initialResolution.record.connectionSecurityFingerprint,
        confirmedAt: 2,
      }],
      experimentalBindingConfirmations: [{
        v: 1,
        connectionId,
        agentTargetKey: 'agent:claude',
        modelId: null,
        compatibilityFingerprint: compatibility.compatibilityFingerprint,
        confirmedAt: 2,
      }],
    });
    const runtimeLease = claudeLease();
    const result = resolveProviderSpawnAuthorization({
      selection: {
        v: 1,
        updatedAt: 2,
        ref: {
          agentTargetKey: 'agent:claude',
          providerConnectionId: connectionId,
          modelId: claudeModel.id,
        },
      },
      runtimeModelDescriptor: claudeModel,
      machineId: 'machine-a',
      agentTargetKey: 'agent:claude',
      agentId: 'claude',
      accountSettings: { providerSettingsV1: settings, secrets },
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl,
      lease: runtimeLease,
    });
    if (!result.ok || result.authorization.deployment.kind !== 'external') {
      throw new Error('Expected ordinary external Provider authorization');
    }
    expect(result.authorization).toMatchObject({
      deployment: { kind: 'external' },
      binding: {
        endpoint: {
          endpointTemplateId: 'cliproxyapi-anthropic',
          protocol: 'anthropic',
          normalizedUrl: 'https://gateway.example/',
        },
        runtimeCredentialTransport: {
          destination: {
            kind: 'httpHeader',
            name: 'Authorization',
            format: 'bearer',
          },
        },
      },
      credentialReference: {
        kind: 'apiKey',
        secretId: 'secret-external-anthropic',
      },
    });

    const credential = resolveProviderCredentialPlaintext({
      reference: result.authorization.credentialReference,
      accountSettings: { providerSettingsV1: settings, secrets },
      settingsSecretsReadKeys: [settingsSecretReadKey],
      connectionId,
      machineId: 'machine-a',
    });
    if (!credential.ok) throw new Error('Expected external Saved Secret resolution');
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial: result.authorization,
      revalidate: async () => result,
      resolveCredential: () => credential,
      materialize: ({ authorization, binding, credential: resolvedCredential }) =>
        materializeLeasedAgentProviderBinding({
          lease: runtimeLease,
          agentId: 'claude',
          binding,
          prepared: authorization.prepared,
          credential: resolvedCredential,
        }),
      materializationBaseDir: '/unused',
      sessionId: 'session-external-anthropic',
    });
    if (attempt.deployment.kind !== 'external') {
      throw new Error('Expected ordinary external Provider materialization attempt');
    }
    if (!('materializeAfterHooks' in attempt)) {
      throw new Error('Expected external Provider materialization operation');
    }
    const materialized = await attempt.materializeAfterHooks();
    if (!materialized.ok) throw new Error('Expected external Claude materialization');
    const materialization = materialized.materialization;
    expect(materialization).toMatchObject({
      launchMaterialization: { kind: 'spawnEnv' },
      providerEnvironmentOverlay: expect.arrayContaining([
        {
          name: 'ANTHROPIC_BASE_URL',
          value: 'https://gateway.example/',
          source: 'provider',
        },
        {
          name: 'ANTHROPIC_AUTH_TOKEN',
          value: 'external-anthropic-secret',
          source: 'provider',
        },
      ]),
    });
    expect(JSON.stringify({ authorization: result.authorization, materialization }))
      .not.toMatch(/request[_-]?auth|capability[_-]?path/iu);
  });
});
