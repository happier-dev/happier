import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('activate', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'systemTools',
      'ui',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      KIMI_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('exposes the custom Kimi ACP runtime with its interactive terminal surface', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const registration = activation.registration('agents', 'kimi');
      expect(registration?.factory).toBeTypeOf('function');
      expect(registration?.sessionRunnerFactory).toMatchObject({
        module: './agent/runtime/factory', export: 'createKimiAgentRuntime', runtimeApiVersion: 1,
      });
      expect(registration).not.toHaveProperty('terminal');
      const runtime = await registration!.factory!({
        plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
        agent: { id: 'kimi' }, signal: new AbortController().signal,
      });
      expect(registration).not.toHaveProperty('cliSessionCommand');
      await expect(runtime.surfaces?.terminal?.resolveLaunch({
        sessionId: 'session', cwd: '/workspace', metadata: {}, modelSelection: null,
      })).resolves.toMatchObject({ argv: [] });
    } finally {
      await activation.dispose();
    }
  });
});
