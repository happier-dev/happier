import { describe, expect, it } from 'vitest';

import {
  resolveHappierItemBehavior,
  resolveHappierItemGroupConstraints,
  resolveHappierItemSemantics,
  resolveHappierRovingSelection,
  resolveHappierRovingTabStop,
} from './semantics.js';

describe('shared item and group semantics', () => {
  it('owns row interaction, density, divider, accessory and selection policy', () => {
    expect(resolveHappierItemBehavior({
      role: 'option',
      selected: true,
      focused: false,
      selectableItemCount: 3,
      disabled: false,
      busy: false,
      density: 'compact',
      hasPrimaryAction: true,
      hasSecondaryActions: true,
      hasAccessory: true,
      accessoryOutsidePressable: true,
      showNavigationAccessory: true,
      keepNavigationAccessoryWithAccessory: false,
      showDivider: true,
    })).toEqual({
      accessibilityState: { selected: true },
      tabIndex: 0,
      interactive: true,
      secondaryActionsEnabled: true,
      density: 'compact',
      dividerVisible: true,
      selectionVisible: true,
      accessoryPlacement: 'outside',
      navigationAccessoryVisible: false,
    });
  });

  it('projects one accessibility state for core and public rows', () => {
    expect(resolveHappierItemSemantics({
      role: 'radio',
      selected: true,
      disabled: false,
      busy: true,
      expanded: false,
      groupedIndex: 2,
      tabStopIndex: 2,
    })).toEqual({
      accessibilityState: { checked: true, disabled: true, busy: true, expanded: false },
      tabIndex: -1,
    });
  });

  it('preserves the primary action owner while disabled or busy', () => {
    expect(resolveHappierItemBehavior({
      role: 'button',
      disabled: true,
      busy: true,
      hasPrimaryAction: true,
    })).toMatchObject({
      interactive: true,
      secondaryActionsEnabled: false,
      accessibilityState: { disabled: true, busy: true },
      tabIndex: -1,
    });
  });

  it('moves over disabled rows with wrapping and RTL-aware horizontal keys', () => {
    const entries = [{ disabled: false }, { disabled: true }, { disabled: false }] as const;
    expect(resolveHappierRovingSelection({ entries, currentIndex: 0, key: 'ArrowDown', rtl: false })).toBe(2);
    expect(resolveHappierRovingSelection({ entries, currentIndex: 0, key: 'ArrowLeft', rtl: true })).toBe(2);
    expect(resolveHappierRovingSelection({ entries, currentIndex: 2, key: 'Home', rtl: false })).toBe(0);
  });

  it('keeps one reachable roving tab stop on the current choice or the first selectable entry', () => {
    const entries = [{ disabled: true }, { disabled: false }, { disabled: false }] as const;

    expect(resolveHappierRovingTabStop({ entries, selectedIndex: 2 })).toBe(2);
    // A collection with no current choice must still be reachable with one Tab,
    // and its stop can never be an entry a reader cannot choose.
    expect(resolveHappierRovingTabStop({ entries, selectedIndex: -1 })).toBe(1);
    expect(resolveHappierRovingTabStop({ entries, selectedIndex: 0 })).toBe(1);
    expect(resolveHappierRovingTabStop({
      entries: [{ disabled: true }],
      selectedIndex: -1,
    })).toBeNull();
  });

  it('rejects group combinations whose visual and semantic orders disagree', () => {
    expect(() => resolveHappierItemGroupConstraints({
      role: 'radiogroup',
      accessibilityLabel: 'Mode',
      columns: 2,
      virtualized: false,
    })).toThrow('cannot combine columns with a radiogroup');
    expect(() => resolveHappierItemGroupConstraints({
      role: 'radiogroup',
      accessibilityLabel: ' ',
      columns: 1,
      virtualized: false,
    })).toThrow('requires a non-empty accessible name');
  });
});
