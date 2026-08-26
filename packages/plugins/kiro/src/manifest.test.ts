import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { KIRO_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { KIRO_PLUGIN, PLUGIN_MANIFEST } from './manifest.js';

describe('Kiro plugin manifest', () => {
  it('uses the strict target manifest and declares its host-owned ACP runtime', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('uses');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('permissions');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activationEvents');
    expect(PLUGIN_MANIFEST).toMatchObject({ entrypoints: { daemon: './.happier-plugin/daemon.js' } });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activation');
    expect(PLUGIN_MANIFEST).toMatchObject({
      hostAccess: {
        required: [{
          id: 'kiro-process',
          capability: 'process',
          scope: { executables: [{ kind: 'systemTool', id: 'kiro-cli' }] },
        }],
        optional: [],
      },
      contributes: {
        agents: [{
          id: 'kiro', title: 'Kiro', primary: 'sessions',
          runtime: {
            kind: 'acp',
            transport: {
              kind: 'stdio',
              executable: { kind: 'systemTool', id: 'kiro-cli' },
              args: ['acp'],
            },
            definition: {
              modelConfigOptionId: 'model',
              stderrRules: expect.objectContaining({
                suppress: expect.any(Array),
              }),
              mcp: { policy: 'pass_through' },
            },
          },
          capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn', 'steer', 'followUp'], cancel: true } },
        }],
        systemTools: [{ id: 'kiro-cli', executableNames: ['kiro-cli'] }],
        settings: [KIRO_AGENT_SETTINGS_CONTRIBUTION],
      },
    });
  });

  it('registers Kiro auth through the canonical activation transaction without a runtime factory', async () => {
    const registerCliAuth = vi.fn();

    await KIRO_PLUGIN.activate({
      agents: { registerCliAuth },
    } as never);

    expect(registerCliAuth).toHaveBeenCalledTimes(1);
    expect(registerCliAuth).toHaveBeenCalledWith('kiro', expect.objectContaining({
      detectAuthStatus: expect.any(Function),
    }));
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli.auth).not.toHaveProperty('probe');
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli.auth.nonInteractiveStatusProbe).toBeUndefined();
  });
});
