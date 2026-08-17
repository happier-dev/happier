import { describe, expect, it } from 'vitest';

import {
  resolveHappierMenuContent,
  resolveHappierMenuKeyAction,
  resolveHappierMenuRadioGroups,
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
    expect(resolveHappierPopoverPlacement({
      placement: 'auto',
      available: { top: 240, bottom: 320, left: 600, right: 480 },
    })).toBe('left');
  });
});
