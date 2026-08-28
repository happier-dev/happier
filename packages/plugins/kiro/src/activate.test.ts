import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Kiro activation', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'settings',
      'systemTools',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      KIRO_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('registers only the manifest-declared CLI auth callback at activation', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    expect(activation.registrations()).toContainEqual({ family: 'agents', localId: 'kiro' });
    expect(activation.registration('agents', 'kiro')).toMatchObject({
      cliAuth: { detectAuthStatus: expect.any(Function) },
    });
    expect(activation.registration('agents', 'kiro')?.factory).toBeUndefined();
    await activation.dispose();
  });

  it('leaves session execution to the host-owned declarative ACP composer', () => {
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.runtime).toEqual({
      kind: 'acp',
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'kiro-cli' },
        args: ['acp'],
      },
      definition: expect.objectContaining({
        mcp: { policy: 'pass_through' },
        stderrRules: expect.any(Object),
      }),
    });
  });
});
