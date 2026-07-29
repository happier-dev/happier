import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderSettingsV1Schema,
  createProviderAccountGrantFingerprintV1,
  resolveProviderBindingCompatibilityWithFingerprintV1,
  type AgentProviderRequirementsV1,
  type ProviderModelDescriptorV1,
} from '@happier-dev/protocol';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '@happier-dev/plugins-cliproxyapi';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { resolveProviderConnectionForMachine } from '../registry';
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
});
