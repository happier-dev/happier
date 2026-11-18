import { describe, expect, it } from 'vitest';

import {
  encodeHappierSectionCellKey,
  encodeHappierSectionRowCellKey,
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
      multiline: true,
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

  // Owner ruling 2026-11-17 23:52Z: one list-row rule for every row, sheets included: only a row of two or more lines is
  // ruled, even where its group asks for a divider.
  it('draws a sheet row divider only under a row of two or more lines', () => {
    const divider = (multiline: boolean | undefined) => resolveHappierItemBehavior({
      hasPrimaryAction: true, showDivider: true, ...(multiline === undefined ? {} : { multiline }),
    }).dividerVisible;
    expect([divider(true), divider(false), divider(undefined)]).toEqual([true, false, false]);
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

  it('lands End on the last ENABLED entry, not the last index', () => {
    // `core/SURFACE.md` §442/§457 make this collection collection-wide owner of
    // Home/End, so a consumer must never re-derive the extremes itself. Home was
    // already covered; End was not, and a trailing disabled row is the case that
    // separates `enabled.at(-1)` from `entries.length - 1`.
    const trailingDisabled = [{ disabled: false }, { disabled: false }, { disabled: true }] as const;
    expect(resolveHappierRovingSelection({
      entries: trailingDisabled, currentIndex: 0, key: 'End', rtl: false,
    })).toBe(1);

    const leadingDisabled = [{ disabled: true }, { disabled: false }, { disabled: false }] as const;
    expect(resolveHappierRovingSelection({
      entries: leadingDisabled, currentIndex: 2, key: 'Home', rtl: false,
    })).toBe(1);
  });

  it('enters a combobox list with no active row from its ends, and leaves a plain list key unclaimed', () => {
    // A combobox's active descendant may be none (the input owns focus): Down enters at the first
    // enabled row, Up at the last. A list whose focus is always on a row claims nothing from "none".
    const entries = [{ disabled: true }, { disabled: false }, { disabled: false }, { disabled: true }] as const;
    const combobox = { entries, currentIndex: -1, rtl: false, enterFromNone: true } as const;
    expect(resolveHappierRovingSelection({ ...combobox, key: 'ArrowDown' })).toBe(1);
    expect(resolveHappierRovingSelection({ ...combobox, key: 'ArrowUp' })).toBe(2);
    expect(resolveHappierRovingSelection({ ...combobox, key: 'End' })).toBe(2);
    expect(resolveHappierRovingSelection({ ...combobox, key: ' ' })).toBeNull();
    expect(resolveHappierRovingSelection({ entries, currentIndex: -1, rtl: false, key: 'ArrowDown' })).toBeNull();
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

  it('encodes sectioned cell identity so no composed virtualizer cell key collides', () => {
    // The platform section virtualizer composes cell keys by plain string
    // concatenation — `sectionKey + ':header'`, `sectionKey + ':footer'`, and
    // `sectionKey + ':' + rowKey`. These author keys collide pairwise under
    // raw concatenation ('a' + 'b:header' is 'a:b:header', the header cell of
    // section 'a:b').
    const sectionKeys = ['', '0', 'a', 'a:b', 'a:b:header'];
    const rowKeys = ['', 'header', 'footer', 'b:header', 'b:c', 'c'];
    const composed = new Set<string>();
    for (const sectionKey of sectionKeys) {
      const sectionCellKey = encodeHappierSectionCellKey(sectionKey);
      composed.add(`${sectionCellKey}:header`);
      composed.add(`${sectionCellKey}:footer`);
      for (const rowKey of rowKeys) {
        composed.add(`${sectionCellKey}:${encodeHappierSectionRowCellKey(rowKey)}`);
      }
    }
    // Every section contributes 2 synthetic cells plus one row cell per row
    // key, and every one of those cells must be addressable on its own.
    expect(composed.size).toBe(sectionKeys.length * (2 + rowKeys.length));
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
