import * as React from 'react';

type Rect = Readonly<{ top: number; height: number; width: number }>;

type AnchorNode = Readonly<{
  isConnected: boolean;
  parentElement?: unknown;
  getBoundingClientRect: () => Rect;
}>;

type ScrollerNode = {
  scrollTop: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  getBoundingClientRect: () => Rect & Readonly<{ left: number }>;
  contains: (node: never) => boolean;
  addEventListener: (
    type: string,
    listener: (event?: { target?: unknown }) => void,
    options?: { passive?: boolean },
  ) => void;
  removeEventListener: (
    type: string,
    listener: (event?: { target?: unknown }) => void,
  ) => void;
};

type AnchorWindow = Readonly<{
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (id: number) => void;
  addEventListener: (type: 'resize', listener: () => void) => void;
  removeEventListener: (type: 'resize', listener: () => void) => void;
  document: Readonly<{
    activeElement: unknown;
    elementFromPoint: (x: number, y: number) => unknown;
  }>;
  ResizeObserver?: new (callback: () => void) => {
    observe: (target: never) => void;
    disconnect: () => void;
  };
}>;

// Rows sampled down the viewport: the top-visible row can be one the new layout replaces, so rows
// below it (then the top row's own containers) are the fallbacks, in reading order.
const PROBE_FRACTIONS = [0, 0.25, 0.5] as const;


function isAnchorNode(value: unknown): value is AnchorNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AnchorNode).getBoundingClientRect === 'function'
  );
}

/**
 * Keeps a web scroller's reading position through a relayout that changes its width — a phone ↔ wide
 * recomposition, a pane resize — by holding the focused element (else the top-visible element) at the
 * offset the person last read it at, instead of the raw pixel offset the browser keeps or clamps.
 *
 * Sample on attachment, focus and scrollend; ordinary scrolls only translate the saved offsets with
 * one scrollTop read. Once the width changes the anchors are held through resulting resizes (the
 * recomposed rows can land a frame later). A scroll at the restored scrollTop is its own echo;
 * a completed scroll — the person's or a reveal's — becomes the new reading position.
 */
export function attachWebScrollReadingAnchor(
  input: Readonly<{
    scroller: ScrollerNode;
    content: unknown;
    win: AnchorWindow;
  }>,
): () => void {
  const { scroller, content, win } = input;
  if (win.ResizeObserver === undefined) return () => {};

  type Anchor = Readonly<{ node: AnchorNode; offset: number }>;
  let anchors: readonly Anchor[] = [];
  let width = scroller.clientWidth;
  let observedHeight = scroller.scrollHeight;
  let relayoutPending = false;
  let readingScrollTop = scroller.scrollTop;
  let scrollOffset = 0;
  let scheduledRestore: number | null = null;
  const cancelRestore = () => {
    if (scheduledRestore === null) return;
    win.cancelAnimationFrame(scheduledRestore);
    scheduledRestore = null;
  };

  const inside = (node: unknown): node is AnchorNode =>
    node !== scroller && isAnchorNode(node) && scroller.contains(node as never);
  const read = () => {
    cancelRestore();
    const viewport = scroller.getBoundingClientRect();
    const nodes: AnchorNode[] = [];
    const add = (node: unknown) => {
      if (inside(node) && !nodes.includes(node)) nodes.push(node);
    };
    add(win.document.activeElement);
    const hits = PROBE_FRACTIONS.map((fraction) =>
      win.document.elementFromPoint(
        viewport.left + viewport.width / 2,
        viewport.top + 1 + fraction * viewport.height,
      ),
    );
    hits.forEach(add);
    for (let node = hits[0]; inside(node); node = node.parentElement) add(node);
    anchors = nodes.map((node) => ({
      node,
      offset: node.getBoundingClientRect().top - viewport.top,
    }));
    readingScrollTop = scroller.scrollTop;
    scrollOffset = 0;
  };
  // The first anchor the current layout still shows; a hidden (display: none) node has no position.
  const heldAnchor = () =>
    anchors.find(({ node }) => {
      if (!node.isConnected) return false;
      const rect = node.getBoundingClientRect();
      return rect.height !== 0 || rect.width !== 0;
    });
  const drift = (anchor: Anchor) =>
    anchor.node.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top -
    anchor.offset - scrollOffset;
  const restore = () => {
    cancelRestore();
    observedHeight = scroller.scrollHeight;
    if (scroller.clientWidth !== width) {
      width = scroller.clientWidth;
      relayoutPending = true;
    }
    if (!relayoutPending) return;
    const anchor = heldAnchor();
    if (anchor === undefined) return;
    const offBy = drift(anchor);
    if (Math.abs(offBy) >= 1) scroller.scrollTop += offBy;
    readingScrollTop = scroller.scrollTop;
  };
  const onScroll = () => {
    const scrollTop = scroller.scrollTop;
    if (scrollTop === readingScrollTop) return;
    if (relayoutPending) {
      // A relayout whose resize callback has not run yet (a synchronous layout read can clamp first).
      if (scroller.clientWidth !== width || scroller.scrollHeight !== observedHeight) return restore();
      // A native layout adjustment has no scrollend. A deliberate scroll completes before the
      // next frame and read() cancels this restoration, accepting that new reading position.
      if (scheduledRestore === null) scheduledRestore = win.requestAnimationFrame(() => {
        scheduledRestore = null;
        if (relayoutPending) restore();
      });
      return;
    }
    scrollOffset += readingScrollTop - scrollTop;
    readingScrollTop = scrollTop;
  };
  const onScrollEnd = () => {
    // A restore's echo must not replace anchors needed by a later recomposition resize.
    if (relayoutPending && scroller.scrollTop === readingScrollTop) return;
    relayoutPending = false;
    read();
  };
  // A browser can reset scroll before delivering ResizeObserver. Preserve the held reading
  // position from the window's resize notification, before that reset looks like a new scroll.
  const onResize = () => { relayoutPending = true; };
  const onFocus = (event?: { target?: unknown }) => {
    // The field the anchor already holds being refocused by a recomposition is not a new position.
    if (relayoutPending && event?.target === anchors[0]?.node) return;
    relayoutPending = false;
    read();
  };

  read();
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('scrollend', onScrollEnd);
  scroller.addEventListener('focusin', onFocus);
  win.addEventListener('resize', onResize);
  const observer = new win.ResizeObserver(restore);
  observer.observe(scroller as never);
  if (content !== null && content !== undefined)
    observer.observe(content as never);

  return () => {
    cancelRestore();
    observer.disconnect();
    scroller.removeEventListener('scroll', onScroll);
    scroller.removeEventListener('scrollend', onScrollEnd);
    scroller.removeEventListener('focusin', onFocus);
    win.removeEventListener('resize', onResize);
  };
}

type WebScrollViewHandle = Readonly<{ getScrollableNode?: () => unknown; getInnerViewNode?: () => unknown }>;

/** Attaches the reading anchor to a react-native-web ScrollView for its life; no-op off web. */
export function useWebScrollReadingAnchor(scrollRef: React.RefObject<WebScrollViewHandle | null>, enabled: boolean): void {
    React.useEffect(() => {
        if (!enabled || typeof window === 'undefined') return;
        const scroller = scrollRef.current?.getScrollableNode?.();
        if (typeof scroller !== 'object' || scroller === null || typeof (scroller as ScrollerNode).addEventListener !== 'function') return;
        return attachWebScrollReadingAnchor({
            scroller: scroller as ScrollerNode,
            content: scrollRef.current?.getInnerViewNode?.() ?? null,
            win: window as unknown as AnchorWindow,
        });
    }, [enabled, scrollRef]);
}
