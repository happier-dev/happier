import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST, activate } from '../manifest.js';

function input(adapter: AgentProviderBindingAdapter, protocol: 'openai-chat' | 'openai-responses' = 'openai-chat'): AgentProviderBindingMaterializeInput {
  const transport = { id: 'qwen-runtime-key', protocols: [protocol], uses: ['runtime'],
    destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } } as const;
  return { v: 1, prepared: adapter.prepare({ v: 1, connectionId: 'pc_qwen', agentTargetKey: 'agent:happier.agent.qwen/qwen' }),
    binding: { v: 1, agentTargetKey: 'agent:happier.agent.qwen/qwen',
      selection: { connectionId: 'pc_qwen', model: { id: 'qwen-custom', name: 'Qwen Custom' } }, contributionKey: null,
      endpoint: { endpointTemplateId: 'custom', normalizedUrl: 'https://provider.example/v1', protocol, publicHeaders: { 'X-Project': 'Happier' } },
      runtimeCredentialTransport: transport, compatibilityFingerprint: 'pcf1:qwen-fixture' },
    credential: { kind: 'apiKey', transport, value: 'fixture-selected-secret' } };
}

describe('registered Qwen Provider binding', () => {
  it.each([['openai-chat', undefined], ['openai-responses', 'responses']] as const)('materializes %s settings without persisting the key', async (protocol, wireApi) => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const adapter = activation.registration('agents', 'qwen')?.providerBinding;
      if (!adapter) throw new Error('Qwen must register its Provider binding adapter');
      const result = await adapter.materialize(input(adapter, protocol));
      expect(result.kind).toBe('configFile');
      if (result.kind !== 'configFile') throw new Error('Expected Qwen settings file');
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.relativePath).toBe('settings.json');
      expect(result.files[0]!.utf8).not.toContain('fixture-selected-secret');
      expect(JSON.parse(result.files[0]!.utf8)).toEqual({ $version: 4,
        modelProviders: { openai: [{ id: 'qwen-custom', envKey: 'HAPPIER_QWEN_PROVIDER_API_KEY', baseUrl: 'https://provider.example/v1',
          ...(wireApi ? { wireApi } : {}), generationConfig: { customHeaders: { 'X-Project': 'Happier' } } }] },
        security: { auth: { selectedType: 'openai' } }, model: { name: 'qwen-custom', baseUrl: 'https://provider.example/v1' } });
      expect(Object.fromEntries(result.env.map(row => [row.name, row.value]))).toEqual({ HAPPIER_QWEN_PROVIDER_API_KEY: 'fixture-selected-secret', QWEN_CODE_SYSTEM_SETTINGS_PATH: null });
    } finally { await activation.dispose(); }
  });

  it('rejects a credential-free binding because Qwen OpenAI transport requires an API key', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const adapter = activation.registration('agents', 'qwen')?.providerBinding;
      if (!adapter) throw new Error('Qwen must register its Provider binding adapter');
      const base = input(adapter);
      await expect(Promise.resolve().then(() => adapter.materialize({ ...base, credential: { kind: 'none' }, binding: { ...base.binding, runtimeCredentialTransport: null } }))).rejects.toThrow(/API key/u);
    } finally { await activation.dispose(); }
  });
});
