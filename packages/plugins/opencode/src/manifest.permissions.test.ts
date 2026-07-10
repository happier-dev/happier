import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('OpenCode plugin runtime permissions', () => {
  it('declares network access for its managed loopback server runtime', () => {
    expect(PLUGIN_MANIFEST.permissions.required).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capability: 'network',
        scope: '*',
      }),
    ]));
  });
});
