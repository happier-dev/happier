import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionConfigurationSnapshot, AgentExecutionRunRuntimeContextV1, AgentExecutionRunRuntime, AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';
import { activate, PLUGIN_MANIFEST } from '../index.js';
import { join } from 'node:path';
import { ProviderPublicHeadersV1Schema } from '@happier-dev/protocol';

function materializeInput(adapter: AgentProviderBindingAdapter, publicHeaders: Readonly<Record<string, string>>): AgentProviderBindingMaterializeInput {
  const transport = { id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
    destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } as const;
  return {
    v: 1,
    prepared: adapter.prepare({ v: 1, agentTargetKey: 'agent-target', connectionId: 'gateway',
      model: { id: 'selected-model', name: 'Selected model' } }),
    binding: { v: 1, agentTargetKey: 'agent-target', contributionKey: null,
      selection: { connectionId: 'gateway', model: { id: 'selected-model', name: 'Selected model',
        capabilities: { reasoningControls: 'supported' } } },
      endpoint: { endpointTemplateId: 'responses', normalizedUrl: 'http://127.0.0.1:7777/v1',
        protocol: 'openai-responses', publicHeaders },
      runtimeCredentialTransport: transport, compatibilityFingerprint: 'admitted' },
    credential: { kind: 'apiKey', transport, value: 'fake-downstream-only' },
  };
}

// The native extension API is an external system boundary; registration and
// materialization use the real admitted plugin contribution.
describe('Oh My Pi selected Provider binding', () => {
  it('preserves literal public headers and the selected Responses source without guessed model limits', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const adapter = fixture.registration('agents', 'ohmypi')?.providerBinding;
    expect(adapter, 'selected Provider binding must be registered').toBeDefined();
    if (!adapter) throw new Error('selected Provider binding is missing');
    const input = materializeInput(adapter, { 'x-source': 'selected', 'x-literal': '!literal $HOME', 'x-spaces': ' ' });
    const materialized = await adapter.materialize(input);
    expect(materialized).toMatchObject({ kind: 'configFile', nativeHome: true });
    if (materialized.kind !== 'configFile') throw new Error('Expected private extension');
    expect(materialized.files).toHaveLength(1);
    const source = materialized.files[0]!.utf8;
    expect(source).not.toContain('fake-downstream-only');
    const registration: unknown[][] = [];
    const extension = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const headerKeys = ['HAPPIER_OH_MY_PI_PROVIDER_HEADER_0', 'HAPPIER_OH_MY_PI_PROVIDER_HEADER_1', 'HAPPIER_OH_MY_PI_PROVIDER_HEADER_2'] as const;
    const previousHeaders = headerKeys.map(key => process.env[key]);
    const previous = process.env.HAPPIER_OH_MY_PI_PROVIDER_API_KEY;
    process.env.HAPPIER_OH_MY_PI_PROVIDER_API_KEY = 'fake-downstream-only';
    try {
      await extension.default({ registerProvider: (...args: unknown[]) => registration.push(args) });
      // Native config resolves an environment reference once, preserving literal !/$ data.
      expect(process.env[headerKeys[0]]).toBe('selected');
      expect(process.env[headerKeys[1]]).toBe('!literal $HOME');
      expect(process.env[headerKeys[2]]).toBe(' ');
    }
    finally { if (previous === undefined) delete process.env.HAPPIER_OH_MY_PI_PROVIDER_API_KEY; else process.env.HAPPIER_OH_MY_PI_PROVIDER_API_KEY = previous;
      headerKeys.forEach((key, index) => { const value = previousHeaders[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    }
    expect(registration).toEqual([['happier-provider', {
      api: 'openai-responses', baseUrl: input.binding.endpoint.normalizedUrl,
      apiKey: 'HAPPIER_OH_MY_PI_PROVIDER_API_KEY', headers: {
        'x-source': 'HAPPIER_OH_MY_PI_PROVIDER_HEADER_0', 'x-literal': 'HAPPIER_OH_MY_PI_PROVIDER_HEADER_1',
        'x-spaces': 'HAPPIER_OH_MY_PI_PROVIDER_HEADER_2',
      },
      models: [{ id: 'selected-model', name: 'Selected model', reasoning: true }],
    }]]);
    expect(materialized.env).toContainEqual({ name: 'HAPPIER_OH_MY_PI_PROVIDER_API_KEY', value: 'fake-downstream-only', source: 'provider' });
  });
  it('refuses admitted empty public headers that native string configuration cannot preserve', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const adapter = fixture.registration('agents', 'ohmypi')?.providerBinding;
      if (!adapter) throw new Error('Expected selected Provider adapter');
      const input = materializeInput(adapter, ProviderPublicHeadersV1Schema.parse({ 'x-empty': '' }));
      await expect(Promise.resolve().then(() => adapter.materialize(input))).rejects.toBeInstanceOf(Error);
    } finally { await fixture.dispose(); }
  });

  it.each(['create', 'resume'] as const)('launches the selected model on the native %s ACP route', async (kind) => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = fixture.registration('agents', 'ohmypi')?.factory;
    if (!factory) throw new Error('Expected native Agent factory');
    const runtime = await factory({ plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' }, agent: { id: 'ohmypi' }, signal: new AbortController().signal });
    const updateConfiguration = vi.fn(async (_configuration: AgentSessionConfigurationSnapshot) => ({ status: 'applied' as const, changed: ['model'] as const }));
    const session = { send: vi.fn(async () => ({ status: 'admitted' as const })), updateConfiguration, watch: () => ({ dispose() {} }), dispose: vi.fn() } satisfies AgentSessionRuntime;
    const open = vi.fn(async (_request: AgentSessionOpenRequest, _options: AgentAcpRuntimeOptions) => session);
    const request: AgentSessionOpenRequest = {
      ...(kind === 'resume' ? { kind: 'resume', providerSessionId: 'native-session' } as const : { kind: 'create' } as const), sessionId: 'bound-session', cwd: '/workspace',
      configuration: { model: { value: 'vendor/selected-model', updatedAtMs: 1 }, mode: { value: null, updatedAtMs: 1 }, permissionIntent: { value: null, updatedAtMs: 1 }, options: {} },
      providerBinding: { connectionId: 'gateway', upstream: { protocol: 'openai-responses', normalizedUrl: 'http://127.0.0.1:7777/v1', credential: 'apiKey' },
        model: { id: 'vendor/selected-model', name: 'Selected' },
        materialization: { v: 1, kind: 'configFile', rootPath: '/private/binding', relativePaths: ['provider.mjs'] } },
    };
    // Host services and the ACP transport are the public plugin system boundaries.
    const context = { protocols: { acp: { open } }, signal: new AbortController().signal,
      services: { connectedAccounts: { getBinding: async () => null, materialize: vi.fn(), watch: (_purpose: string, listener: (event: {kind: 'resync'; authorityChanged: boolean}) => void) => {
        queueMicrotask(() => listener({ kind: 'resync', authorityChanged: false })); return { dispose() {} };
      } } } } as unknown as AgentSessionRuntimeContext;
    const opened = await runtime.sessions.open(request, context);
    expect(open).toHaveBeenCalledWith(request, expect.objectContaining({ transport: expect.objectContaining({
      args: ['acp', '--extension', join('/private/binding', 'provider.mjs'), '--model', 'happier-provider/vendor/selected-model'],
    }) }));
    const codec = open.mock.calls[0]![1].definition?.models;
    const native = { id: 'happier-provider/vendor/selected-model', name: 'Selected' };
    expect(codec?.projectModel({}, native).id).toBe(native.id);
    expect(codec?.projectModelId?.({ modelId: native.id, modelState: null })).toBe('vendor/selected-model');
    expect(codec?.projectModelState?.({ normalizedModelState: { currentModelId: native.id, availableModels: [native] } })).toEqual({
      currentModelId: 'vendor/selected-model', availableModels: [{ ...native, id: 'vendor/selected-model' }],
    });
    expect(codec?.resolveModelUpdate?.({ modelId: 'vendor/selected-model', modelState: null })).toEqual({ modelId: native.id });
    await opened.dispose(); await fixture.dispose();
  });

  it('uses the same selected source for finite native ACP execution', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = fixture.registration('agents', 'ohmypi')?.factory;
    if (!factory) throw new Error('Expected native Agent factory');
    const runtime = await factory({ plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' }, agent: { id: 'ohmypi' }, signal: new AbortController().signal });
    const run = { send: vi.fn(async () => ({ status: 'admitted' as const })), stop: vi.fn(async () => ({ status: 'requested' as const })), watch: () => ({ dispose() {} }), dispose: vi.fn() } satisfies AgentExecutionRunRuntime;
    const openExecutionRunV1 = vi.fn(async () => run);
    const request = { kind: 'create' as const, runId: 'bound-run', cwd: '/workspace', profile: { pluginId: 'happier.agent.ohmypi', localId: 'default' }, input: { text: 'Run once.' },
      providerBinding: { connectionId: 'gateway', upstream: { protocol: 'openai-responses', normalizedUrl: 'http://127.0.0.1:7777/v1', credential: 'apiKey' as const },
        model: { id: 'vendor/selected-model', name: 'Selected' },
        materialization: { v: 1 as const, kind: 'configFile' as const, rootPath: '/private/binding', relativePaths: ['provider.mjs'] } } };
    const context = { protocols: { acp: { openExecutionRunV1 } }, signal: new AbortController().signal,
      services: { connectedAccounts: { getBinding: async () => null, materialize: vi.fn(), watch: (_purpose: string, listener: (event: {kind: 'resync'; authorityChanged: boolean}) => void) => {
        queueMicrotask(() => listener({ kind: 'resync', authorityChanged: false })); return { dispose() {} };
      } } } } as unknown as AgentExecutionRunRuntimeContextV1;
    const opened = await runtime.sessions.executionRunContextV1?.open(request, context);
    expect(openExecutionRunV1).toHaveBeenCalledWith(request, expect.objectContaining({ transport: expect.objectContaining({
      args: ['acp', '--extension', join('/private/binding', 'provider.mjs'), '--model', 'happier-provider/vendor/selected-model'],
    }) }));
    await opened?.dispose(); await fixture.dispose();
  });

});
