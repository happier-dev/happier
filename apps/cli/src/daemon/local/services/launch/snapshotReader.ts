import type { RpcHandlerContext } from '@/api/rpc/types';
import { assertLocalServiceReadCustody } from '../credentialAdmission';
import type { LocalServiceLauncherFeed } from './feed';

/** Bind launcher discovery and its returned metadata to one admitted requester. */
export async function createLocalServiceLauncherSnapshotReader(input: Readonly<{
    feed: Pick<LocalServiceLauncherFeed, 'getSnapshot'>;
    machineId: string;
    accountId?: string;
    serverId?: string | null;
    ingress?: RpcHandlerContext;
    readScope?: 'requester_managed_services';
}>): Promise<Pick<LocalServiceLauncherFeed, 'getSnapshot'> & Readonly<{ requesterOnly: boolean; ownSessionId?: string }>> {
    const accountId = await assertLocalServiceReadCustody({
        accountId: input.accountId ?? input.ingress?.machineAdmission?.custodianAccountId,
        machineId: input.machineId,
        context: input.ingress,
    }, input.readScope);
    if (accountId && !input.serverId) throw new Error('requester_credentials_unavailable');
    // A requester holding their own Session here reads that Session's workspace under their own
    // Account, never another scope (SEC-RU2-1123 F1).
    const lent = input.ingress?.requesterSessionBootstrap;
    const sessionId = accountId && lent?.attribution.accountId === accountId ? lent.getBoundSessionId() : null;
    const ownSession = lent && sessionId ? { sessionId, account: { serverHttpBaseUrl: lent.serverHttpBaseUrl,
        account: { credentials: lent.credentials, sessionCustody: { serverId: lent.attribution.serverId,
            accountId: lent.attribution.accountId, serverHttpBaseUrl: lent.serverHttpBaseUrl,
            isCurrent: () => lent.isCurrent(input.ingress?.signal) } } } } : undefined;
    const requesterManagedServices = accountId && input.serverId
        ? { accountId, serverId: input.serverId, ...(ownSession ? { ownSession } : {}) } : undefined;
    return {
        requesterOnly: requesterManagedServices !== undefined,
        ...(ownSession ? { ownSessionId: ownSession.sessionId } : {}),
        getSnapshot: (request?: Parameters<LocalServiceLauncherFeed['getSnapshot']>[0]) => input.feed.getSnapshot({ ...request,
            ...(requesterManagedServices ? { requesterManagedServices } : {}),
        }),
    };
}
