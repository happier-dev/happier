import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { AUGGIE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Auggie plugin manifest', () => {
  it('uses the strict target manifest and declares its custom ACP handoff', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('uses');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('permissions');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activationEvents');
    expect(PLUGIN_MANIFEST).toMatchObject({ entrypoints: { daemon: './dist/index.js' } });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activation');
    expect(PLUGIN_MANIFEST.contributes.agents[0]).not.toHaveProperty('externalSessions');
    expect(PLUGIN_MANIFEST).toMatchObject({
      hostAccess: {
        required: [{
          id: 'auggie-process',
          capability: 'process',
          scope: { executables: [{ kind: 'systemTool', id: 'auggie-cli' }] },
        }],
        optional: [],
      },
      contributes: {
        agents: [{
          id: 'auggie',
          title: 'Auggie',
          primary: 'sessions',
          runtime: { kind: 'custom' },
          capabilities: {
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn', 'steer', 'followUp'],
              cancel: true,
            },
          },
        }],
        systemTools: [{ id: 'auggie-cli', executableNames: ['auggie'] }],
        settings: [AUGGIE_AGENT_SETTINGS_CONTRIBUTION],
      },
    });
  });
});
