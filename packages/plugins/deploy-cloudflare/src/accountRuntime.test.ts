import { expect, it } from 'vitest';
import { derivePluginAccountContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { createPluginRegistrationScope } from '../../../plugin-sdk/src/registration/scope.js';

import { activateAccount } from './accountRuntime.js';
import { PLUGIN_MANIFEST } from './manifest.js';

it('activates Cloudflare Actions without selecting its separate authentication artifact', async () => {
  const target = { artifactId: 'account-runtime', exportName: 'activateAccount' };
  const scope = createPluginRegistrationScope({ pluginId: PLUGIN_MANIFEST.id,
    target: { realm: 'account', ...target },
    rights: derivePluginAccountContributionRegistrationRights(PLUGIN_MANIFEST.contributes, target),
  });
  try {
    activateAccount(scope.api);
    const registrations = scope.commit();
    expect(registrations).toContainEqual(expect.objectContaining({ family: 'actions', localId: 'cloudflare-named/selections-read' }));
    expect(registrations).not.toContainEqual(expect.objectContaining({ family: 'connectedAccountDescriptors', localId: 'cloudflare' }));
  } finally {
    await scope.dispose();
  }
});

it('preserves the explicit authentication target used by the Account testkit', async () => {
  const target = { artifactId: 'connected-account-authentication', exportName: 'activate' };
  const scope = createPluginRegistrationScope({ pluginId: PLUGIN_MANIFEST.id,
    target: { realm: 'account', ...target },
    rights: derivePluginAccountContributionRegistrationRights(PLUGIN_MANIFEST.contributes, target),
  });
  try {
    activateAccount(scope.api, target);
    expect(scope.commit()).toMatchObject([{ family: 'connectedAccountDescriptors', localId: 'cloudflare' }]);
  } finally {
    await scope.dispose();
  }
});
