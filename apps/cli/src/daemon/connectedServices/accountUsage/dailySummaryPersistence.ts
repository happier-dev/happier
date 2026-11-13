import { buildProviderAccountUsageDaySummaryV1, openProviderAccountUsageDaySummaryV1, sealProviderAccountUsageDaySummaryV1,
  PROVIDER_ACCOUNT_USAGE_DAY_MS, type ProviderAccountUsageDaySummaryV1 } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import { openProviderAccountUsageHistoryPageV4 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { readQualifiedProviderAccountUsageDaySummariesV4, readQualifiedProviderAccountUsageHistoryV4,
  writeQualifiedProviderAccountUsageDaySummaryV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { readHttpStatus } from '@/api/client/httpStatusError';

/** The key-holding writer backfills only days whose remaining detail lacks coverage. */
export async function maintainProviderAccountUsageDaySummaries(input: Readonly<{
  token: string; recordId: string; accountMode: 'plain' | 'e2ee'; material?: AccountScopedCryptoMaterial;
  randomBytes?: (length: number) => Uint8Array; nowMs: number; signal?: AbortSignal;
}>): Promise<Readonly<{ status: 'written'; days: number }> | Readonly<{ status: 'unsupported' | 'conflict'; days: number }>
  | Readonly<{ status: 'unavailable'; days: number; reason: 'authority_unavailable' | 'write_failed' }>
  | Readonly<{ status: 'partial'; days: number; unavailableDays: readonly Readonly<{ dayStartAtMs: number; reason: 'content_unavailable' }>[] }>> {
  const range = { startAtMs: 0, endAtMs: Math.max(1, input.nowMs + 1) };
  const read = await readQualifiedProviderAccountUsageDaySummariesV4({ ...input, query: { recordId: input.recordId, range, includeMissingDays: true }, requestPurpose: 'connected-accounts:usage-persistence' });
  if (!read) return { status: 'unsupported', days: 0 };
  const existingByDay = new Map(read.summaries.map(summary => [summary.dayStartAtMs, summary]));
  let completedPredecessor: ProviderAccountUsageDaySummaryV1 | undefined;
  let days = 0;
  const unavailableDays = new Map<number, Readonly<{ dayStartAtMs: number; reason: 'content_unavailable' }>>();
  try {
    missingDays: for (const missing of [...read.missingDays].sort((left, right) => left.dayStartAtMs - right.dayStartAtMs)) {
      input.signal?.throwIfAborted();
      const existing = existingByDay.get(missing.dayStartAtMs);
      let previous: ProviderAccountUsageDaySummaryV1 | undefined;
      try { previous = existing ? openProviderAccountUsageDaySummaryV1({ ...input, dayStartAtMs: missing.dayStartAtMs, content: existing.payload.content }) : undefined; }
      catch { unavailableDays.set(missing.dayStartAtMs, { dayStartAtMs: missing.dayStartAtMs, reason: 'content_unavailable' }); continue; }
      let preceding = completedPredecessor && completedPredecessor.dayStartAtMs >= (missing.precedingSummary?.dayStartAtMs ?? -1) ? completedPredecessor : undefined;
      if (!preceding && missing.precedingSummary) {
        try { preceding = openProviderAccountUsageDaySummaryV1({ ...input, dayStartAtMs: missing.precedingSummary.dayStartAtMs, content: missing.precedingSummary.payload.content }); }
        catch { unavailableDays.set(missing.precedingSummary.dayStartAtMs,
          { dayStartAtMs: missing.precedingSummary.dayStartAtMs, reason: 'content_unavailable' }); }
      }
      const snapshots: ProviderAccountUsageDaySummaryV1['lastSnapshot'][] = [];
      let cursor: Readonly<{ id: string; observedAtMs: number }> | undefined;
      const pageSize = 100; // Existing exact-history transport page size, not a backfill limit.
      do {
        const page = await readQualifiedProviderAccountUsageHistoryV4({ ...input, query: { recordId: input.recordId,
          history: { range: { startAtMs: Math.max(missing.dayStartAtMs, previous?.lastSnapshot.fetchedAtMs ?? 0), endAtMs: missing.dayStartAtMs + PROVIDER_ACCOUNT_USAGE_DAY_MS }, pageSize,
            ...(cursor ? { cursor } : {}) } }, requestPurpose: 'connected-accounts:usage-persistence' });
        if (!page) return { status: 'unsupported', days };
        let opened: ReturnType<typeof openProviderAccountUsageHistoryPageV4>;
        try { opened = openProviderAccountUsageHistoryPageV4({ ...input, page }); }
        catch { unavailableDays.set(missing.dayStartAtMs, { dayStartAtMs: missing.dayStartAtMs, reason: 'content_unavailable' }); continue missingDays; }
        snapshots.push(...opened.entries.map(entry => entry.snapshot));
        cursor = opened.nextCursor ?? undefined;
      } while (cursor);
      if (!snapshots.length) continue; // A simultaneous covered sweep may already have removed this day.
      const summary = buildProviderAccountUsageDaySummaryV1({ recordId: input.recordId, dayStartAtMs: missing.dayStartAtMs,
        snapshots, previous, precedingSnapshot: preceding?.lastSnapshot });
      if (input.accountMode === 'e2ee' && (!input.material || !input.randomBytes)) throw new Error('provider_account_usage_summary_material_unavailable');
      const content = input.accountMode === 'plain' ? { t: 'plain' as const, v: summary }
        : sealProviderAccountUsageDaySummaryV1({ summary, material: input.material!, randomBytes: input.randomBytes! });
      const status = await writeQualifiedProviderAccountUsageDaySummaryV4({ ...input, write: { recordId: input.recordId,
        dayStartAtMs: missing.dayStartAtMs, payload: { v: 1, coverage: missing.coverage, content } } });
      if (status !== 'written') return { status, days };
      completedPredecessor = summary;
      days++;
    }
  } catch (error) {
    input.signal?.throwIfAborted();
    return { status: 'unavailable', days,
      reason: readHttpStatus(error) === 401 || readHttpStatus(error) === 403 ? 'authority_unavailable' : 'write_failed' };
  }
  return unavailableDays.size ? { status: 'partial', days, unavailableDays: [...unavailableDays.values()] } : { status: 'written', days };
}
