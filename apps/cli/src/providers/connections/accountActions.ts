import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliProviderConnectionsStore, createCliProviderConnectionsStoreForOperation } from '@/providers/settings/catalogStore';
import { refreshActiveProviderConnectionsCatalog } from '@/providers/settings/hydrate';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { promoteSavedSecretWithProviderConnectionsCatalog } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { indexAgentRoutingIdsByContributionIdentity, readAgentRoutingIdForContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';

/** CLI and daemon Account Actions supply transport to the same Protocol semantics. */
export function createCliAccountProviderActionExecuteV1(params: Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  operationContext?: SavedSecretOperationContextV1;
  isCredentialCurrent?(): boolean | Promise<boolean>;
  readDefinitions?: Parameters<typeof createAccountProviderActionExecuteV1>[0]['readDefinitions'];
  now?: () => number;
  preparedSavedSecret?: Parameters<typeof promoteSavedSecretWithProviderConnectionsCatalog>[0]['preparedSavedSecret'];
}>): NonNullable<ActionExecutorDeps['providerActionExecute']> {
  return (request, context) => runWithServerHttpBaseUrl(params.serverHttpBaseUrl, async () => {
    const store = params.operationContext
      ? createCliProviderConnectionsStoreForOperation({ operationContext: params.operationContext, signal: context.signal })
      : createCliProviderConnectionsStore({ credentials: params.credentials, signal: context.signal,
        isCredentialCurrent: params.isCredentialCurrent });
    const demandsCatalog = request.actionId === 'providers.connections.create_contribution'
      || request.actionId === 'providers.connections.create_custom' || request.actionId === 'providers.connections.describe';
    if (demandsCatalog && (await store.readRow()).status === 'absent') {
      // First demand consumes the existing retained-source transfer owner. Mutation reads stay side-effect-free.
      const admitted = await store.readCatalog();
      if (admitted.status !== 'ready') return { ok: false, errorCode: 'provider_catalog_unavailable',
        error: 'provider_catalog_unavailable', details: admitted };
    }
    let registry: ReturnType<typeof resolveMergedContributionRegistry> | undefined;
    let wroteCatalog = false;
    const readRegistry = () => registry ??= resolveMergedContributionRegistry();
    const execute = createAccountProviderActionExecuteV1({
      assertCurrent: () => store.assertCurrent(),
      readCatalog: () => store.readCatalogForMutation(),
      writeCatalog: async value => {
        if (!params.preparedSavedSecret) {
          const result = await store.mutateCatalog(value);
          wroteCatalog = result.status === 'updated';
          return result;
        }
        const result = await promoteSavedSecretWithProviderConnectionsCatalog({ credentials: params.credentials,
          preparedSavedSecret: params.preparedSavedSecret, providerConnections: value,
          operationContext: params.operationContext, signal: context.signal });
        if (result.status === 'applied') { wroteCatalog = true; return { status: 'updated' as const }; }
        if (result.status === 'conflict') throw createProviderErrorV1('provider_connection_changed');
        if (result.status === 'outcome_unknown') throw Object.assign(new Error('Provider mutation outcome is unknown'), { code: 'outcome_unknown' });
        throw createProviderErrorV1('provider_secret_unavailable');
      },
      readDefinitions: async () => {
        const definitions = params.readDefinitions ? await params.readDefinitions()
          : [...((await readRegistry()).providersByContributionKey ?? [])].map(([contributionKey, contribution]) => ({
            contributionKey, definition: contribution.definition, provenance: contribution.provenance,
          }));
        await store.verifyCurrent();
        return definitions;
      },
      readAgentProviderRequirements: async agentTargetKey => {
        const target = parseBackendTargetKeyV2(agentTargetKey);
        const projection = await readRegistry();
        const agentId = target.kind === 'backend' ? target.backendId : readAgentRoutingIdForContributionIdentity(
          indexAgentRoutingIdsByContributionIdentity([...projection.agentDefinitionsById.values()]), target.identity);
        await store.verifyCurrent();
        return agentId ? projection.agentDefinitionsById.get(agentId)?.definition.providerRequirements ?? null : null;
      },
      now: params.now ?? Date.now,
    });
    const result = await execute(request, context);
    if (!wroteCatalog) await store.verifyCurrent();
    if (result.ok && wroteCatalog) {
      try {
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) return result;
        await refreshActiveProviderConnectionsCatalog({ credentials: params.credentials,
          operationContext: params.operationContext, signal: context.signal,
          isCredentialCurrent: params.isCredentialCurrent }, { afterChange: true });
      } catch { /* Projection failure or Account retirement cannot erase the durable row receipt. */ }
    }
    return result;
  });
}
