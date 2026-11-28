import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import * as accountScopedCipher from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createPlainSessionOwnerMetadataEnvelopeV1, sealSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';

import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';

import {
  INITIAL_MEMORY_INVENTORY_STATE,
  refreshMemoryInventoryOnce,
  resolveMemoryInventoryScopes,
  isMemorySessionOnMachine,
  createMemorySessionLocalityReader,
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
  it('selects a scale-shaped page with work linear in its rows', async () => {
    const count = 1_024;
    let identityReads = 0;
    const sessions = Array.from({ length: count }, (_, index) => {
      const session = row(`session-${index}`);
      Object.defineProperty(session, 'id', { get: () => { identityReads++; return `session-${index}`; } });
      return session;
    });
    const { fetchSessionsPage } = createFetcher({ active: [{ sessions, nextCursor: null, hasNext: false }] });
    const result = await refreshMemoryInventoryOnce({ ...BASE, backfillPolicy: 'all_history',
      includeArchivedSessions: false, fetchSessionsPage });
    expect(result.sessionIds).toHaveLength(count);
    // Selection, indexing and eligibility may each read identity; no selected
    // identity may rescan the whole page to recover its already-admitted row.
    expect(identityReads).toBeLessThanOrEqual(6 * count);
  });

  it('reuses unchanged legacy and foreign owner locality, but reopens changed access or content', () => {
    const secret = new Uint8Array(32).fill(19);
    const credentials: StoredCredentials = { token: 'test', encryption: { type: 'legacy', secret } };
    const metadata = (machineId: string) => encodeBase64(encryptLegacy({ machineId }, secret));
    const local = row('legacy-local', { encryptionMode: 'e2ee', metadata: metadata('here'), share: null });
    const foreign = row('legacy-foreign', { encryptionMode: 'e2ee', metadata: metadata('elsewhere'), share: null });
    const read = createMemorySessionLocalityReader({ credentials, machineId: 'here' });
    const opens = vi.spyOn(nacl.secretbox, 'open');
    try {
      for (let tick = 0; tick < 3; tick++) {
        expect(read.isOnMachine({ ...local, updatedAt: tick }, 'e2ee')).toBe(true);
        expect(read.isOnMachine({ ...foreign, updatedAt: tick }, 'e2ee')).toBe(false);
      }
      expect(opens).toHaveBeenCalledTimes(2);
      expect(read.isOnMachine({ ...local, metadata: metadata('elsewhere') }, 'e2ee')).toBe(false);
      expect(read.isOnMachine({ ...local, share: { accessLevel: 'view', canApprovePermissions: false } }, 'e2ee')).toBe(false);
      expect(read.isOnMachine(local, 'e2ee')).toBe(true);
      read.forget([local.id]);
      expect(read.isOnMachine(local, 'e2ee')).toBe(true);
      expect(opens).toHaveBeenCalledTimes(5);
    } finally { opens.mockRestore(); }
  });
  it('opens unchanged owner ciphertext once per worker locality lifetime and reopens changed or forgotten content', () => {
    const secret = new Uint8Array(32).fill(19);
    const credentials: StoredCredentials = { token: 'test', encryption: { type: 'legacy', secret } };
    const envelope = (machineId: string) => sealSessionOwnerMetadataEnvelopeV1({
      ownerMetadata: SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { machineId, path: '/workspace' } }),
      material: { type: 'legacy', secret }, randomBytes: n => new Uint8Array(n).fill(7),
    });
    const session = row('local', { encryptionMode: 'e2ee', metadataLayoutVersion: 1, ownerMetadata: envelope('here') });
    const read = createMemorySessionLocalityReader({ credentials, machineId: 'here' });
    // Measure the Account crypto boundary used by layout-one envelopes rather
    // than the CLI's legacy cipher facade. This spy calls through, preserving
    // real authentication and schema parsing.
    const opens = vi.spyOn(accountScopedCipher, 'openAccountScopedBlobCiphertext');
    try {
      expect(read.isOnMachine(session, 'e2ee')).toBe(true);
      expect(read.isOnMachine({ ...session, updatedAt: 200, ownerMetadata: { ...session.ownerMetadata! } }, 'e2ee')).toBe(true);
      expect(opens).toHaveBeenCalledTimes(1);
      const changed = { ...session, ownerMetadata: envelope('elsewhere') };
      expect(read.isOnMachine(changed, 'e2ee')).toBe(false);
      expect(opens).toHaveBeenCalledTimes(2);
      expect(read.isOnMachine(session, 'plain')).toBe(false);
      expect(read.isOnMachine(session, 'e2ee')).toBe(true);
      read.forget(['local']);
      expect(read.isOnMachine(session, 'e2ee')).toBe(true);
      expect(opens).toHaveBeenCalledTimes(4);
      read.clear();
      expect(read.isOnMachine(session, 'e2ee')).toBe(true);
      expect(opens).toHaveBeenCalledTimes(5);
      secret[0] ^= 1;
      expect(read.isOnMachine(session, 'e2ee')).toBe(false);
      secret[0] ^= 1;
      expect(read.isOnMachine(session, 'e2ee')).toBe(true);
      expect(read.isOnMachine({ ...session, ownerMetadata: null, machineId: 'here' }, 'e2ee')).toBe(false);
      const foreignCredential = createMemorySessionLocalityReader({ machineId: 'here',
        credentials: { token: 'other', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(20) } } });
      expect(foreignCredential.isOnMachine(session, 'e2ee')).toBe(false);
    } finally { opens.mockRestore(); }
  });
  it('remembers each paged Session with a fixed-size proof instead of a copy of its owner ciphertext', () => {
    // The worker remembers every Session it pages (2,000 Sessions retained 6.3 MiB, P03-MEM-DAEMON).
    v8.setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const secret = new Uint8Array(32).fill(19);
    const credentials: StoredCredentials = { token: 'test', encryption: { type: 'legacy', secret } };
    const sessions = Array.from({ length: 2_000 }, (_, index) => row(`s${index}`, {
      encryptionMode: 'e2ee', metadataLayoutVersion: 1,
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        ownerMetadata: SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { machineId: index % 2 ? 'here' : 'other', path: `/workspace/${'p'.repeat(2_000)}/${index}` } }),
        material: { type: 'legacy', secret }, randomBytes: n => new Uint8Array(n).fill(7),
      }),
    }));
    const read = createMemorySessionLocalityReader({ credentials, machineId: 'here' });
    gc();
    const before = process.memoryUsage().heapUsed;
    const local = sessions.filter(session => read.isOnMachine(session, 'e2ee')).length;
    gc();
    const retainedBytes = process.memoryUsage().heapUsed - before;

    expect(local).toBe(1_000);
    expect(retainedBytes).toBeLessThan(1_000_000);
    // Unchanged rows still reuse the remembered decision.
    const opens = vi.spyOn(accountScopedCipher, 'openAccountScopedBlobCiphertext');
    try {
      expect(sessions.filter(session => read.isOnMachine(session, 'e2ee')).length).toBe(1_000);
      expect(opens).toHaveBeenCalledTimes(0);
    } finally { opens.mockRestore(); }
  });
  it.each(['plain', 'e2ee'] as const)('reads layout-one locality without opening shared presentation metadata (%s)', mode => {
    const secret = new Uint8Array(32).fill(19);
    const credentials: StoredCredentials = { token: 'test', encryption: mode === 'plain' ? null : { type: 'legacy', secret } };
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { machineId: 'here', path: '/workspace' } });
    const shared = projectSessionSharedMetadataV1({ metadata: {} });
    const metadata = mode === 'plain' ? JSON.stringify(shared) : encodeBase64(encryptLegacy(shared, secret));
    const session = row('local', { encryptionMode: mode, metadataLayoutVersion: 1, dataEncryptionKey: null, share: null,
      ownerMetadata: mode === 'plain' ? createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata)
        : sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata, material: { type: 'legacy', secret }, randomBytes: n => new Uint8Array(n).fill(7) }),
    });
    let sharedReads = 0;
    Object.defineProperty(session, 'metadata', { enumerable: true, get() { sharedReads++; return metadata; } });
    const input = { session, credentials, machineId: 'here', accountEncryptionMode: mode };
    expect(isMemorySessionOnMachine(input)).toBe(true);
    expect(sharedReads).toBe(0);
    expect(isMemorySessionOnMachine({ ...input, machineId: 'elsewhere' })).toBe(false);
    expect(isMemorySessionOnMachine({ ...input, session: { ...session, ownerMetadata: null, machineId: 'here' } })).toBe(false);
    expect(isMemorySessionOnMachine({ ...input, accountEncryptionMode: mode === 'plain' ? 'e2ee' : 'plain' })).toBe(false);
  });

  it('observes sequences of already-seen sessions without re-admitting them', async () => {
    const { fetchSessionsPage } = createFetcher({ active: [{ sessions: [row('seen', { seq: 8, updatedAt: 12 })],
      nextCursor: null, hasNext: false }] });
    const result = await refreshMemoryInventoryOnce({ ...BASE, seenSessionIds: new Set(['seen']),
      backfillPolicy: 'all_history', includeArchivedSessions: false, fetchSessionsPage });
    expect(result.sessionIds).toEqual([]);
    expect(result.observedSeqBySessionId.get('seen')).toBe(8);
  });
  it('filters foreign and unknown machines through decoded locality', async () => {
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
    expect([...result.observedSeqBySessionId.keys()]).toEqual(['local']);
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
