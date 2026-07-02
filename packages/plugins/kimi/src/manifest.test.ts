import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

function requireKimiBackend() {
  const backend = PLUGIN_MANIFEST.contributes?.backends?.find((entry) => entry.id === 'kimi');
  if (!backend) {
    throw new Error('Expected Kimi plugin manifest to declare kimi backend contribution');
  }
  return backend;
}

describe('Kimi plugin manifest', () => {
  it('declares a plugin-owned ACP backend contribution with MCP dropped', () => {
    const backend = requireKimiBackend();

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.kimi');
    expect(PLUGIN_MANIFEST.runtime.capabilities).toContain('backends');
    expect(backend).toMatchObject({
      kindVersion: 1,
      id: 'kimi',
      agentId: 'kimi',
      engine: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'agent-cli',
            agentId: 'kimi',
          },
        },
        sessionIdHeaderName: 'kimiSessionId',
        mcp: { policy: 'drop' },
        stderrRules: {
          statusErrors: expect.arrayContaining([
            expect.objectContaining({
              detail: 'Authentication error. Run `kimi login` to re-authenticate, then retry.',
            }),
          ]),
        },
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
    expect(backend.engine).not.toHaveProperty('providerCliRuntime');
  });
});
