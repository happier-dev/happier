import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('activate', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'resources',
      'systemTools',
      'ui',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      DROID_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('binds the Droid ACP launch leaf, Provider adapter and interactive terminal', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const registration = activation.registration('agents', 'droid');
      expect(registration?.factory).toBeTypeOf('function');
      expect(registration?.providerBinding).toBeDefined();
      expect(registration?.sessionRunnerFactory).toMatchObject({ module: './agent/runtime/factory', export: 'createDroidAgentRuntime' });
      expect(registration).not.toHaveProperty('cliSessionCommand');
      const runtime = await registration!.factory!({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'droid' }, signal: new AbortController().signal });
      // The host appends `argv` after the Agent CLI executable it resolved, so
      // the leaf contributes arguments only.
      await expect(runtime.surfaces?.terminal?.resolveLaunch({
        sessionId: 'session', cwd: '/workspace', metadata: {}, modelSelection: null,
      })).resolves.toMatchObject({ argv: [] });
    } finally {
      await activation.dispose();
    }
  });
});
