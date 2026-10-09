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

/** One logical and physical tree-focus adapter for host trees and public authors. */
export function useHappierTreeInteraction(input: HappierTreeInteraction) {
  const inputRef = useRef(input);
  inputRef.current = input;
  const previousNodes = useRef<readonly HappierTreeNode[]>([]);
  const targets = useRef(new Map<string, HappierFocusable>());
  const pendingFocus = useRef<string | null>(null);
  const activeKey = useMemo(() => resolveHappierTreeFocusKey(input.visibleNodes, input.focusedKey, previousNodes.current),
    [input.visibleNodes, input.focusedKey]);
  const focusKey = useCallback((key: string) => {
    const current = inputRef.current;
    current.onFocus(key);
    pendingFocus.current = key;
    const target = targets.current.get(key);
    if (target) {
      target.focus();
      pendingFocus.current = null;
    } else {
      const index = current.visibleNodes.findIndex(node => node.key === key);
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
      if (inputRef.current.focusedKey === key) pendingFocus.current = key;
      targets.current.delete(key);
      return;
    }
    targets.current.set(key, target);
    if (pendingFocus.current === key) {
      target.focus();
      pendingFocus.current = null;
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

  return { activeKey, focusKey, bindFocusTarget, onKeyDown };
}
