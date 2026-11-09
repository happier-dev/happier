import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it } from 'vitest';

import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

function createInput(): AgentProviderBindingMaterializeInput {
  const transport = { id: 'key', protocols: ['openai-responses'], uses: ['runtime'],
    destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } as const;
  return {
    v: 1, prepared: { v: 1, materialization: 'spawnEnv' },
    credential: { kind: 'apiKey', transport, value: 'fixture-provider-secret' },
    binding: { v: 1, agentTargetKey: 'agent:happier.review.deepsec/deepsec',
      selection: { bindingKey: 'fixture', model: { id: 'custom-model', name: 'Custom' } }, contributionKey: null,
      endpoint: { endpointTemplateId: 'responses', protocol: 'openai-responses',
        normalizedUrl: 'https://provider.example.test/codex/v1', publicHeaders: {} },
      runtimeCredentialTransport: transport, compatibilityFingerprint: 'pcf1:fixture' },
  };
}

describe('DeepSec native Provider constraints', () => {
  it('refuses endpoint shapes the native Codex harness would rewrite', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const adapter = activation.registration('agents', 'deepsec')?.providerBinding;
      if (!adapter) throw new Error('Expected DeepSec Provider adapter');
      const input = createInput();
      for (const normalizedUrl of ['https://provider.example.test', 'https://provider.example.test/v2',
        'https://provider.example.test/v1?route=other', 'https://provider.example.test/v1#fragment']) {
        await expect(adapter.materialize({ ...input, binding: { ...input.binding,
          endpoint: { ...input.binding.endpoint, normalizedUrl } } })).rejects.toThrow('must end in /v1');
      }
    } finally { await activation.dispose(); }
  });

  it('refuses unsupported headers, unauthenticated routes and mismatched credential transports', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const adapter = activation.registration('agents', 'deepsec')?.providerBinding;
      if (!adapter) throw new Error('Expected DeepSec Provider adapter');
      const input = createInput();
      await expect(adapter.materialize({ ...input, binding: { ...input.binding,
        endpoint: { ...input.binding.endpoint, publicHeaders: { 'x-team': 'coding' } } } })).rejects.toThrow('public headers');
      await expect(adapter.materialize({ ...input, credential: { kind: 'none' } })).rejects.toThrow('API key');
      await expect(adapter.materialize({ ...input, binding: { ...input.binding,
        runtimeCredentialTransport: null } })).rejects.toThrow('selected transport');
    } finally { await activation.dispose(); }
  });
});
