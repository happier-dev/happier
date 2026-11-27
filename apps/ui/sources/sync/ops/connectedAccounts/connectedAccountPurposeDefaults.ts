import type { ConnectedAccountPurposeMutationIntentV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { ConnectedAccountCatalogOperationError, readConnectedAccountCatalogForMutationInContext,
    requireUpdatedConnectedAccountCatalogMutation, writeConnectedAccountCatalogRecordAndPublishInContext,
    type ConnectedAccountCatalogAccountContext } from '@/sync/api/account/apiConnectedAccountCatalog';

/** Purpose defaults only write the admitted catalog row. */
export async function mutateConnectedAccountPurposeDefaultsInContext(context: ConnectedAccountCatalogAccountContext,
    mutate: ConnectedAccountPurposeMutationIntentV1, signal?: AbortSignal): Promise<void> {
    const catalog = await readConnectedAccountCatalogForMutationInContext(context, 'purposes', signal);
    context.assertCurrent();
    signal?.throwIfAborted();
    if (catalog.status !== 'ready' || catalog.record.key !== 'purposes') {
        throw new ConnectedAccountCatalogOperationError(catalog.status === 'unavailable' ? catalog.reason : 'connected_account_purpose_catalog_unavailable');
    }
    const next = mutate(catalog.record.value);
    if (!next) return;
    const record = { key: 'purposes' as const, value: next.purposeBindings };
    requireUpdatedConnectedAccountCatalogMutation(await writeConnectedAccountCatalogRecordAndPublishInContext(context,
        { record, expectedRevision: catalog.revision }, signal));
}
