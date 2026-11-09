import type { QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountRef, ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';
import type { ConnectedServiceAuthGroupSwitchResult } from './ConnectedServiceAuthGroupSwitchCoordinator';

export type ConnectedAccountReauthEvent = Readonly<{
    account: QualifiedConnectedAccountRef;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
}>;

/** Discover affected Pools; only the canonical switch coordinator chooses their next member. */
export async function rotateReauthPools(event: ConnectedAccountReauthEvent, deps: Readonly<{
    listGroups(service: QualifiedConnectedAccountRef['service']): Promise<readonly QualifiedConnectedAccountGroupV4[]>;
    switchAfterCredentialHealth(input: ConnectedAccountReauthEvent & Readonly<{ groupId: string }>): Promise<ConnectedServiceAuthGroupSwitchResult>;
}>): Promise<void> {
    // The public qualified API lists groups by service; it has no account-membership query.
    // Discovery runs only when the health producer commits a reauth transition.
    const groups = await deps.listGroups(event.account.service);
    for (const group of groups) {
        if (group.ref.service.pluginId !== event.account.service.pluginId
            || group.ref.service.localId !== event.account.service.localId
            || group.activeConnectedAccountId !== event.account.accountId
            || !group.members.some(member => member.connectedAccountId === event.account.accountId && member.enabled)) continue;
        await deps.switchAfterCredentialHealth({ ...event, groupId: group.ref.groupId });
    }
}
