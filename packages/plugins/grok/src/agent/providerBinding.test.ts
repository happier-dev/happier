import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST, activate } from '../manifest.js';
import { buildGrokAcpRuntimeDefinition } from './acp/definition.js';
import { GROK_PREFLIGHT_SESSION_CONTROLS } from './preflight/models.js';

function input(adapter: AgentProviderBindingAdapter, credential: 'apiKey' | 'none' = 'apiKey'): AgentProviderBindingMaterializeInput {
  const transport = { id: 'grok-runtime-key', protocols: ['openai-chat'], uses: ['runtime'],
    destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } } as const;
  return { v: 1, prepared: adapter.prepare({ v: 1, connectionId: 'pc_grok', agentTargetKey: 'agent:happier.agent.grok/grok' }),
    binding: { v: 1, agentTargetKey: 'agent:happier.agent.grok/grok',
      selection: { connectionId: 'pc_grok', model: { id: 'custom-grok', name: 'Custom Grok' } }, contributionKey: null,
      endpoint: { endpointTemplateId: 'openai-chat', normalizedUrl: 'https://provider.example/v1', protocol: 'openai-chat', publicHeaders: {} },
      runtimeCredentialTransport: credential === 'none' ? null : transport, compatibilityFingerprint: 'pcf1:grok-fixture' },
    credential: credential === 'none' ? { kind: 'none' } : { kind: 'apiKey', transport, value: 'fixture-secret' } };
}

describe('registered Grok Provider binding', () => {
  it('materializes the vendor config overlay through GROK_CONFIG while keeping the key in env', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const adapter = activation.registration('agents', 'grok')?.providerBinding;
      if (!adapter) throw new Error('Grok must register its Provider binding adapter');
      const result = await adapter.materialize(input(adapter));
      expect(result.kind).toBe('spawnEnv');
      const env = Object.fromEntries(result.env.map(row => [row.name, row.value]));
      expect(env.XAI_API_KEY).toBe('fixture-secret');
      expect(env.GROK_CONFIG).not.toContain('fixture-secret');
      expect(JSON.parse(env.GROK_CONFIG!)).toEqual({ model: { 'custom-grok': {
        model: 'custom-grok', base_url: 'https://provider.example/v1', env_key: 'XAI_API_KEY',
      } } });
    } finally { await activation.dispose(); }
  });

  it.each([
    { advertisedMethodIds: ['xai.api_key'] },
    { advertisedMethodIds: ['cached_token', 'xai.api_key'] },
  ])('selects Provider API-key auth through runtime and preflight with $advertisedMethodIds', async ({ advertisedMethodIds }) => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const adapter = activation.registration('agents', 'grok')?.providerBinding;
      if (!adapter) throw new Error('Grok must register its Provider binding adapter');
      const result = await adapter.materialize(input(adapter));
      const environment = Object.fromEntries(result.env.flatMap(row => typeof row.value === 'string' ? [[row.name, row.value]] : []));
      const initializeMetadata = { defaultAuthMethodId: 'cached_token' };
      const expected = { methodId: 'xai.api_key', metadata: { headless: true } };
      expect(buildGrokAcpRuntimeDefinition(environment).auth?.selectMethod?.({ advertisedMethodIds, initializeMetadata })).toEqual(expected);
      expect(GROK_PREFLIGHT_SESSION_CONTROLS.catalogs.selectAuthentication({
        initializeResult: { authMethods: advertisedMethodIds.map(id => ({ id })), _meta: initializeMetadata },
        probe: { accountSettings: null, environment: {},
          nonblankEnvironment: Object.fromEntries(Object.entries(environment).map(([name, value]) => [name, Boolean(value.trim())])) },
      })).toEqual(expected);
    } finally { await activation.dispose(); }
  });

  it('rejects keyless and public-header bindings before launch', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const adapter = activation.registration('agents', 'grok')?.providerBinding;
      if (!adapter) throw new Error('Grok must register its Provider binding adapter');
      await expect(Promise.resolve().then(() => adapter.materialize(input(adapter, 'none')))).rejects.toThrow(/API key/u);
      const base = input(adapter);
      await expect(Promise.resolve().then(() => adapter.materialize({ ...base, binding: { ...base.binding,
        endpoint: { ...base.binding.endpoint, publicHeaders: { 'X-Project': 'Happier' } } } }))).rejects.toThrow(/custom public headers/u);
    } finally { await activation.dispose(); }
  });
});
