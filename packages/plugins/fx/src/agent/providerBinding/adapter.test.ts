import { PluginError } from '@happier-dev/plugin-sdk';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentAcpRuntimeOptions, AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1, AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginExecSpawnRequest } from '@happier-dev/plugin-sdk/exec';
import { AgentProviderBindingMaterializationV1Schema } from '@happier-dev/protocol/providers/materialization/v1';
import { describe, expect, it, vi } from 'vitest';
import { authorizeResolvedAgentNativeExecLaunchForHost, createStablePluginExecService, issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';

import { sanitizeNativeAgentSessionBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { readSessionPreparationFailureDiagnostic } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { composeProviderBindingMaterialization } from '@/providers/spawn/compose';
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
  it.each(['apiKey', 'none'] as const)('materializes a configured Chat endpoint with %s auth and the selected model in private native settings', async kind => {
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    try {
      const adapter = activation.registration('agents', 'fx')?.providerBinding;
      if (!adapter) throw new Error('FX Provider adapter missing');
      const base = input(adapter);
      const result = await adapter.materialize({ ...base,
        binding: { ...base.binding, contributionKey: null,
          endpoint: { ...base.binding.endpoint, endpointTemplateId: 'custom-chat', normalizedUrl: 'http://127.0.0.1:2345/v1', publicHeaders: {} },
          runtimeCredentialTransport: kind === 'none' ? null : base.binding.runtimeCredentialTransport },
        credential: kind === 'none' ? { kind: 'none' } : base.credential,
      });
      expect(result.kind).toBe('configFile');
      if (result.kind !== 'configFile') throw new Error('Expected private config');
      expect(result).toHaveProperty('nativeHome', true);
      const settings = JSON.parse(result.files.find(file => file.relativePath === '.fx/settings.json')!.utf8);
      expect(settings.models.happier).toBe(base.binding.selection.model.id);
      expect(settings.providers.happier).toEqual({ protocol: 'openai-chat-completions', base_url: 'http://127.0.0.1:2345/v1',
        auth: kind === 'none' ? { type: 'none' } : { type: 'bearer', env: 'HAPPIER_FX_PROVIDER_API_KEY' }, tool_choice_mode: 'omit' });
      expect(JSON.stringify(result.files)).not.toContain('selected-fixture-key');
      expect(Object.fromEntries(result.env.map(row => [row.name, row.value]))).toMatchObject({
        FX_PROVIDER: 'happier', FX_MODEL: base.binding.selection.model.id, AI_GATEWAY_API_KEY: null,
        HAPPIER_FX_PROVIDER_API_KEY: kind === 'none' ? null : 'selected-fixture-key',
      });
    } finally { await activation.dispose(); }
  });
  it.each(['session', 'run'] as const)('admits the bound %s status child through the real native Exec environment owner', async lane => {
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    const controller = new AbortController();
    let cleanup: (() => void) | null = null;
    try {
      const agent = activation.registration('agents', 'fx');
      if (!agent?.factory || !agent.providerBinding || !agent.connectedAccountLaunch?.stateSharingDescriptor) throw new Error('FX runtime factory or native binding missing');
      const runtime = await agent.factory({ plugin: { id: FX_PLUGIN.manifest.id, version: FX_PLUGIN.manifest.version }, agent: { id: 'fx' }, signal: controller.signal });
      const adapter = agent.providerBinding;
      const base = input(adapter);
      const source = await mkdtemp(join(tmpdir(), 'happier-fx-native-provider-'));
      const materialization = await adapter.materialize({ ...base,
        binding: { ...base.binding, contributionKey: null,
          endpoint: { ...base.binding.endpoint, endpointTemplateId: 'custom-chat', normalizedUrl: 'http://127.0.0.1:2345/v1', publicHeaders: {} },
          runtimeCredentialTransport: lane === 'run' ? null : base.binding.runtimeCredentialTransport },
        credential: lane === 'run' ? { kind: 'none' } : base.credential,
      });
      const composed = await composeProviderBindingMaterialization({ materialization,
        materializationBaseDir: join(source, 'materialized'),
        nativeHome: { descriptor: { ...agent.connectedAccountLaunch.stateSharingDescriptor, providerId: 'fx' }, sourceEnvironment: { HOME: source }, homeDir: source },
      });
      cleanup = composed.cleanup;
      const environment = Object.fromEntries(composed.providerEnvironmentOverlay.flatMap(row => row.value === null ? [] : [[row.name, row.value]]));
      let nativePreparations = 0;
      // Only executable resolution is a fake OS boundary. Admission, environment
      // filtering, native qualification, process launch and capture are real.
      const exec = createStablePluginExecService({ allowedExecutables: [{ kind: 'systemTool', id: 'fx-cli' }],
        allowedEnvKeys: [], environment, signal: controller.signal, isOccurrenceCurrent: () => true,
        resolveExecutable: async () => ({ command: process.execPath, args: ['-e', `
          const { readFileSync } = require('node:fs');
          const { join } = require('node:path');
          const settings = JSON.parse(readFileSync(join(process.env.HOME, '.fx/settings.json'), 'utf8'));
          const provider = settings.providers[process.env.FX_PROVIDER];
          const selected = provider.base_url === 'http://127.0.0.1:2345/v1'
            && provider.protocol === 'openai-chat-completions'
            && (provider.auth.type === 'none' || process.env[provider.auth.env] === 'selected-fixture-key')
            && !process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN && !process.env.FX_GATEWAY_BASE_URL;
          process.stdout.write(JSON.stringify({kind:'status',auth:selected?'configured provider':'missing',auth_refreshable:false,model:settings.models[process.env.FX_PROVIDER]}));
        `, '--'] }), resolvePath: async () => process.cwd(),
        prepareAgentNativeLaunch: async () => { nativePreparations += 1; },
      });
      const nativeLaunch = issueAgentNativeLaunchQualifierForHost(exec);
      const binding = { connectionId: 'pc_fx', upstream: { protocol: 'openai-chat' as const, normalizedUrl: 'http://127.0.0.1:2345/v1', credential: lane === 'run' ? 'none' as const : 'apiKey' as const }, model: base.binding.selection.model, materialization: composed.launchMaterialization };
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
    } finally { controller.abort(); cleanup?.(); await activation.dispose(); }
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

  it('materializes the native Gateway route with the selected key and saved model', async () => {
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
      expect(result.kind).toBe('configFile');
      const env = Object.fromEntries(result.env.map(row => [row.name, row.value]));
      expect(env).toMatchObject({ AI_GATEWAY_API_KEY: 'selected-fixture-key', VERCEL_OIDC_TOKEN: null, FX_PROVIDER: 'gateway', FX_MODEL: 'anthropic/claude-sonnet-4.6', FX_AUTH_MODE: 'local', FX_GATEWAY_BASE_URL: null });
      expect(result.env.map(row => row.name).sort()).toEqual([...FX_PLUGIN.manifest.contributes.agents[0]!.providerRequirements!.authIsolation.ownedEnvKeys].sort());
      if (result.kind !== 'configFile') throw new Error('Expected private config');
      expect(result.nativeHome).toBe(true);
      expect(JSON.parse(result.files[0]!.utf8)).toMatchObject({ models: { gateway: 'anthropic/claude-sonnet-4.6' }, credential_source: 'ai_gateway_api_key' });
      expect(JSON.stringify(result.files)).not.toContain('selected-fixture-key');
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
        { ...base, binding: { ...base.binding, endpoint: { ...base.binding.endpoint, protocol: 'openai-responses' } } },
        { ...base, binding: { ...base.binding, contributionKey: null, endpoint: { ...base.binding.endpoint, normalizedUrl: 'https://custom.example/v1', publicHeaders: { 'X-Project': 'custom' } } } },
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
        providerBinding: { connectionId: 'pc_fx', upstream: { protocol: 'openai-chat', normalizedUrl: 'http://127.0.0.1:2345/v1', credential: kind === 'create' ? 'apiKey' : 'none' }, model: { id: 'anthropic/claude-sonnet-4.6', name: 'Sonnet' }, materialization: { v: 1, kind: 'configFile', rootPath: '/private/provider', relativePaths: ['.fx/settings.json'] } } };
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
        expect(openedRequest).toEqual(request);
        expect(options.transport).toEqual({ kind: 'stdio', executable: { kind: 'systemTool', id: 'fx-cli' }, args: ['acp'] });
        return { send: async () => ({ status: 'admitted' as const }), cancel: async () => ({ status: 'requested' as const }), watch: () => ({ dispose() {} }), dispose() {} };
      } } } } as unknown as AgentSessionRuntimeContext;
      await expect(runtime.sessions!.open(request, context)).rejects.toMatchObject({ code: 'fx_provider_credential_source_mismatch' });
      expect(opened).toBe(0);
      source = 'configured provider';
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

  it.each([
    ['exec_rejected', { execError: true }],
    ['native_status_exit_failed', { exitCode: 1 }],
    ['native_status_truncated', { stdoutTruncated: true }],
    ['native_status_invalid', { malformed: true }],
    ['auth_not_confirmed', { auth: 'missing' }],
    ['auth_not_confirmed', { auth_expired: true }],
    ['credential_source_mismatch', { auth: 'fx login' }],
    ['model_mismatch', { model: 'other-model' }],
  ] as const)('preserves the closed FX verification predicate %s through startup diagnostics (%j)', async (reason, change) => {
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    try {
      const agent = activation.registration('agents', 'fx');
      if (!agent?.factory) throw new Error('FX runtime factory missing');
      const runtime = await agent.factory({ plugin: { id: FX_PLUGIN.manifest.id, version: FX_PLUGIN.manifest.version }, agent: { id: 'fx' }, signal: new AbortController().signal });
      const request: AgentSessionOpenRequest = { kind: 'create', sessionId: 'fx-test', cwd: '/workspace',
        providerBinding: { connectionId: 'pc_fx', upstream: { protocol: 'openai-chat', normalizedUrl: 'https://provider.example/v1', credential: 'apiKey' },
          model: { id: 'selected-model', name: 'Selected' }, materialization: { v: 1, kind: 'configFile', rootPath: '/private/provider', relativePaths: ['.fx/settings.json'] } } };
      // Native process status is the external boundary; its unselected data must
      // never escape with the closed predicate identifying this refusal.
      const context = { signal: new AbortController().signal, session: { services: { nativeLaunch: Object.freeze({}) } },
        services: { exec: { run: async () => {
          if ('execError' in change) throw new PluginError({ code: 'plugin_exec_cwd_unavailable',
            message: 'Native working directory unavailable', details: { failureCause: { phase: 'client_start',
              failureReason: 'unknown', providerErrorCode: 'plugin_exec_cwd_unavailable' } } });
          return ({ termination: { observed: { kind: 'exit', exitCode: 'exitCode' in change ? change.exitCode : 0 }, requestedBy: { kind: 'none' } },
          stdout: new TextEncoder().encode('malformed' in change ? 'PRIVATE_NATIVE_OUTPUT' : JSON.stringify({ kind: 'status', auth: 'configured provider', auth_refreshable: false, model: 'selected-model', private: 'PRIVATE_NATIVE_OUTPUT', ...change })),
          stderr: new TextEncoder().encode('PRIVATE_NATIVE_STDERR'), stdoutTruncated: 'stdoutTruncated' in change, stderrTruncated: false }); } } },
        protocols: { acp: { open: async () => { throw new Error('Refused status must not open ACP'); } } } } as unknown as AgentSessionRuntimeContext;
      let caught: unknown;
      try { await runtime.sessions!.open(request, context); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'execError' in change ? 'plugin_exec_cwd_unavailable' : 'fx_provider_credential_source_mismatch' });
      const diagnostic = readSessionPreparationFailureDiagnostic(sanitizeNativeAgentSessionBoundaryError(caught, true));
      expect(diagnostic.failureCause).toMatchObject('execError' in change
        ? { phase: 'client_start', failureReason: 'unknown', providerErrorCode: 'plugin_exec_cwd_unavailable' }
        : { phase: 'authentication', failureReason: 'unknown', providerErrorCode: `fx_provider_${reason}` });
      if ('exitCode' in change) expect(diagnostic.failureCause?.providerErrorMessage).toBe('FX status exited with code 1');
      expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_NATIVE');
    } finally { await activation.dispose(); }
  });

  it('uses the same credential check for finite and retained detached Runs', async () => {
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    try {
      const agent = activation.registration('agents', 'fx');
      if (!agent?.factory) throw new Error('FX runtime factory missing');
      const runtime = await agent.factory({ plugin: { id: FX_PLUGIN.manifest.id, version: FX_PLUGIN.manifest.version }, agent: { id: 'fx' }, signal: new AbortController().signal });
      const request: AgentExecutionRunOpenRequest = { kind: 'create', runId: 'fx-run', cwd: '/workspace', profile: { pluginId: FX_PLUGIN.manifest.id, localId: 'default' }, input: { text: 'Reply OK' },
        providerBinding: { connectionId: 'pc_fx', upstream: { protocol: 'openai-chat', normalizedUrl: 'https://ai-gateway.vercel.sh/coding-agent/v1', credential: 'apiKey' }, model: { id: 'anthropic/claude-sonnet-4.6', name: 'Sonnet' }, materialization: { v: 1, kind: 'configFile', rootPath: '/private/provider', relativePaths: ['.fx/settings.json'] } } };
      let probes = 0;
      let opened = 0;
      const open = async (actual: AgentExecutionRunOpenRequest, options: AgentAcpRuntimeOptions) => {
        expect(actual).toEqual(request);
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
