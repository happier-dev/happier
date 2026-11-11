import * as React from 'react';

/**
 * Which phone bottom bar is on screen, as `MobileBottomChromeHost` decided it: the main tab bar, a
 * detail page's cockpit bar (by page kind), or none. The host is the one owner; a header that lends
 * controls only where no bar holds them reads this instead of re-deriving it from route or platform.
 */
export type PresentedBottomChrome = Readonly<
  { kind: 'main' } | { kind: 'detail'; pageKind: string }
> | null;

let presented: PresentedBottomChrome = null;
const listeners = new Set<() => void>();

function publish(next: PresentedBottomChrome): void {
  presented = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The host reports the bar it presents, and that none is presented once it leaves. */
export function usePublishPresentedBottomChrome(
  value: PresentedBottomChrome,
): void {
  const kind = value?.kind ?? null;
  const pageKind = value?.kind === 'detail' ? value.pageKind : null;
  React.useEffect(() => {
    if (kind === null) return;
    const next: PresentedBottomChrome =
      kind === 'detail' && pageKind !== null
        ? { kind, pageKind }
        : { kind: 'main' };
    publish(next);
    return () => {
      if (presented === next) publish(null);
    };
  }, [kind, pageKind]);
}

/** Whether the cockpit bar of this detail page kind is the bar on screen. */
export function useDetailBottomBarPresented(pageKind: string): boolean {
  const read = React.useCallback(
    () => presented?.kind === 'detail' && presented.pageKind === pageKind,
    [pageKind],
  );
  return React.useSyncExternalStore(subscribe, read, read);
}
