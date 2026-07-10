import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

function requireKimiBackend() {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'kimi');
  if (!backend) {
    throw new Error('Expected Kimi plugin manifest to declare kimi backend contribution');
  }
  return backend;
}

describe('Kimi plugin manifest', () => {
  it('declares agent settings as plugin-authored contribution data', () => {
    const contribution = PLUGIN_MANIFEST.contributes.agentSettings?.find((entry) => entry.agentId === 'kimi');

    expect(contribution).toEqual(expect.objectContaining({
      id: 'kimi.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(contribution?.fields.map((field) => field.id)).toEqual(['kimiAcpPythonSelector']);
    expect(contribution?.ui.sections).toEqual([
      expect.objectContaining({
        id: 'kimiCompatibility',
        fields: ['kimiAcpPythonSelector'],
      }),
    ]);
  });

  it('declares a plugin-owned ACP backend contribution with MCP dropped', () => {
    const backend = requireKimiBackend();

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.kimi');
    expect(PLUGIN_MANIFEST.uses).toContain('agents');
    expect(PLUGIN_MANIFEST.uses).toContain('hooks');
    expect(PLUGIN_MANIFEST.permissions.required).toEqual([]);
    expect(PLUGIN_MANIFEST.contributes.hooks).toEqual([
      expect.objectContaining({
        id: 'agent.resolvePrerequisites',
        filters: { agentId: 'kimi' },
        executionKind: 'decide',
        handler: {
          target: 'plugin',
          exportName: 'resolveKimiDaemonSpawnPrerequisites',
        },
      }),
    ]);
    expect(backend).toMatchObject({
      kindVersion: 1,
      id: 'kimi',
      runtime: {
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
    expect(backend.runtime).not.toHaveProperty('providerCliRuntime');
  });
});
