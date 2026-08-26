import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

function sortRegistrations(
  registrations: readonly Readonly<{ family: string; localId: string }>[],
): readonly Readonly<{ family: string; localId: string }>[] {
  return registrations
    .map(({ family, localId }) => ({ family, localId }))
    .sort((left, right) => `${left.family}:${left.localId}`.localeCompare(`${right.family}:${right.localId}`));
}

describe('Azure DevOps plugin activation', () => {
  it('registers every declared daemon Action, runtime descriptor, and targeted role', async () => {
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });

    try {
      const expectedRegistrations = [
        ...PLUGIN_MANIFEST.contributes.actions
          .filter(({ execution }) => execution.target === 'daemon')
          .map(({ id }) => ({ family: 'actions' as const, localId: id })),
        ...PLUGIN_MANIFEST.contributes.connectedAccountDescriptors
          .map(({ id }) => ({ family: 'connectedAccountDescriptors' as const, localId: id })),
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
          // Targeted source roles are executable daemon Actions; a role that points to a client
          // Action or to an unregistered handler is silently undispatchable at the target plugin.
          expect(registeredActionIds, `${contribution.id}.${role}`).toContain(actionId);
          expect(testkit.registration('actions', actionId)).toEqual(expect.any(Function));
        }
      }
    } finally {
      await testkit.dispose();
    }
  });
});
