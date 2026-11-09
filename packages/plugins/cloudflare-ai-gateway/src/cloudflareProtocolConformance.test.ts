import { describe, expect, it } from 'vitest';
import type { AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';
import { ProviderContributionV1Schema } from '@happier-dev/plugin-sdk/providers';
import { resolveEffectiveProviderEndpointV1 } from '../../../protocol/src/providers/connections/effectiveEndpointV1.js';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { projectAccountProviderModelsV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';
import { resolveProviderBindingCompatibilityWithFingerprintV1, selectProviderRuntimeCredentialTransportV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { PLUGIN_MANIFEST as CODEX_MANIFEST } from '../../codex/src/manifest.js';
import { CODEX_PROVIDER_BINDING_ADAPTER_V1 as adapter } from '../../codex/src/agent/providerBinding/adapter.js';
import { PLUGIN_MANIFEST as OPENCODE_MANIFEST } from '../../opencode/src/manifest.js';
import { OPENCODE_PROVIDER_BINDING_ADAPTER_V1 as openCodeAdapter } from '../../opencode/src/agent/providerBinding/adapter.js';
import { DROID_PLUGIN } from '../../droid/src/manifest.js';
import { PLUGIN_MANIFEST as KILO_MANIFEST } from '../../kilo/src/manifest.js';
import { PLUGIN_MANIFEST as COPILOT_MANIFEST } from '../../copilot/src/manifest.js';
import { PLUGIN_MANIFEST as FX_MANIFEST } from '../../fx/src/manifest.js';
import { PLUGIN_MANIFEST as GEMINI_MANIFEST } from '../../gemini/src/manifest.js';
import { CLOUDFLARE_AI_GATEWAY_PROVIDER_CONTRIBUTION as declaration } from './provider/contribution.js';

const agentTargetKey = 'agent:happier.agent.codex/codex';
const agent = CODEX_MANIFEST.contributes.agents[0]!.providerRequirements!;
const contributionKey = 'happier.provider.cloudflare-ai-gateway/cloudflare-ai-gateway';
const model = { id: 'gpt-5.1', name: 'Manual native OpenAI model' };
const baseUrl = 'https://gateway.ai.cloudflare.com/v1/account/gateway/openai';
const policies = { 'cf-aig-collect-log': 'false', 'cf-aig-no-wholesale': 'true', 'cf-aig-skip-cache': 'true' };
const source = () => ProviderContributionV1Schema.parse(declaration);
const connection = () => ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_cloudflare_conformance',
  source: { kind: 'contribution', contributionKey }, role: 'default', displayName: 'Cloudflare AI Gateway', displayNameMode: 'automatic',
  revision: 1, createdAt: 1, updatedAt: 1,
  endpointOverrides: [{ endpointTemplateId: 'cloudflare-responses', baseUrl }] });
function responses() {
  const endpoint = source().endpointTemplates.find(row => row.id === 'cloudflare-responses');
  expect(endpoint, 'The proven fixed native Responses family must be contributed').toBeDefined();
  if (!endpoint) throw new Error('Missing Responses endpoint');
  return endpoint;
}
function compatibility(selectedModel = model) {
  const provider = source();
  return resolveProviderBindingCompatibilityWithFingerprintV1({ agentTargetKey, agent, adapterVersion: adapter.adapterVersion,
    endpoints: provider.endpointTemplates, credential: provider.credential, model: selectedModel,
    compatibilityOverrides: provider.compatibilityOverrides });
}

describe('Cloudflare fixed native Responses conformance', () => {
  it('does not offer gateway-only Responses to native drivers that cannot preserve its authentication contract', () => {
    const provider = source();
    for (const manifest of [OPENCODE_MANIFEST, DROID_PLUGIN.manifest, KILO_MANIFEST, COPILOT_MANIFEST, FX_MANIFEST, GEMINI_MANIFEST]) {
      const target = manifest.contributes.agents[0]!;
      const requirements = target.providerRequirements;
      if (!requirements) throw new Error('Expected the real Agent declaration');
      const result = resolveProviderBindingCompatibilityWithFingerprintV1({ agentTargetKey: `agent:${manifest.id}/${target.id}`,
        agent: requirements, adapterVersion: 1, endpoints: provider.endpointTemplates,
        credential: provider.credential, model, compatibilityOverrides: provider.compatibilityOverrides });
      expect(result.result.status, `${manifest.id} gateway-only Responses`).toBe('incompatible');
    }
  });
  it('resolves the exact admitted family into the real Codex configuration without upstream auth or model rewriting', async () => {
    const provider = source();
    const endpoint = responses();
    const effective = resolveEffectiveProviderEndpointV1({ connection: connection(), template: endpoint });
    expect(effective).toMatchObject({ baseUrl, ready: true, publicHeaders: policies });
    const selected = compatibility();
    expect(selected.result).toMatchObject({ status: 'experimental', selectedProtocol: 'openai-responses' });
    const transport = selectProviderRuntimeCredentialTransportV1({ agent, protocol: endpoint.protocol,
      transports: provider.credential!.transports });
    expect(transport).toMatchObject({ destination: { kind: 'httpHeader', name: 'cf-aig-authorization', format: 'bearer' } });
    expect(transport?.additionalCredentials ?? []).toEqual([]);
    if (!transport || !effective.baseUrl) throw new Error('Missing admitted binding');
    const input: AgentProviderBindingMaterializeInput = { v: 1,
      prepared: adapter.prepare({ v: 1, connectionId: connection().id, agentTargetKey }),
      binding: { v: 1, agentTargetKey, contributionKey, selection: { connectionId: connection().id, model },
        endpoint: { endpointTemplateId: endpoint.id, protocol: endpoint.protocol,
          normalizedUrl: effective.baseUrl, publicHeaders: effective.publicHeaders },
        compatibilityFingerprint: selected.compatibilityFingerprint, runtimeCredentialTransport: transport },
      credential: { kind: 'apiKey', transport, value: 'cf-u2-synthetic-token' } };
    const output = await adapter.materialize(input);
    expect(output.kind).toBe('engineConfig');
    if (output.kind !== 'engineConfig') throw new Error('Expected Codex configuration');
    expect(output.engineConfig.config).toMatchObject({ [`model_providers.${input.prepared.adapterBindingKey}`]: {
      base_url: baseUrl, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
      http_headers: policies, env_http_headers: { 'cf-aig-authorization': 'HAPPIER_CODEX_PROVIDER_API_KEY' },
    } });
    expect(JSON.stringify(output.engineConfig)).not.toContain('cf-u2-synthetic-token');
    expect(output.env).toEqual(expect.arrayContaining([
      { name: 'HAPPIER_CODEX_PROVIDER_API_KEY', value: 'Bearer cf-u2-synthetic-token', source: 'provider' },
      { name: 'OPENAI_API_KEY', value: null, source: 'provider' },
      { name: 'CODEX_API_KEY', value: null, source: 'provider' },
    ]));
    expect(input.binding.selection.model.id).toBe('gpt-5.1');
  });

  it('refuses account/Chat/Workers AI wire ids and wrong-family addresses without selecting another credential', () => {
    responses();
    for (const id of ['openai/gpt-5.1', '@cf/openai/gpt-oss-120b', 'claude-sonnet-4-5']) {
      expect(compatibility({ id, name: id }).result.status).toBe('incompatible');
    }
    for (const url of ['https://api.cloudflare.com/client/v4/accounts/account/ai/v1',
      'https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic', `${baseUrl}/compat`, `${baseUrl}?key=public`]) {
      const wrong = { ...connection(), endpointOverrides: [{ endpointTemplateId: 'cloudflare-responses', baseUrl: url }] };
      expect(() => resolveEffectiveProviderEndpointV1({ connection: wrong, template: responses() })).toThrow();
    }
    const provider = source();
    const transport = provider.credential!.transports.find(row => row.protocols.includes('openai-responses'))!;
    expect(() => selectProviderRuntimeCredentialTransportV1({ agent, protocol: 'openai-responses',
      transports: [...provider.credential!.transports, { ...transport, id: 'ambiguous-responses' }] })).toThrow(/Multiple/);
  });

  it('keeps manual models and declared reasoning controls across reload, with no probe or invented authentication result', () => {
    responses();
    const provider = source();
    expect(provider.catalog).toEqual({ source: 'manual', manualModelPolicy: 'allowed' });
    expect(provider.catalog.probes ?? []).toEqual([]);
    expect(provider.usageSources ?? []).toEqual([]);
    const catalog = ProviderConnectionsCatalogV1Schema.parse(JSON.parse(JSON.stringify({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection()],
      manualModelsByConnectionId: { [connection().id]: [{ id: model.id, addedAt: 1, reasoningEffortLevels: ['low', 'medium', 'high'] }] } })));
    const projection = projectAccountProviderModelsV1({ catalog,
      definitions: [{ contributionKey, definition: provider, provenance: 'first_party' }], agent,
      request: { agentTargetKey, mode: 'management' } });
    expect(projection.status).toBe('success');
    if (projection.status !== 'success') throw new Error('Expected Account model projection');
    expect(projection.groups[0]?.rows).toHaveLength(1);
    expect(projection.groups[0]?.rows[0]).toMatchObject({ ref: { modelId: 'gpt-5.1' }, confidence: 'account_unverified',
      compatibility: { result: { status: 'experimental', selectedProtocol: 'openai-responses' }, confirmed: false },
      endpointHealth: 'not_checked', sources: { manual: true, probe: false } });
    expect(projection.groups[0]?.rows[0]?.descriptor.modelOptions?.[0]?.options?.map(row => row.value)).toEqual(['low', 'medium', 'high']);
  });
});

describe('Cloudflare fixed account Chat conformance', () => {
  const chatTarget = 'agent:happier.agent.opencode/opencode';
  const chatAgent = OPENCODE_MANIFEST.contributes.agents[0]!.providerRequirements!;
  const chatModel = { id: 'openai/gpt-4.1', name: 'Manual account Chat model' };
  const chatBaseUrl = 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
  function chat() {
    const endpoint = source().endpointTemplates.find(row => row.id === 'cloudflare-chat');
    expect(endpoint, 'The natively characterized account Chat family must be contributed').toBeDefined();
    if (!endpoint) throw new Error('Missing account Chat endpoint');
    return endpoint;
  }
  function chatConnection() {
    return ProviderConnectionV1Schema.parse({ ...connection(), endpointOverrides: [{
      endpointTemplateId: 'cloudflare-chat', baseUrl: chatBaseUrl, publicHeaders: { 'cf-aig-gateway-id': 'gateway' },
    }] });
  }
  function chatCompatibility(selectedModel = chatModel) {
    const provider = source();
    return resolveProviderBindingCompatibilityWithFingerprintV1({ agentTargetKey: chatTarget, agent: chatAgent,
      adapterVersion: openCodeAdapter.adapterVersion, endpoints: provider.endpointTemplates,
      credential: provider.credential, model: selectedModel, compatibilityOverrides: provider.compatibilityOverrides });
  }

  it('retains the prefixed model, required gateway and bearer policy through Account reload and the real OpenCode materializer', async () => {
    const provider = source();
    const endpoint = chat();
    const effective = resolveEffectiveProviderEndpointV1({ connection: chatConnection(), template: endpoint });
    expect(effective).toMatchObject({ ready: true, baseUrl: chatBaseUrl,
      publicHeaders: { ...policies, 'cf-aig-gateway-id': 'gateway' } });
    const selected = chatCompatibility();
    expect(selected.result).toMatchObject({ status: 'experimental', selectedProtocol: 'openai-chat' });
    const transport = selectProviderRuntimeCredentialTransportV1({ agent: chatAgent, protocol: endpoint.protocol,
      transports: provider.credential!.transports });
    expect(transport).toMatchObject({ destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } });
    expect(transport?.additionalCredentials ?? []).toEqual([]);
    if (!transport || !effective.baseUrl) throw new Error('Missing admitted Chat binding');
    const prepared = openCodeAdapter.prepare({ v: 1, connectionId: connection().id, agentTargetKey: chatTarget });
    const output = await openCodeAdapter.materialize({ v: 1, prepared,
      binding: { v: 1, agentTargetKey: chatTarget, contributionKey,
        selection: { connectionId: connection().id, model: chatModel },
        endpoint: { endpointTemplateId: endpoint.id, protocol: endpoint.protocol,
          normalizedUrl: effective.baseUrl, publicHeaders: effective.publicHeaders },
        compatibilityFingerprint: selected.compatibilityFingerprint, runtimeCredentialTransport: transport },
      credential: { kind: 'apiKey', transport, value: 'cf-u2-chat-synthetic-token' } });
    expect(output.kind).toBe('configFile');
    if (output.kind !== 'configFile') throw new Error('Expected OpenCode configuration');
    const config = JSON.parse(output.files[0]!.utf8);
    expect(config).toMatchObject({ model: `${prepared.adapterBindingKey}/${chatModel.id}`, provider: {
      [prepared.adapterBindingKey!]: { npm: '@ai-sdk/openai-compatible',
        options: { baseURL: chatBaseUrl, apiKey: '{env:HAPPIER_OPENCODE_PROVIDER_API_KEY}',
          headers: { ...policies, 'cf-aig-gateway-id': 'gateway' } },
        models: { [chatModel.id]: { name: chatModel.name } } },
    } });
    expect(output.files[0]!.utf8).not.toContain('cf-u2-chat-synthetic-token');
    expect(output.env).toContainEqual({ name: 'HAPPIER_OPENCODE_PROVIDER_API_KEY', value: 'cf-u2-chat-synthetic-token', source: 'provider' });
    const catalog = ProviderConnectionsCatalogV1Schema.parse(JSON.parse(JSON.stringify({
      ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [chatConnection()],
      manualModelsByConnectionId: { [connection().id]: [{ id: chatModel.id, addedAt: 1 }] },
    })));
    const projection = projectAccountProviderModelsV1({ catalog,
      definitions: [{ contributionKey, definition: provider, provenance: 'first_party' }], agent: chatAgent,
      request: { agentTargetKey: chatTarget, mode: 'management' } });
    expect(projection).toMatchObject({ status: 'success', groups: [{ rows: [{
      ref: { modelId: chatModel.id }, confidence: 'account_unverified', endpointHealth: 'not_checked',
      compatibility: { confirmed: false, result: { status: 'experimental', selectedProtocol: 'openai-chat' } },
    }] }] });
    expect(provider.catalog.probes ?? []).toEqual([]);
    expect(provider.usageSources ?? []).toEqual([]);
  });

  it('refuses native wire ids, missing routing policy, wrong-family URLs and ambiguous Chat transports', () => {
    const endpoint = chat();
    for (const id of ['gpt-4.1', 'claude-sonnet-4-5']) {
      expect(chatCompatibility({ id, name: id }).result.status).toBe('incompatible');
    }
    for (const baseUrl of ['https://gateway.ai.cloudflare.com/v1/account/gateway/openai',
      `${chatBaseUrl}/compat`, `${chatBaseUrl}?gateway=gateway`]) {
      expect(() => resolveEffectiveProviderEndpointV1({ template: endpoint, connection: {
        ...chatConnection(), endpointOverrides: [{ endpointTemplateId: endpoint.id, baseUrl,
          publicHeaders: { 'cf-aig-gateway-id': 'gateway' } }],
      } })).toThrow();
    }
    const missingGateway = resolveEffectiveProviderEndpointV1({ template: endpoint, connection: {
      ...chatConnection(), endpointOverrides: [{ endpointTemplateId: endpoint.id, baseUrl: chatBaseUrl }],
    } });
    expect(missingGateway.ready).toBe(false);
    const provider = source();
    const transport = provider.credential!.transports.find(row => row.protocols.includes('openai-chat'))!;
    expect(() => selectProviderRuntimeCredentialTransportV1({ agent: chatAgent, protocol: 'openai-chat',
      transports: [...provider.credential!.transports, { ...transport, id: 'ambiguous-chat' }] })).toThrow(/Multiple/);
  });
});
