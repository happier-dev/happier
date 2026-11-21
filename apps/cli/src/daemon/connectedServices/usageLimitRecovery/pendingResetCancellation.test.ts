import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { buildProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createPendingResetStartRecoveryPorts } from './createPendingResetStartRecoveryPorts';
import { UsageLimitRecoveryScheduler } from './UsageLimitRecoveryScheduler';

describe('Pending reset quota tick cancellation', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(['authority', 'pending', 'witness', 'current'] as const)(
    'cancels a tracked demand during %s HTTP preparation and later releases the changed window', async phase => {
      vi.useFakeTimers(); vi.setSystemTime(500);
      const source = { ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'account' }, bindingKind: 'account' as const };
      const recordKey = { providerId: 'test', accountSubjectId: 'subject', subjectKind: 'account', quotaScope: 'account' } as const;
      const previous: ProviderAccountUsageSnapshotV1 = { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'test',
        accountSubject: { kind: 'providerSubject', id: 'subject' }, observedAtMs: 500, fetchedAtMs: 500, staleAfterMs: 1_000,
        source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [{ meterId: 'window', label: 'Window',
          used: 50, limit: 100, unit: 'requests', utilizationPct: 50, resetsAt: 1_000, windowDurationMs: 1_000, status: 'ok', details: {} }] };
      const reset = { source, recordId: previous.recordId, meterId: 'window', witness: { id: 'history', observedAtMs: 500 } };
      const requestedAction = PendingRequestedActionV1Schema.parse({ v: 1, kind: 'reset_start', reset });
      let current = previous;
      let rows = [{ localId: 'pending', reset }];
      const record = (value: typeof previous) => ({ content: { t: 'plain', v: value },
        metadata: { fetchedAt: value.fetchedAtMs, staleAfterMs: 1_000, status: 'ok' }, sources: [source] });
      const rawSession = { ...createSessionNotificationContextFixture('session'), encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine' }) };
      const controller = new AbortController();
      const reason = new Error('quota tick cancelled');
      let cancelRead = false;
      let observedSignal: AbortSignal | undefined;
      let postAbortReads = 0;
      const reads = { authority: 0, session: 0, pending: 0, source: 0, witness: 0, current: 0 };
      vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/encryption/currentness')) reads.authority++;
        if (path.endsWith('/sessions/session')) reads.session++;
        if (path.endsWith('/pending')) reads.pending++;
        if (path.endsWith('/sources/resolve')) reads.source++;
        if (path.endsWith('/history')) reads.witness++;
        if (path.endsWith('/record')) reads.current++;
        if (controller.signal.aborted) postAbortReads += 1;
        const matched = phase === 'authority' ? path.endsWith('/encryption/currentness')
          : phase === 'pending' ? path.endsWith('/pending')
            : phase === 'witness' ? path.endsWith('/history') : path.endsWith('/record');
        if (cancelRead && matched) {
          observedSignal = config?.signal as AbortSignal | undefined;
          controller.abort(reason);
        }
        if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
          settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path.endsWith('/sessions/session')) return { status: 200, data: { session: rawSession } };
        if (path.endsWith('/pending')) return { status: 200, data: { pending: rows.map(row => ({ ...row, status: 'queued', requestedAction })) } };
        if (path.endsWith('/history')) return { status: 200, data: { entries: [{ id: 'history', observedAtMs: 500, record: record(previous) }], nextCursor: null } };
        if (path.endsWith('/sources/resolve')) return { status: 200, data: { source, recordId: current.recordId, providerAccountId: 'subject', fetchedAt: current.fetchedAtMs, staleAfterMs: 1_000 } };
        return { status: 200, data: record(current) };
      });
      let sourceAuthorityReads = 0;
      vi.spyOn(axios, 'post').mockImplementation(async url => {
        if (new URL(String(url)).pathname.endsWith('/pending/reset-starts/read')) sourceAuthorityReads++;
        if (controller.signal.aborted) postAbortReads += 1;
        return { status: 200, data: { entries: rows.map(row => ({ sessionId: 'session', ...row, authorityCurrent: true })) } };
      });
      const released: string[] = [];
      const isCurrent = vi.fn(() => true);
      const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => Date.now(),
        pendingResetStarts: createPendingResetStartRecoveryPorts({ credentials: { token: 'token', encryption: null }, machineId: 'machine',
          isCurrent, onError: error => { throw error; }, release: async demand => { released.push(demand.localId); rows = []; } }) });
      try {
        await scheduler.reconcilePendingResetStarts('session');
        // One Session and one reset demand for one connected account in this pass.
        expect({ ...reads, sourceAuthority: sourceAuthorityReads }).toEqual({
          authority: 1, session: 1, pending: 1, source: 1, witness: 1, current: 1, sourceAuthority: 1,
        });
        expect(isCurrent).toHaveBeenCalledOnce();
        isCurrent.mockClear();
        vi.setSystemTime(1_000);
        current = { ...previous, observedAtMs: 1_000, fetchedAtMs: 1_000, meters: [{ ...previous.meters[0]!, resetsAt: 2_000 }] };
        cancelRead = true;
        const result = await scheduler.reconcilePendingResetStartsForTrackedSessions(controller.signal).then(() => null, error => error);
        expect(controller.signal.aborted).toBe(true);
        expect(result).toBe(reason);
        expect(observedSignal).toBe(controller.signal);
        expect(postAbortReads).toBe(0);
        expect(released).toEqual([]);
        cancelRead = false;
        await scheduler.reconcilePendingResetStartsForTrackedSessions();
        expect(released).toEqual(['pending']);
      } finally { scheduler.dispose(); }
    });
});
