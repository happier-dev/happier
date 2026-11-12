import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConnectedAccountRuntime, ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentAcpRuntimeOptions, AgentRuntimeContext, AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpMcpPolicyFixture } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { OPENAI_SELECTED_API_KEY_ENV } from '@happier-dev/plugins-openai/connected-account-service';
import * as plugin from '../manifest.js';
import { anthropicConnectedAccountRuntime } from '../../../claude/src/connectedAccounts/anthropicRuntime.js';
import { openAiConnectedAccountRuntime } from '../../../openai/src/auth/connectedAccountRuntime.js';
import { geminiConnectedAccountRuntime } from '../../../gemini/src/connectedAccounts/runtime.js';
import { QWEN_ACCOUNT_SOURCES, prepareQwenConnectedAccount } from './connectedAccount.js';
import { QWEN_ACP_COMMAND } from './acp/preflight.js';
import { QWEN_ACP_RUNTIME_DEFINITION } from './acp/definition.js';
import { projectAgentConnectedAccountLaunchCatalogEntry } from '../../../../../apps/cli/src/plugins/projection/registry/agentCatalogEntryHooks.js';

describe('Qwen native account launch', () => {
  it.each(['session', 'preflight'] as const)('delivers selected OpenAI settings to the native child through the public ACP composer (%s)', async entry => {
    const source = QWEN_ACCOUNT_SOURCES.find(row => row.purpose === 'openai-api-key')!;
    const account = { service: source.service, accountId: 'selected' };
    const materializationContext = { signal: new AbortController().signal, configuration: { values: {} },
      credentials: { async get(key: string) { return key === 'token' ? 'fake-native-openai' : null; } },
    } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    const accounts: Pick<ConnectedAccountsService, 'getBinding' | 'materialize'> = {
      async getBinding(purpose) { return purpose === source.purpose ? { purpose, service: source.service, account,
        target: { kind: 'account', displayName: 'Selected' } } : null; },
      materialize(_purpose, request) { return openAiConnectedAccountRuntime.materialize(request, materializationContext); },
    };
    const activation = await createPluginTestkit({ manifest: plugin.PLUGIN_MANIFEST, module: plugin });
    const cwd = await mkdtemp(join(tmpdir(), 'qwen-account-launch-'));
    let session: AgentSessionRuntime | undefined;
    let fixture: ReturnType<typeof createAcpMcpPolicyFixture> | undefined;
    let disposePreflight: (() => void | Promise<void>) | undefined;
    try {
      const agent = activation.registration('agents', 'qwen')!;
      const parsed = parsePluginManifest(plugin.PLUGIN_MANIFEST);
      if (!parsed.ok) throw new Error('Invalid authored manifest');
      const declaration = parsed.manifest.contributes.agents.find(row => row.id === 'qwen');
      if (!declaration) throw new Error('Missing Qwen Agent');
      fixture = createAcpMcpPolicyFixture({ agent: declaration, pluginId: plugin.PLUGIN_MANIFEST.id, toolWireFormat: 'underscore',
        ...(entry === 'session' ? { models: { currentModelId: 'native-default', availableModels: [
          { modelId: 'selected-model(openai)', name: 'Selected' }, { modelId: 'native-default', name: 'Native default' },
        ] } } : {}),
        async factory(context) {
          const native = await agent.factory!(context);
          return { ...native, sessions: { ...native.sessions, open(request, host) {
            if (entry === 'preflight') return (async () => {
              const input = { modelId: 'selected-model', environment: { OPENAI_API_KEY: 'ambient' },
                connectedAccounts: { ...accounts, watch() { return { dispose() {} }; } }, signal: materializationContext.signal };
              const prepared = await agent.preflightSessionControls!.prepareLaunchEnvironment!(input);
              if (!prepared) throw new Error('Expected prepared native launch');
              disposePreflight = prepared.dispose;
              expect(prepared.catalogConfidence).toBe('account_unverified');
              return host.protocols.acp.open(request, { transport: { kind: 'stdio',
                executable: { kind: 'systemTool', id: QWEN_ACP_COMMAND.toolId },
                args: [...QWEN_ACP_COMMAND.args, ...(prepared.commandArgsSuffix ?? [])], env: prepared.environment },
                definition: QWEN_ACP_RUNTIME_DEFINITION });
            })();
            return native.sessions!.open(request, { ...host, services: { ...host.services,
              connectedAccounts: { ...host.services.connectedAccounts, ...accounts } } });
          } } };
        },
      });
      await fixture.fixtureServer.prepare({ cwd });
      session = await fixture.openSession({ kind: 'create', sessionId: 'account', cwd, configuration: {
        model: { value: 'selected-model', updatedAtMs: 1, selectionSource: 'explicit' }, mode: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {},
      } });
      const launch = fixture.observeLaunch();
      expect(launch.env[OPENAI_SELECTED_API_KEY_ENV]).toBe('fake-native-openai');
      expect(launch.env.OPENAI_API_KEY).toBe('');
      const settings = JSON.parse(readFileSync(launch.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!, 'utf8'));
      expect(settings.modelProviders.openai).toEqual([{ id: 'selected-model', envKey: OPENAI_SELECTED_API_KEY_ENV,
        baseUrl: 'https://api.openai.com/v1' }]);
      expect(JSON.stringify(settings)).not.toContain('fake-native-openai');
      expect(launch.argv.join(' ')).not.toContain('fake-native-openai');
      expect(launch.argv).toContain('selected-model');
    } finally {
      try { await session?.dispose(); } finally {
        try { await disposePreflight?.(); await fixture?.fixtureServer.dispose(); } finally { await activation.dispose(); await rm(cwd, { recursive: true, force: true }); }
      }
    }
  });
  it.each(['anthropic-api-key', 'openai-api-key', 'google-model'])('withholds native catalogs for %s before acquiring credentials', async purpose => {
    const activation = await createPluginTestkit({ manifest: plugin.PLUGIN_MANIFEST, module: plugin });
    const account = { service: QWEN_ACCOUNT_SOURCES.find(source => source.purpose === purpose)!.service, accountId: 'selected' };
    let acquired = false;
    try {
      const prepare = activation.registration('agents', 'qwen')!.preflightSessionControls!.prepareLaunchEnvironment!;
      await expect(prepare({ environment: { OPENAI_API_KEY: 'ambient' }, signal: new AbortController().signal,
        connectedAccounts: {
          async getBinding(requested) { return requested === purpose ? { purpose, service: account.service, account,
            target: { kind: 'account', displayName: 'Selected' } } : null; },
          async materialize() { acquired = true; throw new Error('Catalog must not acquire credentials without a model'); },
          watch() { return { dispose() {} }; },
        },
      })).rejects.toMatchObject({ code: 'agent_startup_model_reconciliation_failed',
        details: { failureCause: { failureReason: 'model_selection_required' } } });
      expect(acquired).toBe(false);
    } finally { await activation.dispose(); }
  });
  it.each([
    { purpose: 'anthropic-api-key', runtime: anthropicConnectedAccountRuntime, mode: 'api-key', values: { token: 'fake-selected' }, protocol: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
    { purpose: 'openai-api-key', runtime: openAiConnectedAccountRuntime, mode: 'api-key', values: { token: 'fake-selected' }, protocol: 'openai', envKey: OPENAI_SELECTED_API_KEY_ENV },
    { purpose: 'google-model', runtime: geminiConnectedAccountRuntime, mode: 'api-key', values: { apiKey: 'fake-selected' }, protocol: 'gemini', envKey: 'GEMINI_API_KEY' },
    { purpose: 'google-model', runtime: geminiConnectedAccountRuntime, mode: 'service-account', values: { serviceAccountJson: JSON.stringify({ type: 'service_account', client_id: '123', client_email: 'fixture@example.invalid', project_id: 'selected-project', private_key: 'fake-selected' }) }, protocol: 'vertex-ai', envKey: null },
  ])('selects $protocol through materialization and the registered runtime', async row => {
    const activation = await createPluginTestkit({ manifest: plugin.PLUGIN_MANIFEST, module: plugin });
    const account = { service: QWEN_ACCOUNT_SOURCES.find(source => source.purpose === row.purpose)!.service, accountId: 'selected' };
    const materializationContext = { signal: new AbortController().signal, configuration: { target: { modeId: row.mode }, values: {} },
      credentials: { async get(key: string) { return (row.values as Record<string, string>)[key] ?? null; } },
    } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    const accounts: Pick<ConnectedAccountsService, 'getBinding' | 'materialize'> = {
      async getBinding(purpose) { return purpose === row.purpose ? { purpose, account, service: account.service, target: { kind: 'account', displayName: 'Selected' } } : null; },
      async materialize(_purpose, request) { return row.runtime.materialize(request, materializationContext); },
    };
    let options: AgentAcpRuntimeOptions | undefined;
    try {
      const factory = activation.registration('agents', 'qwen')?.factory;
      projectAgentConnectedAccountLaunchCatalogEntry({ pluginId: plugin.PLUGIN_MANIFEST.id, agentId: 'qwen',
        connectedAccountLaunch: activation.registration('agents', 'qwen')!.connectedAccountLaunch!,
        hostAccess: plugin.PLUGIN_MANIFEST.hostAccess, isCurrent: () => true });
      expect(factory).toBeTypeOf('function');
      if (!factory) return;
      const runtime = await factory({ plugin: { id: plugin.PLUGIN_MANIFEST.id, version: '0.0.0' }, agent: { id: 'qwen' }, signal: materializationContext.signal });
      const context = { services: { connectedAccounts: accounts }, protocols: { acp: { async open(_request: AgentSessionOpenRequest, value: AgentAcpRuntimeOptions) {
        options = value;
        return { async dispose() {}, async send() { return { status: 'admitted' }; }, watch() { return { dispose() {} }; } };
      } } } } as unknown as AgentRuntimeContext;
      const session = await runtime.sessions!.open({ kind: 'create', cwd: '/fixture', configuration: {
        model: { value: 'selected-model', updatedAtMs: 1, selectionSource: 'explicit' }, mode: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
      } }, context);
      const env = options!.transport.env!;
      const settingsPath = env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(settings.modelProviders[row.protocol]).toEqual([expect.objectContaining({ id: 'selected-model' })]);
      expect(options!.transport.args).toContain(row.protocol);
      const nativeModelId = `selected-model(${row.protocol})`;
      const controls = options!.definition!.models!;
      const projected = controls.projectModel({ modelId: nativeModelId, name: 'Selected' }, { id: nativeModelId, name: 'Selected' });
      expect(projected.id).toBe(nativeModelId);
      expect(controls.projectModelState!({ normalizedModelState: {
        currentModelId: nativeModelId, availableModels: [projected, { id: 'unrelated-native-model', name: 'Native' }],
      } })).toEqual({ currentModelId: 'selected-model', availableModels: [{ ...projected, id: 'selected-model' }] });
      expect(controls.resolveModelUpdate!({ modelId: 'selected-model', modelState: null })).toMatchObject({ modelId: nativeModelId });
      expect(JSON.stringify(settings)).not.toContain('fake-selected');
      if (row.envKey) expect(env[row.envKey]).toBe('fake-selected');
      else {
        expect(env.GOOGLE_CLOUD_PROJECT).toBe('selected-project');
        expect(JSON.parse(readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')).private_key).toBe('fake-selected');
        expect(env.GEMINI_API_KEY).toBe('');
      }
      await session.dispose();
      expect(existsSync(settingsPath)).toBe(false);
    } finally { await activation.dispose(); }
  });
});
