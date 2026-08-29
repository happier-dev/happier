import type { AccountDirectorySession, AccountDirectorySessionSnapshot } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { adoptDirectoryHome } from './adoptDirectoryHome';

/** Refreshes advisory directory metadata and adopts returned Homes without changing focus/groups. */
export async function refreshAccountHomeDirectory(
    session: AccountDirectorySession,
): Promise<AccountDirectorySessionSnapshot> {
    const snapshot = await session.refresh();
    if (snapshot.status !== 'ready') return snapshot;
    for (const entry of snapshot.homes) {
        await adoptDirectoryHome(entry);
    }
    return snapshot;
}
