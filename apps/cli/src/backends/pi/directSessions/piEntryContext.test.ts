import { describe, expect, it } from 'vitest';

import {
  buildContextEntries,
  buildSessionPath,
  resolveActiveLeafId,
  type PiSessionEntry,
} from './piEntryContext';

// Minimal entry factory. Timestamps are ISO strings on real pi entries.
function entry(partial: Partial<PiSessionEntry> & Pick<PiSessionEntry, 'type' | 'id'>): PiSessionEntry {
  return {
    parentId: null,
    timestamp: '2024-12-03T14:00:00.000Z',
    ...partial,
  } as PiSessionEntry;
}

const header = { type: 'session', id: 'root-uuid', timestamp: '2024-12-03T14:00:00.000Z', version: 3, cwd: '/proj' };

describe('piEntryContext', () => {
  describe('resolveActiveLeafId', () => {
    it('returns the last non-header entry id (mirrors pi _buildIndex)', () => {
      const entries: PiSessionEntry[] = [
        entry({ type: 'message', id: 'a1b2c3d4', parentId: null }),
        entry({ type: 'message', id: 'b2c3d4e5', parentId: 'a1b2c3d4' }),
      ];
      expect(resolveActiveLeafId(entries)).toBe('b2c3d4e5');
    });

    it('skips the session header when present', () => {
      const entries = [
        header,
        entry({ type: 'message', id: 'a1b2c3d4', parentId: null }),
        entry({ type: 'message', id: 'c3d4e5f6', parentId: 'a1b2c3d4' }),
      ];
      expect(resolveActiveLeafId(entries)).toBe('c3d4e5f6');
    });

    it('returns null when there are no non-header entries', () => {
      expect(resolveActiveLeafId([header as any])).toBeNull();
      expect(resolveActiveLeafId([])).toBeNull();
    });
  });

  describe('buildSessionPath', () => {
    it('walks a linear branch root -> leaf', () => {
      const entries: PiSessionEntry[] = [
        entry({ type: 'message', id: 'a1b2c3d4', parentId: null }),
        entry({ type: 'message', id: 'b2c3d4e5', parentId: 'a1b2c3d4' }),
        entry({ type: 'message', id: 'c3d4e5f6', parentId: 'b2c3d4e5' }),
      ];
      expect(buildSessionPath(entries).map((e) => e.id)).toEqual(['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6']);
    });

    it('defaults the leaf to the last-in-file entry, so the active branch excludes abandoned siblings', () => {
      // root a -> b, and a -> b' where b' was appended later (b' is the active leaf)
      const entries: PiSessionEntry[] = [
        entry({ type: 'message', id: 'a1b2c3d4', parentId: null }),
        entry({ type: 'message', id: 'bbbbbbbb', parentId: 'a1b2c3d4' }),
        entry({ type: 'message', id: 'b2c3d4e5', parentId: 'a1b2c3d4' }),
      ];
      expect(buildSessionPath(entries).map((e) => e.id)).toEqual(['a1b2c3d4', 'b2c3d4e5']);
    });

    it('honors an explicit leafId to select a non-default branch', () => {
      const entries: PiSessionEntry[] = [
        entry({ type: 'message', id: 'a1b2c3d4', parentId: null }),
        entry({ type: 'message', id: 'bbbbbbbb', parentId: 'a1b2c3d4' }),
        entry({ type: 'message', id: 'b2c3d4e5', parentId: 'a1b2c3d4' }),
      ];
      expect(buildSessionPath(entries, 'bbbbbbbb').map((e) => e.id)).toEqual(['a1b2c3d4', 'bbbbbbbb']);
    });

    it('returns [] when leafId is null', () => {
      const entries: PiSessionEntry[] = [entry({ type: 'message', id: 'a1b2c3d4', parentId: null })];
      expect(buildSessionPath(entries, null)).toEqual([]);
    });
  });

  describe('buildContextEntries', () => {
    it('returns the full path when there is no compaction', () => {
      const entries: PiSessionEntry[] = [
        entry({ type: 'message', id: 'a1b2c3d4', parentId: null }),
        entry({ type: 'message', id: 'b2c3d4e5', parentId: 'a1b2c3d4' }),
      ];
      expect(buildContextEntries(entries).map((e) => e.id)).toEqual(['a1b2c3d4', 'b2c3d4e5']);
    });

    it('drops entries before the latest compaction firstKeptEntryId, keeps compaction + kept tail + post-compaction', () => {
      const entries: PiSessionEntry[] = [
        entry({ type: 'message', id: 'a1b2c3d4', parentId: null }),
        entry({ type: 'message', id: 'summarized1', parentId: 'a1b2c3d4' }),
        entry({ type: 'message', id: 'keptstart', parentId: 'summarized1' }),
        entry({ type: 'message', id: 'keptnext', parentId: 'keptstart' }),
        entry({ type: 'compaction', id: 'comp12345', parentId: 'keptnext', firstKeptEntryId: 'keptstart', summary: '...' }),
        entry({ type: 'message', id: 'aftercmp', parentId: 'comp12345' }),
      ];
      expect(buildContextEntries(entries).map((e) => e.id)).toEqual(['comp12345', 'keptstart', 'keptnext', 'aftercmp']);
    });

    it('uses the latest compaction when multiple are on the path', () => {
      const entries: PiSessionEntry[] = [
        entry({ type: 'message', id: 'a1b2c3d4', parentId: null }),
        entry({ type: 'compaction', id: 'oldcomp12', parentId: 'a1b2c3d4', firstKeptEntryId: 'a1b2c3d4', summary: 'old' }),
        entry({ type: 'message', id: 'midmsg12', parentId: 'oldcomp12' }),
        entry({ type: 'compaction', id: 'newcomp12', parentId: 'midmsg12', firstKeptEntryId: 'midmsg12', summary: 'new' }),
        entry({ type: 'message', id: 'afternew', parentId: 'newcomp12' }),
      ];
      // latest compaction wins: [newcomp, midmsg, afternew]
      expect(buildContextEntries(entries).map((e) => e.id)).toEqual(['newcomp12', 'midmsg12', 'afternew']);
    });
  });
});
