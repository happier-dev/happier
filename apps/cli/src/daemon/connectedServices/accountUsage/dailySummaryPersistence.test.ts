import { describe, expect, it, vi } from 'vitest';
import axios from '@/api/client/credentialAxios';
import { buildProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
import { maintainProviderAccountUsageDaySummaries } from './dailySummaryPersistence';
import { buildProviderAccountUsageDaySummaryV1, openProviderAccountUsageDaySummaryV1, sealProviderAccountUsageDaySummaryV1, ProviderAccountUsageDaySummaryWriteV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import { persistProviderAccountUsageWithDaySummaries } from './persistence';
import { logger } from '@/ui/logger';

function openPlainWrite(value: unknown) {
  const write = ProviderAccountUsageDaySummaryWriteV1Schema.parse(value);
  return openProviderAccountUsageDaySummaryV1({ recordId: write.recordId, dayStartAtMs: write.dayStartAtMs,
    accountMode: 'plain', content: write.payload.content });
}

describe('key-holding quota summary maintenance', () => {
  describe('producer clock extrema upgrades', () => {
    const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const sample = (fetchedAtMs: number, observedAtMs: number, used = 20): ProviderAccountUsageSnapshotV1 => ({
      v: 1, recordId, recordKey, providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' },
      observedAtMs, fetchedAtMs, staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'daily', label: 'Daily', used, limit: 100, remaining: 100 - used, utilizationPct: used,
        unit: 'requests', resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }],
    });
    const legacySummary = (snapshots: readonly ProviderAccountUsageSnapshotV1[]) => {
      const summary = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: 0, snapshots });
      return { v: summary.v, recordId, dayStartAtMs: 0, lastSnapshot: summary.lastSnapshot, windows: summary.windows };
    };

    it.each(['plain', 'e2ee'] as const)('rewrites a covered %s legacy encoding without rereading exact history', async accountMode => {
      const previous = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: 0, snapshots: [sample(100, 100)] });
      const coverage = { observationCount: 1, frontier: { id: '100', observedAtMs: 100 } };
      const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
      const randomBytes = (n: number) => new Uint8Array(n).fill(3);
      const { sealAccountScopedBlobCiphertext } = await import('@happier-dev/protocol/crypto/accountScopedCipher');
      const content = accountMode === 'plain' ? { t: 'plain' as const, v: previous }
        : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'provider_account_usage_day_summary', material, payload: previous, randomBytes }) };
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        const query = JSON.parse(new URL(String(url)).searchParams.get('query')!);
        expect(query).toMatchObject({ includeMissingDays: true, requireClockBounds: true, requireCompact: true });
        if (!String(url).includes('/day-summaries')) throw new Error('covered_encoding_upgrade_must_not_read_history');
        return { status: 200, data: { summaries: [{ dayStartAtMs: 0, payload: { v: 1, clockBoundsVersion: 1, coverage, content } }],
          missingDays: [{ dayStartAtMs: 0, coverage, rewriteOnly: true }] } };
      });
      const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { success: true } });
      try {
        expect(await maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode, material, randomBytes, nowMs: 200 }))
          .toEqual({ status: 'written', days: 1 });
        const write = put.mock.calls[0]![1] as { payload: { encoding: string; content: typeof content } };
        expect(write.payload.encoding).toBe('snapshot_table_v1');
        expect(openProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: 0, accountMode, material, content: write.payload.content })).toEqual(previous);
      } finally { get.mockRestore(); put.mockRestore(); }
    });

    it.each(['plain', 'e2ee'] as const)('upgrades %s legacy days from all remaining rows despite backwards provider clocks', async accountMode => {
      const observations = [sample(100, 9100, 80), sample(200, 50)];
      const previous = legacySummary(observations);
      const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
      const randomBytes = (n: number) => new Uint8Array(n).fill(3);
      const content = accountMode === 'plain' ? { t: 'plain' as const, v: previous }
        : sealProviderAccountUsageDaySummaryV1({ summary: previous, material, randomBytes });
      const { sealProviderAccountUsageSnapshot } = await import('@happier-dev/protocol/connect/accountUsage');
      const ranges: number[] = [];
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).includes('/day-summaries')) {
          const query = JSON.parse(new URL(String(url)).searchParams.get('query')!);
          expect(query).toMatchObject({ includeMissingDays: true, requireClockBounds: true });
          return { status: 200, data: {
            summaries: [{ dayStartAtMs: 0, payload: { v: 1, coverage: { observationCount: 2, frontier: { id: '200', observedAtMs: 200 } }, content } },
              { dayStartAtMs: 86_400_000, payload: { v: 1, coverage: { observationCount: 0, frontier: null }, content: { t: 'encrypted', c: 'unrelated-completed-body' } } }],
            missingDays: [{ dayStartAtMs: 0, coverage: { observationCount: 2, frontier: { id: '200', observedAtMs: 200 } } }],
          } };
        }
        const query = JSON.parse(new URL(String(url)).searchParams.get('query')!) as { history: { range: { startAtMs: number } } };
        ranges.push(query.history.range.startAtMs);
        return { status: 200, data: { entries: observations.filter(snapshot => snapshot.fetchedAtMs >= query.history.range.startAtMs)
          .map(snapshot => ({ id: String(snapshot.fetchedAtMs), observedAtMs: snapshot.fetchedAtMs, record: {
            content: accountMode === 'plain' ? { t: 'plain', v: snapshot }
              : { t: 'encrypted', c: sealProviderAccountUsageSnapshot({ snapshot, material, randomBytes }).ciphertext },
            metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: 1000, status: 'ok' }, sources: [],
          } })), nextCursor: null } };
      });
      const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { success: true } });
      try {
        expect(await maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode, material, randomBytes, nowMs: 86_400_200 }))
          .toEqual({ status: 'written', days: 1 });
        expect(ranges).toEqual([0]);
        const { ProviderAccountUsageDaySummaryWriteV1Schema } = await import('@happier-dev/protocol/connect/providerAccountUsageDaySummary');
        const write = ProviderAccountUsageDaySummaryWriteV1Schema.parse(put.mock.calls[0]?.[1]);
        expect(write.payload).toMatchObject({ clockBoundsVersion: 1 });
        expect(openProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: 0, accountMode, material, content: write.payload.content }))
          .toMatchObject({ observedAtRange: { startAtMs: 50, endAtMs: 9101 }, windows: [{ peakUsed: 80 }] });
        expect(get.mock.calls).toHaveLength(2);
        expect(put.mock.calls).toHaveLength(1);
      } finally { get.mockRestore(); put.mockRestore(); }
    });

    it.each([false, true])('preserves compacted chart and reset evidence when remaining detail is empty=%s', async empty => {
      const previous = legacySummary([sample(100, 100, 80), { ...sample(200, 1200), meters: [{ ...sample(200, 1200).meters[0]!, resetsAt: 2000 }] },
        { ...sample(300, 9100), meters: [] }]);
      expect(previous.windows[0]?.resets).toEqual([{ resetAtMs: 1000, usedBeforeReset: 80 }]);
      const remaining = empty ? [] : [{ ...sample(50, 10), meters: [] }];
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).includes('/day-summaries')
        ? { summaries: [{ dayStartAtMs: 0, payload: { v: 1, coverage: { observationCount: remaining.length, frontier: empty ? null : { id: '50', observedAtMs: 50 } }, content: { t: 'plain', v: previous } } }],
          missingDays: [{ dayStartAtMs: 0, coverage: { observationCount: remaining.length, frontier: empty ? null : { id: '50', observedAtMs: 50 } } }] }
        : { entries: remaining.map(snapshot => ({ id: '50', observedAtMs: 50, record: { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 50, staleAfterMs: 1000, status: 'ok' }, sources: [] } })), nextCursor: null } }));
      const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { success: true } });
      try {
        expect(await maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode: 'plain', nowMs: 300 })).toEqual({ status: 'written', days: 1 });
        expect(put.mock.calls[0]?.[1]).toMatchObject({ payload: { clockBoundsVersion: 1 } });
        expect(openPlainWrite(put.mock.calls[0]?.[1])).toMatchObject({
          observedAtRange: { startAtMs: empty ? 100 : 10, endAtMs: 9101 }, lastSnapshot: previous.lastSnapshot,
          windows: expect.arrayContaining(previous.windows.map(window => expect.objectContaining({ peakUsed: window.peakUsed,
            firstObservedAtMs: window.firstObservedAtMs, resets: window.resets }))),
        });
      } finally { get.mockRestore(); put.mockRestore(); }
    });

    it('includes accepted backdated rows even when the same pending day also gains a newer row', async () => {
      const first = sample(100, 100, 20);
      const previous = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: 0, snapshots: [first] });
      const observations = [sample(50, 9100, 90), first, sample(200, 200, 30)];
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).includes('/day-summaries')) return { status: 200, data: {
          summaries: [{ dayStartAtMs: 0, payload: { v: 1, coverage: { observationCount: 0, frontier: null }, content: { t: 'plain', v: previous } } }],
          missingDays: [{ dayStartAtMs: 0, coverage: { observationCount: 3, frontier: { id: '200', observedAtMs: 200 } } }],
        } };
        const query = JSON.parse(new URL(String(url)).searchParams.get('query')!) as { history: { range: { startAtMs: number } } };
        return { status: 200, data: { entries: observations.filter(snapshot => snapshot.fetchedAtMs >= query.history.range.startAtMs)
          .map(snapshot => ({ id: String(snapshot.fetchedAtMs), observedAtMs: snapshot.fetchedAtMs, record: { content: { t: 'plain', v: snapshot },
            metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: 1000, status: 'ok' }, sources: [] } })), nextCursor: null } };
      });
      const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { success: true } });
      try {
        expect(await maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode: 'plain', nowMs: 300 })).toEqual({ status: 'written', days: 1 });
        expect(put.mock.calls[0]?.[1]).toMatchObject({ payload: { clockBoundsVersion: 1 } });
        expect(openPlainWrite(put.mock.calls[0]?.[1])).toMatchObject({
          observedAtRange: { startAtMs: 100, endAtMs: 9101 }, windows: [{ peakUsed: 90, firstObservedAtMs: 50 }],
        });
      } finally { get.mockRestore(); put.mockRestore(); }
    });

    it.each(['mode_mismatch', 'material_unavailable'] as const)('does not mark a legacy day proven when %s prevents opening it', async reason => {
      const previous = legacySummary([sample(100, 9100)]);
      const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
      const content = reason === 'mode_mismatch' ? { t: 'plain' as const, v: previous }
        : sealProviderAccountUsageDaySummaryV1({ summary: previous, material, randomBytes: n => new Uint8Array(n).fill(3) });
      const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
        summaries: [{ dayStartAtMs: 0, payload: { v: 1, coverage: { observationCount: 0, frontier: null }, content } }],
        missingDays: [{ dayStartAtMs: 0, coverage: { observationCount: 0, frontier: null } }],
      } });
      const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { success: true } });
      try {
        expect(await maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode: 'e2ee', nowMs: 200 }))
          .toEqual({ status: 'partial', days: 0, unavailableDays: [{ dayStartAtMs: 0, reason: 'content_unavailable' }] });
        expect(get.mock.calls).toHaveLength(1);
        expect(put).not.toHaveBeenCalled();
      } finally { get.mockRestore(); put.mockRestore(); }
    });

    it('stops before sealing or publishing clock proof when cancelled during the final detail read', async () => {
      const controller = new AbortController();
      const cancellation = new Error('cancelled');
      const snapshot = sample(100, 9100);
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).includes('/day-summaries')) return { status: 200, data: { summaries: [],
          missingDays: [{ dayStartAtMs: 0, coverage: { observationCount: 1, frontier: { id: '100', observedAtMs: 100 } } }] } };
        controller.abort(cancellation);
        return { status: 200, data: { entries: [{ id: '100', observedAtMs: 100, record: { content: { t: 'plain', v: snapshot },
          metadata: { fetchedAt: 100, staleAfterMs: 1000, status: 'ok' }, sources: [] } }], nextCursor: null } };
      });
      const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { success: true } });
      try {
        await expect(maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode: 'plain', nowMs: 200, signal: controller.signal }))
          .rejects.toBe(cancellation);
        expect(put).not.toHaveBeenCalled();
      } finally { get.mockRestore(); put.mockRestore(); }
    });

    it('publishes clock proof with the discovered coverage and reports a concurrent coverage conflict', async () => {
      const snapshot = sample(100, 9100);
      const coverage = { observationCount: 1, frontier: { id: '100', observedAtMs: 100 } };
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).includes('/day-summaries')
        ? { summaries: [], missingDays: [{ dayStartAtMs: 0, coverage }] }
        : { entries: [{ id: '100', observedAtMs: 100, record: { content: { t: 'plain', v: snapshot },
          metadata: { fetchedAt: 100, staleAfterMs: 1000, status: 'ok' }, sources: [] } }], nextCursor: null } }));
      const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 409, data: { error: 'provider_account_usage_projection_conflict' } });
      try {
        expect(await maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode: 'plain', nowMs: 200 })).toEqual({ status: 'conflict', days: 0 });
        expect(put.mock.calls[0]?.[1]).toMatchObject({ payload: { coverage, clockBoundsVersion: 1 } });
      } finally { get.mockRestore(); put.mockRestore(); }
    });
  });
  it('uses the just-updated preceding day when discovery also captured its stale body', async () => {
    const day = 86_400_000;
    const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const sample = (at: number, used: number, resetsAt: number): ProviderAccountUsageSnapshotV1 => ({ v: 1, recordId, recordKey, providerId: 'test',
      accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: at, fetchedAtMs: at, staleAfterMs: 1000,
      source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [{ meterId: 'hour', label: 'Hourly', used, limit: 100,
        remaining: 100 - used, utilizationPct: used, resetsAt, windowDurationMs: 1000, unit: 'requests', status: 'ok', details: {} }] });
    const stale = sample(day - 200, 50, day);
    const updated = sample(day - 100, 80, day);
    const current = sample(day + 100, 5, day + 1000);
    const previous = { dayStartAtMs: 0, payload: { v: 1, coverage: { observationCount: 0, frontier: null },
      content: { t: 'plain', v: buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: 0, snapshots: [stale] }) } } };
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).includes('/day-summaries')) return { status: 200, data: { summaries: [previous], missingDays: [
        { dayStartAtMs: 0, coverage: { observationCount: 2, frontier: { id: 'updated', observedAtMs: updated.fetchedAtMs } } },
        { dayStartAtMs: day, coverage: { observationCount: 1, frontier: { id: 'current', observedAtMs: current.fetchedAtMs } }, precedingSummary: previous },
      ] } };
      const query = JSON.parse(new URL(String(url)).searchParams.get('query')!) as { history: { range: { startAtMs: number } } };
      const snapshot = query.history.range.startAtMs < day ? updated : current;
      return { status: 200, data: { entries: [{ id: snapshot === updated ? 'updated' : 'current', observedAtMs: snapshot.fetchedAtMs,
        record: { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: 1000, status: 'ok' }, sources: [] } }], nextCursor: null } };
    });
    const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { success: true } });
    try {
      expect(await maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode: 'plain', nowMs: day + 200 })).toEqual({ status: 'written', days: 2 });
      const { ProviderAccountUsageDaySummaryWriteV1Schema } = await import('@happier-dev/protocol/connect/providerAccountUsageDaySummary');
      const write = ProviderAccountUsageDaySummaryWriteV1Schema.parse(put.mock.calls[1]?.[1]);
      expect(openProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, accountMode: 'plain', content: write.payload.content }).windows.flatMap(window => window.resets))
        .toEqual([{ resetAtMs: day, usedBeforeReset: 80 }]);
    } finally { get.mockRestore(); put.mockRestore(); }
  });
  it('reads the full pending day through transport pages when a summarized day gains an observation', async () => {
    const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const observations: ProviderAccountUsageSnapshotV1[] = Array.from({ length: 102 }, (_, index) => ({ v: 1, recordId, recordKey, providerId: 'test',
      accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: 100 + index, fetchedAtMs: 100 + index, staleAfterMs: 1000,
      source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] }));
    const summary = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: 0, snapshots: observations.slice(0, -1) });
    let transferred = 0;
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).includes('/day-summaries')) return { status: 200, data: { summaries: [{ dayStartAtMs: 0,
        payload: { v: 1, coverage: { observationCount: 0, frontier: null }, content: { t: 'plain', v: summary } } }],
        missingDays: [{ dayStartAtMs: 0, coverage: { observationCount: 102, frontier: { id: '201', observedAtMs: 201 } } }] } };
      const query = JSON.parse(new URL(String(url)).searchParams.get('query')!) as { history: { range: { startAtMs: number }; pageSize: number; cursor?: { observedAtMs: number } } };
      const remaining = observations.filter(snapshot => snapshot.fetchedAtMs >= query.history.range.startAtMs
        && snapshot.fetchedAtMs > (query.history.cursor?.observedAtMs ?? -1));
      const selected = remaining.slice(0, query.history.pageSize);
      transferred += selected.length;
      return { status: 200, data: { entries: selected.map(snapshot => ({ id: String(snapshot.fetchedAtMs), observedAtMs: snapshot.fetchedAtMs,
        record: { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: 1000, status: 'ok' }, sources: [] } })),
        nextCursor: remaining.length > selected.length ? { id: String(selected.at(-1)!.fetchedAtMs), observedAtMs: selected.at(-1)!.fetchedAtMs } : null } };
    });
    const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { success: true } });
    try {
      expect(await maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode: 'plain', nowMs: 300 })).toEqual({ status: 'written', days: 1 });
      expect(transferred).toBe(102);
      expect(openPlainWrite(put.mock.calls[0]?.[1])).toMatchObject({ lastSnapshot: observations.at(-1) });
    } finally { get.mockRestore(); put.mockRestore(); }
  });
  it('does no detail transfer or sealing when discovery reports no missing days', async () => {
    const recordId = buildProviderAccountUsageRecordId({ providerId: 'test', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' });
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { summaries: [], missingDays: [] } });
    const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { success: true } });
    const randomBytes = vi.fn((length: number) => new Uint8Array(length));
    try {
      expect(await maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) }, randomBytes, nowMs: 200 })).toEqual({ status: 'written', days: 0 });
      expect(get.mock.calls).toHaveLength(1);
      expect(put).not.toHaveBeenCalled();
      expect(randomBytes).not.toHaveBeenCalled();
    } finally { get.mockRestore(); put.mockRestore(); }
  });
  it('keeps an accepted detail write successful and reports summary failure without credentials or content', async () => {
    const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const snapshot: ProviderAccountUsageSnapshotV1 = { v: 1, recordId, recordKey, providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' },
      observedAtMs: 100, fetchedAtMs: 100, staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] };
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true, source: { status: 'linked' } } });
    const get = vi.spyOn(axios, 'get').mockRejectedValue({ response: { status: 403, data: { error: 'denied' } } });
    const warning = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
      const result = await persistProviderAccountUsageWithDaySummaries({ token: 'secret-token', nowMs: 200, write: {
        source: { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' },
        expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', expectedConfigurationRevision: 'cfg-current',
        recordId, recordKey, payloadMode: 'plain_json_v1', snapshot, fetchedAt: 100, staleAfterMs: 1000, status: 'ok',
      } });
      expect(result).toMatchObject({ success: true, dailySummary: { status: 'unavailable', reason: 'authority_unavailable' } });
      expect(post.mock.calls).toHaveLength(1);
      expect(warning.mock.calls).toEqual([['Provider account usage daily summary maintenance unavailable',
        { phase: 'daily_summary', reason: 'authority_unavailable', writtenDays: 0 }]]);
    } finally { post.mockRestore(); get.mockRestore(); warning.mockRestore(); }
  });
  it('retains an unreadable old day while summarizing later days that can be opened', async () => {
    const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const day = 86_400_000;
    const snapshot: ProviderAccountUsageSnapshotV1 = { v: 1, recordId, recordKey, providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' },
      observedAtMs: day + 100, fetchedAtMs: day + 100, staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] };
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    const randomBytes = (n: number) => new Uint8Array(n).fill(3);
    const { sealProviderAccountUsageSnapshot } = await import('@happier-dev/protocol/connect/accountUsage');
    const sealed = sealProviderAccountUsageSnapshot({ snapshot, material, randomBytes });
    let historyReads = 0;
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).includes('/day-summaries')) return { status: 200, data: { summaries: [], missingDays: [0, day].map(dayStartAtMs => ({ dayStartAtMs,
        coverage: { observationCount: 1, frontier: { id: String(dayStartAtMs), observedAtMs: dayStartAtMs + 100 } },
        ...(dayStartAtMs === day ? { precedingSummary: { dayStartAtMs: 0, payload: { v: 1, coverage: { observationCount: 0, frontier: null },
          content: { t: 'encrypted', c: 'invalid-ciphertext' } } } } : {}) })) } };
      historyReads++;
      const readable = historyReads === 2;
      return { status: 200, data: { entries: [{ id: readable ? String(day) : '0', observedAtMs: readable ? day + 100 : 100,
        record: { content: { t: 'encrypted', c: readable ? sealed.ciphertext : 'invalid-ciphertext' },
          metadata: { fetchedAt: readable ? day + 100 : 100, staleAfterMs: 1000, status: 'ok' }, sources: [] } }], nextCursor: null } };
    });
    const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { success: true } });
    try {
      expect(await maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode: 'e2ee', material, randomBytes, nowMs: day + 200 }))
        .toEqual({ status: 'partial', days: 1, unavailableDays: [{ dayStartAtMs: 0, reason: 'content_unavailable' }] });
      expect(put.mock.calls).toHaveLength(1);
      expect(put.mock.calls[0]?.[1]).toMatchObject({ dayStartAtMs: day });
    } finally { get.mockRestore(); put.mockRestore(); }
  });
  it.each(['plain', 'e2ee'] as const)('merges %s compacted evidence with remaining detail instead of replacing its peak and first time', async accountMode => {
    const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const old: ProviderAccountUsageSnapshotV1 = { v: 1, recordId, recordKey, providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' },
      observedAtMs: 100, fetchedAtMs: 100, staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'daily', label: 'Daily', used: 80, limit: 100, remaining: 20, utilizationPct: 80, unit: 'requests', resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }] };
    const next = { ...old, observedAtMs: 200, fetchedAtMs: 200, meters: [{ ...old.meters[0]!, used: 20, remaining: 80, utilizationPct: 20 }] };
    const summary = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: 0, snapshots: [old] });
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    const randomBytes = (n: number) => new Uint8Array(n).fill(3);
    const content = accountMode === 'plain' ? { t: 'plain' as const, v: summary } : sealProviderAccountUsageDaySummaryV1({ summary, material, randomBytes });
    const { sealProviderAccountUsageSnapshot } = await import('@happier-dev/protocol/connect/accountUsage');
    const sealed = sealProviderAccountUsageSnapshot({ snapshot: next, material, randomBytes });
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).includes('/day-summaries')
      ? { summaries: [{ dayStartAtMs: 0, payload: { v: 1, coverage: { observationCount: 0, frontier: null }, content } }], missingDays: [{ dayStartAtMs: 0, coverage: { observationCount: 1, frontier: { id: 'new', observedAtMs: 200 } } }] }
      : { entries: [{ id: 'new', observedAtMs: 200, record: { content: accountMode === 'plain' ? { t: 'plain', v: next } : { t: 'encrypted', c: sealed.ciphertext }, metadata: { fetchedAt: 200, staleAfterMs: 1000, status: 'ok' }, sources: [] } }], nextCursor: null } }));
    const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { success: true } });
    try {
      expect(await maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode, material, randomBytes, nowMs: 300 })).toEqual({ status: 'written', days: 1 });
      const written = put.mock.calls[0]?.[1];
      const { ProviderAccountUsageDaySummaryWriteV1Schema } = await import('@happier-dev/protocol/connect/providerAccountUsageDaySummary');
      const payload = ProviderAccountUsageDaySummaryWriteV1Schema.parse(written).payload;
      const opened = openProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: 0, accountMode, material, content: payload.content });
      expect(opened.windows[0]).toMatchObject({ peakUsed: 80, firstObservedAtMs: 100, lastObservedAtMs: 200, lastSnapshot: next });
    } finally { get.mockRestore(); put.mockRestore(); }
  });
  it('backfills exactly missing days and follows cursor pages without growing the transport page size', async () => {
    const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const snapshot: ProviderAccountUsageSnapshotV1 = { v: 1, recordId, recordKey, providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' },
      observedAtMs: 100, fetchedAtMs: 100, staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] };
    const pageSizes: number[] = [];
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).includes('/day-summaries')) return { status: 200, data: { summaries: [], missingDays: [{ dayStartAtMs: 0, coverage: { observationCount: 2, frontier: { id: 'later', observedAtMs: 200 } } }] } };
      const query = JSON.parse(new URL(String(url)).searchParams.get('query')!) as { history: { pageSize: number; cursor?: unknown } };
      pageSizes.push(query.history.pageSize);
      const cursor = query.history.cursor;
      const current = cursor ? { ...snapshot, observedAtMs: 200, fetchedAtMs: 200 } : snapshot;
      return { status: 200, data: { entries: [{ id: cursor ? 'later' : 'accepted', observedAtMs: current.fetchedAtMs,
        record: { content: { t: 'plain', v: current }, metadata: { fetchedAt: current.fetchedAtMs, staleAfterMs: 1000, status: 'ok' }, sources: [] } }],
        nextCursor: cursor ? null : { id: 'accepted', observedAtMs: 100 } } };
    });
    const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { success: true } });
    try {
      expect(await maintainProviderAccountUsageDaySummaries({ token: 'token', recordId, accountMode: 'plain', nowMs: 200 })).toEqual({ status: 'written', days: 1 });
      expect(pageSizes).toEqual([100, 100]);
      expect(put.mock.calls[0]?.[1]).toMatchObject({ recordId, dayStartAtMs: 0, payload: { coverage: { observationCount: 2 } } });
      expect(openPlainWrite(put.mock.calls[0]?.[1])).toMatchObject({ lastSnapshot: { ...snapshot, observedAtMs: 200, fetchedAtMs: 200 } });
    } finally { get.mockRestore(); put.mockRestore(); }
  });
});
