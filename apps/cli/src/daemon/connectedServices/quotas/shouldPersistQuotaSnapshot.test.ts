import { describe, expect, it } from 'vitest';

describe('shouldPersistQuotaSnapshot', () => {
  it('persists the first snapshot and suppresses unchanged fresh repeats', async () => {
    const mod = await import('./shouldPersistQuotaSnapshot').catch(() => null);
    expect(mod?.shouldPersistQuotaSnapshot).toBeTypeOf('function');
    if (!mod) return;

    const next = {
      fingerprint: 'f1',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      status: 'ok' as const,
    };

    expect(mod.shouldPersistQuotaSnapshot({
      previous: null,
      next,
      nowMs: 1_000,
      minFreshnessMs: 5_000,
    })).toEqual({ persist: true, reason: 'first_snapshot' });

    expect(mod.shouldPersistQuotaSnapshot({
      previous: next,
      next: { ...next, fetchedAt: 2_000 },
      nowMs: 2_000,
      minFreshnessMs: 5_000,
    })).toEqual({ persist: false, reason: 'unchanged_fresh' });
  });

  it('persists material changes and rejects stale snapshots', async () => {
    const mod = await import('./shouldPersistQuotaSnapshot').catch(() => null);
    expect(mod?.shouldPersistQuotaSnapshot).toBeTypeOf('function');
    if (!mod) return;

    const previous = {
      fingerprint: 'f1',
      fetchedAt: 2_000,
      staleAfterMs: 300_000,
      status: 'ok' as const,
    };

    expect(mod.shouldPersistQuotaSnapshot({
      previous,
      next: { ...previous, fingerprint: 'f2', fetchedAt: 2_100 },
      nowMs: 2_100,
      minFreshnessMs: 5_000,
    })).toEqual({ persist: true, reason: 'fingerprint_changed' });

    expect(mod.shouldPersistQuotaSnapshot({
      previous,
      next: { ...previous, fetchedAt: 1_000 },
      nowMs: 2_100,
      minFreshnessMs: 5_000,
    })).toEqual({ persist: false, reason: 'stale_snapshot' });
  });

  it('persists refresh marker clearing even when the fingerprint is unchanged', async () => {
    const mod = await import('./shouldPersistQuotaSnapshot').catch(() => null);
    expect(mod?.shouldPersistQuotaSnapshot).toBeTypeOf('function');
    if (!mod) return;

    expect(mod.shouldPersistQuotaSnapshot({
      previous: {
        fingerprint: 'f1',
        fetchedAt: 1_000,
        staleAfterMs: 300_000,
        status: 'ok' as const,
        refreshRequestedAt: 2_000,
      },
      next: {
        fingerprint: 'f1',
        fetchedAt: 2_100,
        staleAfterMs: 300_000,
        status: 'ok' as const,
      },
      nowMs: 2_100,
      minFreshnessMs: 5_000,
    })).toEqual({ persist: true, reason: 'refresh_marker_clearing' });
  });
});
