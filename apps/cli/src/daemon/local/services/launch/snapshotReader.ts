import type { RpcHandlerContext } from '@/api/rpc/types';
import { assertLocalServiceReadCustody } from '../credentialAdmission';
import type { LocalServiceLauncherFeed } from './feed';

/** Bind launcher discovery and its returned metadata to one admitted requester. */
export async function createLocalServiceLauncherSnapshotReader(input: Readonly<{
    feed: Pick<LocalServiceLauncherFeed, 'getSnapshot'>;
    machineId: string;
    accountId?: string;
    serverId?: string;
    ingress?: RpcHandlerContext;
    readScope?: 'requester_managed_services';
}>): Promise<Pick<LocalServiceLauncherFeed, 'getSnapshot'> & Readonly<{ requesterOnly: boolean }>> {
    const accountId = await assertLocalServiceReadCustody({
        accountId: input.accountId ?? input.ingress?.machineAdmission?.custodianAccountId,
        machineId: input.machineId,
        context: input.ingress,
    }, input.readScope);
    if (accountId && !input.serverId) throw new Error('requester_credentials_unavailable');
    const requesterManagedServices = accountId && input.serverId ? { accountId, serverId: input.serverId } : undefined;
    return {
        requesterOnly: requesterManagedServices !== undefined,
        getSnapshot: (request?: Parameters<LocalServiceLauncherFeed['getSnapshot']>[0]) => input.feed.getSnapshot({ ...request,
            ...(requesterManagedServices ? { requesterManagedServices } : {}),
        }),
    };
}
