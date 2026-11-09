import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentProviderBindingMaterializationV1Schema, resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { activate } from '../activate.js';

const transport = { id: 'gemini-key', protocols: ['gemini'], uses: ['runtime'],
  destination: { kind: 'httpHeader', name: 'x-goog-api-key', format: 'raw' } } as const;

describe('Gemini Provider binding', () => {
  it('activates a session-only binding that chooses the endpoint/model and removes competing Google auth', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const adapter = activation.registration('agents', 'gemini')?.providerBinding;
      expect(adapter).toBeDefined();
      if (!adapter) throw new Error('Gemini Provider adapter missing');
      const input: AgentProviderBindingMaterializeInput = {
        v: 1, prepared: adapter.prepare({ v: 1, agentTargetKey: 'agent:happier.agent.gemini/gemini', bindingKey: 'gateway' }),
        credential: { kind: 'apiKey', transport, value: 'fixture-private-key' },
        binding: { v: 1, agentTargetKey: 'agent:happier.agent.gemini/gemini',
          selection: { bindingKey: 'gateway', model: { id: 'gemini-custom', name: 'Gateway model' } },
          contributionKey: null, endpoint: { endpointTemplateId: 'gemini', protocol: 'gemini',
            normalizedUrl: 'https://gateway.example.test', publicHeaders: { 'x-team': 'coding' } },
          runtimeCredentialTransport: transport, compatibilityFingerprint: 'pcf1:gemini-test' },
      };
      const output = await adapter.materialize(input);
      expect(AgentProviderBindingMaterializationV1Schema.parse(output)).toEqual(output);
      expect(output.kind).toBe('spawnEnv');
      const env = Object.fromEntries(output.env.map(row => [row.name, row.value]));
      expect(env).toMatchObject({ GEMINI_API_KEY: 'fixture-private-key', GEMINI_MODEL: 'gemini-custom',
        GOOGLE_GEMINI_BASE_URL: 'https://gateway.example.test', GOOGLE_API_KEY: null,
        GOOGLE_GENAI_USE_VERTEXAI: null, GOOGLE_GENAI_USE_GCA: null, GOOGLE_APPLICATION_CREDENTIALS: null,
        GEMINI_CLI_CUSTOM_HEADERS: 'x-team: coding', GEMINI_API_KEY_AUTH_MECHANISM: null,
        GEMINI_CLI_AUTH_OVERRIDE: null });
      expect(output.env.map(row => row.name).sort()).toEqual(
        [...PLUGIN_MANIFEST.contributes.agents[0]!.providerRequirements!.authIsolation.ownedEnvKeys].sort());
      const commaHeader = await adapter.materialize({ ...input, binding: { ...input.binding, endpoint: {
        ...input.binding.endpoint, publicHeaders: { 'x-meta': 'part-a, two words:tail' },
      } } });
      expect(commaHeader.env.find(row => row.name === 'GEMINI_CLI_CUSTOM_HEADERS')?.value)
        .toBe('x-meta: part-a, two words:tail');
      // Official resolveModel/defaultModelConfigs can rewrite these identifiers.
      for (const id of ['auto', 'pro', 'flash', 'flash-lite', 'auto-gemini-2.5', 'auto-gemini-3', 'none',
        'gemini-3-pro-preview', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-3.1-flash-lite']) {
        expect(() => adapter.materialize({ ...input, binding: { ...input.binding, selection: {
          ...input.binding.selection, model: { id, name: id },
        } } })).toThrow('literal model');
      }
      expect(() => adapter.materialize({ ...input, binding: { ...input.binding,
        endpoint: { ...input.binding.endpoint, protocol: 'openai-chat' } } })).toThrow('protocol');
    } finally { await activation.dispose(); }
  });

  it('rejects Chat Completions providers with the shared typed protocol reason', () => {
    const support = PLUGIN_MANIFEST.contributes.agents[0]?.providerRequirements;
    expect(support).toBeDefined();
    if (!support) throw new Error('Gemini Provider requirements missing');
    expect(support.applyPolicy).toBe('restart_session');
    expect(resolveProviderBindingCompatibilityWithFingerprintV1({
      agentTargetKey: 'agent:happier.agent.gemini/gemini', adapterVersion: 1, agent: support,
      endpoints: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1',
        capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
      model: { id: 'chat-model', name: 'Chat model' },
    }).result).toMatchObject({ status: 'incompatible', reasons: ['no_compatible_protocol'] });
  });
});
