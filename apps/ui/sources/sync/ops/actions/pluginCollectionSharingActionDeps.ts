import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createPluginCollectionSharingActionExecuteV1 } from '@happier-dev/protocol/plugins/data/collectionSharingActionsV1';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createActivePluginCollectionClientForContractRef } from '@/sync/api/plugins/data/activePluginCollectionClient';
import type { LazyActionAccountContext } from './actionAccountContext';

export function createUiPluginCollectionSharingActionDeps(
    account: LazyActionAccountContext,
): Pick<ActionExecutorDeps, 'pluginCollectionSharingAction'> {
    return { pluginCollectionSharingAction: async request => createPluginCollectionSharingActionExecuteV1({
        resolveClient: async (ref, signal) => {
            account.assertCurrent();
            const resolved = await createActivePluginCollectionClientForContractRef({ ref,
                accountLifetime: account.accountLifetime, signal });
            if (resolved.status !== 'ready') throw new PluginError({
                code: resolved.status === 'rejected' ? resolved.code : resolved.reason,
                message: 'Collection sharing is unavailable', details: { outcome: 'refused' },
            });
            return resolved.client.sharing;
        },
    })(request) };
}
