import { describe, expect, it } from 'vitest';
import { SessionBoardLayoutV1Schema, SessionBoardLayoutV1StoredSchema } from './layout.js';

describe('Session Board layout', () => {
  const tab = { id: 'Overview', title: 'Overview', items: [{ itemId: 'Note', width: 'wide' }] };
  it('normalizes additive stored layout fields and preserves placement and identity checks', () => {
    const canonical = { v: 1, tabs: [tab] };
    const stored = { ...canonical, extra: true, tabs: [{ ...tab, extra: true, items: [{ ...tab.items[0], extra: true }] }] };
    expect(SessionBoardLayoutV1StoredSchema.parse(stored)).toEqual(canonical);
    expect(SessionBoardLayoutV1Schema.safeParse(stored).success).toBe(false);
    for (const invalid of [
      { ...stored, tabs: [stored.tabs[0], stored.tabs[0]] },
      { ...stored, tabs: [{ ...tab, items: [{ itemId: 'Note' }] }] },
      { ...stored, tabs: [{ ...tab, items: [{ itemId: 'Note', width: 'unknown' }] }] },
    ]) expect(SessionBoardLayoutV1StoredSchema.safeParse(invalid).success).toBe(false);
  });
  it('preserves semantic identity and permits an item in distinct views', () => {
    const layout = { v: 1, tabs: [tab, { ...tab, id: 'second' }] };
    expect(SessionBoardLayoutV1Schema.parse(layout)).toEqual(layout);
  });
  it('retains an optional shared frame override and rejects noncanonical frame styles', () => {
    const layout = { v: 1, tabs: [{ ...tab, items: [{ ...tab.items[0], frameStyle: 'plain' }] }] };
    expect(SessionBoardLayoutV1Schema.parse(layout)).toEqual(layout);
    for (const frameStyle of [null, 'full_bleed', true]) {
      expect(SessionBoardLayoutV1Schema.safeParse({ v: 1, tabs: [{ ...tab,
        items: [{ ...tab.items[0], frameStyle }],
      }] }).success).toBe(false);
    }
  });
  it('rejects duplicate views and placements, pixels and viewer-local state', () => {
    for (const layout of [
      { v: 1, tabs: [tab, tab] },
      { v: 1, tabs: [{ ...tab, items: [...tab.items, ...tab.items] }] },
      { v: 1, tabs: [{ ...tab, items: [{ itemId: 'Note', width: 400 }] }] },
      { v: 1, tabs: [tab], activeTab: 'Overview' },
    ]) expect(SessionBoardLayoutV1Schema.safeParse(layout).success).toBe(false);
  });
});
