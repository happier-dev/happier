import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  AgentAcpRuntimeOptions,
  AgentExecutionRunConversationRuntimeV1,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeContextV1,
  AgentProviderBindingAdapter,
  AgentProviderBindingMaterializeInput,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
  AgentProviderBindingMaterializationV1Schema,
  resolveProviderBindingCompatibilityWithFingerprintV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

async function registeredAgent() {
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const agent = activation.registration('agents', 'kilo');
  if (!agent?.providerBinding) throw new Error('Kilo must register its Provider binding adapter');
  return { activation, agent, adapter: agent.providerBinding };
}

function materializeInput(adapter: AgentProviderBindingAdapter, protocol: 'openai-chat' | 'openai-responses' | 'anthropic' = 'openai-chat'): AgentProviderBindingMaterializeInput {
  const transport = {
    id: 'runtime-key', protocols: [protocol], uses: ['runtime'],
    destination: { kind: 'httpHeader', name: protocol === 'anthropic' ? 'x-api-key' : 'Authorization',
      format: protocol === 'anthropic' ? 'raw' : 'bearer' },
  } as const;
  return {
    v: 1,
    prepared: adapter.prepare({ v: 1, agentTargetKey: 'agent:happier.agent.kilo/kilo', connectionId: 'pc_custom' }),
    binding: {
      v: 1, agentTargetKey: 'agent:happier.agent.kilo/kilo',
      selection: { connectionId: 'pc_custom', model: { id: 'vendor/model', name: 'Custom model' } },
      contributionKey: null,
      endpoint: { endpointTemplateId: 'custom', normalizedUrl: 'https://provider.example/v1', protocol,
        publicHeaders: { 'X-App-Title': 'Happier' } },
      runtimeCredentialTransport: transport, compatibilityFingerprint: 'pcf1:kilo-fixture',
    },
    credential: { kind: 'apiKey', transport, value: 'selected-secret' },
  };
}

describe('registered Kilo Provider binding', () => {
  it.each([
    ['openai-chat', '@ai-sdk/openai-compatible'],
    ['openai-responses', '@ai-sdk/openai'],
    ['anthropic', '@ai-sdk/anthropic'],
  ] as const)('launches %s with session-only config and a separate credential', async (protocol, npm) => {
    const { activation, adapter } = await registeredAgent();
    try {
      const input = materializeInput(adapter, protocol);
      const result = await adapter.materialize(input);
      expect(AgentProviderBindingMaterializationV1Schema.parse(result)).toEqual(result);
      expect(result.kind).toBe('spawnEnv');
      const env = Object.fromEntries(result.env.map(entry => [entry.name, entry.value]));
      const configText = env.KILO_CONFIG_CONTENT!;
      expect(configText).not.toContain('selected-secret');
      expect(env.HAPPIER_KILO_PROVIDER_API_KEY).toBe('selected-secret');
      const key = input.prepared.adapterBindingKey!;
      expect(JSON.parse(configText)).toEqual({
        enabled_providers: [key], model: `${key}/vendor/model`,
        provider: { [key]: { npm, name: 'Happier provider',
          options: { baseURL: 'https://provider.example/v1', apiKey: '{env:HAPPIER_KILO_PROVIDER_API_KEY}', headers: { 'X-App-Title': 'Happier' } },
          models: { 'vendor/model': { name: 'Custom model' } } } },
      });
      const requirements = PLUGIN_MANIFEST.contributes.agents[0]!.providerRequirements!;
      expect(requirements).toMatchObject({ materialization: 'spawnEnv', applyPolicy: 'restart_session' });
      expect(result.env.map(entry => entry.name).sort()).toEqual([...requirements.authIsolation.ownedEnvKeys].sort());
      expect(env.KILO_AUTH_CONTENT).toBe('{}');
      expect(Object.entries(env).filter(([name]) => !['KILO_CONFIG_CONTENT', 'KILO_AUTH_CONTENT', 'HAPPIER_KILO_PROVIDER_API_KEY'].includes(name))
        .every(([, value]) => value === null)).toBe(true);
    } finally { await activation.dispose(); }
  });

  it('preserves credential-free local Chat and refuses incompatible protocols/auth with typed reasons', async () => {
    const { activation, adapter } = await registeredAgent();
    try {
      const input = materializeInput(adapter);
      const result = await adapter.materialize({ ...input, credential: { kind: 'none' },
        binding: { ...input.binding, runtimeCredentialTransport: null } });
      const env = Object.fromEntries(result.env.map(entry => [entry.name, entry.value]));
      expect(env.HAPPIER_KILO_PROVIDER_API_KEY).toBeNull();
      expect(env.KILO_CONFIG_CONTENT).not.toContain('apiKey');
      const agent = PLUGIN_MANIFEST.contributes.agents[0]!.providerRequirements!;
      const compatibility = (protocol: 'openai-chat' | 'openai-responses' | 'gemini-generate-content') => resolveProviderBindingCompatibilityWithFingerprintV1({
        agentTargetKey: input.binding.agentTargetKey, adapterVersion: adapter.adapterVersion, agent,
        endpoints: [{ id: protocol, protocol, baseUrl: 'http://127.0.0.1:1234/v1',
          capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
        credential: undefined, model: { id: 'local', name: 'Local' },
      }).result;
      expect(compatibility('openai-chat')).toMatchObject({ selectedProtocol: 'openai-chat' });
      expect(compatibility('openai-responses')).toMatchObject({ status: 'incompatible', reasons: ['no_auth_unsupported'] });
      expect(compatibility('gemini-generate-content')).toMatchObject({ status: 'incompatible', reasons: ['no_compatible_protocol'] });
      const wrongTransport = { ...input.credential, transport: { id: 'wrong-header', protocols: ['openai-chat'], uses: ['runtime'],
        destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' } } } as const;
      expect(resolveProviderBindingCompatibilityWithFingerprintV1({
        agentTargetKey: input.binding.agentTargetKey, adapterVersion: adapter.adapterVersion, agent,
        endpoints: [{ id: 'chat', protocol: 'openai-chat', baseUrl: input.binding.endpoint.normalizedUrl,
          capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
        credential: { slotId: 'apiKey', kind: 'apiKey', required: true, transports: [wrongTransport.transport] }, model: input.binding.selection.model,
      }).result).toMatchObject({ status: 'incompatible', reasons: ['credential_transport_unavailable'] });
      const responses = materializeInput(adapter, 'openai-responses');
      await expect(Promise.resolve().then(() => adapter.materialize({ ...responses, credential: { kind: 'none' },
        binding: { ...responses.binding, runtimeCredentialTransport: null } }))).rejects.toThrow(/without a credential/u);
    } finally { await activation.dispose(); }
  });

  it.each(['create', 'resume'] as const)('opens a bound %s through registered ACP startup with the qualified model', async kind => {
    const { activation, agent, adapter } = await registeredAgent();
    try {
      const input = materializeInput(adapter);
      const materialized = await adapter.materialize(input);
      const runtime = await agent.factory!({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'kilo' }, signal: new AbortController().signal });
      const session = { send: vi.fn(async () => ({ status: 'admitted' as const })),
        cancel: vi.fn(async ({ turnId }: { turnId: string }) => ({ status: 'requested' as const, turnId })),
        watch: () => ({ dispose() {} }), dispose() {} } satisfies AgentSessionRuntime;
      const open = vi.fn(async (_request: AgentSessionOpenRequest, _options: AgentAcpRuntimeOptions) => session);
      const request: AgentSessionOpenRequest = {
        ...(kind === 'create' ? { kind } : { kind, providerSessionId: 'native-session' }),
        sessionId: 'session-kilo', cwd: '/workspace',
        launchEnvironment: { values: Object.fromEntries(materialized.env.flatMap(entry => entry.value === null ? [] : [[entry.name, entry.value]])),
          unset: materialized.env.filter(entry => entry.value === null).map(entry => entry.name) },
        providerBinding: { connectionId: 'pc_custom', upstream: { protocol: 'openai-chat', normalizedUrl: input.binding.endpoint.normalizedUrl, credential: 'apiKey' },
          model: input.binding.selection.model, materialization: { v: 1, kind: 'spawnEnv' } },
        configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: 'vendor/model', updatedAtMs: 2 },
          permissionIntent: { value: 'read-only', updatedAtMs: 3 }, options: {} },
      };
      await runtime.sessions.open(request, { protocols: { acp: { open } } } as AgentSessionRuntimeContext);
      expect(open.mock.calls[0]![0].configuration?.model).toEqual(request.configuration?.model);
      const controls = open.mock.calls[0]![1].definition?.models;
      const nativeId = `${input.prepared.adapterBindingKey}/vendor/model`;
      expect(controls?.resolveModelUpdate?.({ modelId: 'vendor/model', modelState: null })).toEqual({ modelId: nativeId });
      expect(controls?.projectModelState?.({ normalizedModelState: { currentModelId: nativeId,
        availableModels: [{ id: nativeId, name: 'Custom model' }] } })).toEqual({ currentModelId: 'vendor/model',
          availableModels: [{ id: 'vendor/model', name: 'Custom model' }] });
      expect(() => controls?.resolveModelUpdate?.({ modelId: 'another-model', modelState: null })).toThrow(/does not match/u);
      expect(open.mock.calls[0]![0].launchEnvironment).toEqual(request.launchEnvironment);
      expect(open.mock.calls[0]![1].transport).toMatchObject({ kind: 'stdio', args: ['acp'], env: { KILO_PERMISSION: expect.any(String) } });
    } finally { await activation.dispose(); }
  });

  it('refuses native substitutions in Provider catalog/config data before the child can read secrets or files', async () => {
    const { activation, adapter } = await registeredAgent();
    try {
      const input = materializeInput(adapter);
      await expect(Promise.resolve().then(() => adapter.materialize({ ...input, binding: { ...input.binding,
        selection: { ...input.binding.selection, model: { id: 'vendor/model', name: '{env:HAPPIER_KILO_PROVIDER_API_KEY}' } },
      } }))).rejects.toThrow(/substitution/u);
      await expect(Promise.resolve().then(() => adapter.materialize({ ...input, binding: { ...input.binding,
        endpoint: { ...input.binding.endpoint, publicHeaders: { 'X-Model': '{file:/private/config}' } },
      } }))).rejects.toThrow(/substitution/u);
    } finally { await activation.dispose(); }
  });

  it.each(['finite', 'conversation'] as const)('applies bound native models in %s Runs', async kind => {
    const { activation, agent, adapter } = await registeredAgent();
    try {
      const input = materializeInput(adapter);
      const materialized = await adapter.materialize(input);
      const runtime = await agent.factory!({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'kilo' }, signal: new AbortController().signal });
      const run = { send: async () => ({ status: 'admitted' as const }), stop: async () => ({ status: 'requested' as const }),
        watch: () => ({ dispose() {} }), dispose() {} } satisfies AgentExecutionRunRuntime;
      const conversation = { ...run, send: async () => ({ status: 'admitted' as const }) } satisfies AgentExecutionRunConversationRuntimeV1;
      const open = vi.fn(async (_request: AgentExecutionRunOpenRequest, _options: AgentAcpRuntimeOptions) => run);
      const openConversation = vi.fn(async (_request: AgentExecutionRunOpenRequest, _options: AgentAcpRuntimeOptions) => conversation);
      const request: AgentExecutionRunOpenRequest = {
        kind: 'create', runId: 'kilo-run', cwd: '/workspace', profile: { pluginId: PLUGIN_MANIFEST.id, localId: 'default' }, input: { text: 'Run' },
        launchEnvironment: { values: Object.fromEntries(materialized.env.flatMap(entry => entry.value === null ? [] : [[entry.name, entry.value]])),
          unset: materialized.env.filter(entry => entry.value === null).map(entry => entry.name) },
        providerBinding: { connectionId: 'pc_custom', upstream: { protocol: 'openai-chat', normalizedUrl: input.binding.endpoint.normalizedUrl, credential: 'apiKey' },
          model: input.binding.selection.model, materialization: { v: 1, kind: 'spawnEnv' } },
        configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: 'vendor/model', updatedAtMs: 2 },
          permissionIntent: { value: 'read-only', updatedAtMs: 3 }, options: {} },
      };
      const context = { protocols: { acp: { openExecutionRunV1: open, openExecutionRunConversationV1: openConversation } } } as unknown as AgentExecutionRunRuntimeContextV1;
      if (kind === 'finite') await runtime.sessions.executionRunContextV1!.open(request, context);
      else await runtime.sessions.executionRunContextV1!.openConversation!(request, context);
      const options = (kind === 'finite' ? open.mock.calls : openConversation.mock.calls)[0]![1];
      expect(options.definition?.models?.resolveModelUpdate?.({ modelId: 'vendor/model', modelState: null }))
        .toEqual({ modelId: `${input.prepared.adapterBindingKey}/vendor/model` });
    } finally { await activation.dispose(); }
  });
});
