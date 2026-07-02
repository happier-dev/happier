import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

function requireQwenBackend() {
  const backend = PLUGIN_MANIFEST.contributes?.backends?.find((entry) => entry.id === 'qwen');
  if (!backend) {
    throw new Error('Expected Qwen plugin manifest to declare qwen backend contribution');
  }
  return backend;
}

describe('Qwen plugin manifest', () => {
  it('declares a plugin-owned ACP backend contribution', () => {
    const backend = requireQwenBackend();

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.qwen');
    expect(PLUGIN_MANIFEST.runtime.capabilities).toContain('backends');
    expect(backend).toMatchObject({
      kindVersion: 1,
      id: 'qwen',
      agentId: 'qwen',
      engine: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'agent-cli',
            agentId: 'qwen',
            args: ['--acp'],
          },
        },
        sessionIdHeaderName: 'qwenSessionId',
        mcp: { policy: 'pass_through' },
      },
      capabilities: {
        executionRun: { supported: true },
        session: {
          media: {
            acceptsImageInput: { supported: false },
            emitsSessionMedia: { supported: false },
            nativeImageGeneration: { supported: false },
          },
        },
      },
    });
    expect(backend.engine).not.toHaveProperty('callbacks');
  });

  it('preserves Qwen approval-mode omission for default permission modes', () => {
    const backend = requireQwenBackend();

    expect(backend.engine).toMatchObject({
      permissionModeArgv: {
        flag: '--approval-mode',
        map: {
          default: null,
          plan: 'plan',
          'read-only': 'plan',
          'safe-yolo': 'auto-edit',
          yolo: 'yolo',
          bypassPermissions: 'yolo',
        },
      },
    });
  });
});
