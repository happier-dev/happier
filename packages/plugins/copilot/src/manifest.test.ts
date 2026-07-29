import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { COPILOT_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Copilot plugin manifest', () => {
  it('uses the strict target manifest and declares its custom ACP handoff', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('uses');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('permissions');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activationEvents');
    expect(PLUGIN_MANIFEST).toMatchObject({ entrypoints: { daemon: './dist/index.js' } });
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
          capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn', 'steer', 'followUp'], cancel: true } },
        }],
        systemTools: [{ id: 'copilot-cli', executableNames: ['copilot'] }],
        settings: [COPILOT_AGENT_SETTINGS_CONTRIBUTION],
      },
    });
  });
});
