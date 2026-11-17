import type { ProviderAccountUsageHistoryRequestV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import type { QualifiedConnectedServiceUsageSourceV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

import { inReadSnapshot } from '@/storage/inTx';
import {
    parseProviderAccountUsageHistoryEntry,
    projectProviderAccountUsageRecordV4,
    readProviderAccountUsageHistoryPageRows,
} from '../providerAccountUsage/recordStorage';
import { ProviderAccountUsagePayloadInvariantError, type StoredProviderAccountUsageRecord } from '../providerAccountUsage/types';

type CapturedPage = Awaited<ReturnType<typeof readProviderAccountUsageHistoryPageRows>>;
type HistoryPage = Readonly<{
    entries: ReturnType<typeof parseProviderAccountUsageHistoryEntry>[];
    nextCursor: CapturedPage['nextCursor'];
    sources: readonly QualifiedConnectedServiceUsageSourceV4[];
}>;
type HistoryScope = Readonly<{ accountId: string; recordId: string; payloadMode: StoredProviderAccountUsageRecord['payloadMode'] }>;

/** Decode after releasing the read connection, preserving the admitted identity and Account mode. */
export function parseQualifiedProviderAccountUsageHistoryEntries(entries: CapturedPage['entries'], scope: HistoryScope) {
    const parsed = entries.map(parseProviderAccountUsageHistoryEntry);
    return parsed.some(entry => entry.record.accountId !== scope.accountId || entry.record.recordId !== scope.recordId
        || entry.record.payloadMode !== scope.payloadMode) ? null : parsed;
}

export function projectQualifiedProviderAccountUsageHistoryPage(page: HistoryPage) {
    return { entries: page.entries.map(entry => ({ id: entry.id, observedAtMs: entry.observedAtMs,
        record: projectProviderAccountUsageRecordV4(entry.record, page.sources) })), nextCursor: page.nextCursor };
}

/** Drain one admitted finite range. Later pages consume that admission; they never reacquire authority. */
export async function* streamQualifiedProviderAccountUsageHistory(params: Readonly<{
    accountId: string;
    recordId: string;
    history: ProviderAccountUsageHistoryRequestV1;
    firstPage: HistoryPage;
    isCancelled: () => boolean;
}>): AsyncGenerator<string> {
    let page = params.firstPage;
    while (!params.isCancelled()) {
        yield JSON.stringify(projectQualifiedProviderAccountUsageHistoryPage(page)) + '\n';
        if (!page.nextCursor || params.isCancelled()) return;
        // A continuation exists only when the admitted first page has entries.
        const payloadMode = params.firstPage.entries[0]!.record.payloadMode;
        const history = { ...params.history, cursor: page.nextCursor };
        // Admission is already captured. This page is one atomic SELECT; an
        // interactive transaction adds a commit deadline after stream headers.
        const captured = await inReadSnapshot(tx => readProviderAccountUsageHistoryPageRows({
            accountId: params.accountId, recordId: params.recordId, history,
        }, tx), { singleStatementRead: true });
        if (params.isCancelled()) return;
        const entries = parseQualifiedProviderAccountUsageHistoryEntries(captured.entries, {
            accountId: params.accountId, recordId: params.recordId, payloadMode,
        });
        if (!entries) throw new ProviderAccountUsagePayloadInvariantError('Provider usage history disagrees with admitted identity or Account mode');
        page = { entries, nextCursor: captured.nextCursor, sources: params.firstPage.sources };
    }
}
