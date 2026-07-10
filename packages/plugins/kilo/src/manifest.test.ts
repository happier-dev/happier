import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

function requireKiloBackend() {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'kilo');
  if (!backend) {
    throw new Error('Expected Kilo plugin manifest to declare kilo backend contribution');
  }
  return backend;
}

describe('Kilo plugin manifest', () => {
  it('declares agent settings as plugin-authored contribution data', () => {
    const contribution = PLUGIN_MANIFEST.contributes.agentSettings?.find((entry) => entry.agentId === 'kilo');

    expect(contribution).toEqual(expect.objectContaining({
      id: 'kilo.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(contribution?.fields).toEqual([]);
    expect(contribution?.ui.sections).toEqual([]);
  });

  it('declares a plugin-owned static ACP backend contribution', () => {
    const backend = requireKiloBackend();

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.kilo');
    expect(PLUGIN_MANIFEST.uses).toContain('agents');
    expect(backend).toMatchObject({
      kindVersion: 1,
      id: 'kilo',
      runtime: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'agent-cli',
            agentId: 'kilo',
            args: ['acp'],
          },
        },
        sessionIdHeaderName: 'kiloSessionId',
        stderrRules: {
          suppress: expect.arrayContaining([
            expect.objectContaining({ includes: ['models.dev', 'unable to connect'] }),
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
