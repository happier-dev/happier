import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { UsageLimitRecoveryScheduler } from './UsageLimitRecoveryScheduler';

function snapshot(at: number, resetsAt: number): ProviderAccountUsageSnapshotV1 {
  const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' } as const;
  return {
    v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'test',
    accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: at, fetchedAtMs: at,
    staleAfterMs: 1_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
    meters: [{ meterId: 'window', label: 'Window', used: 50, limit: 100, unit: 'requests',
      utilizationPct: 50, resetsAt, windowDurationMs: 1_000, status: 'ok', details: {} }],
  };
}

describe('UsageLimitRecoveryScheduler Pending reset demand', () => {
  afterEach(() => vi.useRealTimers());

  it('reconstructs demand from Pending and releases only a fresh witnessed next window, without a recovery prompt', async () => {
    vi.useFakeTimers(); vi.setSystemTime(500);
    const previous = snapshot(500, 1_000);
    const reset = { source: { ref: { service: { pluginId: 'example', localId: 'service' }, accountId: 'account' }, bindingKind: 'account' } as const,
      recordId: previous.recordId, meterId: 'window', witness: { id: 'history', observedAtMs: 500 } };
    let rows = [{ localId: 'pending', reset }];
    let current = previous;
    const released: string[] = [];
    const resumed: string[] = [];
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(), resume: async () => { resumed.push('resume'); },
      pendingResetStarts: { withSession: async (_sessionId, run) => run({
        isCurrent: async () => true,
        read: async () => rows,
        readAuthority: async () => true,
        readWitness: async () => previous,
        readCurrent: async () => current,
        release: async ({ localId }) => { released.push(localId); rows = []; },
      }) },
    });
    await scheduler.reconcilePendingResetStarts('session');
    await vi.advanceTimersByTimeAsync(500);
    expect(released).toEqual([]);
    current = snapshot(1_000, 2_000);
    await scheduler.reconcilePendingResetStartsForTrackedSessions();
    expect(released).toEqual(['pending']);
    expect(resumed).toEqual([]);
    expect(scheduler.read('session')).toBeNull();
    await scheduler.reconcilePendingResetStarts('session');
    expect(released).toEqual(['pending']);
    scheduler.dispose();
  });

  it.each(['retired', 'expired', 'stale'] as const)('does not release when %s during the final Account currentness probe', async reason => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const previous = snapshot(500, 1_000);
    const current = snapshot(1_000, 2_000);
    current.staleAfterMs = reason === 'expired' ? 10_000 : reason === 'stale' ? 100 : 1_000;
    const reset = { source: { ref: { service: { pluginId: 'example', localId: 'service' }, accountId: 'account' }, bindingKind: 'account' } as const,
      recordId: previous.recordId, meterId: 'window', witness: { id: 'history', observedAtMs: 500 } };
    let holdAuthority = false;
    let enterAuthority: (() => void) | undefined;
    let releaseAuthority: (() => void) | undefined;
    const authorityEntered = new Promise<void>(resolve => { enterAuthority = resolve; });
    const released: string[] = [];
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => Date.now(), pendingResetStarts: { withSession: async (_sessionId, run) => run({
      isCurrent: async () => {
        if (holdAuthority) {
          enterAuthority?.();
          await new Promise<void>(resolve => { releaseAuthority = resolve; });
        }
        return true;
      },
      read: async () => [{ localId: 'pending', reset }], readAuthority: async () => true,
      readWitness: async () => previous,
      readCurrent: async () => { holdAuthority = true; return current; },
      release: async ({ localId }) => { released.push(localId); },
    }) } });
    try {
      const reconciling = scheduler.reconcilePendingResetStarts('session');
      await authorityEntered;
      if (reason === 'retired') scheduler.dispose();
      else vi.setSystemTime(reason === 'expired' ? 2_000 : 1_200);
      releaseAuthority?.();
      await reconciling;
      expect(released).toEqual([]);
    } finally { releaseAuthority?.(); scheduler.dispose(); }
  });

  it.each(['withdrawn', 'stale', 'changed_window', 'expired_next_window', 'changed_entitlement', 'changed_denominator', 'unavailable_meter', 'wrong_witness', 'authority_lost', 'retired'] as const)('withholds release for %s demand', async reason => {
    vi.useFakeTimers(); vi.setSystemTime(500);
    const previous = snapshot(500, 1_000);
    const reset = { source: { ref: { service: { pluginId: 'example', localId: 'service' }, accountId: 'account' }, bindingKind: 'account' } as const,
      recordId: previous.recordId, meterId: 'window', witness: { id: 'history', observedAtMs: 500 } };
    let rows = [{ localId: 'pending', reset }];
    let current = previous;
    let authorityCurrent = true;
    const released: string[] = [];
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => Date.now(), pendingResetStarts: { withSession: async (_sessionId, run) => run({
      isCurrent: async () => true,
      read: async () => rows, readWitness: async () => reason === 'wrong_witness' ? { ...previous, fetchedAtMs: 501 } : previous, readCurrent: async () => current,
      readAuthority: async () => authorityCurrent,
      release: async ({ localId }) => { released.push(localId); },
    }) } });
    await scheduler.reconcilePendingResetStarts('session');
    current = snapshot(reason === 'stale' ? 0 : 1_000, reason === 'changed_window' ? 3_000 : 2_000);
    if (reason === 'expired_next_window') { current.staleAfterMs = 10_000; vi.setSystemTime(2_000); }
    if (reason === 'changed_entitlement') current.planLabel = 'different';
    if (reason === 'changed_denominator') current.meters[0]!.limit = 200;
    if (reason === 'unavailable_meter') current.meters[0]!.status = 'unavailable';
    if (reason === 'withdrawn') rows = [];
    if (reason === 'authority_lost') authorityCurrent = false;
    if (reason === 'retired') scheduler.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(released).toEqual([]);
    scheduler.dispose();
  });
});
