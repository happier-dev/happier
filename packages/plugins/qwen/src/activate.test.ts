import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { activate } from './manifest.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Qwen activation', () => {
  it('registers native history beside the account-aware ACP runtime', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      expect(activation.registration('agents', 'qwen')?.externalSessions).toBeDefined();
      expect(activation.registration('agents', 'qwen')?.factory).toBeTypeOf('function');
    } finally {
      await activation.dispose();
    }
  });
});
