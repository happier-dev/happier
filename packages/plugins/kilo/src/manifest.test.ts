import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

function requireKiloBackend() {
  const backend = PLUGIN_MANIFEST.contributes?.backends?.find((entry) => entry.id === 'kilo');
  if (!backend) {
    throw new Error('Expected Kilo plugin manifest to declare kilo backend contribution');
  }
  return backend;
}

describe('Kilo plugin manifest', () => {
  it('declares a plugin-owned static ACP backend contribution', () => {
    const backend = requireKiloBackend();

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.kilo');
    expect(PLUGIN_MANIFEST.runtime.capabilities).toContain('backends');
    expect(backend).toMatchObject({
      kindVersion: 1,
      id: 'kilo',
      agentId: 'kilo',
      engine: {
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
    expect(backend.engine).not.toHaveProperty('callbacks');
  });
});
