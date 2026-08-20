import { describe, expect, it } from 'vitest';

import {
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

    it('terminates when malformed parent links contain a cycle', () => {
      const entries: PiSessionEntry[] = [
        entry({ type: 'message', id: 'cycle-a', parentId: 'cycle-b' }),
        entry({ type: 'message', id: 'cycle-b', parentId: 'cycle-a' }),
      ];

      expect(buildSessionPath(entries).map((item) => item.id)).toEqual(['cycle-a', 'cycle-b']);
    });
  });

});
