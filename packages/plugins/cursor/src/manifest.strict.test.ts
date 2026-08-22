import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Cursor strict plugin manifest', () => {
  it('uses the strict v2 root and keeps the custom runtime binding identity aligned', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST).toMatchObject({
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: { required: expect.arrayContaining([{ id: 'cursor-api-key', capability: 'environment', reason: expect.any(String), scope: { keys: ['CURSOR_API_KEY'] } }]), optional: [] },
    });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activation');
    expect(PLUGIN_MANIFEST.contributes.agents).toEqual([
      expect.objectContaining({ id: 'cursor', runtime: { kind: 'custom' }, primary: 'sessions' }),
    ]);
    for (const retired of ['uses', 'source', 'permissions', 'activationEvents']) {
      expect(retired in PLUGIN_MANIFEST).toBe(false);
    }
  });
});
