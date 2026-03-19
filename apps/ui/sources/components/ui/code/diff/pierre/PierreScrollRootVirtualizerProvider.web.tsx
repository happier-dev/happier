import * as React from 'react';

import { Virtualizer as PierreVirtualizer } from '@pierre/diffs';
import { VirtualizerContext } from '@pierre/diffs/react';
import { iterateWebDescendantElements } from '@/components/ui/scroll/resolveWebScrollableElement';

type ScrollToPatchRecord = Readonly<{
    original: ((...args: any[]) => any) | null;
}>;

const HAPPIER_SCROLL_TO_PATCH_KEY = '__happierScrollToOptionsPatch' as const;

function isElementScrollable(el: HTMLElement): boolean {
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return false;
    const style = window.getComputedStyle(el);
    const overflowY = style?.overflowY ?? null;
    const scrollOk = overflowY === 'auto' || overflowY === 'scroll';
    if (!scrollOk) return false;
    return el.scrollHeight > el.clientHeight + 5;
}

function findNearestScrollRoot(anchor: HTMLElement): HTMLElement | Document {
    type Candidate = Readonly<{
        el: HTMLElement;
        kind: 'ancestor' | 'descendant';
        depth: number;
        clientHeight: number;
        scrollRange: number;
    }>;

    const candidates: Candidate[] = [];

    const computeDescendantDepth = (node: HTMLElement): number => {
        let depth = 0;
        let cursor: HTMLElement | null = node.parentElement;
        while (cursor) {
            depth += 1;
            if (cursor === anchor) return depth;
            cursor = cursor.parentElement;
        }
        return depth;
    };

    const addCandidate = (el: HTMLElement, kind: Candidate['kind'], depth: number) => {
        const clientHeight = Math.max(el.clientHeight, 0);
        const scrollRange = Math.max(el.scrollHeight - el.clientHeight, 0);
        candidates.push({ el, kind, depth, clientHeight, scrollRange });
    };

    // Prefer the *actual* vertical scroll root (the element the user scrolls). In practice this can
    // be either:
    // - an ancestor pane scroller (most flex layouts), or
    // - an internal descendant scroller (e.g. FlashList web).
    //
    // When multiple scrollable nodes exist (code blocks, nested editors, etc), selecting a small
    // inner scroller can cause Pierre's virtualization to compute massive empty "buffer" spacers.
    //
    // Heuristic:
    // 1) Prefer larger scroll roots (bigger clientHeight).
    // 2) Then prefer greater scroll range.
    // 3) Then prefer descendant roots (they often receive the actual scroll events on web lists).
    // 4) Finally, prefer deeper descendants / closer ancestors as tie-breakers.
    let el: HTMLElement | null = anchor.parentElement;
    let steps = 0;
    while (el && steps < 30) {
        if (isElementScrollable(el)) addCandidate(el, 'ancestor', -steps - 1);
        el = el.parentElement;
        steps += 1;
    }

    for (const candidate of iterateWebDescendantElements(anchor, { maxNodes: 1500 })) {
        if (!isElementScrollable(candidate)) continue;
        addCandidate(candidate, 'descendant', computeDescendantDepth(candidate));
    }

    const best = candidates.reduce<Candidate | null>((acc, candidate) => {
        if (!acc) return candidate;
        if (candidate.clientHeight !== acc.clientHeight) return candidate.clientHeight > acc.clientHeight ? candidate : acc;
        if (candidate.scrollRange !== acc.scrollRange) return candidate.scrollRange > acc.scrollRange ? candidate : acc;
        if (candidate.kind !== acc.kind) return candidate.kind === 'descendant' ? candidate : acc;
        return candidate.depth > acc.depth ? candidate : acc;
    }, null);

    if (best) return best.el;
    return typeof document !== 'undefined' ? document : (anchor.ownerDocument ?? document);
}

function patchElementScrollToOptionsIfNeeded(el: HTMLElement): void {
    const anyEl = el as any;
    const existing: ScrollToPatchRecord | undefined = anyEl[HAPPIER_SCROLL_TO_PATCH_KEY] as any;
    if (existing) return;

    const nativeScrollTo: ((...args: any[]) => any) | null = typeof (el as any).scrollTo === 'function'
        ? (el as any).scrollTo.bind(el)
        : null;
    if (!nativeScrollTo) {
        anyEl[HAPPIER_SCROLL_TO_PATCH_KEY] = { original: null } satisfies ScrollToPatchRecord;
        return;
    }

    // Detect whether this browser supports Element.scrollTo(ScrollToOptions).
    //
    // Some environments (notably RN-web ScrollView hosts) expose `scrollTo` but:
    // - ignore DOM-style ScrollToOptions objects ({ top, left, behavior }) (no-op, no throw), and/or
    // - support only RN-style objects ({ x, y, animated }) or deprecated numeric signatures.
    //
    // Pierre uses DOM-style options objects for its scroll-fix logic; when ignored or translated
    // incorrectly, the scroll position can "snap" back to the top during virtualization.
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const maxLeft = Math.max(0, el.scrollWidth - el.clientWidth);

    let supportsOptions = false;
    if (maxTop > 0 || maxLeft > 0) {
        const beforeTop = el.scrollTop;
        const beforeLeft = el.scrollLeft;
        const probeTop = maxTop > 0
            ? (beforeTop < maxTop ? beforeTop + 1 : Math.max(0, beforeTop - 1))
            : beforeTop;
        const probeLeft = maxLeft > 0
            ? (beforeLeft < maxLeft ? beforeLeft + 1 : Math.max(0, beforeLeft - 1))
            : beforeLeft;

        try {
            nativeScrollTo({ top: probeTop, left: probeLeft });
            supportsOptions = el.scrollTop !== beforeTop || el.scrollLeft !== beforeLeft;
        } catch {
            supportsOptions = false;
        } finally {
            // Restore any probe movement immediately (best-effort, assignment is most reliable).
            try {
                el.scrollLeft = beforeLeft;
                el.scrollTop = beforeTop;
            } catch {
                // ignore
            }
        }
    }

    if (supportsOptions) {
        anyEl[HAPPIER_SCROLL_TO_PATCH_KEY] = { original: nativeScrollTo } satisfies ScrollToPatchRecord;
        return;
    }

    // RN-web ScrollView hosts typically support object args, but use {x,y} instead of DOM {top,left}.
    // Prefer that path when available so we do not rely on `scrollTop` assignment (which may be ignored
    // depending on how the scroll container is implemented).
    let supportsXYOptions = false;
    if (maxTop > 0 || maxLeft > 0) {
        const beforeTop = el.scrollTop;
        const beforeLeft = el.scrollLeft;
        const probeTop = maxTop > 0
            ? (beforeTop < maxTop ? beforeTop + 1 : Math.max(0, beforeTop - 1))
            : beforeTop;
        const probeLeft = maxLeft > 0
            ? (beforeLeft < maxLeft ? beforeLeft + 1 : Math.max(0, beforeLeft - 1))
            : beforeLeft;
        try {
            nativeScrollTo({ y: probeTop, x: probeLeft, animated: false } as any);
            supportsXYOptions = el.scrollTop !== beforeTop || el.scrollLeft !== beforeLeft;
        } catch {
            supportsXYOptions = false;
        } finally {
            try {
                el.scrollLeft = beforeLeft;
                el.scrollTop = beforeTop;
            } catch {
                // ignore
            }
        }
    }

    const patched = (...args: any[]) => {
        const first = args[0];
        if (first && typeof first === 'object') {
            // Pass through RN-web-style objects ({x,y,animated}) untouched.
            if ('x' in first || 'y' in first) {
                return nativeScrollTo(first);
            }

            const top = typeof first.top === 'number' && Number.isFinite(first.top) ? first.top : el.scrollTop;
            const left = typeof first.left === 'number' && Number.isFinite(first.left) ? first.left : el.scrollLeft;

            if (supportsXYOptions) {
                try {
                    return nativeScrollTo({ x: left, y: top, animated: false } as any);
                } catch {
                    // ignore (fall back below)
                }
            }

            // Ignore non-standard `behavior: 'instant'` and other behavior hints. Pierre uses these
            // primarily as "not smooth"; numeric scrolling is deterministic across browsers.
            try {
                nativeScrollTo(left, top);
            } catch {
                // ignore (we'll fall back to direct assignment below)
            }
            // Some environments expose Element.scrollTo but implement it as a no-op. Ensure the
            // scroll position actually updates (best-effort; in some RN-web implementations this
            // assignment can be ignored, hence the `supportsXYOptions` preferred path above).
            if (el.scrollTop !== top || el.scrollLeft !== left) {
                try {
                    el.scrollLeft = left;
                    el.scrollTop = top;
                } catch {
                    // ignore
                }
            }
            return;
        }
        // Numeric signature: (x, y)
        return nativeScrollTo(...args);
    };

    try {
        (el as any).scrollTo = patched;
    } catch {
        // ignore
    }
    anyEl[HAPPIER_SCROLL_TO_PATCH_KEY] = { original: nativeScrollTo } satisfies ScrollToPatchRecord;
}

export function PierreScrollRootVirtualizerProvider(props: Readonly<{ children: React.ReactNode }>) {
    const anchorRef = React.useRef<HTMLDivElement | null>(null);

    const [instance] = React.useState(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
        if (typeof (globalThis as any).IntersectionObserver === 'undefined') return undefined;
        if (typeof (globalThis as any).ResizeObserver === 'undefined') return undefined;
        return new PierreVirtualizer();
    });

    React.useEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        if (!instance) return;

        const raf: (cb: FrameRequestCallback) => number =
            typeof globalThis.requestAnimationFrame === 'function'
                ? globalThis.requestAnimationFrame.bind(globalThis)
                : (cb) => globalThis.setTimeout(() => cb(Date.now()), 0);

        let cancelled = false;
        let attempts = 0;
        const maxAttempts = 30;
        let lastRoot: HTMLElement | Document | null = null;

        const bindToCurrentRoot = () => {
            if (cancelled) return;
            const root = findNearestScrollRoot(anchor);
            if (root !== lastRoot) {
                try {
                    instance.cleanUp();
                } catch {
                    // ignore
                }

                try {
                    // IMPORTANT:
                    // - When binding to an *element* scroll root (common with nested list scrollers on web),
                    //   we must NOT pass an external content container that lives *outside* that scroll root.
                    //   Pierre will infer the correct content container from the scroll root itself.
                    // - For document root, the 2nd argument is ignored.
                    if (root instanceof Document) {
                        instance.setup(root as any, anchor);
                    } else {
                        patchElementScrollToOptionsIfNeeded(root);
                        instance.setup(root as any);
                    }
                    lastRoot = root;
                } catch {
                    // Fail closed: virtualization is best-effort, never crash the UI.
                }
            }

            attempts += 1;
            // FlashList web can mount its internal scroll root after the first effect pass.
            // Probe briefly so we can rebind to the best nested list container once it mounts.
            if (attempts >= maxAttempts) return;
            raf(() => bindToCurrentRoot());
        };

        bindToCurrentRoot();

        return () => {
            cancelled = true;
            try {
                instance.cleanUp();
            } catch {
                // ignore
            }
        };
    }, [instance]);

    const rootStyle = React.useMemo<React.CSSProperties>(() => {
        // This wrapper participates in many flex-based panes (details/review/file viewers).
        // On web, ensure it can shrink to the available height and allow nested lists to scroll,
        // rather than expanding to full content height.
        return {
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            flex: '1 1 0%',
            minHeight: 0,
            overflowAnchor: 'none',
        };
    }, []);

    return (
        <VirtualizerContext.Provider value={instance}>
            <div ref={anchorRef} style={rootStyle} data-happier-diff-virtual-root="1">
                {props.children}
            </div>
        </VirtualizerContext.Provider>
    );
}
