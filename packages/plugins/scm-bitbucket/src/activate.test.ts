import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { activate } from './activate.js';
import { activate as activateAccount } from './accountRuntime.js';
import { PLUGIN_MANIFEST } from './manifest.js';

function sortRegistrations(
  registrations: readonly Readonly<{ family: string; localId: string }>[],
): readonly Readonly<{ family: string; localId: string }>[] {
  return registrations
    .map(({ family, localId }) => ({ family, localId }))
    .sort((left, right) => `${left.family}:${left.localId}`.localeCompare(`${right.family}:${right.localId}`));
}

describe('Bitbucket plugin activation', () => {
  it('registers every declared Account and daemon Action, runtime descriptor, and targeted role', async () => {
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });

    try {
      const expectedRegistrations = [
        ...PLUGIN_MANIFEST.contributes.actions
          .map(({ id }) => ({ family: 'actions' as const, localId: id })),
        ...PLUGIN_MANIFEST.contributes.connectedAccountDescriptors
          .flatMap(({ id }) => Array.from({ length: 2 }, () => ({ family: 'connectedAccountDescriptors' as const, localId: id }))),
        ...PLUGIN_MANIFEST.contributes.scmHostingProviders
          .map(({ id }) => ({ family: 'scmHostingProviders' as const, localId: id })),
      ];

      // Exact parity catches both silent omissions and undeclared registrations while ignoring
      // generated family traversal order.
      expect(sortRegistrations(testkit.registrations())).toEqual(sortRegistrations(expectedRegistrations));

      for (const { id } of PLUGIN_MANIFEST.contributes.connectedAccountDescriptors) {
        expect(testkit.registration('connectedAccountDescriptors', id)).toEqual(expect.any(Object));
      }
      for (const { id } of PLUGIN_MANIFEST.contributes.scmHostingProviders) {
        expect(testkit.registration('scmHostingProviders', id)).toEqual(expect.any(Object));
      }

      const registeredActionIds = new Set(
        testkit.registrations()
          .filter(({ family }) => family === 'actions')
          .map(({ localId }) => localId),
      );
      for (const contribution of PLUGIN_MANIFEST.contributes.targetedPluginContributions) {
        for (const [role, actionId] of Object.entries(contribution.operations ?? {})) {
          // Targeted roles must resolve through their admitted Account or daemon activation.
          expect(registeredActionIds, `${contribution.id}.${role}`).toContain(actionId);
          expect(testkit.registration('actions', actionId)).toEqual(expect.any(Function));
        }
      }
    } finally {
      await testkit.dispose();
    }
  });
});
