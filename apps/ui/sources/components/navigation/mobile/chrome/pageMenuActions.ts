import * as React from 'react';

import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';

/**
 * A detail page's `⋯` actions where its own header does not draw them (a phone, whose Project page has no desktop
 * header): the page publishes the one list its desktop header reads, by page kind, and that page kind's phone bar
 * lists it in More after its navigation (UI refinements ruling 11-14, option b). The opposite direction of
 * `presentedBottomChrome`; the page stays the one owner of what its actions are.
 */
const NO_ACTIONS: readonly PageHeaderMenuAction[] = Object.freeze([]);
const published = new Map<string, readonly PageHeaderMenuAction[]>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publishes `actions` for this page kind while given; `null` (or unmounting) withdraws them. */
export function usePublishDetailPageMenuActions(
  pageKind: string,
  actions: readonly PageHeaderMenuAction[] | null,
): void {
  React.useEffect(() => {
    if (!actions || actions.length === 0) return undefined;
    published.set(pageKind, actions);
    emit();
    return () => {
      if (published.get(pageKind) !== actions) return;
      published.delete(pageKind);
      emit();
    };
  }, [actions, pageKind]);
}

/** The `⋯` actions the shown page of this kind offers to its phone bar; empty when none. */
export function useDetailPageMenuActions(
  pageKind: string,
): readonly PageHeaderMenuAction[] {
  const read = React.useCallback(
    () => published.get(pageKind) ?? NO_ACTIONS,
    [pageKind],
  );
  return React.useSyncExternalStore(subscribe, read, read);
}
