import { describe, expect, it, vi } from 'vitest';
import {
  ProviderConnectionIdSchema,
  ProviderConnectionV1Schema,
  ProviderContributionV1Schema,
  type ProviderWireProtocol,
} from '@happier-dev/protocol';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ResolvedProviderConnectionRecord } from '@/providers/registry';

import { projectProviderConnectionCompatibility } from './compatibility';

const contributionKey = 'acme.gateway/main';

function lease(externalAgentProtocol?: ProviderWireProtocol): PluginRuntimeRegistryLease {
  const support = (protocol: ProviderWireProtocol) => ({
    acceptsProtocols: [protocol],
    required: { streaming: true },
    credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
    authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
    materialization: 'spawnEnv' as const,
    applyPolicy: 'restart_session' as const,
    supportsFreeformModelIds: true,
  });
  const adapter = {
    v: 1 as const,
    adapterVersion: 1,
    prepare: () => ({ v: 1 as const, materialization: 'spawnEnv' as const }),
    materialize: async () => ({ v: 1 as const, kind: 'spawnEnv' as const, env: [] }),
  };
  const definitions = new Map([
    ['codex', { definition: { id: 'codex', kindVersion: 1, providerRequirements: support('openai-responses') }, runtimeSpec: { title: 'Codex' } }],
    ['claude', { definition: { id: 'claude', kindVersion: 1, providerRequirements: support('anthropic') }, runtimeSpec: { title: 'Claude' } }],
    ['inactive', {
      definition: { id: 'inactive', kindVersion: 1, providerRequirements: support('openai-responses') },
      runtimeSpec: { title: 'Inactive supported Agent' },
    }],
    ['external', {
      definition: {
        id: 'external',
        kindVersion: 1,
        ...(externalAgentProtocol ? { providerRequirements: support(externalAgentProtocol) } : {}),
      },
      ...(externalAgentProtocol ? { runtimeSpec: { title: 'External Agent' } } : {}),
      richDefinition: {
        provenance: 'external' as const,
        definition: { id: 'external', title: { key: 'agents.external.title', fallback: 'External Agent' } },
      },
    }],
    ['gemini', { definition: { id: 'gemini', kindVersion: 1 }, runtimeSpec: { title: 'Gemini' } }],
  ]);
  const runtimes = new Map([...['codex', 'claude'], ...(externalAgentProtocol ? ['external'] : [])].map((agentId) => [agentId, {
    pluginId: `happier.agent.${agentId}`,
    pluginVersion: '1.0.0',
    agentId,
    generation: 'fixture-generation',
    providerBinding: adapter,
    isCurrent: () => true,
    retirementSignal: new AbortController().signal,
    createRuntime: vi.fn(async () => ({})),
  }]));
  const registry = {
    contributes: { agentDefinitionsById: definitions },
    agentRuntimesByAgentId: runtimes,
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  return { registry, source: 'active', release: async () => undefined };
}

function record(options: Readonly<{
  protocol?: ProviderWireProtocol;
  overrideAgentTargetKey?: string;
}> = {}): ResolvedProviderConnectionRecord {
  const protocol = options.protocol ?? 'openai-responses';
  const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
  const definition = ProviderContributionV1Schema.parse({
    v: 1, id: 'main', name: 'Gateway', kind: 'cloud',
    endpointTemplates: [{
      id: 'responses', protocol, baseUrl: 'https://gateway.example/v1',
      capabilities: { streaming: 'supported', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
    }],
    catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    compatibilityOverrides: [{
      agentTargetKey: options.overrideAgentTargetKey ?? 'backend:codex', protocol, status: 'verified',
      reason: 'Integration tested',
      evidence: { sourceUrls: ['https://docs.example.test/codex'], verifiedAt: '2026-07-11', testIds: ['codex-provider-live'] },
    }],
  });
  const connection = ProviderConnectionV1Schema.parse({
      v: 1, id: connectionId, source: { kind: 'contribution', contributionKey }, role: 'default',
      displayName: 'Gateway', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
  });
  return {
    v: 1, connectionId, machineId: 'machine-a',
    connection,
    displayName: 'Gateway',
    source: { kind: 'contribution', contributionKey, pluginId: 'acme.gateway', provenance: 'external', definition },
    deployment: { kind: 'external' },
    endpoints: [{
      endpointTemplateId: 'responses', protocol, publicHeaders: {}, source: 'contribution',
      machineOverrideApplied: false, normalizedUrl: 'https://gateway.example/v1', locality: 'public',
      endpointScope: 'account', resolvedAddresses: ['8.8.8.8'], nonPublicAddresses: [],
    }],
    scope: 'account', connectionSecurityFingerprint: 'connection-security:v1:test',
    endpointSetFingerprint: 'endpoint-set:v1:test',
    authorization: {
      authorized: true,
      grantKind: 'account',
      grantFingerprint: 'grant:v1:test',
      grantConfirmedAt: 1,
    },
  };
}

describe('provider connection compatibility summary', () => {
  it('uses the leased executable adapter and canonical compatibility resolver per agent', () => {
    expect(projectProviderConnectionCompatibility({ lease: lease(), connection: record() })).toEqual([
      { agentTargetKey: 'backend:claude', agentName: 'Claude', status: 'incompatible', reasons: ['no_compatible_protocol'] },
      { agentTargetKey: 'backend:codex', agentName: 'Codex', status: 'verified', reasons: [] },
      { agentTargetKey: 'backend:external', agentName: 'External Agent', status: 'incompatible', reasons: ['agent_external_providers_unsupported'] },
      { agentTargetKey: 'backend:gemini', agentName: 'Gemini', status: 'incompatible', reasons: ['agent_external_providers_unsupported'] },
    ]);
  });

  it('binds an external Provider and external Agent on a wire protocol the host does not bundle', () => {
    // `acme-wire` is contributed by plugins on both sides. The host never
    // interprets a wire protocol - it only matches the two declarations - so a
    // bundled protocol vocabulary must not decide whether the pair can bind.
    const summaries = projectProviderConnectionCompatibility({
      lease: lease('acme-wire'),
      connection: record({ protocol: 'acme-wire', overrideAgentTargetKey: 'backend:external' }),
    });
    expect(summaries).toContainEqual({
      agentTargetKey: 'backend:external', agentName: 'External Agent', status: 'verified', reasons: [],
    });
    expect(summaries.filter((summary) => summary.status !== 'incompatible')).toHaveLength(1);
  });
});
