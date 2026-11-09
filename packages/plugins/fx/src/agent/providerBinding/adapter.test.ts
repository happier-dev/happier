import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentAcpRuntimeOptions, AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1, AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginExecSpawnRequest } from '@happier-dev/plugin-sdk/exec';
import { AgentProviderBindingMaterializationV1Schema } from '@happier-dev/protocol/providers/materialization/v1';
import { describe, expect, it, vi } from 'vitest';
import { authorizeResolvedAgentNativeExecLaunchForHost, createStablePluginExecService, issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';

import { FX_PLUGIN } from '../../manifest.js';
import { VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION } from '../../../../vercel-ai-gateway/src/provider/contribution.js';

function input(adapter: AgentProviderBindingAdapter): AgentProviderBindingMaterializeInput {
  const provider = VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION;
  const transport = provider.credential.transports[0]!;
  const endpoint = provider.endpointTemplates.find(candidate => candidate.protocol === 'openai-chat')!;
  return { v: 1, prepared: adapter.prepare({ v: 1, connectionId: 'pc_fx', agentTargetKey: 'agent:happier.agent.fx/fx' }),
    binding: { v: 1, agentTargetKey: 'agent:happier.agent.fx/fx', selection: { connectionId: 'pc_fx', model: { id: 'anthropic/claude-sonnet-4.6', name: 'Sonnet' } },
      contributionKey: 'happier.provider.vercel-ai-gateway/vercel-ai-gateway',
      endpoint: { endpointTemplateId: endpoint.id, normalizedUrl: endpoint.baseUrl, protocol: endpoint.protocol, publicHeaders: endpoint.publicHeaders },
      runtimeCredentialTransport: transport, compatibilityFingerprint: 'pcf1:fx-fixture' }, credential: { kind: 'apiKey', transport, value: 'selected-fixture-key' } };
}

describe('registered FX Provider binding', () => {
  it.each(['session', 'run'] as const)('admits the bound %s status child through the real native Exec environment owner', async lane => {
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    const controller = new AbortController();
    try {
      const agent = activation.registration('agents', 'fx');
      if (!agent?.factory) throw new Error('FX runtime factory missing');
      const runtime = await agent.factory({ plugin: { id: FX_PLUGIN.manifest.id, version: FX_PLUGIN.manifest.version }, agent: { id: 'fx' }, signal: controller.signal });
      const environment = { AI_GATEWAY_API_KEY: 'selected-fixture-key', FX_PROVIDER: 'gateway', FX_MODEL: 'anthropic/claude-sonnet-4.6', FX_AUTH_MODE: 'local' };
      let nativePreparations = 0;
      // Only executable resolution is a fake OS boundary. Admission, environment
      // filtering, native qualification, process launch and capture are real.
      const exec = createStablePluginExecService({ allowedExecutables: [{ kind: 'systemTool', id: 'fx-cli' }],
        allowedEnvKeys: [], environment, signal: controller.signal, isOccurrenceCurrent: () => true,
        resolveExecutable: async () => ({ command: process.execPath, args: ['-e', `
          const selected = process.env.AI_GATEWAY_API_KEY === 'selected-fixture-key'
            && process.env.FX_PROVIDER === 'gateway' && process.env.FX_AUTH_MODE === 'local'
            && !process.env.VERCEL_OIDC_TOKEN && !process.env.FX_GATEWAY_BASE_URL;
          process.stdout.write(JSON.stringify({kind:'status',auth:selected?'AI_GATEWAY_API_KEY':'missing',auth_refreshable:false,model:process.env.FX_MODEL}));
        `, '--'] }), resolvePath: async () => process.cwd(),
        prepareAgentNativeLaunch: async () => { nativePreparations += 1; },
      });
      const nativeLaunch = issueAgentNativeLaunchQualifierForHost(exec);
      const binding = { connectionId: 'pc_fx', upstream: { protocol: 'openai-chat' as const, normalizedUrl: 'https://ai-gateway.vercel.sh/coding-agent/v1', credential: 'apiKey' as const }, model: { id: environment.FX_MODEL, name: 'Sonnet' }, materialization: { v: 1 as const, kind: 'spawnEnv' as const } };
      let opened = false;
      const open = async () => {
        expect(nativePreparations).toBe(1);
        const launch = await authorizeResolvedAgentNativeExecLaunchForHost(exec, { command: process.execPath, args: [], cwd: process.cwd(), env: environment }, controller.signal, nativeLaunch);
        try { expect(launch.env).toMatchObject(environment); expect(launch.env).not.toHaveProperty('VERCEL_OIDC_TOKEN'); }
        finally { await launch.release(); }
        opened = true;
        return {} as never;
      };
      const common = { signal: controller.signal, services: { exec }, protocols: { acp: { open, openExecutionRunV1: open } } };
      if (lane === 'session') await runtime.sessions!.open({ kind: 'create', sessionId: 'bound-fx', cwd: process.cwd(), providerBinding: binding },
        { ...common, session: { id: 'bound-fx', services: { nativeLaunch } } } as unknown as AgentSessionRuntimeContext);
      else await runtime.sessions!.executionRunContextV1!.open({ kind: 'create', runId: 'bound-fx', cwd: process.cwd(), providerBinding: binding, profile: { pluginId: FX_PLUGIN.manifest.id, localId: 'default' }, input: { text: 'Reply OK' } },
        { ...common, executionRun: { services: { nativeLaunch } } } as unknown as AgentExecutionRunRuntimeContextV1);
      expect(opened).toBe(true);
    } finally { controller.abort(); await activation.dispose(); }
  });

  it('passes native stop, recovery and usage codecs to the canonical host ACP composer', async () => {
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    try {
      const agent = activation.registration('agents', 'fx');
      if (!agent?.factory) throw new Error('FX runtime factory missing');
      const runtime = await agent.factory({ plugin: { id: FX_PLUGIN.manifest.id, version: FX_PLUGIN.manifest.version }, agent: { id: 'fx' }, signal: new AbortController().signal });
      const context = { protocols: { acp: { open: async (_request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) => {
        expect(options.definition?.sessionUpdates?.projectStopReason?.('refused')).toBe('refusal');
        expect(options.definition?.sessionUpdates?.project({ sessionUpdate: 'session_info_update', _meta: { fx: { modelResponseRecovery: { state: 'paused', requiredAction: 'retry' } } } })).toMatchObject({ diagnostic: { code: 'provider_recovery_paused', details: { state: 'paused', requiredAction: 'retry' } } });
        expect(options.definition?.usage?.projectPromptUsage({ usage: { inputTokens: 17, outputTokens: 7, cacheReadTokens: 5, reasoningTokens: 3 }, promptResponse: {} })).toEqual({ inputTokens: 17, outputTokens: 7, cacheReadTokens: 5, reasoningTokens: 3, totalTokens: 24 });
        return {} as never;
      } } } } as unknown as AgentSessionRuntimeContext;
      await runtime.sessions!.open({ kind: 'create', sessionId: 'fx-codecs', cwd: '/workspace' }, context);
    } finally { await activation.dispose(); }
  });

  it('materializes the selected Gateway key and model only in the child environment', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'inherited-rival-key');
    vi.stubEnv('VERCEL_OIDC_TOKEN', 'inherited-oidc');
    vi.stubEnv('FX_PROVIDER', 'codex');
    vi.stubEnv('FX_MODEL', 'inherited-model');
    vi.stubEnv('FX_AUTH_MODE', 'host-managed');
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    try {
      const adapter = activation.registration('agents', 'fx')?.providerBinding;
      expect(adapter).toBeDefined();
      if (!adapter) throw new Error('FX Provider adapter missing');
      const result = await adapter.materialize(input(adapter));
      expect(AgentProviderBindingMaterializationV1Schema.parse(result)).toEqual(result);
      expect(result.kind).toBe('spawnEnv');
      const env = Object.fromEntries(result.env.map(row => [row.name, row.value]));
      expect(env).toMatchObject({ AI_GATEWAY_API_KEY: 'selected-fixture-key', VERCEL_OIDC_TOKEN: null, FX_PROVIDER: 'gateway', FX_MODEL: 'anthropic/claude-sonnet-4.6', FX_AUTH_MODE: 'local', FX_GATEWAY_BASE_URL: null });
      expect(result.env.map(row => row.name).sort()).toEqual([...FX_PLUGIN.manifest.contributes.agents[0]!.providerRequirements!.authIsolation.ownedEnvKeys].sort());
      expect(result).not.toHaveProperty('files');
      const base = input(adapter);
      const transport = base.binding.runtimeCredentialTransport!;
      // This external boundary is semantic data; JSON key insertion order
      // cannot change which admitted bearer transport the key belongs to.
      expect(await adapter.materialize({ ...base, credential: { kind: 'apiKey', value: 'selected-fixture-key',
        transport: { destination: transport.destination, uses: transport.uses, protocols: transport.protocols, id: transport.id },
      } })).toEqual(result);
    } finally { vi.unstubAllEnvs(); await activation.dispose(); }
  });

  it('refuses unsupported Provider endpoints and credentials instead of silently using Gateway', async () => {
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    try {
      const adapter = activation.registration('agents', 'fx')?.providerBinding;
      if (!adapter) throw new Error('FX Provider adapter missing');
      const base = input(adapter);
      const unsupported: AgentProviderBindingMaterializeInput[] = [
        { ...base, credential: { kind: 'none' as const } },
        { ...base, binding: { ...base.binding, contributionKey: null } },
        { ...base, binding: { ...base.binding, endpoint: { ...base.binding.endpoint, normalizedUrl: 'https://custom.example/v1' } } },
        { ...base, binding: { ...base.binding, endpoint: { ...base.binding.endpoint, publicHeaders: { 'X-Project': 'custom' } } } },
        { ...base, credential: { kind: 'apiKey', transport: base.binding.runtimeCredentialTransport!, value: '' } },
      ];
      for (const candidate of unsupported) await expect(Promise.resolve().then(() => adapter.materialize(candidate))).rejects.toThrow();
    } finally { await activation.dispose(); }
  });

  it.each(['create', 'resume'] as const)('verifies the native credential source once before opening a bound %s', async kind => {
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    try {
      const agent = activation.registration('agents', 'fx');
      if (!agent?.factory) throw new Error('FX runtime factory missing');
      const runtime = await agent.factory({ plugin: { id: FX_PLUGIN.manifest.id, version: FX_PLUGIN.manifest.version }, agent: { id: 'fx' }, signal: new AbortController().signal });
      const request: AgentSessionOpenRequest = { ...(kind === 'create' ? { kind } : { kind, providerSessionId: 'native-fx' }), sessionId: 'fx-test', cwd: '/workspace',
        providerBinding: { connectionId: 'pc_fx', upstream: { protocol: 'openai-chat', normalizedUrl: 'https://ai-gateway.vercel.sh/coding-agent/v1', credential: 'apiKey' }, model: { id: 'anthropic/claude-sonnet-4.6', name: 'Sonnet' }, materialization: { v: 1, kind: 'spawnEnv' } } };
      let source = 'fx login';
      let probes = 0;
      let opened = 0;
      // The host process service is the genuine plugin↔host boundary. It supplies
      // the finalized Provider environment; the plugin never reads credential values.
      const context = { signal: new AbortController().signal, session: { services: { nativeLaunch: Object.freeze({}) } }, services: { exec: { run: async (command: PluginExecSpawnRequest) => {
        probes += 1;
        expect(command).toEqual({ executable: { kind: 'systemTool', id: 'fx-cli' }, args: ['status', '--json'], cwd: '/workspace' });
        return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } }, stdout: new TextEncoder().encode(JSON.stringify({ kind: 'status', auth: source, auth_refreshable: source === 'fx login', model: 'anthropic/claude-sonnet-4.6' })), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
      } } }, protocols: { acp: { open: async (openedRequest: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) => {
        opened += 1;
        expect(openedRequest).toBe(request);
        expect(options.transport).toEqual({ kind: 'stdio', executable: { kind: 'systemTool', id: 'fx-cli' }, args: ['acp'] });
        return { send: async () => ({ status: 'admitted' as const }), cancel: async () => ({ status: 'requested' as const }), watch: () => ({ dispose() {} }), dispose() {} };
      } } } } as unknown as AgentSessionRuntimeContext;
      await expect(runtime.sessions!.open(request, context)).rejects.toMatchObject({ code: 'fx_provider_credential_source_mismatch' });
      expect(opened).toBe(0);
      source = 'AI_GATEWAY_API_KEY';
      await runtime.sessions!.open(request, context);
      expect(opened).toBe(1);
      expect(probes).toBe(2);
      await expect(runtime.sessions!.open(request, { ...context, session: { services: {} } } as AgentSessionRuntimeContext))
        .rejects.toMatchObject({ code: 'fx_provider_credential_source_mismatch' });
      expect(probes).toBe(2);
      await runtime.sessions!.open({ kind: 'create', sessionId: 'native', cwd: '/workspace' }, { ...context, protocols: { acp: { open: async () => { opened += 1; return {} as never; } } } } as AgentSessionRuntimeContext);
      expect(probes).toBe(2);
    } finally { await activation.dispose(); }
  });

  it('uses the same credential check for finite and retained detached Runs', async () => {
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    try {
      const agent = activation.registration('agents', 'fx');
      if (!agent?.factory) throw new Error('FX runtime factory missing');
      const runtime = await agent.factory({ plugin: { id: FX_PLUGIN.manifest.id, version: FX_PLUGIN.manifest.version }, agent: { id: 'fx' }, signal: new AbortController().signal });
      const request: AgentExecutionRunOpenRequest = { kind: 'create', runId: 'fx-run', cwd: '/workspace', profile: { pluginId: FX_PLUGIN.manifest.id, localId: 'default' }, input: { text: 'Reply OK' },
        providerBinding: { connectionId: 'pc_fx', upstream: { protocol: 'openai-chat', normalizedUrl: 'https://ai-gateway.vercel.sh/coding-agent/v1', credential: 'apiKey' }, model: { id: 'anthropic/claude-sonnet-4.6', name: 'Sonnet' }, materialization: { v: 1, kind: 'spawnEnv' } } };
      let probes = 0;
      let opened = 0;
      const open = async (actual: AgentExecutionRunOpenRequest, options: AgentAcpRuntimeOptions) => {
        expect(actual).toBe(request);
        expect(options.transport).toMatchObject({ args: ['acp'] });
        opened += 1;
        return { send: async () => ({ status: 'admitted' as const }), stop: async () => ({ status: 'requested' as const }), watch: () => ({ dispose() {} }), dispose() {} };
      };
      const context = { signal: new AbortController().signal, executionRun: { services: { nativeLaunch: Object.freeze({}) } }, services: { exec: { run: async () => {
        probes += 1;
        return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } }, stdout: new TextEncoder().encode(JSON.stringify({ kind: 'status', auth: 'AI_GATEWAY_API_KEY', auth_refreshable: false, model: request.providerBinding!.model.id })), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
      } } }, protocols: { acp: { openExecutionRunV1: open, openExecutionRunConversationV1: open } } } as unknown as AgentExecutionRunRuntimeContextV1;
      await runtime.sessions!.executionRunContextV1!.open(request, context);
      await runtime.sessions!.executionRunContextV1!.openConversation!(request, context);
      expect(opened).toBe(2);
      expect(probes).toBe(2);
    } finally { await activation.dispose(); }
  });
});
