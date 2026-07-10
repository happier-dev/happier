import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

function requireCopilotBackend() {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'copilot');
  if (!backend) {
    throw new Error('Expected Copilot plugin manifest to declare copilot backend contribution');
  }
  return backend;
}

describe('Copilot plugin manifest', () => {
  it('declares agent settings as plugin-authored contribution data', () => {
    const contribution = PLUGIN_MANIFEST.contributes.agentSettings?.find((entry) => entry.agentId === 'copilot');

    expect(contribution).toEqual(expect.objectContaining({
      id: 'copilot.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(contribution?.fields).toEqual([]);
    expect(contribution?.ui.sections).toEqual([]);
  });

  it('declares a plugin-owned static ACP backend contribution', () => {
    const backend = requireCopilotBackend();

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.copilot');
    expect(PLUGIN_MANIFEST.uses).toContain('agents');
    expect(backend).toMatchObject({
      kindVersion: 1,
      id: 'copilot',
      runtime: {
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
    expect(backend.runtime).not.toHaveProperty('callbacks');
  });
});
