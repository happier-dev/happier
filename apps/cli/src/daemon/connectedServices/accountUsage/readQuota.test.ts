import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { readProviderAccountUsageQuotaV4 } from './readQuota';

function fixture() {
  const source = { ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'account' }, bindingKind: 'account' as const };
  const recordKey = { providerId: 'test', accountSubjectId: 'subject', subjectKind: 'account' as const, quotaScope: 'account' as const };
  const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'subject' }, observedAtMs: 250, fetchedAtMs: 250, staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [{ meterId: 'weekly', label: 'Weekly', used: 50, limit: 100, utilizationPct: 50, unit: 'requests', resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }] });
  return { source, snapshot };
}

describe('qualified quota read', () => {
  it.each(['pending', 'witness'] as const)('samples completion time after held %s HTTP without changing explicit as-of reads', async held => {
    const { source, snapshot: base } = fixture();
    const witness = { ...base, observedAtMs: 500, fetchedAtMs: 500 };
    const current = { ...base, observedAtMs: 1250, fetchedAtMs: 1250, staleAfterMs: 500, meters: [{ ...base.meters[0]!, resetsAt: 2000 }] };
    const record = (snapshot: typeof base) => ({ content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' }, sources: [source] });
    let nowMs = 1250;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    let release!: () => void;
    const heldResponse = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const responseEntered = new Promise<void>(resolve => { entered = resolve; });
    const waitAtBoundary = async () => { entered(); await heldResponse; };
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).includes('/history')) {
        if (held === 'witness') await waitAtBoundary();
        return { status: 200, data: { entries: [{ id: 'accepted', observedAtMs: 500, record: record(witness) }], nextCursor: null } };
      }
      return { status: 200, data: String(url).includes('/sources/resolve') ? { source, recordId: current.recordId, providerAccountId: 'subject', fetchedAt: 1250, staleAfterMs: 500 } : record(current) };
    });
    const pendingHttp = vi.spyOn(axios, 'post').mockImplementation(async () => {
      if (held === 'pending') await waitAtBoundary();
      return { status: 200, data: { entries: [{ sessionId: 'session', localId: 'held', reset: { source, recordId: witness.recordId, meterId: 'weekly', witness: { id: 'accepted', observedAtMs: 500 } }, authorityCurrent: true }] } };
    });
    const options = { credentials: { token: 'token' }, accountMode: 'plain' as const };
    try {
      const reading = readProviderAccountUsageQuotaV4({ source }, options);
      await responseEntered;
      nowMs = 2251; // Both the actual observation freshness and its next window have expired.
      release();
      const result = await reading;
      expect(result.current).toEqual(current);
      expect(result.pace).toMatchObject([{ value: { status: 'unavailable', reason: 'stale' } }]);
      expect(result.waitingWork).toMatchObject({ status: 'available', entries: [{ readiness: { status: 'waiting', reason: 'quota_stale' } }] });
      const deterministic = await readProviderAccountUsageQuotaV4({ source }, { ...options, nowMs: 1250 });
      expect(deterministic.pace).toMatchObject([{ value: { status: 'available', pace: 2 } }]);
      expect(deterministic.waitingWork).toMatchObject({ status: 'available', entries: [{ readiness: { status: 'ready' } }] });
    } finally { release(); http.mockRestore(); pendingHttp.mockRestore(); clock.mockRestore(); }
  });
  it('distinguishes an unavailable requested history route from a successfully read empty history', async () => {
    const { source, snapshot } = fixture();
    let historyAvailable = false;
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).includes('/history')) {
        // This transport's validateStatus explicitly admits HTTP 404.
        if (!historyAvailable) return { status: 404, data: {} };
        return { status: 200, data: { entries: [], nextCursor: null } };
      }
      return { status: 200, data: String(url).includes('/sources/resolve') ? { source, recordId: snapshot.recordId, providerAccountId: 'subject', fetchedAt: 250, staleAfterMs: 1000 } : { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 250, staleAfterMs: 1000, status: 'ok' }, sources: [source] } };
    });
    const pendingHttp = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { entries: [] } });
    const input = { source, history: { range: { startAtMs: 0, endAtMs: 500 }, pageSize: 1 } };
    const options = { credentials: { token: 'token' }, accountMode: 'plain' as const, nowMs: 500 };
    try {
      await expect(readProviderAccountUsageQuotaV4(input, options)).rejects.toMatchObject({ code: 'provider_account_usage_content_unavailable' });
      historyAvailable = true;
      expect((await readProviderAccountUsageQuotaV4(input, options)).history).toEqual({ entries: [], nextCursor: null });
    } finally { http.mockRestore(); pendingHttp.mockRestore(); }
  });
  it('opens the canonical keyless plain record, derives its observed pace and retains targets without refreshing a vendor', async () => {
    const { source, snapshot } = fixture();
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).includes('/sources/resolve') ? { source, recordId: snapshot.recordId, providerAccountId: 'subject', fetchedAt: 250, staleAfterMs: 1000 } : { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 250, staleAfterMs: 1000, status: 'ok' }, sources: [source] } }));
    const pendingHttp = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { entries: [] } });
    try {
      const targets = [{ id: 'personal', scope: { kind: 'personal' as const }, utilizationFraction: 1.2 }];
      const result = await readProviderAccountUsageQuotaV4({ source }, { credentials: { token: 'token' }, accountMode: 'plain', nowMs: 500, targets });
      expect(result.current).toEqual(snapshot);
      expect(result.pace).toMatchObject([{ meterId: 'weekly', value: { status: 'available', pace: 2 } }]);
      expect(result.targets).toEqual(targets);
      expect(result.waitingWork).toEqual({ status: 'available', entries: [] });
      expect(http.mock.calls.every(([url]) => !String(url).includes('/refresh'))).toBe(true);
    } finally { http.mockRestore(); pendingHttp.mockRestore(); }
  });
});
