import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Devin activation', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      DEVIN_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('registers the manifest-declared CLI auth callback and terminal contribution', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    expect(activation.registrations()).toContainEqual({ family: 'agents', localId: 'devin' });
    expect(activation.registration('agents', 'devin')).toMatchObject({
      cliAuth: { detectAuthStatus: expect.any(Function) },
      terminal: { resolveLaunch: expect.any(Function) },
    });
    await activation.dispose();
  });

  it('leaves Sessions to the host declarative ACP owner instead of a plugin runtime', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const registration = activation.registration('agents', 'devin');
    expect(registration?.factory).toBeUndefined();
    expect(registration?.sessionRunnerFactory).toBeUndefined();
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.runtime).toMatchObject({ kind: 'acp' });
    await activation.dispose();
  });

  it('contributes the terminal surface it declares, with arguments only', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const terminal = activation.registration('agents', 'devin')?.terminal;
    if (!terminal) throw new Error('Expected Devin terminal contribution');
    expect(terminal.resolveLaunch({
      sessionId: 'session', cwd: '/workspace', metadata: {}, modelSelection: null,
    })).toMatchObject({ argv: [], process: { stdio: 'inherit' } });
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.capabilities.surfaces).toContain('terminal');
    await activation.dispose();
  });
});
