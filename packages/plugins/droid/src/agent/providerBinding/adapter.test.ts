import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentAcpRuntimeOptions, AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1, AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentProviderBindingMaterializationV1Schema, resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { DROID_PLUGIN } from '../../manifest.js';

async function registered() {
  const activation = await createPluginTestkit({ manifest: DROID_PLUGIN.manifest, module: { activate: DROID_PLUGIN.activate } });
  const agent = activation.registration('agents', 'droid');
  if (!agent?.providerBinding) throw new Error('Droid must register its Provider binding adapter');
  return { activation, agent, adapter: agent.providerBinding };
}

function input(adapter: AgentProviderBindingAdapter, protocol: 'openai-chat' | 'openai-responses' | 'anthropic' = 'openai-chat'): AgentProviderBindingMaterializeInput {
  const transport = { id: 'runtime-key', protocols: [protocol], uses: ['runtime'],
    destination: { kind: 'httpHeader', name: protocol === 'anthropic' ? 'x-api-key' : 'Authorization', format: protocol === 'anthropic' ? 'raw' : 'bearer' } } as const;
  return { v: 1, prepared: adapter.prepare({ v: 1, connectionId: 'pc_droid', agentTargetKey: 'agent:happier.agent.droid/droid' }),
    binding: { v: 1, agentTargetKey: 'agent:happier.agent.droid/droid',
      selection: { connectionId: 'pc_droid', model: { id: 'vendor/model', name: 'Custom model' } }, contributionKey: null,
      endpoint: { endpointTemplateId: 'custom', normalizedUrl: 'https://provider.example/v1', protocol, publicHeaders: { 'X-Project': 'Happier' } },
      runtimeCredentialTransport: transport, compatibilityFingerprint: 'pcf1:droid-fixture' },
    credential: { kind: 'apiKey', transport, value: 'fixture-selected-secret' } };
}

describe('registered Droid Provider binding', () => {
  it.each([['openai-chat', 'generic-chat-completion-api'], ['openai-responses', 'openai'], ['anthropic', 'anthropic']] as const)(
    'materializes %s settings with an environment reference rather than a persisted key', async (protocol, provider) => {
      const { activation, adapter } = await registered();
      try {
        const result = await adapter.materialize(input(adapter, protocol));
        expect(AgentProviderBindingMaterializationV1Schema.parse(result)).toEqual(result);
        expect(result.kind).toBe('configFile');
        if (result.kind !== 'configFile') throw new Error('Expected Droid settings file');
        expect(result.files).toHaveLength(1);
        expect(result.files[0]!.utf8).not.toContain('fixture-selected-secret');
        expect(JSON.parse(result.files[0]!.utf8)).toEqual({ customModels: [{ model: 'vendor/model', displayName: 'Happier provider: vendor/model',
          baseUrl: 'https://provider.example/v1', provider, apiKey: '${HAPPIER_DROID_PROVIDER_API_KEY}', extraHeaders: { 'X-Project': 'Happier' } }] });
        const env = Object.fromEntries(result.env.map(row => [row.name, row.value]));
        expect(env).toEqual({ HAPPIER_DROID_PROVIDER_API_KEY: 'fixture-selected-secret' });
        expect(result.env.map(row => row.name).sort()).toEqual([...DROID_PLUGIN.manifest.contributes.agents[0]!.providerRequirements!.authIsolation.ownedEnvKeys].sort());
      } finally { await activation.dispose(); }
    });

  it('keeps keyless connections credential-free and returns canonical typed protocol refusal', async () => {
    const { activation, adapter } = await registered();
    try {
      const base = input(adapter);
      const result = await adapter.materialize({ ...base, credential: { kind: 'none' }, binding: { ...base.binding, runtimeCredentialTransport: null } });
      expect(result.env.every(row => row.value === null)).toBe(true);
      if (result.kind !== 'configFile') throw new Error('Expected settings file');
      expect(JSON.parse(result.files[0]!.utf8).customModels[0]).not.toHaveProperty('apiKey');
      const compatibility = resolveProviderBindingCompatibilityWithFingerprintV1({ agentTargetKey: base.binding.agentTargetKey, adapterVersion: adapter.adapterVersion,
        agent: DROID_PLUGIN.manifest.contributes.agents[0]!.providerRequirements!,
        endpoints: [{ id: 'gemini', protocol: 'gemini-generate-content', baseUrl: 'https://provider.example/v1', capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
        model: { id: 'vendor/model', name: 'Custom model' } });
      expect(compatibility.result).toMatchObject({ status: 'incompatible', reasons: ['no_compatible_protocol'] });
      await expect(Promise.resolve().then(() => adapter.materialize({ ...base, credential: { kind: 'none' } }))).rejects.toThrow();
    } finally { await activation.dispose(); }
  });

  it('refuses native environment references supplied as public Provider data', async () => {
    const { activation, adapter } = await registered();
    try {
      const base = input(adapter);
      await expect(Promise.resolve().then(() => adapter.materialize({ ...base, binding: { ...base.binding,
        selection: { ...base.binding.selection, model: { id: '${HAPPIER_DROID_PROVIDER_API_KEY}', name: 'Untrusted' } } } }))).rejects.toThrow(/substitution/u);
      await expect(Promise.resolve().then(() => adapter.materialize({ ...base, binding: { ...base.binding,
        endpoint: { ...base.binding.endpoint, publicHeaders: { 'X-Project': '${HAPPIER_DROID_PROVIDER_API_KEY}' } } } }))).rejects.toThrow(/substitution/u);
    } finally { await activation.dispose(); }
  });

  it.each(['create', 'resume'] as const)('opens bound %s with process-only settings and resolves the advertised custom model', async kind => {
    const { activation, agent, adapter } = await registered();
    try {
      const materialized = await adapter.materialize(input(adapter));
      if (materialized.kind !== 'configFile') throw new Error('Expected settings file');
      const runtime = await agent.factory!({ plugin: { id: DROID_PLUGIN.manifest.id, version: DROID_PLUGIN.manifest.version }, agent: { id: 'droid' }, signal: new AbortController().signal });
      const open = vi.fn(async (_request: AgentSessionOpenRequest, _options: AgentAcpRuntimeOptions) => ({ send: async () => ({ status: 'admitted' as const }), cancel: async () => ({ status: 'requested' as const }), watch: () => ({ dispose() {} }), dispose() {} }));
      const request: AgentSessionOpenRequest = { ...(kind === 'create' ? { kind } : { kind, providerSessionId: 'native-session' }), sessionId: 'session-droid', cwd: '/workspace',
        configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 2 }, permissionIntent: { value: 'read-only', updatedAtMs: 3 }, options: {} },
        providerBinding: { connectionId: 'pc_droid', upstream: { protocol: 'openai-chat', normalizedUrl: 'https://provider.example/v1', credential: 'apiKey' }, model: input(adapter).binding.selection.model,
          materialization: { v: 1, kind: 'configFile', rootPath: '/private/session', relativePaths: materialized.files.map(file => file.relativePath) } } };
      await runtime.sessions!.open(request, { services: { connectedAccounts: { getBinding: async () => null } }, protocols: { acp: { open } } } as unknown as AgentSessionRuntimeContext);
      const options = open.mock.calls[0]![1];
      expect(open.mock.calls[0]![0].configuration!.model).toEqual({ value: 'vendor/model', updatedAtMs: 2 });
      expect(options.transport).toMatchObject({ kind: 'stdio', args: ['exec', '--output-format', 'acp', '--settings', '/private/session/droid/settings.json'] });
      const native = { id: 'custom:Happier-provider-vendor/model-7', name: 'Happier provider: vendor/model' };
      const projected = options.definition!.models!.projectModelState!({ normalizedModelState: { currentModelId: native.id,
        availableModels: [{ id: 'vendor/model', name: 'Native model' }, { id: 'native-ineligible-model', name: 'Other native model' }, native] } });
      expect(projected).toEqual({ currentModelId: 'vendor/model', availableModels: [{ id: 'vendor/model', name: 'Custom model' }] });
      expect(options.definition!.models!.resolveModelUpdate!({ modelId: 'vendor/model', modelState: projected })).toEqual({ modelId: native.id });
      expect(options.definition!.models!.projectModelId!({ modelId: native.id, modelState: projected })).toBe('vendor/model');
      expect(() => options.definition!.models!.resolveModelUpdate!({ modelId: 'vendor/model', modelState: null })).toThrow();
      expect(() => options.definition!.models!.resolveModelUpdate!({ modelId: 'vendor/model', modelState: { currentModelId: 'native-default', availableModels: [{ id: 'vendor/model', name: 'Native model' }] } })).toThrow();
      expect(() => options.definition!.models!.projectModelState!({ normalizedModelState: { currentModelId: native.id, availableModels: [native, { ...native, id: 'custom:duplicate' }] } })).toThrow();
    } finally { await activation.dispose(); }
  });

  it('preserves native-auth launch and both detached Run entry points', async () => {
    const { activation, agent, adapter } = await registered();
    try {
      const runtime = await agent.factory!({ plugin: { id: DROID_PLUGIN.manifest.id, version: DROID_PLUGIN.manifest.version }, agent: { id: 'droid' }, signal: new AbortController().signal });
      const open = vi.fn(async (_request: AgentSessionOpenRequest, _options: AgentAcpRuntimeOptions) => ({ send: async () => ({ status: 'admitted' as const }), cancel: async () => ({ status: 'requested' as const }), watch: () => ({ dispose() {} }), dispose() {} }));
      const unbound: AgentSessionOpenRequest = { kind: 'create', sessionId: 'native-session', cwd: '/workspace' };
      await runtime.sessions!.open(unbound, { services: { connectedAccounts: { getBinding: async () => null } }, protocols: { acp: { open } } } as unknown as AgentSessionRuntimeContext);
      expect(open.mock.calls[0]![0]).toBe(unbound);
      expect(open.mock.calls[0]![1]).toEqual({ transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'droid-cli' }, args: ['exec', '--output-format', 'acp'] }, definition: { modelConfigOptionId: 'model', mcp: { policy: 'pass_through' } } });
      const materialized = await adapter.materialize(input(adapter));
      if (materialized.kind !== 'configFile') throw new Error('Expected settings file');
      const request: AgentExecutionRunOpenRequest = { kind: 'create', runId: 'droid-run', cwd: '/workspace', profile: { pluginId: DROID_PLUGIN.manifest.id, localId: 'default' }, input: { text: 'Run' },
        configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 2 }, permissionIntent: { value: 'read-only', updatedAtMs: 3 }, options: {} },
        providerBinding: { connectionId: 'pc_droid', upstream: { protocol: 'openai-chat', normalizedUrl: 'https://provider.example/v1', credential: 'apiKey' }, model: input(adapter).binding.selection.model,
          materialization: { v: 1, kind: 'configFile', rootPath: '/private/run', relativePaths: materialized.files.map(file => file.relativePath) } } };
      const run = { send: async () => ({ status: 'admitted' as const }), stop: async () => ({ status: 'requested' as const }), watch: () => ({ dispose() {} }), dispose() {} };
      const openRun = vi.fn(async (_request: AgentExecutionRunOpenRequest, _options: AgentAcpRuntimeOptions) => run);
      const openConversation = vi.fn(async (_request: AgentExecutionRunOpenRequest, _options: AgentAcpRuntimeOptions) => run);
      const context = { services: { connectedAccounts: { getBinding: async () => null } }, protocols: { acp: { openExecutionRunV1: openRun, openExecutionRunConversationV1: openConversation } } } as unknown as AgentExecutionRunRuntimeContextV1;
      await runtime.sessions!.executionRunContextV1!.open(request, context);
      await runtime.sessions!.executionRunContextV1!.openConversation!(request, context);
      for (const calls of [openRun.mock.calls, openConversation.mock.calls]) {
        expect(calls[0]![0].configuration!.model.value).toBe('vendor/model');
        expect(calls[0]![1].transport).toMatchObject({ args: ['exec', '--output-format', 'acp', '--settings', '/private/run/droid/settings.json'] });
      }
    } finally { await activation.dispose(); }
  });
});
