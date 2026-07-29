import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Qwen plugin manifest', () => {
  it('uses the strict target manifest and declares its custom ACP handoff', () => {
    expect(PLUGIN_MANIFEST).not.toHaveProperty('uses');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('permissions');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activationEvents');
    expect(PLUGIN_MANIFEST).toMatchObject({ entrypoints: { daemon: './dist/index.js' } });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activation');
    expect(PLUGIN_MANIFEST).toMatchObject({
      hostAccess: {
        required: [{
          id: 'qwen-process',
          capability: 'process',
          scope: { executables: [{ kind: 'systemTool', id: 'qwen-cli' }] },
        }],
        optional: [],
      },
      contributes: {
        agents: [{
          id: 'qwen', title: 'Qwen Code', primary: 'sessions',
          runtime: { kind: 'custom' },
          capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn', 'steer', 'followUp'], cancel: true } },
        }],
        systemTools: [{ id: 'qwen-cli', executableNames: ['qwen'] }],
      },
    });
  });
});
