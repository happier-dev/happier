import { buildProviderAccountUsageDaySummaryV1, openProviderAccountUsageDaySummaryV1, sealProviderAccountUsageDaySummaryV1,
  packProviderAccountUsageDaySummaryV1, PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING,
  PROVIDER_ACCOUNT_USAGE_DAY_MS, type ProviderAccountUsageDaySummaryV1 } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import { openProviderAccountUsageHistoryPageV4 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { readQualifiedProviderAccountUsageDaySummariesV4, readQualifiedProviderAccountUsageHistoryV4,
  writeQualifiedProviderAccountUsageDaySummaryV4, QualifiedProviderAccountUsageReadConflictError,
  QualifiedProviderAccountUsageOwnershipError } from '@/api/client/qualifiedConnectedAccountApi';
import { readHttpStatus } from '@/api/client/httpStatusError';
import { logger } from '@/ui/logger';

type SummaryCoverageConflict = Extract<Awaited<ReturnType<typeof writeQualifiedProviderAccountUsageDaySummaryV4>>,
  { status: 'conflict' }>;

/** The key-holding writer maintains pending days and upgrades legacy clock evidence. */
export async function maintainProviderAccountUsageDaySummaries(input: Readonly<{
  token: string; recordId: string; accountMode: 'plain' | 'e2ee'; material?: AccountScopedCryptoMaterial;
  randomBytes?: (length: number) => Uint8Array; nowMs: number; signal?: AbortSignal;
}>): Promise<Readonly<{ status: 'written'; days: number }> | Readonly<{ status: 'unsupported'; days: number }>
  | Readonly<SummaryCoverageConflict & { days: number }>
  | Readonly<{ status: 'refused'; days: number;
      operation: 'index' | 'history' | 'put';
      errorCode: QualifiedProviderAccountUsageReadConflictError['code'] | QualifiedProviderAccountUsageOwnershipError['code'] }>
  | Readonly<{ status: 'unavailable'; days: number; reason: 'authority_unavailable' | 'write_failed' }>
  | Readonly<{ status: 'partial'; days: number; unavailableDays: readonly Readonly<{ dayStartAtMs: number; reason: 'content_unavailable' }>[] }>> {
  const range = { startAtMs: 0, endAtMs: Math.max(1, input.nowMs + 1) };
  let days = 0;
  let operation: 'index' | 'history' | 'put' = 'index';
  const unavailableDays = new Map<number, Readonly<{ dayStartAtMs: number; reason: 'content_unavailable' }>>();
  try {
    const read = await readQualifiedProviderAccountUsageDaySummariesV4({ ...input, query: { recordId: input.recordId, range, includeMissingDays: true, requireClockBounds: true, requireCompact: true }, requestPurpose: 'connected-accounts:usage-persistence' });
    if (!read) return { status: 'unsupported', days };
    const existingByDay = new Map(read.summaries.map(summary => [summary.dayStartAtMs, summary]));
    let completedPredecessor: ProviderAccountUsageDaySummaryV1 | undefined;
    missingDays: for (const missing of [...read.missingDays].sort((left, right) => left.dayStartAtMs - right.dayStartAtMs)) {
      input.signal?.throwIfAborted();
      const dayRange = { startAtMs: missing.dayStartAtMs, endAtMs: missing.dayStartAtMs + PROVIDER_ACCOUNT_USAGE_DAY_MS };
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
      const rewrite = missing.rewriteOnly && previous?.observedAtRange ? previous : undefined;
      let cursor: Readonly<{ id: string; observedAtMs: number }> | undefined;
      const pageSize = 100; // Existing exact-history transport page size, not a backfill limit.
      if (!rewrite) do {
        operation = 'history';
        const page = await readQualifiedProviderAccountUsageHistoryV4({ ...input, query: { recordId: input.recordId,
          // Accepted rows can arrive behind the retained last snapshot. Read the
          // selected day's remaining basis before publishing its coverage proof.
          history: { range: dayRange, pageSize,
            ...(cursor ? { cursor } : {}) } }, requestPurpose: 'connected-accounts:usage-persistence' });
        if (!page) return { status: 'unsupported', days };
        let opened: ReturnType<typeof openProviderAccountUsageHistoryPageV4>;
        try { opened = openProviderAccountUsageHistoryPageV4({ ...input, page }); }
        catch { unavailableDays.set(missing.dayStartAtMs, { dayStartAtMs: missing.dayStartAtMs, reason: 'content_unavailable' }); continue missingDays; }
        snapshots.push(...opened.entries.map(entry => entry.snapshot));
        cursor = opened.nextCursor ?? undefined;
      } while (cursor);
      input.signal?.throwIfAborted();
      if (!snapshots.length && !previous) continue; // A simultaneous covered sweep may already have removed this day.
      const summary = rewrite ?? buildProviderAccountUsageDaySummaryV1({ recordId: input.recordId, dayStartAtMs: missing.dayStartAtMs,
        snapshots, previous, precedingSnapshot: preceding?.lastSnapshot, completeDayHistory: true });
      if (input.accountMode === 'e2ee' && (!input.material || !input.randomBytes)) throw new Error('provider_account_usage_summary_material_unavailable');
      const content = input.accountMode === 'plain' ? { t: 'plain' as const, v: packProviderAccountUsageDaySummaryV1(summary) }
        : sealProviderAccountUsageDaySummaryV1({ summary, material: input.material!, randomBytes: input.randomBytes! });
      operation = 'put';
      const result = await writeQualifiedProviderAccountUsageDaySummaryV4({ ...input, write: { recordId: input.recordId,
        dayStartAtMs: missing.dayStartAtMs, payload: { v: 1, coverage: missing.coverage, content, encoding: PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING,
          ...(summary.observedAtRange ? { clockBoundsVersion: 1 as const } : {}) } } });
      if (result.status === 'conflict') {
        logger.warnLocalFile('Provider account usage daily summary write conflict',
          { phase: 'daily_summary', operation, errorCode: result.errorCode, writtenDays: days });
        // Retain Home's pending day if the winner has not covered it yet.
        try {
          const covered = await readQualifiedProviderAccountUsageDaySummariesV4({ ...input, query: {
            recordId: input.recordId, range: dayRange, includeCoverage: true,
          }, requestPurpose: 'connected-accounts:usage-persistence' });
          input.signal?.throwIfAborted();
          const winner = covered && !covered.missingDays.length
            ? covered.summaries.find(entry => entry.dayStartAtMs === missing.dayStartAtMs) : undefined;
          if (!winner) return { ...result, days };
          completedPredecessor = openProviderAccountUsageDaySummaryV1({
            ...input, dayStartAtMs: missing.dayStartAtMs, content: winner.payload.content,
          });
          continue;
        } catch {
          input.signal?.throwIfAborted();
          return { ...result, days };
        }
      }
      if (result.status === 'unsupported') return { ...result, days };
      completedPredecessor = summary;
      days++;
    }
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof QualifiedProviderAccountUsageReadConflictError || error instanceof QualifiedProviderAccountUsageOwnershipError) {
      return { status: 'refused', days, operation, errorCode: error.code };
    }
    return { status: 'unavailable', days,
      reason: readHttpStatus(error) === 401 || readHttpStatus(error) === 403 ? 'authority_unavailable' : 'write_failed' };
  }
  return unavailableDays.size ? { status: 'partial', days, unavailableDays: [...unavailableDays.values()] } : { status: 'written', days };
}
