import { isDeepStrictEqual } from 'node:util';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { composeProviderSettingsV1, splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { requireSavedSecretReferenceReady } from './settings';
import type { ProviderConnectionServiceDeps } from './types';

/** Real Account semantics over the tests' in-memory persistence boundary. */
export function createInMemoryAccountProviderActions(input: Pick<ProviderConnectionServiceDeps, 'loadSnapshot' | 'updateProviderSettings' | 'now'>):
  NonNullable<ProviderConnectionServiceDeps['accountProviderActionExecute']> {
  let revision = 0;
  return async (request, preparedSavedSecret) => {
    const captured = await input.loadSnapshot();
    const capturedCatalog = splitProviderSettingsV1(captured.providerSettings).catalog;
    const capturedRevision = revision;
    return createAccountProviderActionExecuteV1({ assertCurrent() {}, now: input.now,
      readCatalog: async () => captured.providerSettingsDiagnostics?.length
        ? { status: 'unavailable', reason: 'invalid-stored-content' }
        : { status: 'ready', revision: capturedRevision, catalog: capturedCatalog },
      readDefinitions: async () => [...captured.registry.providersByContributionKey].map(([contributionKey, value]) => ({
        contributionKey, definition: value.definition, provenance: value.provenance,
      })),
      writeCatalog: async value => {
        await input.updateProviderSettings(settings => {
          if (revision !== value.expectedRevision || !isDeepStrictEqual(splitProviderSettingsV1(settings).catalog, capturedCatalog)) {
            throw createProviderErrorV1('provider_connection_changed', { machineId: 'machine-a' });
          }
          for (const [connectionId, bindings] of Object.entries(value.catalog.secretBindingsByConnectionId)) {
            for (const savedSecretId of Object.values(bindings.account ?? {})) requireSavedSecretReferenceReady({
              rawAccountSettings: captured.rawAccountSettings, savedSecretId, connectionId, machineId: 'machine-a',
              savedSecretResources: captured.savedSecretResources, savedSecretCatalogState: captured.savedSecretCatalogState,
              preparedSavedSecret,
            });
          }
          revision += 1;
          return composeProviderSettingsV1(value.catalog, settings.defaultsByAgentTargetKey);
        }, { preparedSavedSecret });
        return { status: 'updated' };
      },
    })(request, { surface: 'cli' });
  };
}
