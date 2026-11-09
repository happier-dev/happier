import * as React from 'react';
import renderer from 'react-test-renderer';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { resolveHappierTreeFocusKey, resolveHappierTreeKeyIntent, useHappierTreeInteraction, type HappierTreeNode } from './treeInteraction.js';

const branch: HappierTreeNode = { key: 'branch', parentKey: null, depth: 0, kind: 'branch', expanded: true };
const child: HappierTreeNode = { key: 'opaque-child', parentKey: 'branch', depth: 1, kind: 'leaf', expanded: false };
const other: HappierTreeNode = { key: 'sibling', parentKey: null, depth: 0, kind: 'leaf', expanded: false };

/** A browser page whose focus sits on the page itself (what a recycled row's blur leaves behind). */
async function onWebPage(run: () => Promise<void> | void) {
  const body = { kind: 'body' };
  (globalThis as { document?: unknown }).document = { body, activeElement: body, addEventListener: () => {} };
  try { await run(); } finally { delete (globalThis as { document?: unknown }).document; }
}

describe('shared tree interaction', () => {
  it('keeps arrow disclosure, explicit-parent traversal and activation distinct', () => {
    const nodes = [branch, child, other];
    expect(resolveHappierTreeKeyIntent(nodes, branch.key, 'ArrowRight')).toEqual({ kind: 'focus', key: child.key });
    expect(resolveHappierTreeKeyIntent(nodes, child.key, 'ArrowLeft')).toEqual({ kind: 'focus', key: branch.key });
    expect(resolveHappierTreeKeyIntent(nodes, branch.key, 'ArrowLeft')).toEqual({ kind: 'disclose', key: branch.key, expanded: false });
    expect(resolveHappierTreeKeyIntent([{ ...branch, expanded: false }, other], branch.key, 'ArrowRight'))
      .toEqual({ kind: 'disclose', key: branch.key, expanded: true });
    expect(resolveHappierTreeKeyIntent(nodes, child.key, 'Enter')).toEqual({ kind: 'activate', key: child.key });
    expect(resolveHappierTreeKeyIntent(nodes, branch.key, 'ArrowDown')).toEqual({ kind: 'focus', key: child.key });
    expect(resolveHappierTreeKeyIntent(nodes, child.key, 'ArrowUp')).toEqual({ kind: 'focus', key: branch.key });
    expect(resolveHappierTreeKeyIntent(nodes, child.key, 'Home')).toEqual({ kind: 'focus', key: branch.key });
    expect(resolveHappierTreeKeyIntent(nodes, child.key, 'End')).toEqual({ kind: 'focus', key: other.key });
  });

  it('toggles a branch with Space in either direction and leaves a leaf alone', () => {
    const nodes = [branch, child, other];
    expect(resolveHappierTreeKeyIntent(nodes, branch.key, ' ')).toEqual({ kind: 'disclose', key: branch.key, expanded: false });
    expect(resolveHappierTreeKeyIntent([{ ...branch, expanded: false }, other], branch.key, ' '))
      .toEqual({ kind: 'disclose', key: branch.key, expanded: true });
    expect(resolveHappierTreeKeyIntent(nodes, child.key, ' ')).toBeNull();
  });

  it('retains disabled rows for inspection but refuses disclosure and activation', () => {
    const disabled = { ...branch, disabled: true, expanded: false };
    expect(resolveHappierTreeKeyIntent([disabled, other], disabled.key, 'Enter')).toBeNull();
    expect(resolveHappierTreeKeyIntent([disabled, other], disabled.key, 'ArrowRight')).toBeNull();
    expect(resolveHappierTreeKeyIntent([disabled, other], other.key, 'Home')).toEqual({ kind: 'focus', key: disabled.key });
  });

  it('repairs to the nearest known visible ancestor without inventing a path parent', () => {
    const nested: HappierTreeNode = { ...branch, key: 'nested', parentKey: branch.key, depth: 1 };
    const grandchild = { ...child, parentKey: nested.key, depth: 2 };
    expect(resolveHappierTreeFocusKey([other, branch], grandchild.key, [other, branch, nested, grandchild])).toBe(branch.key);
    expect(resolveHappierTreeFocusKey([other], grandchild.key, [branch, nested, grandchild])).toBe(other.key);
    expect(resolveHappierTreeFocusKey([], grandchild.key, [branch, nested, grandchild])).toBeNull();
  });

  it('lands focus on a row a windowed list brings into view, even as the row it left is recycled away', () => onWebPage(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const rows: HappierTreeNode[] = Array.from({ length: 3 }, (_, index) => ({ key: `row-${index}`, parentKey: null, depth: 0, kind: 'leaf', expanded: false }));
    const focused: string[] = [];
    const revealed: number[] = [];
    let tree: ReturnType<typeof useHappierTreeInteraction> | null = null;
    function Probe() {
      const [focusedKey, setFocusedKey] = React.useState<string | null>('row-0');
      tree = useHappierTreeInteraction({ visibleNodes: rows, focusedKey, onFocus: setFocusedKey,
        onExpandedChange: () => {}, onActivate: () => {}, onRevealIndex: index => { revealed.push(index); } });
      return null;
    }
    act(() => { renderer.create(React.createElement(Probe)); });
    const target = (key: string) => ({ focus: () => { focused.push(key); } });
    act(() => {
      tree!.bindFocusTarget('row-0', target('row-0'));
      tree!.onFocusChange('row-0', true);
    });
    // End: the last row is not built yet, so the list is asked to bring it into view.
    act(() => { tree!.onKeyDown('row-0', 'End'); });
    expect(revealed).toEqual([2]);
    // The scroll recycles the row that had focus (it blurs and unbinds) before the target row binds.
    act(() => {
      tree!.onFocusChange('row-0', false);
      tree!.bindFocusTarget('row-0', null);
      tree!.bindFocusTarget('row-2', target('row-2'));
    });
    expect(focused).toEqual(['row-2']);
    // Focus given during the row's commit may never reach its focus handler; the row still owns it, so a
    // cell reorder that blurs it right after gives it back.
    act(() => { tree!.onFocusChange('row-2', false); });
    await Promise.resolve();
    expect(focused).toEqual(['row-2', 'row-2']);
  }));

  it('gives focus back to the focused row a windowed list recycles and mounts again on web', () => onWebPage(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const rows: HappierTreeNode[] = [{ key: 'row-0', parentKey: null, depth: 0, kind: 'leaf', expanded: false }];
    const focused: string[] = [];
    let tree: ReturnType<typeof useHappierTreeInteraction> | null = null;
    function Probe() {
      const [focusedKey, setFocusedKey] = React.useState<string | null>('row-0');
      tree = useHappierTreeInteraction({ visibleNodes: rows, focusedKey, onFocus: setFocusedKey,
        onExpandedChange: () => {}, onActivate: () => {} });
      return null;
    }
    act(() => { renderer.create(React.createElement(Probe)); });
    act(() => {
      tree!.bindFocusTarget('row-0', { focus: () => { focused.push('first'); } });
      tree!.onFocusChange('row-0', true);
    });
    // React detaches the row's ref before removing it; the removal then blurs it.
    act(() => {
      tree!.bindFocusTarget('row-0', null);
      tree!.onFocusChange('row-0', false);
    });
    act(() => { tree!.bindFocusTarget('row-0', { focus: () => { focused.push('remounted'); } }); });
    expect(focused).toEqual(['remounted']);
  }));

  it('keeps focus on a web row whose node a windowed list moves, never pulling focus back from another control or on native', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const rows: HappierTreeNode[] = [{ key: 'row-0', parentKey: null, depth: 0, kind: 'leaf', expanded: false }];
    const focused: string[] = [];
    let tree: ReturnType<typeof useHappierTreeInteraction> | null = null;
    function Probe() {
      const [focusedKey, setFocusedKey] = React.useState<string | null>('row-0');
      tree = useHappierTreeInteraction({ visibleNodes: rows, focusedKey, onFocus: setFocusedKey,
        onExpandedChange: () => {}, onActivate: () => {} });
      return null;
    }
    const blurRow = async () => {
      act(() => {
        tree!.onFocusChange('row-0', true);
        tree!.onFocusChange('row-0', false);
      });
      await Promise.resolve();
    };
    // Native (no document): a blur always means focus moved on, e.g. into a TextInput.
    act(() => { renderer.create(React.createElement(Probe)); });
    act(() => { tree!.bindFocusTarget('row-0', { focus: () => { focused.push('row-0'); } }); });
    await blurRow();
    expect(focused).toEqual([]);
    // Web: a cell reorder blurs the row to the page itself; the row keeps focus.
    const body = { kind: 'body' };
    const page = { body, activeElement: body as unknown, addEventListener: () => {} };
    (globalThis as { document?: unknown }).document = page;
    try {
      await blurRow();
      expect(focused).toEqual(['row-0']);
      // Focus the user moved to another control stays there.
      page.activeElement = { kind: 'text-field' };
      await blurRow();
      expect(focused).toEqual(['row-0']);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it('names each row\'s position among its siblings from the whole tree, not from the rows a window built', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let tree: ReturnType<typeof useHappierTreeInteraction> | null = null;
    function Probe() {
      tree = useHappierTreeInteraction({ visibleNodes: [branch, child, other], focusedKey: null, onFocus: () => {},
        onExpandedChange: () => {}, onActivate: () => {} });
      return null;
    }
    act(() => { renderer.create(React.createElement(Probe)); });
    expect([branch.key, child.key, other.key].map(key => tree!.positionOf(key))).toEqual([
      { positionInSet: 1, setSize: 2 },
      { positionInSet: 1, setSize: 1 },
      { positionInSet: 2, setSize: 2 },
    ]);
    expect(tree!.positionOf('missing')).toBeNull();
  });
});

