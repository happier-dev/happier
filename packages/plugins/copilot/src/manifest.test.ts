import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { COPILOT_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { COPILOT_PLUGIN, PLUGIN_MANIFEST } from './manifest.js';

describe('Copilot plugin manifest', () => {
  it('uses the strict target manifest and declares its custom ACP handoff', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('uses');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('permissions');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activationEvents');
    expect(PLUGIN_MANIFEST).toMatchObject({ entrypoints: { daemon: './.happier-plugin/daemon.js' } });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activation');
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli.auth.nonInteractiveStatusProbe).toBe(true);
    expect(PLUGIN_MANIFEST).toMatchObject({
      hostAccess: {
        required: [{
          id: 'copilot-process',
          capability: 'process',
          scope: {
            executables: [
              { kind: 'systemTool', id: 'copilot-cli' },
              { kind: 'systemTool', id: 'github-cli' },
            ],
            envKeys: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
          },
        }],
        optional: [],
      },
      contributes: {
        agents: [{
          id: 'copilot', title: 'GitHub Copilot', primary: 'sessions',
          runtime: { kind: 'custom' },
          capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn', 'steer', 'followUp'], cancel: true } },
        }],
        systemTools: [
          { id: 'copilot-cli', executableNames: ['copilot'] },
          { id: 'github-cli', executableNames: ['gh'] },
        ],
        settings: [COPILOT_AGENT_SETTINGS_CONTRIBUTION],
      },
    });
  });

  it('registers the Copilot GitHub CLI auth probe through the declared-system-tool boundary', async () => {
    const register = vi.fn();
    const registerCliAuth = vi.fn();
    await COPILOT_PLUGIN.activate({ agents: { register, registerCliAuth } } as never);

    expect(registerCliAuth).toHaveBeenCalledWith('copilot', expect.objectContaining({
      detectAuthStatus: expect.any(Function),
    }));

    const contribution = registerCliAuth.mock.calls[0]?.[1] as {
      detectAuthStatus(input: {
        runDeclaredSystemToolCommand: ReturnType<typeof vi.fn>;
      }): Promise<unknown>;
    };
    const runDeclaredSystemToolCommand = vi.fn().mockResolvedValue({
      ok: true,
      stdout: 'github-token',
      stderr: '',
      exitCode: 0,
    });

    await expect(contribution.detectAuthStatus({
      runDeclaredSystemToolCommand,
    })).resolves.toEqual({ state: 'logged_in', method: 'oauth_cli', source: 'command' });

    expect(runDeclaredSystemToolCommand).toHaveBeenCalledWith({
      toolId: 'github-cli',
      args: ['auth', 'status'],
      timeoutMs: 1_500,
    });
  });
});
