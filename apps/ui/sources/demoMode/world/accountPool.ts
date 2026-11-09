import { QualifiedConnectedAccountQuotaSnapshotV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { fromQualifiedGroup } from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import type { PoolMemberQuota } from '@/components/settings/connectedServices/pools/QualifiedPoolDetailView';

import { buildDemoProfile } from './connectedAccounts';
import { DEMO_NOW_MS } from './constants';

/** The already-seeded Codex pool, with synthetic usage snapshots at the same world clock. */
export function buildDemoAccountPool() {
    const profile = buildDemoProfile();
    const native = profile.connectedAccountGroupsV4[0]!;
    const group = fromQualifiedGroup(native, native.ref.service);
    const accounts = profile.connectedAccountsV4.filter(account => account.ref.service.pluginId === native.ref.service.pluginId
        && account.ref.service.localId === native.ref.service.localId);
    const accountLabels = Object.fromEntries(accounts.map(account => [account.ref.accountId, account.displayName ?? account.ref.accountId]));
    const remaining = [68, 24, 91];
    const memberQuotaByAccountId: Record<string, PoolMemberQuota> = {};
    for (const [index, account] of accounts.entries()) {
        memberQuotaByAccountId[account.ref.accountId] = {
            loading: false,
            snapshot: QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
                v: 1, ref: account.ref, fetchedAt: DEMO_NOW_MS - 60_000, staleAfterMs: 900_000,
                planLabel: index === 1 ? 'Team' : 'Plus', accountLabel: accountLabels[account.ref.accountId],
                meters: [
                    { meterId: 'session', label: '5-hour', used: null, limit: null, unit: 'unknown', remainingPct: remaining[index],
                        utilizationPct: 100 - remaining[index]!, resetsAt: DEMO_NOW_MS + 7_200_000, status: 'ok', details: {} },
                    { meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown', remainingPct: 73,
                        utilizationPct: 27, resetsAt: DEMO_NOW_MS + 345_600_000, status: 'ok', details: {} },
                ],
            }),
        };
    }
    return { group, accounts, accountLabels, memberQuotaByAccountId, now: DEMO_NOW_MS };
}
