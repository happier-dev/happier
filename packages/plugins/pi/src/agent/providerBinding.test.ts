import { describe, expect, it, onTestFinished } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';
import { activate, PLUGIN_MANIFEST } from '../index.js';

// The models.json file is the native configuration boundary. Registration and
// materialization use the real admitted plugin contribution.
describe('Pi selected Provider binding', () => {
  const museProvider = { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' };
  it.each([
    {
      source: { bindingKey: 'connected_account:' + JSON.stringify({ consumer: museProvider, purpose: 'meta-upstream' }) },
      contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
      modelId: 'muse-spark-1.3-contributor',
    },
    {
      source: { connectionId: 'pc_fixture' },
      contributionKey: null,
      modelId: 'meta/muse-spark-1.3-contributor',
    },
  ])('serializes the exact selected Responses model $modelId', async ({ source, contributionKey, modelId }) => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    onTestFinished(() => fixture.dispose());
    const adapter = fixture.registration('agents', 'pi')?.providerBinding;
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts?.map(row => row.purpose)).not.toContain('meta-inference');
    expect(adapter, 'selected Provider binding must be registered').toBeDefined();
    if (!adapter) throw new Error('selected Provider binding is missing');
    const transport = { id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } as const;
    const input: AgentProviderBindingMaterializeInput = {
      v: 1,
      prepared: adapter.prepare({ v: 1, agentTargetKey: 'agent-target', ...source,
        model: { id: modelId, name: 'Selected model' } }),
      binding: { v: 1, agentTargetKey: 'agent-target', contributionKey,
        selection: { ...source, model: { id: modelId, name: 'Selected model',
          capabilities: { reasoningControls: 'supported' }, contextWindowTokens: 65536 } },
        endpoint: { endpointTemplateId: 'responses', normalizedUrl: 'http://127.0.0.1:7777/v1',
          protocol: 'openai-responses', publicHeaders: { 'x-source': 'selected', 'x-literal': '!do-not-execute $HOME' } },
        runtimeCredentialTransport: transport, compatibilityFingerprint: 'admitted' },
      credential: { kind: 'apiKey', transport, value: 'fake-downstream-only' },
    };
    const materialized = await adapter.materialize(input);
    expect(materialized).toMatchObject({ kind: 'configFile', nativeHome: true });
    if (materialized.kind !== 'configFile') throw new Error('Expected private extension');
    expect(materialized.files).toHaveLength(1);
    const modelsJson = materialized.files[0]!.utf8;
    expect(modelsJson).not.toContain('fake-downstream-only');
    expect(materialized.files[0]!.relativePath).toBe('models.json');
    expect(JSON.parse(modelsJson)).toEqual({ providers: { 'happier-provider': {
      api: 'openai-responses', baseUrl: input.binding.endpoint.normalizedUrl,
      apiKey: '${HAPPIER_PI_PROVIDER_API_KEY}', headers: { 'x-source': 'selected', 'x-literal': '$!do-not-execute $$HOME' },
      models: [{ id: modelId, name: 'Selected model', reasoning: true, contextWindow: 65536 }],
    } } });
    expect(materialized.env).toContainEqual({ name: 'HAPPIER_PI_PROVIDER_API_KEY', value: 'fake-downstream-only', source: 'provider' });
    expect(materialized.env).toContainEqual({ name: 'META_API_KEY', value: null, source: 'provider' });
    const nativeConfig = JSON.parse(modelsJson) as { providers: Record<string, { apiKey: string; headers: Record<string, string> }> };
    const provider = nativeConfig.providers['happier-provider']!;
    // The retained native parser is an external boundary. Loading it executes no CLI.
    for (const artifact of ['pi-coding-agent-0810', 'pi-coding-agent-0811', 'pi-coding-agent-0820', 'pi-coding-agent-0821']) {
      const native: { resolveConfigValue(value: string, env?: Record<string, string>): string | undefined } =
        await import(/* @vite-ignore */ new URL(`../../../../../node_modules/${artifact}/dist/core/resolve-config-value.js`, import.meta.url).href);
      expect(native.resolveConfigValue(provider.apiKey, { HAPPIER_PI_PROVIDER_API_KEY: 'fake-downstream-only' })).toBe('fake-downstream-only');
      expect(native.resolveConfigValue(provider.headers['x-literal']!)).toBe('!do-not-execute $HOME');
    }
  });
});
