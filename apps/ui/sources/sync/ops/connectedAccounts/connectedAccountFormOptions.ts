import { listConnectedAccountActionFormOptions,
    type ConnectedAccountPurposeTargetSource } from '@happier-dev/cli-common/connectedAccounts';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { readUiAccountConnectedServiceDeclarations } from '@/sync/domains/connectedServices/accountDeclarations';
import { listQualifiedConnectedAccountsV4 } from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/** The metadata adapter shared by selected forms and Account Action purposes. */
export function createUiConnectedAccountMetadataSource(account: LazyActionAccountContext,
    declarations = readUiAccountConnectedServiceDeclarations(account.accountLifetime)):
    Pick<ConnectedAccountPurposeTargetSource, 'available' | 'resolveService' | 'listAccounts'> {
    return {
        available: true,
        async resolveService(service) {
            const declaration = declarations.find(candidate => candidate.service.pluginId === service.pluginId
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
