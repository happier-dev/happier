import { describe, expect, it, vi } from 'vitest';

import { createSessionListRenderableSessionFixture, createSessionViewerFixture } from '@/dev/testkit';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';

import { orderBots } from './botActivity';

describe('one Bot order over loaded and paged rows', () => {
  const now = 1_800_000_000_000;
  it('uses meaningful time, stable ties and qualified identities with either source and supplied statuses', () => {
    const rows = [
      { serverId: 'home-a', sessionId: 'twin', session: createSessionListRenderableSessionFixture({ id: 'twin', meaningfulActivityAt: 20, activeAt: now }) },
      { serverId: 'home-b', sessionId: 'twin', session: createSessionListRenderableSessionFixture({ id: 'twin', meaningfulActivityAt: 30, activeAt: 1 }) },
      { serverId: 'home-b', sessionId: 'tie', session: createSessionListRenderableSessionFixture({ id: 'tie', meaningfulActivityAt: 30, activeAt: 2 }) },
      { serverId: 'home-a', sessionId: 'ask', session: createSessionListRenderableSessionFixture({ id: 'ask', meaningfulActivityAt: 1,
        viewer: createSessionViewerFixture({ attention: { needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full' } }) }) },
      // A queried page need not be in any loaded-Bot map.
      { serverId: 'home-c', sessionId: 'page-only', session: createSessionListRenderableSessionFixture({ id: 'page-only', meaningfulActivityAt: 40 }) },
    ];
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Pure ordering must use supplied time'); });
    try {
      const loaded = orderBots(rows, now);
      const paged = orderBots(rows, now, row => getSessionStatus(row.session!, now));
      expect(paged).toEqual(loaded);
      expect(loaded.map(row => [row.serverId, row.sessionId])).toEqual([
        ['home-a', 'ask'], ['home-c', 'page-only'], ['home-b', 'twin'], ['home-b', 'tie'], ['home-a', 'twin'],
      ]);
      expect(new Set(loaded.map(row => row.key)).size).toBe(rows.length);
      expect(loaded.map(row => row.meaningfulActivityAt)).toEqual([1, 40, 30, 30, 20]);
    } finally { wallClock.mockRestore(); }
  });
});
