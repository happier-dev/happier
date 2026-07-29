import {
    projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1,
    type ConnectedServiceId,
    type ConnectedServiceQuotaSnapshotV1,
    type SealedConnectedServiceQuotaSnapshotV1,
    type SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

import { openProviderAccountUsageSnapshot } from './accountUsage/openProviderAccountUsageSnapshot';
import { openConnectedServiceQuotaSnapshot } from './openConnectedServiceQuotaSnapshot';

export function openConnectedServiceQuotaViewSnapshot(
    credentials: AuthCredentials,
    sealed: SealedConnectedServiceQuotaSnapshotV1 | SealedProviderAccountUsageSnapshotV1,
    source: Readonly<{
        serviceId: ConnectedServiceId;
        profileId: string;
    }>,
): ConnectedServiceQuotaSnapshotV1 | null {
    const legacyQuotaSnapshot = openConnectedServiceQuotaSnapshot(credentials, sealed);
    if (legacyQuotaSnapshot) return legacyQuotaSnapshot;

    const providerUsageSnapshot = openProviderAccountUsageSnapshot(credentials, sealed);
    if (!providerUsageSnapshot) return null;

    return projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
        snapshot: providerUsageSnapshot,
        source: {
            serviceId: source.serviceId,
            profileId: source.profileId,
            bindingKind: 'profile',
        },
    });
}
