import { describe, expect, it } from 'vitest';

import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';

import {
  INITIAL_MEMORY_INVENTORY_STATE,
  refreshMemoryInventoryOnce,
  resolveMemoryInventoryScopes,
  isMemorySessionOnMachine,
  type MemoryInventoryScope,
} from './refreshMemoryInventory';

type FetchCall = Readonly<{ scope: MemoryInventoryScope; cursor: string | undefined; limit: number }>;

function row(id: string, extra: Record<string, unknown> = {}): RawSessionListRow {
  return { id, seq: 1, createdAt: 1_000, updatedAt: 1_000, ...extra } as unknown as RawSessionListRow;
}

function createFetcher(
  pagesByScope: Partial<Record<MemoryInventoryScope, ReadonlyArray<Readonly<{
    sessions: RawSessionListRow[];
    nextCursor: string | null;
    hasNext: boolean;
  }>>>>,
) {
  const calls: FetchCall[] = [];
  const consumed: Record<string, number> = {};
  const fetchSessionsPage = async (args: Readonly<{
    scope: MemoryInventoryScope;
    cursor?: string;
    limit: number;
  }>) => {
    calls.push({ scope: args.scope, cursor: args.cursor, limit: args.limit });
    const pages = pagesByScope[args.scope] ?? [];
    const index = consumed[args.scope] ?? 0;
    consumed[args.scope] = index + 1;
    return pages[index] ?? { sessions: [], nextCursor: null, hasNext: false };
  };
  return { calls, fetchSessionsPage };
}

const BASE = {
  enabledAtMs: 0,
  pageLimit: 50,
  nowMs: 10_000,
  seenSessionIds: new Set<string>(),
  state: INITIAL_MEMORY_INVENTORY_STATE,
} as const;

describe('resolveMemoryInventoryScopes', () => {
  it('never includes the archived inventory while archived eligibility is off', () => {
    expect(resolveMemoryInventoryScopes(false)).toEqual(['active']);
    expect(resolveMemoryInventoryScopes(true)).toEqual(['active', 'archived']);
  });
});

describe('refreshMemoryInventoryOnce', () => {
  it('observes revisions of already-seen sessions without re-admitting them', async () => {
    const { fetchSessionsPage } = createFetcher({ active: [{ sessions: [row('seen', { seq: 8, updatedAt: 12 })],
      nextCursor: null, hasNext: false }] });
    const result = await refreshMemoryInventoryOnce({ ...BASE, seenSessionIds: new Set(['seen']),
      backfillPolicy: 'all_history', includeArchivedSessions: false, fetchSessionsPage });
    expect(result.sessionIds).toEqual([]);
    expect(result.observedUpdatedAtBySessionId.get('seen')).toBe(12);
    expect(result.observedSeqBySessionId.get('seen')).toBe(8);
  });
  it('filters foreign and unknown machines through decoded locality and carries edit observations', async () => {
    const credentials = { token: 'test', encryption: null };
    const { fetchSessionsPage } = createFetcher({ active: [{ sessions: [
      row('local', { encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'here' }), updatedAt: 12 }),
      row('foreign', { encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'elsewhere' }) }),
      row('unknown', { encryptionMode: 'plain', metadata: '{}' }),
    ], nextCursor: null, hasNext: false }] });
    const result = await refreshMemoryInventoryOnce({ ...BASE, backfillPolicy: 'all_history',
      includeArchivedSessions: false, fetchSessionsPage,
      isSessionEligible: session => {
        return isMemorySessionOnMachine({ session, credentials, machineId: 'here', accountEncryptionMode: 'plain' });
      },
    });
    expect(result.sessionIds).toEqual(['local']);
    expect(result.observedUpdatedAtBySessionId.get('local')).toBe(12);
  });
  it('never requests the archived endpoint under new_only when archived eligibility is off', async () => {
    const { calls, fetchSessionsPage } = createFetcher({
      active: [{ sessions: [row('s1')], nextCursor: null, hasNext: false }],
    });

    const result = await refreshMemoryInventoryOnce({
      ...BASE,
      backfillPolicy: 'new_only',
      includeArchivedSessions: false,
      fetchSessionsPage,
    });

    expect(calls.map((call) => call.scope)).toEqual(['active']);
    expect(result.mode).toBe('snapshot');
    expect(result.sessionIds).toEqual(['s1']);
  });

  it('never requests the archived endpoint under paged policies when archived eligibility is off', async () => {
    const { calls, fetchSessionsPage } = createFetcher({
      active: [{ sessions: [row('s1')], nextCursor: 'c1', hasNext: true }],
    });

    const result = await refreshMemoryInventoryOnce({
      ...BASE,
      backfillPolicy: 'all_history',
      includeArchivedSessions: false,
      fetchSessionsPage,
    });

    expect(calls.map((call) => call.scope)).toEqual(['active']);
    expect(result.mode).toBe('append');
    expect(result.sessionIds).toEqual(['s1']);
    expect(result.state.active).toEqual({ cursor: 'c1', hasNext: true });
    expect(result.state.archived).toEqual({ cursor: null, hasNext: true });
  });

  it('pages the archived endpoint under new_only when archived eligibility is on and dedupes identities', async () => {
    const { calls, fetchSessionsPage } = createFetcher({
      active: [{ sessions: [row('s1'), row('shared')], nextCursor: null, hasNext: false }],
      archived: [{ sessions: [row('shared'), row('a1')], nextCursor: null, hasNext: false }],
    });

    const result = await refreshMemoryInventoryOnce({
      ...BASE,
      backfillPolicy: 'new_only',
      includeArchivedSessions: true,
      fetchSessionsPage,
    });

    expect(calls.map((call) => call.scope)).toEqual(['active', 'archived']);
    expect(result.sessionIds).toEqual(['s1', 'shared', 'a1']);
  });

  it('pages the archived endpoint under all_history and advances each scope cursor independently', async () => {
    const { calls, fetchSessionsPage } = createFetcher({
      active: [{ sessions: [row('s1')], nextCursor: 'ac1', hasNext: true }],
      archived: [{ sessions: [row('a1')], nextCursor: null, hasNext: false }],
    });

    const result = await refreshMemoryInventoryOnce({
      ...BASE,
      backfillPolicy: 'all_history',
      includeArchivedSessions: true,
      fetchSessionsPage,
    });

    expect(calls.map((call) => call.scope)).toEqual(['active', 'archived']);
    expect(result.sessionIds).toEqual(['s1', 'a1']);
    expect(result.state).toEqual({
      active: { cursor: 'ac1', hasNext: true },
      archived: { cursor: null, hasNext: false },
    });
  });

  it('applies the same 30-day cut-off to the archived inventory', async () => {
    const nowMs = 100 * 24 * 60 * 60 * 1000;
    const stale = nowMs - (60 * 24 * 60 * 60 * 1000);
    const { fetchSessionsPage } = createFetcher({
      active: [{ sessions: [row('s1', { updatedAt: nowMs })], nextCursor: 'ac1', hasNext: true }],
      archived: [{
        sessions: [row('a1', { updatedAt: nowMs }), row('a2', { updatedAt: stale })],
        nextCursor: 'rc1',
        hasNext: true,
      }],
    });

    const result = await refreshMemoryInventoryOnce({
      ...BASE,
      nowMs,
      backfillPolicy: 'last_30_days',
      includeArchivedSessions: true,
      fetchSessionsPage,
    });

    expect(result.sessionIds).toEqual(['s1', 'a1']);
    expect(result.state.archived).toEqual({ cursor: null, hasNext: false });
  });

  it('skips already-seen identities while appending and carries observed sequences', async () => {
    const { fetchSessionsPage } = createFetcher({
      active: [{ sessions: [row('s1', { seq: 7 }), row('s2', { seq: 9 })], nextCursor: null, hasNext: false }],
    });

    const result = await refreshMemoryInventoryOnce({
      ...BASE,
      seenSessionIds: new Set(['s1']),
      backfillPolicy: 'all_history',
      includeArchivedSessions: false,
      fetchSessionsPage,
    });

    expect(result.sessionIds).toEqual(['s2']);
    expect(result.observedSeqBySessionId.get('s2')).toBe(9);
  });

  it('marks only post-enablement sessions as initial-backfill eligible under new_only', async () => {
    const { fetchSessionsPage } = createFetcher({
      active: [{
        sessions: [row('old', { createdAt: 500 }), row('new', { createdAt: 2_000 })],
        nextCursor: null,
        hasNext: false,
      }],
    });

    const result = await refreshMemoryInventoryOnce({
      ...BASE,
      enabledAtMs: 1_000,
      backfillPolicy: 'new_only',
      includeArchivedSessions: false,
      fetchSessionsPage,
    });

    expect(result.sessionIds).toEqual(['old', 'new']);
    expect(result.allowInitialBackfillSessionIds).toEqual(['new']);
  });

  it('pages new_only through the enablement boundary without scanning older history', async () => {
    const { calls, fetchSessionsPage } = createFetcher({
      active: [
        {
          sessions: [row('recent-1', { meaningfulActivityAt: 9_000, createdAt: 9_000 })],
          nextCursor: 'active-2',
          hasNext: true,
        },
        {
          sessions: [
            row('recent-2', { meaningfulActivityAt: 6_000, createdAt: 6_000 }),
            row('boundary-old', { meaningfulActivityAt: 4_000, createdAt: 4_000 }),
          ],
          nextCursor: 'active-3',
          hasNext: true,
        },
        {
          sessions: [row('too-old', { meaningfulActivityAt: 3_000, createdAt: 3_000 })],
          nextCursor: null,
          hasNext: false,
        },
      ],
      archived: [
        {
          sessions: [row('archived-recent', { meaningfulActivityAt: 7_000, createdAt: 7_000, archivedAt: 8_000 })],
          nextCursor: 'archived-2',
          hasNext: true,
        },
        {
          sessions: [row('archived-boundary', { meaningfulActivityAt: 2_000, createdAt: 2_000, archivedAt: 3_000 })],
          nextCursor: 'archived-3',
          hasNext: true,
        },
        {
          sessions: [row('archived-too-old', { meaningfulActivityAt: 1_000, createdAt: 1_000, archivedAt: 2_000 })],
          nextCursor: null,
          hasNext: false,
        },
      ],
    });

    const result = await refreshMemoryInventoryOnce({
      ...BASE,
      enabledAtMs: 5_000,
      backfillPolicy: 'new_only',
      includeArchivedSessions: true,
      fetchSessionsPage,
    });

    expect(calls).toEqual([
      { scope: 'active', cursor: undefined, limit: 50 },
      { scope: 'active', cursor: 'active-2', limit: 50 },
      { scope: 'archived', cursor: undefined, limit: 50 },
      { scope: 'archived', cursor: 'archived-2', limit: 50 },
    ]);
    expect(result.sessionIds).toEqual([
      'recent-1',
      'recent-2',
      'boundary-old',
      'archived-recent',
      'archived-boundary',
    ]);
    expect(result.allowInitialBackfillSessionIds).toEqual(['recent-1', 'recent-2', 'archived-recent']);
  });

  it('does not mistake an old pinned row ahead of the ordered page for the enablement boundary', async () => {
    const { calls, fetchSessionsPage } = createFetcher({
      active: [
        {
          sessions: [
            row('old-pinned', { meaningfulActivityAt: 1_000, createdAt: 1_000 }),
            row('recent', { meaningfulActivityAt: 9_000, createdAt: 9_000 }),
          ],
          nextCursor: 'active-2',
          hasNext: true,
        },
        {
          sessions: [row('ordered-boundary', { meaningfulActivityAt: 4_000, createdAt: 4_000 })],
          nextCursor: 'active-3',
          hasNext: true,
        },
        {
          sessions: [row('too-old', { meaningfulActivityAt: 3_000, createdAt: 3_000 })],
          nextCursor: null,
          hasNext: false,
        },
      ],
    });

    const result = await refreshMemoryInventoryOnce({
      ...BASE,
      enabledAtMs: 5_000,
      backfillPolicy: 'new_only',
      includeArchivedSessions: false,
      fetchSessionsPage,
    });

    expect(calls).toHaveLength(2);
    expect(result.sessionIds).toEqual(['old-pinned', 'recent', 'ordered-boundary']);
  });

  it('restarts an exhausted scope from its head page without re-opening paging', async () => {
    const { calls, fetchSessionsPage } = createFetcher({
      active: [{ sessions: [row('s1')], nextCursor: 'ignored', hasNext: true }],
    });

    const result = await refreshMemoryInventoryOnce({
      ...BASE,
      state: {
        active: { cursor: 'stale', hasNext: false },
        archived: { cursor: null, hasNext: true },
      },
      backfillPolicy: 'all_history',
      includeArchivedSessions: false,
      fetchSessionsPage,
    });

    expect(calls[0]?.cursor).toBeUndefined();
    expect(result.state.active).toEqual({ cursor: null, hasNext: false });
  });
});
