import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

function requireAuggieBackend() {
  const backend = PLUGIN_MANIFEST.contributes?.backends?.find((entry) => entry.id === 'auggie');
  if (!backend) {
    throw new Error('Expected Auggie plugin manifest to declare auggie backend contribution');
  }
  return backend;
}

describe('Auggie plugin manifest', () => {
  it('declares a plugin-owned ACP backend contribution', () => {
    const backend = requireAuggieBackend();

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.auggie');
    expect(PLUGIN_MANIFEST.runtime.capabilities).toContain('backends');
    expect(backend).toMatchObject({
      kindVersion: 1,
      id: 'auggie',
      agentId: 'auggie',
      engine: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'agent-cli',
            agentId: 'auggie',
            args: ['--acp'],
          },
        },
        sessionIdHeaderName: 'auggieSessionId',
        mcp: { policy: 'pass_through' },
        stderrRules: {
          statusErrors: expect.arrayContaining([
            expect.objectContaining({
              detail: 'Authentication error. Run `auggie login` or set AUGMENT_SESSION_AUTH in your environment.',
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
