import type { ConnectedServiceId } from '@happier-dev/protocol';

import { rematerializeActiveSessionsForConnectedServiceProfile } from '@/sync/ops/connectedServices/rematerializeConnectedServiceCredentialSessions';
import { sync } from '@/sync/sync';

import { invalidateConnectedServiceGroupsRefreshSignal } from './connectedServiceGroupsRefreshSignal';

export async function runConnectedServiceCredentialStoredEffects(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
}>): Promise<void> {
    await sync.refreshProfile();
    invalidateConnectedServiceGroupsRefreshSignal();
    await rematerializeActiveSessionsForConnectedServiceProfile(params);
}
