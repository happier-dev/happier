import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { activate as activateAccount } from './accountRuntime.js';
import { activate } from './activate.js';
import { PLUGIN_MANIFEST, POSTHOG_CONNECTED_ACCOUNT_PURPOSE } from './manifest.js';

describe('PostHog plugin activation', () => {
  it('registers the generated Actions, connected account and evidence reference', async () => {
    const plugin = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate, activateAccount },
    });
    try {
      const actions = plugin.registrations().filter(registration => registration.family === 'actions');
      expect(actions.map(registration => registration.localId).sort()).toEqual(
        PLUGIN_MANIFEST.contributes.actions.map(action => action.id).sort(),
      );
      expect(plugin.registration('connectedAccountDescriptors', POSTHOG_CONNECTED_ACCOUNT_PURPOSE)).toEqual(
        expect.objectContaining({ authentication: expect.any(Object) }),
      );
      expect(plugin.registration('composerReferences', 'posthog-evidence')).toMatchObject({
        search: expect.any(Function),
        resolve: expect.any(Function),
      });
    } finally {
      await plugin.dispose();
    }
  });
});
