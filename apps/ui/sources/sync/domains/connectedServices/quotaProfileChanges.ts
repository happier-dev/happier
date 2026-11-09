import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { connectedServiceProfileKey, qualifiedConnectedAccountPreferenceServiceKey } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';
import type { Profile } from '@/sync/domains/profiles/profile';

type Account = Profile['connectedAccountsV4'][number];
type AccountChange = Readonly<{ before: Account | undefined; after: Account | undefined }>;

function accountKey(ref: QualifiedConnectedAccountRef): string {
    return connectedServiceProfileKey({ serviceId: qualifiedConnectedAccountPreferenceServiceKey(ref.service), profileId: ref.accountId });
}

/** Project Profile account replacements for the quota store's identity invalidation. */
export function readQuotaProfileChanges(
    before: readonly Account[],
    after: readonly Account[],
): (ref: QualifiedConnectedAccountRef) => AccountChange | undefined {
    const previousRows = new Set(before);
    const nextRows = new Set(after);
    const changes = new Map<string, AccountChange>();
    for (const account of before) {
        if (!nextRows.has(account)) changes.set(accountKey(account.ref), { before: account, after: undefined });
    }
    for (const account of after) {
        if (previousRows.has(account)) continue;
        const key = accountKey(account.ref);
        changes.set(key, { before: changes.get(key)?.before, after: account });
    }
    return ref => changes.get(accountKey(ref));
}
