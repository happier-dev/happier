import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { HappierFocusable } from '../portableTypes.js';

/** Already-visible owner data; keys carry no path or filesystem meaning. */
export type HappierTreeNode = Readonly<{
  key: string;
  parentKey: string | null;
  depth: number;
  kind: 'branch' | 'leaf';
  expanded: boolean;
  disabled?: boolean;
}>;

export type HappierTreeInteraction = Readonly<{
  visibleNodes: readonly HappierTreeNode[];
  focusedKey: string | null;
  onFocus: (key: string) => void;
  onExpandedChange: (key: string, expanded: boolean) => void;
  onActivate: (key: string) => void;
  /** A virtualizer reveals a missing physical focus target without choosing focus. */
  onRevealIndex?: (index: number) => void;
}>;

export type HappierTreeKeyIntent =
  | Readonly<{ kind: 'focus'; key: string }>
  | Readonly<{ kind: 'disclose'; key: string; expanded: boolean }>
  | Readonly<{ kind: 'activate'; key: string }>;

/** Tree focus repairs through known parent identity, never through key spelling. */
export function resolveHappierTreeFocusKey(
  nodes: readonly HappierTreeNode[],
  focusedKey: string | null,
  previousNodes: readonly HappierTreeNode[] = [],
): string | null {
  const visible = new Map(nodes.map(node => [node.key, node]));
  if (focusedKey !== null && visible.has(focusedKey)) return focusedKey;
  const previous = new Map(previousNodes.map(node => [node.key, node]));
  const visited = new Set<string>();
  let key = focusedKey;
  while (key !== null && !visited.has(key)) {
    visited.add(key);
    key = previous.get(key)?.parentKey ?? null;
    if (key !== null && visible.has(key)) return key;
  }
  return nodes[0]?.key ?? null;
}

/** Disclosure and activation are distinct intents at the shared keyboard owner. */
export function resolveHappierTreeKeyIntent(
  nodes: readonly HappierTreeNode[],
  key: string,
  keyboardKey: string,
): HappierTreeKeyIntent | null {
  const index = nodes.findIndex(node => node.key === key);
  const node = nodes[index];
  if (!node) return null;
  let next: HappierTreeNode | undefined;
  if (keyboardKey === 'ArrowDown') next = nodes[index + 1];
  else if (keyboardKey === 'ArrowUp') next = nodes[index - 1];
  else if (keyboardKey === 'Home') next = nodes[0];
  else if (keyboardKey === 'End') next = nodes[nodes.length - 1];
  else if (keyboardKey === 'ArrowRight') {
    if (node.kind === 'branch' && !node.expanded && !node.disabled) return { kind: 'disclose', key, expanded: true };
    if (node.kind === 'branch' && node.expanded) next = nodes.find(child => child.parentKey === key);
  } else if (keyboardKey === 'ArrowLeft') {
    if (node.kind === 'branch' && node.expanded && !node.disabled) return { kind: 'disclose', key, expanded: false };
    next = nodes.find(parent => parent.key === node.parentKey);
  } else if (keyboardKey === 'Enter' && !node.disabled) return { kind: 'activate', key };
  // Space toggles a branch in place (plan 13 §2 / plan 10 §2), never scrolls the page; a leaf has nothing to toggle.
  else if ((keyboardKey === ' ' || keyboardKey === 'Spacebar') && node.kind === 'branch' && !node.disabled) {
    return { kind: 'disclose', key, expanded: !node.expanded };
  }
  return next ? { kind: 'focus', key: next.key } : null;
}

type TreeKeyboardEvent = Readonly<{
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: unknown;
  currentTarget?: unknown;
}>;

/** On web, whether something outside a lost tree row holds focus (not the page itself). */
function focusIsElsewhere(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  return active !== null && active !== document.body;
}

// A press anywhere legitimately takes focus away from a row (to the page or a control); only a blur no
// pointer caused can be the host moving the row's node. The flag lasts for the press's own task.
let pointerPressing = false;
let pointerTrackerInstalled = false;
function installPointerPressTracker() {
  if (pointerTrackerInstalled || typeof document === 'undefined') return;
  pointerTrackerInstalled = true;
  document.addEventListener('pointerdown', () => {
    pointerPressing = true;
    setTimeout(() => { pointerPressing = false; }, 0);
  }, true);
}

/** A row's place among its siblings, for `aria-posinset`/`aria-setsize` (1-based). */
export type HappierTreePosition = Readonly<{ positionInSet: number; setSize: number }>;

/**
 * One logical and physical tree-focus adapter for host trees and public authors.
 *
 * - A keyboard move to a row that is not mounted calls `onRevealIndex` (a windowed host scrolls it into
 *   view); focus lands on the row when it binds, even if the row it left is recycled meanwhile.
 * - On web, a focused row whose node the host recycles or reorders keeps focus. Focus that moved to
 *   another control, a press, or any blur on native is never pulled back.
 * - `positionOf(key)` gives the row's position and set size among its siblings in the whole tree, for
 *   rows a windowed host builds out of order or only in part.
 */
export function useHappierTreeInteraction(input: HappierTreeInteraction) {
  installPointerPressTracker();
  const inputRef = useRef(input);
  inputRef.current = input;
  const previousNodes = useRef<readonly HappierTreeNode[]>([]);
  const targets = useRef(new Map<string, HappierFocusable>());
  const pendingFocus = useRef<string | null>(null);
  // A keyboard move to a row a windowed host is bringing into view. The scroll can recycle the row that
  // had focus (it blurs and unbinds) before the target row binds; that is not focus leaving the tree.
  const revealing = useRef<string | null>(null);
  const focusedTargetKey = useRef<string | null>(null);
  const onFocusChange = useCallback((key: string, focused: boolean) => {
    if (focused) {
      focusedTargetKey.current = key;
      if (revealing.current !== key) revealing.current = null;
      inputRef.current.onFocus(key);
    } else if (focusedTargetKey.current === key) {
      focusedTargetKey.current = null;
      // A row that unbinds before it blurs is being unmounted (a windowed host recycling it), not left by
      // the user: it takes focus back when it mounts again, unless a keyboard move is already under way.
      const target = targets.current.get(key);
      // Recovery is web-only: there a blur with no successor can be the browser moving the row's node.
      // On native a blur always means focus moved on (a TextInput, another control) and is left alone.
      const web = typeof document !== 'undefined';
      pendingFocus.current = revealing.current ?? (web && !target ? pendingFocus.current : null);
      // A row that stays bound but loses focus to nothing, without a press, had its node moved (a
      // windowed host reordering its cells, which blurs in the browser): it keeps focus where it is.
      if (web && target && revealing.current === null && !pointerPressing) {
        queueMicrotask(() => {
          // The move re-renders the row, which may rebind it: focus whatever target the row has now.
          const current = targets.current.get(key);
          if (current && focusedTargetKey.current === null && !focusIsElsewhere()) current.focus();
        });
      }
    }
  }, []);
  const activeKey = useMemo(() => resolveHappierTreeFocusKey(input.visibleNodes, input.focusedKey, previousNodes.current),
    [input.visibleNodes, input.focusedKey]);
  const focusKey = useCallback((key: string) => {
    const current = inputRef.current;
    current.onFocus(key);
    pendingFocus.current = key;
    const target = targets.current.get(key);
    if (target) {
      revealing.current = null;
      target.focus();
      pendingFocus.current = null;
    } else {
      const index = current.visibleNodes.findIndex(node => node.key === key);
      revealing.current = index >= 0 && current.onRevealIndex ? key : null;
      if (index >= 0) current.onRevealIndex?.(index);
    }
  }, []);

  useEffect(() => {
    if (input.focusedKey && activeKey && input.focusedKey !== activeKey) {
      if (pendingFocus.current === input.focusedKey) focusKey(activeKey);
      else input.onFocus(activeKey);
    }
    previousNodes.current = input.visibleNodes;
  }, [activeKey, focusKey, input.focusedKey, input.onFocus, input.visibleNodes]);

  const bindFocusTarget = useCallback((key: string, target: HappierFocusable | null) => {
    if (!target) {
      // The roving tab stop survives focus moving into an editor. A ref rebind
      // is not an intent to pull that external focus back into the tree.
      if (focusedTargetKey.current === key) pendingFocus.current = revealing.current ?? key;
      targets.current.delete(key);
      return;
    }
    targets.current.set(key, target);
    if (pendingFocus.current === key) {
      const moving = revealing.current === key;
      revealing.current = null;
      pendingFocus.current = null;
      // A recycled row takes focus back only while focus is nowhere; focus the user moved elsewhere stays.
      if (moving || !focusIsElsewhere()) {
        // Focus given while the row is still being committed may not reach its focus handler: record it here.
        focusedTargetKey.current = key;
        target.focus();
      }
    }
  }, []);

  const onKeyDown = useCallback((key: string, keyboardKey: string, event?: unknown,
    handlers?: Pick<HappierTreeInteraction, 'onExpandedChange' | 'onActivate'>) => {
    const keyboardEvent = event && typeof event === 'object' ? event as TreeKeyboardEvent : null;
    if (keyboardEvent?.ctrlKey || keyboardEvent?.metaKey || keyboardEvent?.altKey) return false;
    if (keyboardEvent?.target && keyboardEvent.currentTarget && keyboardEvent.target !== keyboardEvent.currentTarget) return false;
    const current = inputRef.current;
    const intent = resolveHappierTreeKeyIntent(current.visibleNodes, key, keyboardKey);
    if (intent?.kind === 'focus') focusKey(intent.key);
    else if (intent?.kind === 'disclose') (handlers ?? current).onExpandedChange(intent.key, intent.expanded);
    else if (intent?.kind === 'activate') (handlers ?? current).onActivate(intent.key);
    // A tree boundary still owns arrows at its first/last/root row; they must not escape to page scrolling.
    return intent !== null || (current.visibleNodes.some(node => node.key === key)
      && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(keyboardKey));
  }, [focusKey]);

  // Each row's place among its siblings in the whole visible tree. A windowed host builds only some rows,
  // so assistive tech cannot count them from what is mounted; rows carry these as posinset/setsize.
  const positions = useMemo(() => {
    const siblings = new Map<string | null, string[]>();
    for (const node of input.visibleNodes) {
      const list = siblings.get(node.parentKey) ?? [];
      list.push(node.key);
      siblings.set(node.parentKey, list);
    }
    const byKey = new Map<string, HappierTreePosition>();
    for (const list of siblings.values()) list.forEach((key, index) => byKey.set(key, { positionInSet: index + 1, setSize: list.length }));
    return byKey;
  }, [input.visibleNodes]);
  // Stable: a row reads its position when it renders, so a host's memoized rows are not all invalidated
  // when one branch opens. A host that skips rendering a row must compare that row's position itself.
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const positionOf = useCallback((key: string): HappierTreePosition | null => positionsRef.current.get(key) ?? null, []);

  return { activeKey, focusKey, bindFocusTarget, onFocusChange, onKeyDown, positionOf };
}
