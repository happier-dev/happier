import { AgentProviderBindingMaterializationV1Schema, ingestPluginManifestV2 } from '@happier-dev/protocol';
import type { AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput, AgentPreflightSessionControlsContributionV1, AgentPreflightSessionControlsProbeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { COPILOT_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { COPILOT_PROVIDER_OWNED_ENV_KEYS } from './agent/providerBinding.js';
import { COPILOT_PLUGIN, PLUGIN_MANIFEST } from './manifest.js';

describe('Copilot plugin manifest', () => {
  it('preserves distinct optional ChatGPT and native GitHub account purposes', () => {
    expect(PLUGIN_MANIFEST.contributes.agents?.[0]?.connectedAccounts).toEqual(expect.arrayContaining([{
      purpose: 'openai-codex',
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      materializationKinds: ['httpHeaders'],
      credentialKinds: ['oauth'],
    }, {
      purpose: 'github-copilot',
      service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
      materializationKinds: ['environment'],
      credentialKinds: ['token', 'oauth'],
    }]));
  });

  async function registeredProviderAdapter(): Promise<AgentProviderBindingAdapter> {
    const register = vi.fn();
    // Plugin registration is the host boundary; the registered adapter remains real.
    await COPILOT_PLUGIN.activate({ agents: { register, registerExternalSessions() {} } } as never);
    const adapter: AgentProviderBindingAdapter | undefined = register.mock.calls[0]?.[2]?.providerBinding;
    expect(adapter, 'Copilot registers its native Provider binding').toBeDefined();
    if (!adapter) throw new Error('Missing Copilot Provider binding');
    return adapter;
  }

  function bindingInput(adapter: AgentProviderBindingAdapter, protocol: 'openai-chat' | 'anthropic'): AgentProviderBindingMaterializeInput {
    return {
      v: 1,
      binding: {
        v: 1, agentTargetKey: 'backend:copilot:built_in',
        selection: { connectionId: 'pc_copilot_test', model: { id: 'exact/native-model', name: 'Test model' } },
        contributionKey: null,
        endpoint: { endpointTemplateId: 'custom', normalizedUrl: 'http://127.0.0.1:11434/v1', protocol, publicHeaders: {} },
        runtimeCredentialTransport: null,
        compatibilityFingerprint: 'pcf1:copilot-test',
      },
      prepared: adapter.prepare({ v: 1, agentTargetKey: 'backend:copilot:built_in', connectionId: 'pc_copilot_test' }),
      credential: { kind: 'none' },
    };
  }

  it.each(['openai-chat', 'anthropic'] as const)('materializes the registered %s binding without ambient credentials or model overrides', async protocol => {
    const adapter = await registeredProviderAdapter();
    const output = AgentProviderBindingMaterializationV1Schema.parse(await adapter.materialize(bindingInput(adapter, protocol)));
    const environment = Object.fromEntries(output.env.map(row => [row.name, row.value]));
    expect(output.kind).toBe('spawnEnv');
    expect(environment).toMatchObject({
      COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:11434/v1',
      COPILOT_PROVIDER_TYPE: protocol === 'anthropic' ? 'anthropic' : 'openai',
      COPILOT_MODEL: 'exact/native-model',
      COPILOT_PROVIDER_API_KEY: null, COPILOT_PROVIDER_BEARER_TOKEN: null,
      COPILOT_PROVIDER_WIRE_API: null, COPILOT_PROVIDER_WIRE_MODEL: null,
      COPILOT_PROVIDER_MODEL_ID: null, COPILOT_PROVIDER_AZURE_API_VERSION: null,
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS: null, COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: null,
    });
    const requirements = PLUGIN_MANIFEST.contributes.agents?.[0]?.providerRequirements;
    expect(requirements).toMatchObject({
      acceptsProtocols: ['openai-chat', 'anthropic'], required: { streaming: true, toolRoundTrips: true },
      credentialSupport: { supportsNoAuth: true }, materialization: 'spawnEnv',
      applyPolicy: 'restart_session', supportsFreeformModelIds: true,
    });
    expect(output.env.map(row => row.name).sort()).toEqual([...requirements!.authIsolation.ownedEnvKeys].sort());
  });

  it.each([
    ['openai-chat', 'authorization', 'bearer', 'COPILOT_PROVIDER_BEARER_TOKEN'],
    ['anthropic', 'authorization', 'bearer', 'COPILOT_PROVIDER_BEARER_TOKEN'],
    ['anthropic', 'x-api-key', 'raw', 'COPILOT_PROVIDER_API_KEY'],
  ] as const)('materializes %s %s credentials only through their selected native transport', async (protocol, name, format, variable) => {
    const adapter = await registeredProviderAdapter();
    const input = bindingInput(adapter, protocol);
    const transport = { id: 'test-key', protocols: [protocol], uses: ['runtime'] as const, destination: { kind: 'httpHeader' as const, name, format } };
    const output = await adapter.materialize({ ...input,
      binding: { ...input.binding, runtimeCredentialTransport: transport },
      credential: { kind: 'apiKey', transport, value: 'test-secret' },
    });
    expect(output.env.filter(row => row.value === 'test-secret')).toEqual([{ name: variable, value: 'test-secret', source: 'provider' }]);
    await expect(adapter.materialize({ ...input, binding: { ...input.binding, runtimeCredentialTransport: transport } })).rejects.toThrow();
  });

  it('refuses unsupported public headers instead of silently dropping them', async () => {
    const adapter = await registeredProviderAdapter();
    const input = bindingInput(adapter, 'openai-chat');
    await expect(adapter.materialize({ ...input, binding: { ...input.binding,
      endpoint: { ...input.binding.endpoint, publicHeaders: { 'x-required-route': 'route' } },
    } })).rejects.toThrow();
  });

  it('projects only the observed current model controls through the declared ACP process', async () => {
    // Host registration and JSON-RPC execution are the plugin's external boundaries.
    const register = vi.fn();
    await COPILOT_PLUGIN.activate({ agents: { register, registerExternalSessions() {} } } as never);
    const preflight: AgentPreflightSessionControlsContributionV1 | undefined = register.mock.calls[0]?.[2]?.preflightSessionControls;
    expect(preflight).toBeDefined();
    const payload = {
      sessionId: 'probe-session',
      models: { currentModelId: 'model-a', availableModels: [{ modelId: 'model-a', name: 'A' }, { modelId: 'model-b', name: 'B' }] },
      configOptions: [{ id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }],
    };
    const context: AgentPreflightSessionControlsProbeContextV1 = {
      cwd: '/workspace/project', accountSettings: null, environment: {}, signal: new AbortController().signal,
      runDeclaredSystemToolCommand: async () => { throw new Error('Unexpected text command'); },
      resolveDeclaredSystemTool: async () => { throw new Error('Native managed service is not used by this fixture'); },
      withDeclaredManagedService: async () => { throw new Error('Native managed service is not used by this fixture'); },
      withDeclaredJsonRpcClient: async (command, inspect) => {
        expect(command).toEqual({ toolId: 'copilot-cli', args: ['--acp'] });
        return await inspect({
          request: async (method, params) => {
            if (method === 'initialize') return { protocolVersion: 1 };
            expect(method).toBe('session/new');
            expect(params).toEqual({ cwd: context.cwd, mcpServers: [] });
            return payload;
          },
          notify: async () => undefined,
        }, context.signal);
      },
    };
    const models = await preflight?.probeModels?.(context);
    expect(models).toEqual([
      { modelId: 'model-a', name: 'A', modelOptions: [{ id: 'reasoning_effort', name: 'Effort', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }] },
      { modelId: 'model-b', name: 'B' },
    ]);
  });

  it('uses the strict target manifest and declares its custom ACP handoff', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('uses');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('permissions');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activationEvents');
    expect(PLUGIN_MANIFEST).toMatchObject({ entrypoints: { daemon: './.happier-plugin/daemon.js' } });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activation');
    expect(PLUGIN_MANIFEST).toMatchObject({
      hostAccess: {
        required: [{
          id: 'copilot-process',
          capability: 'process',
          scope: {
            executables: [{ kind: 'systemTool', id: 'copilot-cli' }],
            envKeys: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', ...COPILOT_PROVIDER_OWNED_ENV_KEYS],
          },
        }],
        optional: [],
      },
      contributes: {
        agents: [{
          id: 'copilot', title: 'GitHub Copilot', primary: 'sessions',
          runtime: { kind: 'custom' },
          cli: {
            auth: {
              support: 'login_terminal',
              environmentVariables: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
              credentialPaths: ['~/.copilot/config.json'],
              missingCredentialState: 'unknown',
              loginLaunches: [{ kind: 'primary', args: ['login'] }],
            },
          },
          capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn', 'followUp'], cancel: true } },
        }],
        systemTools: [{ id: 'copilot-cli', executableNames: ['copilot'] }],
        settings: [COPILOT_AGENT_SETTINGS_CONTRIBUTION],
      },
    });
  });

  it('does not register an unrelated GitHub CLI auth probe', async () => {
    const register = vi.fn();
    await COPILOT_PLUGIN.activate({ agents: { register, registerExternalSessions() {} } } as never);

    expect(register).toHaveBeenCalledWith('copilot', expect.any(Function), expect.not.objectContaining({
      cliAuth: expect.anything(),
    }));
  });
});
