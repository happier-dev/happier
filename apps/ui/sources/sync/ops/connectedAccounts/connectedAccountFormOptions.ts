import { listConnectedAccountActionFormOptions,
    type ConnectedAccountPurposeTargetSource } from '@happier-dev/cli-common/connectedAccounts';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { readUiAccountConnectedServiceDeclarations } from '@/sync/domains/connectedServices/accountDeclarations';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { listQualifiedConnectedAccountsV4 } from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/** The metadata adapter shared by selected forms and Account Action purposes. */
export function createUiConnectedAccountMetadataSource(account: LazyActionAccountContext):
    Pick<ConnectedAccountPurposeTargetSource, 'available' | 'resolveService' | 'listAccounts'> {
    return {
        available: true,
        async resolveService(service, signal) {
            signal.throwIfAborted();
            // A consuming Action can belong to another plugin. Demand only
            // this selected provider, as the authentication host already does.
            const selected = await readPluginAccountAvailability(account.accountLifetime.scope)
                .ensureCurrentAccountExecution(service.pluginId);
            signal.throwIfAborted();
            if (selected.kind !== 'available') return null;
            const declaration = readUiAccountConnectedServiceDeclarations(account.accountLifetime)
                .find(candidate => candidate.service.pluginId === service.pluginId
                && candidate.service.localId === service.localId);
            return declaration ? { service, authentication: declaration.descriptor.authentication } : null;
        },
        async listAccounts(service, signal) {
            return (await listQualifiedConnectedAccountsV4(account.credentials, { service, request: account.request,
                signal, retry: 'none' })).accounts;
        },
    };
}

/** Selected forms share the Action purpose owner's metadata projection. */
export async function readUiConnectedAccountActionFormOptions(account: LazyActionAccountContext,
    serviceRefs: readonly ConnectedAccountRef['service'][], signal: AbortSignal) {
    const options = await listConnectedAccountActionFormOptions(createUiConnectedAccountMetadataSource(account), { serviceRefs, signal });
    account.assertCurrent();
    return options;
}
