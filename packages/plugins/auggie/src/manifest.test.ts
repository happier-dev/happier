import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

function requireAuggieBackend() {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'auggie');
  if (!backend) {
    throw new Error('Expected Auggie plugin manifest to declare auggie backend contribution');
  }
  return backend;
}

describe('Auggie plugin manifest', () => {
  it('declares agent settings as plugin-authored contribution data', () => {
    const contribution = PLUGIN_MANIFEST.contributes.agentSettings?.find((entry) => entry.agentId === 'auggie');

    expect(contribution).toEqual(expect.objectContaining({
      id: 'auggie.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(contribution?.fields).toEqual([]);
    expect(contribution?.ui.sections).toEqual([]);
  });

  it('declares a plugin-owned ACP backend contribution', () => {
    const backend = requireAuggieBackend();

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.auggie');
    expect(PLUGIN_MANIFEST.uses).toContain('agents');
    expect(backend).toMatchObject({
      kindVersion: 1,
      id: 'auggie',
      runtime: {
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
    expect(backend.runtime).not.toHaveProperty('providerCliRuntime');
  });
});
