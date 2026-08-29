import { adoptHomeProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { AccountDirectoryHomeEntryV1 } from '@/sync/api/accountDirectory/accountDirectoryClient';

/** Reconcile one directory entry through the canonical Home profile registry. */
export async function adoptDirectoryHome(entry: AccountDirectoryHomeEntryV1): Promise<ServerProfile> {
    return await adoptHomeProfile({
        descriptor: entry.connectionDescriptor,
        source: 'account-directory',
        preserveUserLabel: true,
    });
}
