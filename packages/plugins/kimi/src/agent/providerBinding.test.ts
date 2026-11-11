import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentProviderBindingMaterializationV1Schema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { KIMI_PROVIDER_SECRET_ENV } from './providerBinding.js';

function input(adapter: NonNullable<Awaited<ReturnType<typeof registeredAgent>>['adapter']>): AgentProviderBindingMaterializeInput {
  const transport = { id: 'bearer', protocols: ['openai-chat'], uses: ['runtime'],
    destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } as const;
  return {
    v: 1,
    prepared: adapter.prepare({ v: 1, agentTargetKey: 'agent:happier.agent.kimi/kimi', connectionId: 'pc_gateway' }),
    binding: { v: 1, agentTargetKey: 'agent:happier.agent.kimi/kimi', contributionKey: 'happier.provider.vercel-ai-gateway/vercel-ai-gateway',
      selection: { connectionId: 'pc_gateway', model: { id: 'openai/gpt-5', name: 'GPT 5', contextWindowTokens: 128000 } },
      endpoint: { endpointTemplateId: 'chat', normalizedUrl: 'https://gateway.example/v1', protocol: 'openai-chat', publicHeaders: { 'X-Title': 'Happier' } },
      runtimeCredentialTransport: transport, compatibilityFingerprint: 'pcf1:kimi-fixture' },
    credential: { kind: 'apiKey', transport, value: 'selected-secret' },
  };
}

async function registeredAgent() {
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const agent = activation.registration('agents', 'kimi');
  if (!agent?.providerBinding) throw new Error('Kimi must register its Provider binding adapter');
  return { activation, adapter: agent.providerBinding };
}

describe('registered Kimi Provider binding', () => {
  it('materializes a streaming OpenAI-compatible provider without persisting the key', async () => {
    const { activation, adapter } = await registeredAgent();
    try {
      const fixture = input(adapter);
      const materialized = await adapter.materialize(fixture);
      expect(AgentProviderBindingMaterializationV1Schema.parse(materialized)).toEqual(materialized);
      expect(materialized).toMatchObject({ kind: 'configFile', nativeHome: true });
      if (materialized.kind !== 'configFile') throw new Error('Expected native config');
      expect(materialized.files).toHaveLength(1);
      const config = materialized.files[0]!.utf8;
      expect(config).toContain('type = "openai"');
      expect(config).toContain('base_url = "https://gateway.example/v1"');
      expect(config).toContain('api_key_env = "HAPPIER_KIMI_PROVIDER_API_KEY"');
      expect(config).toContain('[models."openai/gpt-5"]');
      expect(config).toContain('provider = "happier-provider"');
      expect(config).toContain('model = "openai/gpt-5"');
      expect(config).toContain('custom_headers');
      expect(config).not.toContain('selected-secret');
      expect(Object.fromEntries(materialized.env.map(row => [row.name, row.value]))).toMatchObject({ HAPPIER_KIMI_PROVIDER_API_KEY: 'selected-secret' });
    } finally { await activation.dispose(); }
  });

  it('materializes a direct OpenAI-compatible API-key Provider without a gateway contribution', async () => {
    const { activation, adapter } = await registeredAgent();
    try {
      const base = input(adapter);
      const materialized = await adapter.materialize({ ...base,
        binding: { ...base.binding, contributionKey: null,
          endpoint: { ...base.binding.endpoint, normalizedUrl: 'https://api.example.test/v1', publicHeaders: {} } },
      });
      expect(materialized.kind).toBe('configFile');
      if (materialized.kind !== 'configFile') throw new Error('Expected native config');
      expect(materialized.files[0]!.utf8).toContain('base_url = "https://api.example.test/v1"');
      expect(materialized.env).toContainEqual({ name: KIMI_PROVIDER_SECRET_ENV, value: 'selected-secret', source: 'provider' });
    } finally { await activation.dispose(); }
  });

  it('supports Anthropic and Responses wire protocols and refuses auth-header collisions', async () => {
    const { activation, adapter } = await registeredAgent();
    try {
      const base = input(adapter);
      for (const protocol of ['openai-responses', 'anthropic'] as const) {
        const transport = { id: protocol, protocols: [protocol], uses: ['runtime'], destination: {
          kind: 'httpHeader', name: protocol === 'anthropic' ? 'x-api-key' : 'authorization', format: protocol === 'anthropic' ? 'raw' : 'bearer',
        } } as const;
        const result = await adapter.materialize({ ...base,
          binding: { ...base.binding, endpoint: { ...base.binding.endpoint, protocol }, runtimeCredentialTransport: transport },
          credential: { kind: 'apiKey', transport, value: 'selected-secret' },
        });
        expect(result.kind).toBe('configFile');
        if (result.kind === 'configFile') expect(result.files[0]!.utf8).toContain(`type = "${protocol === 'anthropic' ? 'anthropic' : 'openai_responses'}"`);
      }
      await expect(Promise.resolve().then(() => adapter.materialize({ ...base, binding: { ...base.binding, endpoint: { ...base.binding.endpoint, publicHeaders: { Authorization: 'spoof' } } } }))).rejects.toThrow(/public header/i);
    } finally { await activation.dispose(); }
  });
});
