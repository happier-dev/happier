import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { activate } from './activate.js';
import {
  INSPECTOR_SELF_CHECK_ACTION_ID,
  PLUGIN_MANIFEST,
} from './manifest.js';

describe('Inspector activation', () => {
  it('registers its declared self-check action through the public plugin API', async () => {
    const testkit = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });

    await expect(testkit.invokeAction(INSPECTOR_SELF_CHECK_ACTION_ID, null)).resolves.toEqual({ ok: true });
    expect(testkit.registrations()).toContainEqual({
      family: 'actions',
      localId: INSPECTOR_SELF_CHECK_ACTION_ID,
    });

    await testkit.dispose();
  });
});
