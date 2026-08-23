import { describe, expect, it } from 'vitest';

import {
  createInitialHappierListMultiSelectionState,
  reduceHappierListMultiSelection,
  resolveHappierListMultiSelectionKeyboardIntent,
  resolveHappierListMultiSelectionPointerAction,
  resolveHappierListMultiSelectionRange,
  type HappierListMultiSelectionState,
} from './multiSelection.js';

function selectedKeys(state: HappierListMultiSelectionState): string[] {
  return Array.from(state.selectedKeys).sort();
}

describe('reduceHappierListMultiSelection', () => {
  it('replaces selection and tracks the range anchor separately from current focus', () => {
    let state = createInitialHappierListMultiSelectionState({
      scopeKey: 'scope-a',
      visibleOrderedKeys: ['a', 'b', 'c'],
    });

    state = reduceHappierListMultiSelection(state, { type: 'replace', key: 'b' });

    expect(state.isSelectionMode).toBe(true);
    expect(selectedKeys(state)).toEqual(['b']);
    expect(state.anchorKey).toBe('b');
    expect(state.focusedKey).toBe('b');
    expect(state.version).toBe(1);
  });

  it('extends a range from the anchor without losing the anchor', () => {
    let state = createInitialHappierListMultiSelectionState({
      scopeKey: 'scope-a',
      visibleOrderedKeys: ['a', 'b', 'c', 'd'],
    });

    state = reduceHappierListMultiSelection(state, { type: 'replace', key: 'b' });
    state = reduceHappierListMultiSelection(state, { type: 'selectRange', targetKey: 'd' });

    expect(selectedKeys(state)).toEqual(['b', 'c', 'd']);
    expect(state.anchorKey).toBe('b');
    expect(state.focusedKey).toBe('d');
    expect(state.version).toBe(2);
  });

  it('adds a disjoint range when requested', () => {
    let state = createInitialHappierListMultiSelectionState({
      scopeKey: 'scope-a',
      visibleOrderedKeys: ['a', 'b', 'c', 'd', 'e'],
    });

    state = reduceHappierListMultiSelection(state, { type: 'replace', key: 'a' });
    state = reduceHappierListMultiSelection(state, { type: 'toggle', key: 'e' });
    state = reduceHappierListMultiSelection(state, { type: 'selectRange', targetKey: 'd', add: true });

    expect(selectedKeys(state)).toEqual(['a', 'd', 'e']);
    expect(state.anchorKey).toBe('e');
    expect(state.focusedKey).toBe('d');
  });

  it('selects all visible eligible keys and ignores ineligible rows', () => {
    let state = createInitialHappierListMultiSelectionState({
      scopeKey: 'scope-a',
      visibleOrderedKeys: ['a', 'b', 'c'],
      eligibleKeys: ['a', 'c'],
    });

    state = reduceHappierListMultiSelection(state, { type: 'selectAllVisible' });

    expect(selectedKeys(state)).toEqual(['a', 'c']);
    expect(state.anchorKey).toBe('a');
  });

  it('replaces selection from a result set and prunes ineligible keys', () => {
    let state = createInitialHappierListMultiSelectionState({
      scopeKey: 'scope-a',
      visibleOrderedKeys: ['a', 'b', 'c'],
      eligibleKeys: ['a', 'c'],
    });

    state = reduceHappierListMultiSelection(state, { type: 'selectAllVisible' });
    state = reduceHappierListMultiSelection(state, { type: 'setSelectedKeys', keys: ['b', 'c'] });

    expect(state.isSelectionMode).toBe(true);
    expect(selectedKeys(state)).toEqual(['c']);
    expect(state.anchorKey).toBe('c');
    expect(state.focusedKey).toBe('c');
  });

  it('exits selection mode when result replacement has no remaining keys', () => {
    let state = createInitialHappierListMultiSelectionState({
      scopeKey: 'scope-a',
      visibleOrderedKeys: ['a', 'b'],
    });

    state = reduceHappierListMultiSelection(state, { type: 'selectAllVisible' });
    state = reduceHappierListMultiSelection(state, { type: 'setSelectedKeys', keys: [] });

    expect(state.isSelectionMode).toBe(false);
    expect(selectedKeys(state)).toEqual([]);
    expect(state.anchorKey).toBeNull();
    expect(state.focusedKey).toBeNull();
  });

  it('exits selection mode when toggling the final selected key off', () => {
    let state = createInitialHappierListMultiSelectionState({
      scopeKey: 'scope-a',
      visibleOrderedKeys: ['a', 'b'],
    });

    state = reduceHappierListMultiSelection(state, { type: 'replace', key: 'a' });
    state = reduceHappierListMultiSelection(state, { type: 'toggle', key: 'a' });

    expect(state.isSelectionMode).toBe(false);
    expect(selectedKeys(state)).toEqual([]);
    expect(state.anchorKey).toBeNull();
    expect(state.focusedKey).toBeNull();
  });

  it('preserves selected keys hidden by collapsed groups when they remain eligible in scope', () => {
    let state = createInitialHappierListMultiSelectionState({
      scopeKey: 'scope-a',
      visibleOrderedKeys: ['a', 'b', 'c'],
      eligibleKeys: ['a', 'b', 'c'],
    });

    state = reduceHappierListMultiSelection(state, { type: 'replace', key: 'a' });
    state = reduceHappierListMultiSelection(state, { type: 'toggle', key: 'c' });
    state = reduceHappierListMultiSelection(state, {
      type: 'setVisibleOrder',
      visibleOrderedKeys: ['b'],
      eligibleKeys: ['a', 'b', 'c'],
    });

    expect(state.isSelectionMode).toBe(true);
    expect(selectedKeys(state)).toEqual(['a', 'c']);
    expect(state.anchorKey).toBe('c');
    expect(state.focusedKey).toBeNull();
  });

  it('exits selection mode when eligibility pruning removes every selected key', () => {
    let state = createInitialHappierListMultiSelectionState({
      scopeKey: 'scope-a',
      visibleOrderedKeys: ['a', 'b'],
      eligibleKeys: ['a', 'b'],
    });

    state = reduceHappierListMultiSelection(state, { type: 'replace', key: 'a' });
    state = reduceHappierListMultiSelection(state, {
      type: 'setVisibleOrder',
      visibleOrderedKeys: ['b'],
      eligibleKeys: ['b'],
    });

    expect(state.isSelectionMode).toBe(false);
    expect(selectedKeys(state)).toEqual([]);
    expect(state.anchorKey).toBeNull();
    expect(state.focusedKey).toBeNull();
  });

  it('keeps remaining selected keys from bulk results even when their rows are currently collapsed', () => {
    let state = createInitialHappierListMultiSelectionState({
      scopeKey: 'scope-a',
      visibleOrderedKeys: ['b'],
      eligibleKeys: ['a', 'b', 'c'],
    });

    state = reduceHappierListMultiSelection(state, { type: 'setSelectedKeys', keys: ['a', 'c'] });

    expect(state.isSelectionMode).toBe(true);
    expect(selectedKeys(state)).toEqual(['a', 'c']);
    expect(state.anchorKey).toBeNull();
    expect(state.focusedKey).toBeNull();
  });

  it('does not enter selection mode when select-all has no eligible visible keys', () => {
    let state = createInitialHappierListMultiSelectionState({
      scopeKey: 'scope-a',
      visibleOrderedKeys: ['a'],
      eligibleKeys: [],
    });

    state = reduceHappierListMultiSelection(state, { type: 'selectAllVisible' });

    expect(state.isSelectionMode).toBe(false);
    expect(selectedKeys(state)).toEqual([]);
    expect(state.anchorKey).toBeNull();
    expect(state.focusedKey).toBeNull();
  });

  it('clears selection when scope changes instead of relying on route changes', () => {
    let state = createInitialHappierListMultiSelectionState({
      scopeKey: 'scope-a',
      visibleOrderedKeys: ['a', 'b'],
    });

    state = reduceHappierListMultiSelection(state, { type: 'replace', key: 'a' });
    state = reduceHappierListMultiSelection(state, {
      type: 'resetScope',
      scopeKey: 'scope-b',
      visibleOrderedKeys: ['a', 'b'],
    });

    expect(state.scopeKey).toBe('scope-b');
    expect(state.isSelectionMode).toBe(false);
    expect(selectedKeys(state)).toEqual([]);
    expect(state.anchorKey).toBeNull();
  });
});

describe('resolveHappierListMultiSelectionRange', () => {
  const visibleKeys = ['a', 'b', 'c', 'd'];

  it('resolves forward and backward inclusive ranges over visible keys', () => {
    expect(resolveHappierListMultiSelectionRange({
      visibleOrderedKeys: visibleKeys,
      anchorKey: 'b',
      targetKey: 'd',
    })).toEqual(['b', 'c', 'd']);

    expect(resolveHappierListMultiSelectionRange({
      visibleOrderedKeys: visibleKeys,
      anchorKey: 'd',
      targetKey: 'b',
    })).toEqual(['b', 'c', 'd']);
  });

  it('falls back to the target when the anchor is missing', () => {
    expect(resolveHappierListMultiSelectionRange({
      visibleOrderedKeys: visibleKeys,
      anchorKey: 'missing',
      targetKey: 'c',
    })).toEqual(['c']);
  });

  it('filters ineligible keys from the resolved span', () => {
    expect(resolveHappierListMultiSelectionRange({
      visibleOrderedKeys: visibleKeys,
      anchorKey: 'a',
      targetKey: 'd',
      eligibleKeys: new Set(['a', 'c', 'd']),
    })).toEqual(['a', 'c', 'd']);
  });

  it('returns an empty range when the target is not visible or eligible', () => {
    expect(resolveHappierListMultiSelectionRange({
      visibleOrderedKeys: visibleKeys,
      anchorKey: 'a',
      targetKey: 'missing',
    })).toEqual([]);

    expect(resolveHappierListMultiSelectionRange({
      visibleOrderedKeys: visibleKeys,
      anchorKey: 'a',
      targetKey: 'b',
      eligibleKeys: new Set(['a']),
    })).toEqual([]);
  });
});

describe('resolveHappierListMultiSelectionPointerAction', () => {
  it('keeps a plain row press as navigation outside selection mode', () => {
    expect(resolveHappierListMultiSelectionPointerAction({
      isSelectionMode: false,
      platform: 'macos',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
    })).toBe('open');
  });

  it('toggles rows for platform command-click and adds ranges with shift', () => {
    expect(resolveHappierListMultiSelectionPointerAction({
      isSelectionMode: false,
      platform: 'macos',
      shiftKey: false,
      ctrlKey: false,
      metaKey: true,
    })).toBe('toggle');

    expect(resolveHappierListMultiSelectionPointerAction({
      isSelectionMode: false,
      platform: 'windows',
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
    })).toBe('addRange');
  });

  it('reads the command modifier from the platform rather than the key name', () => {
    // Control-click on macOS is the context-menu gesture, never a selection
    // toggle; the same physical key IS the toggle on Windows.
    expect(resolveHappierListMultiSelectionPointerAction({
      isSelectionMode: false,
      platform: 'macos',
      shiftKey: false,
      ctrlKey: true,
      metaKey: false,
    })).toBe('open');

    expect(resolveHappierListMultiSelectionPointerAction({
      isSelectionMode: false,
      platform: 'windows',
      shiftKey: false,
      ctrlKey: true,
      metaKey: false,
    })).toBe('toggle');
  });

  it('selects ranges with shift and toggles plain row presses once already in selection mode', () => {
    expect(resolveHappierListMultiSelectionPointerAction({
      isSelectionMode: false,
      platform: 'windows',
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
    })).toBe('selectRange');

    expect(resolveHappierListMultiSelectionPointerAction({
      isSelectionMode: true,
      platform: 'windows',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
    })).toBe('toggle');
  });
});

describe('resolveHappierListMultiSelectionKeyboardIntent', () => {
  const entries = [
    { disabled: false },
    { disabled: true },
    { disabled: false },
    { disabled: false },
  ] as const;

  function intent(input: Partial<Parameters<typeof resolveHappierListMultiSelectionKeyboardIntent>[0]>) {
    return resolveHappierListMultiSelectionKeyboardIntent({
      key: 'a',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      platform: 'macos',
      entries,
      currentIndex: 0,
      rtl: false,
      ...input,
    });
  }

  it('claims Space as the multi-selectable listbox choose key', () => {
    expect(intent({ key: ' ' })).toEqual({ kind: 'toggleFocused' });
    expect(intent({ key: 'Spacebar' })).toEqual({ kind: 'toggleFocused' });
  });

  it('extends a range over the DISABLED row rather than stopping at it', () => {
    // Only the collection owner can answer this: the row the key event reached
    // cannot see that index 1 is skipped and index 2 is the real next stop.
    expect(intent({ key: 'ArrowDown', shiftKey: true, currentIndex: 0 })).toEqual({
      kind: 'extendRange',
      toIndex: 2,
    });
  });

  it('mirrors horizontal extension under RTL', () => {
    expect(intent({ key: 'ArrowLeft', shiftKey: true, currentIndex: 0, rtl: true })).toEqual({
      kind: 'extendRange',
      toIndex: 2,
    });
    expect(intent({ key: 'ArrowRight', shiftKey: true, currentIndex: 2, rtl: true })).toEqual({
      kind: 'extendRange',
      toIndex: 0,
    });
  });

  it('stops at the collection edge instead of wrapping a range around it', () => {
    expect(intent({ key: 'ArrowUp', shiftKey: true, currentIndex: 0 })).toBeNull();
    expect(intent({ key: 'ArrowDown', shiftKey: true, currentIndex: 3 })).toBeNull();
  });

  it('resolves select-all and exit from the platform command modifier', () => {
    expect(intent({ key: 'a', metaKey: true, platform: 'macos' })).toEqual({ kind: 'selectAllVisible' });
    expect(intent({ key: 'a', ctrlKey: true, platform: 'macos' })).toBeNull();
    expect(intent({ key: 'A', ctrlKey: true, platform: 'windows' })).toEqual({ kind: 'selectAllVisible' });
    expect(intent({ key: 'Escape' })).toEqual({ kind: 'exit' });
  });

  it('leaves unmodified navigation keys to the collection roving owner', () => {
    expect(intent({ key: 'ArrowDown' })).toBeNull();
    expect(intent({ key: 'Home' })).toBeNull();
    expect(intent({ key: 'Enter' })).toBeNull();
  });
});
