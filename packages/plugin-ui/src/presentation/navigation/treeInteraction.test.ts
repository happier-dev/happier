import { describe, expect, it } from 'vitest';

import { resolveHappierTreeFocusKey, resolveHappierTreeKeyIntent, type HappierTreeNode } from './treeInteraction.js';

const branch: HappierTreeNode = { key: 'branch', parentKey: null, depth: 0, kind: 'branch', expanded: true };
const child: HappierTreeNode = { key: 'opaque-child', parentKey: 'branch', depth: 1, kind: 'leaf', expanded: false };
const other: HappierTreeNode = { key: 'sibling', parentKey: null, depth: 0, kind: 'leaf', expanded: false };

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
});
