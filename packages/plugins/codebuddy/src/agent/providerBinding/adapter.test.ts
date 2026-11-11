import { AgentProviderBindingMaterializationV1Schema } from '@happier-dev/protocol';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  AgentProviderBindingAdapter,
  AgentProviderBindingMaterializeInput,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { activate } from '../../activate.js';

async function registered() {
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const agent = activation.registration('agents', 'codebuddy');
  if (!agent?.providerBinding) throw new Error('CodeBuddy must register its Provider binding adapter');
  return { activation, agent, adapter: agent.providerBinding };
}

function input(
  adapter: AgentProviderBindingAdapter,
  protocol: 'openai-chat' | 'openai-responses' = 'openai-chat',
  credential: 'none' | 'apiKey' = 'apiKey',
): AgentProviderBindingMaterializeInput {
  const transport = {
    id: 'runtime-bearer', protocols: [protocol], uses: ['runtime'],
    destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
  } as const;
  return {
    v: 1,
    prepared: adapter.prepare({ v: 1, agentTargetKey: 'agent:happier.agent.codebuddy/codebuddy', connectionId: 'pc_codebuddy' }),
    binding: {
      v: 1, agentTargetKey: 'agent:happier.agent.codebuddy/codebuddy',
      selection: { connectionId: 'pc_codebuddy', model: { id: 'vendor/model', name: 'Vendor model', capabilities: { reasoningControls: 'supported' } } },
      contributionKey: 'happier.provider.cloudflare-ai-gateway/cloudflare-ai-gateway',
      endpoint: { endpointTemplateId: 'gateway-openai', normalizedUrl: 'https://gateway.example/v1', protocol,
        publicHeaders: { 'cf-aigateway-id': 'gateway' } },
      runtimeCredentialTransport: credential === 'none' ? null : transport,
      compatibilityFingerprint: 'pcf1:codebuddy-fixture',
    },
    credential: credential === 'none' ? { kind: 'none' } : { kind: 'apiKey', transport, value: 'selected-secret' },
  };
}

describe('CodeBuddy Provider binding adapter', () => {
  it('declares the OpenAI Chat/Responses process configuration contract', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents[0]!;
    expect(agent.providerRequirements).toMatchObject({
      acceptsProtocols: ['openai-chat', 'openai-responses'],
      required: { streaming: true, toolRoundTrips: true },
      credentialSupport: {
        supportsNoAuth: true,
        noAuthProtocols: ['openai-chat'],
        apiKeyTransports: [{ protocol: 'openai-chat', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } },
          { protocol: 'openai-responses', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } }],
      },
      materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
    });
  });

  it.each([
    ['openai-chat', 'openai-completions', '/chat/completions'],
    ['openai-responses', 'openai-responses', '/responses'],
  ] as const)('materializes %s through the vendor custom-model serializer without embedding the key', async (protocol, api, suffix) => {
    const { activation, adapter } = await registered();
    try {
      const result = await adapter.materialize(input(adapter, protocol));
    expect(AgentProviderBindingMaterializationV1Schema.parse(result)).toEqual(result);
    expect(result.kind).toBe('spawnEnv');
    const env = Object.fromEntries(result.env.map(row => [row.name, row.value]));
    expect(env.CODEBUDDY_API_KEY).toBe('selected-secret');
    expect(env.ACC_PRODUCT_CONFIG_V3).not.toContain('selected-secret');
    expect(JSON.parse(env.ACC_PRODUCT_CONFIG_V3!)).toEqual({
      productFeatures: { ResponsesStore: false },
      models: [{ id: 'vendor/model', name: 'vendor/model', tags: ['custom'], api, url: `https://gateway.example/v1${suffix}`,
        supportsToolCall: true, supportsReasoning: true }],
    });
      expect(env.CODEBUDDY_CUSTOM_HEADERS).toBe('cf-aigateway-id: gateway');
    } finally { await activation.dispose(); }
  });

  it('allows a keyless OpenAI Chat connection and refuses keyless Responses', async () => {
    const { activation, adapter } = await registered();
    try {
      const chat = await adapter.materialize(input(adapter, 'openai-chat', 'none'));
    const env = Object.fromEntries(chat.env.map(row => [row.name, row.value]));
    expect(env.CODEBUDDY_API_KEY).toBeNull();
    expect(JSON.parse(env.ACC_PRODUCT_CONFIG_V3!).models[0]).not.toHaveProperty('apiKey');
      await expect(Promise.resolve().then(() => adapter.materialize(input(adapter, 'openai-responses', 'none')))).rejects.toThrow(/credential/u);
    } finally { await activation.dispose(); }
  });

  it('rejects a public Authorization header competing with the credential slot', async () => {
    const { activation, adapter } = await registered();
    try {
      const base = input(adapter);
      await expect(Promise.resolve().then(() => adapter.materialize({ ...base, binding: { ...base.binding,
        endpoint: { ...base.binding.endpoint, publicHeaders: { Authorization: 'public' } } } }))).rejects.toThrow(/credential destination/u);
    } finally { await activation.dispose(); }
  });
});
