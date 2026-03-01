import * as React from 'react';

import { Virtualizer as PierreVirtualizer } from '@pierre/diffs';
import { VirtualizerContext } from '@pierre/diffs/react';

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

    const descendants = Array.from(anchor.querySelectorAll('*')) as HTMLElement[];
    for (const candidate of descendants) {
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
