import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import type { AgentPreflightSessionControlsContributionV1, AgentPreflightSessionControlsProbeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { COPILOT_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { COPILOT_PLUGIN, PLUGIN_MANIFEST } from './manifest.js';

describe('Copilot plugin manifest', () => {
  it('projects only the observed current model controls through the declared ACP process', async () => {
    // Host registration and JSON-RPC execution are the plugin's external boundaries.
    const register = vi.fn();
    await COPILOT_PLUGIN.activate({ agents: { register } } as never);
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
            envKeys: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
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
    await COPILOT_PLUGIN.activate({ agents: { register } } as never);

    expect(register).toHaveBeenCalledWith('copilot', expect.any(Function), expect.not.objectContaining({
      cliAuth: expect.anything(),
    }));
  });
});
