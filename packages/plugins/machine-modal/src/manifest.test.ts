import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { MODAL_PLUGIN, PLUGIN_MANIFEST } from './manifest.js';

describe('Modal public plugin activation', () => {
  it('admits the real manifest and activates its declared native roles through the public ABI', async () => {
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: MODAL_PLUGIN });
    try {
      expect(await testkit.invokeAction('check', {})).toMatchObject({ available: false });
      // No selected credential or vendor access is borrowed by an unconfigured
      // public host. Input admission runs before private/native construction.
      await expect(testkit.invokeAction('acquire', { launch: { timeoutMs: 1001 } })).rejects.toThrow();
    } finally { await testkit.dispose(); }
  });
});
