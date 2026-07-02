import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

function requireCopilotBackend() {
  const backend = PLUGIN_MANIFEST.contributes?.backends?.find((entry) => entry.id === 'copilot');
  if (!backend) {
    throw new Error('Expected Copilot plugin manifest to declare copilot backend contribution');
  }
  return backend;
}

describe('Copilot plugin manifest', () => {
  it('declares a plugin-owned static ACP backend contribution', () => {
    const backend = requireCopilotBackend();

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.copilot');
    expect(PLUGIN_MANIFEST.runtime.capabilities).toContain('backends');
    expect(backend).toMatchObject({
      kindVersion: 1,
      id: 'copilot',
      agentId: 'copilot',
      engine: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'agent-cli',
            agentId: 'copilot',
            args: ['--acp'],
          },
        },
        sessionIdHeaderName: 'copilotSessionId',
        toolNameInference: {
          shellBridgeHint: true,
        },
        stderrRules: {
          statusErrors: expect.arrayContaining([
            expect.objectContaining({
              includes: ['authentication'],
              detail: 'Authentication error. Run `copilot login` to authenticate with GitHub.',
            }),
          ]),
        },
        mcp: { policy: 'pass_through' },
      },
      capabilities: {
        executionRun: { supported: true },
      },
    });
    expect(backend.engine).not.toHaveProperty('callbacks');
  });
});
