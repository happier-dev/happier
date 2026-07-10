import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Kiro plugin manifest', () => {
  it('declares agent settings as plugin-authored contribution data', () => {
    const contribution = PLUGIN_MANIFEST.contributes.agentSettings?.find((entry) => entry.agentId === 'kiro');

    expect(contribution).toEqual(expect.objectContaining({
      id: 'kiro.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(contribution?.fields).toEqual([]);
    expect(contribution?.ui.sections).toEqual([]);
  });

  it('declares a plugin-owned generic ACP backend contribution', () => {
    const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'kiro');

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.kiro');
    expect(PLUGIN_MANIFEST.uses).toContain('agents');
    expect(backend).toBeDefined();
    if (!backend) return;

    expect(backend).toMatchObject({
      kindVersion: 1,
      id: 'kiro',
      runtime: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'agent-cli',
            agentId: 'kiro',
            args: ['acp'],
          },
        },
        auth: {
          config: {
            support: 'login_terminal',
            machineLoginKey: 'kiro-cli',
            docsUrl: 'https://kiro.dev/docs/cli/acp/',
            loginCommand: { command: 'kiro-cli', args: ['login'] },
            statusCommand: ['whoami', '--format', 'json'],
            parser: 'kiroWhoamiJson',
          },
        },
        sessionIdHeaderName: 'kiroSessionId',
        stderrRules: {
          suppress: [
            {
              includes: ['error handling notification', '_kiro.dev/', 'method not found'],
            },
          ],
        },
        mcp: { policy: 'pass_through' },
      },
      capabilities: {
        executionRun: { supported: true },
        session: {
          media: {
            acceptsImageInput: { supported: true },
            emitsSessionMedia: { supported: false },
            nativeImageGeneration: { supported: false },
          },
        },
      },
    });
    expect(backend.runtime).not.toHaveProperty('callbacks');
  });
});
