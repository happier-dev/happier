import { describe, expect, it, vi } from 'vitest';

// Native Platform is the SDK boundary; all menu semantics below remain real.
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

import {
  resolveHappierMenuContent,
  resolveHappierMenuKeyAction,
  resolveHappierMenuRadioGroups,
  resolveHappierMenuRowNavigation,
  resolveHappierMenuSelection,
  resolveHappierMenuTypeahead,
  resolveHappierPopoverPlacement,
} from './Menu.js';

describe('shared menu selection and keyboard semantics', () => {
  const items = [{ id: 'a' }, { id: 'b', disabled: true }, { id: 'c' }] as const;

  it('selects the first enabled item and skips disabled items', () => {
    expect(resolveHappierMenuSelection({ items, selectedIndex: -1, direction: 1, wrap: true })).toBe(0);
    expect(resolveHappierMenuSelection({ items, selectedIndex: 0, direction: 1, wrap: true })).toBe(2);
    expect(resolveHappierMenuSelection({ items, selectedIndex: 2, direction: 1, wrap: true })).toBe(0);
  });

  it('maps keyboard input onto one close/move/activate vocabulary', () => {
    expect(resolveHappierMenuKeyAction('Escape')).toEqual({ kind: 'close' });
    expect(resolveHappierMenuKeyAction('ArrowDown')).toEqual({ kind: 'move', direction: 1 });
    expect(resolveHappierMenuKeyAction('Home')).toEqual({ kind: 'edge', edge: 'start' });
    expect(resolveHappierMenuKeyAction('End')).toEqual({ kind: 'edge', edge: 'end' });
    expect(resolveHappierMenuKeyAction('Enter')).toEqual({ kind: 'activate' });
    expect(resolveHappierMenuKeyAction('x')).toEqual({ kind: 'typeahead', value: 'x' });
    expect(resolveHappierMenuKeyAction('ArrowRight')).toEqual({ kind: 'cross', direction: 1 });
    expect(resolveHappierMenuKeyAction('ArrowLeft')).toEqual({ kind: 'cross', direction: -1 });
  });

  it('moves across a row of items sideways and between rows vertically', () => {
    const grid = [
      { id: 'blue', row: 'presets' }, { id: 'green', row: 'presets', disabled: true }, { id: 'red', row: 'presets' },
      { id: 'custom-1', row: 'custom' },
      { id: 'picker' },
    ];
    const getRowGroup = (item: { row?: string }) => item.row ?? null;
    const nav = (selectedIndex: number, action: { kind: 'move' | 'cross'; direction: -1 | 1 }) =>
      resolveHappierMenuRowNavigation({ items: grid, selectedIndex, action, getRowGroup });

    expect(nav(0, { kind: 'cross', direction: 1 })).toBe(2);
    expect(nav(2, { kind: 'cross', direction: 1 })).toBeNull();
    expect(nav(0, { kind: 'cross', direction: -1 })).toBeNull();
    expect(nav(2, { kind: 'cross', direction: -1 })).toBe(0);
    expect(nav(4, { kind: 'cross', direction: 1 })).toBeNull();
    expect(nav(0, { kind: 'move', direction: 1 })).toBe(3);
    expect(nav(3, { kind: 'move', direction: 1 })).toBe(4);
    expect(nav(4, { kind: 'move', direction: -1 })).toBe(3);
    expect(nav(3, { kind: 'move', direction: -1 })).toBe(0);
  });

  it('finds the next enabled label match for shared typeahead', () => {
    const labelledItems = [
      { id: 'alpha', label: 'Alpha' },
      { id: 'disabled', label: 'Archive', disabled: true },
      { id: 'beta', label: 'Beta' },
      { id: 'build', label: 'Build' },
    ] as const;

    expect(resolveHappierMenuTypeahead({
      items: labelledItems,
      selectedIndex: 0,
      query: 'b',
    })).toBe(2);
    expect(resolveHappierMenuTypeahead({
      items: labelledItems,
      selectedIndex: 2,
      query: 'b',
    })).toBe(3);
    expect(resolveHappierMenuTypeahead({
      items: labelledItems,
      selectedIndex: 3,
      query: 'a',
    })).toBe(0);
  });

  it('accepts one controlled checked item for each named radio menu group', () => {
    const items = [
      { id: 'project', label: 'Project', kind: 'radio' as const, radioGroupId: 'scope' },
      { id: 'workspace', label: 'Workspace', kind: 'radio' as const, radioGroupId: 'scope' },
    ];

    expect(resolveHappierMenuRadioGroups({
      items,
      radioGroups: [{ id: 'scope', accessibilityLabel: 'Scope', selectedId: 'workspace' }],
    }).get('scope')?.selectedId).toBe('workspace');
    expect(() => resolveHappierMenuRadioGroups({
      items,
      radioGroups: [{ id: 'scope', accessibilityLabel: 'Scope', selectedId: 'missing' }],
    })).toThrow(/outside the group/i);
  });

  it('flattens named semantic groups through one ordered menu selection model', () => {
    const content = resolveHappierMenuContent({
      items: [{ id: 'refresh', label: 'Refresh' }],
      groups: [
        {
          id: 'view',
          accessibilityLabel: 'View options',
          items: [
            { id: 'pin', label: 'Pin', kind: 'checkbox', checked: true },
            { id: 'archive', label: 'Archive' },
          ],
        },
      ],
    });

    expect(content.items.map((item) => item.id)).toEqual(['refresh', 'pin', 'archive']);
    expect(content.groups[0]).toMatchObject({
      id: 'view',
      accessibilityLabel: 'View options',
      entries: [
        { index: 1, item: { id: 'pin' } },
        { index: 2, item: { id: 'archive' } },
      ],
    });
    expect(() => resolveHappierMenuContent({
      items: [{ id: 'duplicate', label: 'First' }],
      groups: [{
        id: 'more',
        accessibilityLabel: 'More actions',
        items: [{ id: 'duplicate', label: 'Second' }],
      }],
    })).toThrow(/duplicate menu item id/i);
    expect(() => resolveHappierMenuContent({
      items: [{ id: 'checkbox', label: 'Checkbox', kind: 'checkbox' }],
    })).toThrow(/checkbox menu item .* requires a boolean checked/i);
    expect(() => resolveHappierMenuContent({
      items: [{ id: '  ', label: 'Anonymous action' }],
    })).toThrow(/non-empty menu item id/i);
  });

  it('resolves portable auto placement using the available space and preferred axis capacity', () => {
    expect(resolveHappierPopoverPlacement({
      placement: 'auto-vertical',
      preferredMinAvailable: 320,
      available: { top: 520, bottom: 320, left: 320, right: 480 },
    })).toBe('bottom');
    expect(resolveHappierPopoverPlacement({
      placement: 'auto-vertical',
      preferredMinAvailable: 320,
      available: { top: 240, bottom: 24, left: 320, right: 480 },
    })).toBe('top');
    expect(resolveHappierPopoverPlacement({
      placement: 'auto-horizontal',
      preferredMinAvailable: 240,
      available: { top: 240, bottom: 120, left: 320, right: 24 },
    })).toBe('left');
  });

  // A popover from a top-of-page trigger (Export…, History, a database picker) opened beside it, over the page
  // title, because a wide window has more room on a side than below (DBW-UI-4 N3). Auto prefers below, then above,
  // and takes a side only when neither holds it.
  it('opens an auto popover below, above when below is short, and beside only when neither holds it', () => {
    expect(resolveHappierPopoverPlacement({
      placement: 'auto',
      preferredMinAvailable: 320,
      available: { top: 60, bottom: 700, left: 900, right: 1100 },
    })).toBe('bottom');
    expect(resolveHappierPopoverPlacement({
      placement: 'auto',
      preferredMinAvailable: 320,
      available: { top: 600, bottom: 120, left: 900, right: 1100 },
    })).toBe('top');
    expect(resolveHappierPopoverPlacement({
      placement: 'auto',
      preferredMinAvailable: 320,
      available: { top: 200, bottom: 240, left: 300, right: 900 },
    })).toBe('right');
    expect(resolveHappierPopoverPlacement({
      placement: 'auto',
      preferredMinAvailable: 320,
      available: { top: 200, bottom: 240, left: 100, right: 90 },
    })).toBe('bottom');
  });

  // A submenu from a menu that fills a phone has room on neither side: squeezed beside it, it was 66 px wide
  // at 390 (QA-J3-1106). It opens above or below instead, at full width, and scrolls in that height.
  it('opens a side menu above or below when neither side holds it', () => {
    expect(resolveHappierPopoverPlacement({
      placement: 'auto-horizontal',
      preferredMinAvailable: 280,
      available: { top: 620, bottom: 40, left: 90, right: 10 },
    })).toBe('top');
    expect(resolveHappierPopoverPlacement({
      placement: 'auto-horizontal',
      preferredMinAvailable: 280,
      available: { top: 60, bottom: 500, left: 90, right: 10 },
    })).toBe('bottom');
    // One side that holds it still wins, as before.
    expect(resolveHappierPopoverPlacement({
      placement: 'auto-horizontal',
      preferredMinAvailable: 280,
      available: { top: 620, bottom: 40, left: 300, right: 10 },
    })).toBe('left');
  });

  it('keeps an explicit side unless asked to flip it, and flips only to a roomier opposite side', () => {
    const cramped = { top: 4, bottom: 700, left: 320, right: 480 };
    expect(resolveHappierPopoverPlacement({ placement: 'top', preferredMinAvailable: 72, available: cramped })).toBe('top');
    expect(resolveHappierPopoverPlacement({ placement: 'top', preferredMinAvailable: 72, available: cramped, flip: true })).toBe('bottom');
    expect(resolveHappierPopoverPlacement({
      placement: 'top',
      preferredMinAvailable: 72,
      available: { top: 40, bottom: 20, left: 320, right: 480 },
      flip: true,
    })).toBe('top');
    expect(resolveHappierPopoverPlacement({
      placement: 'top',
      preferredMinAvailable: 72,
      available: { top: 300, bottom: 700, left: 320, right: 480 },
      flip: true,
    })).toBe('top');
  });
});
