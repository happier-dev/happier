import * as React from 'react';

import { Virtualizer as PierreVirtualizer } from '@pierre/diffs';
import { VirtualizerContext } from '@pierre/diffs/react';
import { iterateWebDescendantElements } from '@/components/ui/scroll/resolveWebScrollableElement';

function isElementScrollable(el: HTMLElement): boolean {
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return false;
    const style = window.getComputedStyle(el);
    const overflowY = style?.overflowY ?? null;
    const scrollOk = overflowY === 'auto' || overflowY === 'scroll';
    if (!scrollOk) return false;
    return el.scrollHeight > el.clientHeight + 5;
}

/**
 * Resolve the scroll root Pierre may virtualize against.
 *
 * Pierre's virtualizer does not merely *observe* its root: `Virtualizer.applyScrollFix` issues
 * `root.scrollTo({ top: root.scrollTop + offset })` while reconciling row heights. Whatever we hand
 * it therefore becomes a scroll *writer*. The only element this provider is entitled to move is one
 * it owns, so candidates are restricted to descendants of its own anchor. An ancestor pane scroller
 * — on a session route, the transcript scroller — is never a candidate, however large it is.
 *
 * Among owned candidates (a diff list can nest code scrollers inside its list scroller), prefer the
 * largest viewport, then the greatest scroll range, then the deepest node, so virtualization is not
 * bound to a small inner scroller that would produce huge empty buffer spacers.
 *
 * With no owned scroller the fallback is `document`: Pierre then measures against the window, which
 * writes nothing the app owns.
 */
function findOwnedScrollRoot(anchor: HTMLElement): HTMLElement | Document {
    type Candidate = Readonly<{
        el: HTMLElement;
        depth: number;
        clientHeight: number;
        scrollRange: number;
    }>;

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

    const candidates: Candidate[] = [];
    for (const candidate of iterateWebDescendantElements(anchor, { maxNodes: 1500 })) {
        if (!isElementScrollable(candidate)) continue;
        candidates.push({
            el: candidate,
            depth: computeDescendantDepth(candidate),
            clientHeight: Math.max(candidate.clientHeight, 0),
            scrollRange: Math.max(candidate.scrollHeight - candidate.clientHeight, 0),
        });
    }

    const best = candidates.reduce<Candidate | null>((acc, candidate) => {
        if (!acc) return candidate;
        if (candidate.clientHeight !== acc.clientHeight) return candidate.clientHeight > acc.clientHeight ? candidate : acc;
        if (candidate.scrollRange !== acc.scrollRange) return candidate.scrollRange > acc.scrollRange ? candidate : acc;
        return candidate.depth > acc.depth ? candidate : acc;
    }, null);

    if (best) return best.el;
    return typeof document !== 'undefined' ? document : (anchor.ownerDocument ?? document);
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
            const root = findOwnedScrollRoot(anchor);
            if (root !== lastRoot) {
                try {
                    instance.cleanUp();
                } catch {
                    // ignore
                }

                try {
                    // IMPORTANT:
                    // - When binding to an *element* scroll root (the diff subtree's own list scroller
                    //   on web), we must NOT pass an external content container that lives *outside*
                    //   that scroll root. Pierre infers the content container from the scroll root.
                    // - For document root, the 2nd argument is ignored.
                    if (root instanceof Document) {
                        instance.setup(root as any, anchor);
                    } else {
                        instance.setup(root as any);
                    }
                    lastRoot = root;
                } catch {
                    // Fail closed: virtualization is best-effort, never crash the UI.
                }
            }

            attempts += 1;
            // The diff subtree's own scroll root (FlashList web) can mount after the first effect
            // pass, so probe until it exists. Once bound to an owned element the search is over —
            // there is nothing better inside our own subtree to wait for. The attempt ceiling only
            // bounds the case where no owned scroller ever appears (a non-virtualized inline diff),
            // where `document` stays the resolved root.
            if (lastRoot !== null && !(lastRoot instanceof Document)) return;
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
