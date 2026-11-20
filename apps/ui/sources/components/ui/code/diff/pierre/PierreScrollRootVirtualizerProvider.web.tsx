import * as React from 'react';

import type { Virtualizer as PierreVirtualizer } from '@pierre/diffs';
import { iterateWebDescendantElements } from '@/components/ui/scroll/resolveWebScrollableElement';

type PierreScrollRootScope = Readonly<{
    getInstance: (create: () => PierreVirtualizer) => PierreVirtualizer | undefined;
    activate: () => void;
    /** The scope is a list's own scroller that its rows' diffs window against (see `getScrollRoot`). */
    enclosing: boolean;
}>;

const PierreScrollRootContext = React.createContext<PierreScrollRootScope | undefined>(undefined);

/** The demanded Pierre leaf supplies the constructor; the retained list owns its lifetime. */
export function usePierreScrollRootVirtualizer(create: (() => PierreVirtualizer) | null): PierreVirtualizer | undefined {
    const scope = React.useContext(PierreScrollRootContext);
    const demanded = create !== null;
    const instance = create ? scope?.getInstance(create) : undefined;
    React.useEffect(() => {
        if (demanded) scope?.activate();
    }, [demanded, scope]);
    return instance;
}

/** True inside a list scroller that its rows' diffs window their lines against, instead of each owning a scroller. */
export function usePierreEnclosingScrollRoot(): boolean {
    return React.useContext(PierreScrollRootContext)?.enclosing === true;
}

function canScrollVertically(el: HTMLElement): boolean {
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return false;
    const overflowY = window.getComputedStyle(el)?.overflowY ?? null;
    return overflowY === 'auto' || overflowY === 'scroll';
}

function isElementScrollable(el: HTMLElement): boolean {
    return canScrollVertically(el) && el.scrollHeight > el.clientHeight + 5;
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
 * writes nothing the app owns. Owned scrollers that exist but do not overflow yet (a list whose rows
 * have not rendered) are returned as `waiting`, so the caller can rebind when one outgrows its viewport.
 */
function findOwnedScrollRoot(anchor: HTMLElement): Readonly<{ root: HTMLElement | Document; waiting: readonly HTMLElement[] }> {
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
    const waiting: HTMLElement[] = [];
    for (const candidate of iterateWebDescendantElements(anchor, { maxNodes: 1500 })) {
        // Bounded diff bodies own their scrolling; the shared list must not adopt a child's
        // viewport merely because that viewport is taller than a short enclosing pane.
        const diffOwner = candidate.closest('.happier-pierre-diff-wrapper');
        if (diffOwner && anchor.contains(diffOwner)) continue;
        if (!isElementScrollable(candidate)) {
            if (candidate.clientHeight > 0 && canScrollVertically(candidate)) waiting.push(candidate);
            continue;
        }
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

    if (best) return { root: best.el, waiting };
    return { root: typeof document !== 'undefined' ? document : (anchor.ownerDocument ?? document), waiting };
}

const UNTRACKED_CONNECT = new WeakMap<PierreVirtualizer, PierreVirtualizer['connect']>();

/** Records which diffs are connected (until they disconnect) so a rebind can re-connect them. */
function trackConnections(
    instance: PierreVirtualizer,
    connected: Map<HTMLElement, Parameters<PierreVirtualizer['connect']>[1]>,
): PierreVirtualizer {
    const connect = instance.connect;
    const disconnect = instance.disconnect;
    UNTRACKED_CONNECT.set(instance, connect);
    instance.connect = (container, subscriber) => {
        connected.set(container, subscriber);
        return connect.call(instance, container, subscriber);
    };
    instance.disconnect = (container) => {
        connected.delete(container);
        disconnect.call(instance, container);
    };
    return instance;
}

function untrackedConnect(instance: PierreVirtualizer): PierreVirtualizer['connect'] {
    return UNTRACKED_CONNECT.get(instance) ?? instance.connect;
}

export function PierreScrollRootVirtualizerProvider(props: Readonly<{
    children: React.ReactNode;
    /**
     * The list's own scroll node, when the list hands it over (a plugin List whose rows disclose diffs). Its
     * diffs then window their lines against that one scroller (QB-81) rather than each owning a capped one, and
     * no anchor is searched.
     */
    getScrollRoot?: () => unknown;
    /** Draw no layout frame of its own: the list keeps exactly the box its own layout gives it (a plugin List). */
    unframed?: boolean;
}>) {
    const getScrollRootRef = React.useRef(props.getScrollRoot);
    getScrollRootRef.current = props.getScrollRoot;
    const anchorRef = React.useRef<HTMLDivElement | null>(null);
    const instanceRef = React.useRef<PierreVirtualizer | undefined>(undefined);
    // Pierre forgets every connected (and queued) diff on `cleanUp`, and a diff connects only once, when it
    // mounts. Each bind re-connects the live diffs, or the first diffs of a list (mounted before the
    // provider first bound, or bound to an earlier root) stay blank until they remount.
    const connectedRef = React.useRef(new Map<HTMLElement, Parameters<PierreVirtualizer['connect']>[1]>());
    const cleanupRef = React.useRef<(() => void) | undefined>(undefined);

    const activate = React.useCallback(() => {
        if (cleanupRef.current) return;
        const anchor = anchorRef.current;
        const getScrollRoot = getScrollRootRef.current;
        if (!anchor && !getScrollRoot) return;
        const instance = instanceRef.current;
        if (!instance) return;
        const connect = untrackedConnect(instance);

        const raf: (cb: FrameRequestCallback) => number =
            typeof globalThis.requestAnimationFrame === 'function'
                ? globalThis.requestAnimationFrame.bind(globalThis)
                : (cb) => window.setTimeout(() => cb(Date.now()), 0);

        let cancelled = false;
        let attempts = 0;
        const maxAttempts = 30;
        let lastRoot: HTMLElement | Document | null = null;
        let growthObserver: ResizeObserver | null = null;

        // A list that is mounted but not yet overflowing (its diffs are still rendering) becomes the root
        // the moment its content outgrows it; a resize of the scroller or its content is that moment.
        const watchGrowth = (waiting: readonly HTMLElement[]) => {
            growthObserver?.disconnect();
            growthObserver = null;
            if (waiting.length === 0 || typeof ResizeObserver === 'undefined') return;
            try {
                // A ResizeObserver reports every target once when it starts observing; that is not growth.
                let delivered = false;
                const observer = new ResizeObserver(() => {
                    if (!delivered) {
                        delivered = true;
                        return;
                    }
                    if (growthObserver !== observer) return;
                    observer.disconnect();
                    growthObserver = null;
                    bindToCurrentRoot();
                });
                for (const scroller of waiting) {
                    observer.observe(scroller);
                    for (const content of Array.from(scroller.children)) observer.observe(content);
                }
                growthObserver = observer;
            } catch {
                // Best-effort, like the rest of the binding.
            }
        };

        const bindToCurrentRoot = () => {
            if (cancelled) return;
            const given = getScrollRoot?.();
            const { root, waiting } = getScrollRoot
                ? { root: typeof HTMLElement !== 'undefined' && given instanceof HTMLElement ? given : null, waiting: [] }
                : findOwnedScrollRoot(anchor!);
            if (root !== null && root !== lastRoot) {
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
                        instance.setup(root, anchor!);
                    } else {
                        instance.setup(root);
                    }
                    // `cleanUp` above dropped Pierre's queue and observers; every live diff connects again.
                    for (const [container, subscriber] of connectedRef.current) connect.call(instance, container, subscriber);
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
            if (attempts >= maxAttempts) {
                watchGrowth(waiting);
                return;
            }
            raf(() => bindToCurrentRoot());
        };

        cleanupRef.current = () => {
            cancelled = true;
            growthObserver?.disconnect();
            growthObserver = null;
            try {
                instance.cleanUp();
            } catch {
                // ignore
            }
        };
        bindToCurrentRoot();
    }, []);

    const [scope] = React.useState<PierreScrollRootScope>(() => ({
        getInstance: (create) => {
            if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
            if (typeof globalThis.IntersectionObserver === 'undefined') return undefined;
            if (typeof globalThis.ResizeObserver === 'undefined') return undefined;
            return instanceRef.current ??= trackConnections(create(), connectedRef.current);
        },
        activate,
        enclosing: props.getScrollRoot !== undefined,
    }));

    React.useEffect(() => () => {
        cleanupRef.current?.();
        cleanupRef.current = undefined;
    }, []);

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

    if (props.unframed === true) {
        return <PierreScrollRootContext.Provider value={scope}>{props.children}</PierreScrollRootContext.Provider>;
    }
    return (
        <PierreScrollRootContext.Provider value={scope}>
            <div ref={anchorRef} style={rootStyle} data-happier-diff-virtual-root="1">
                {props.children}
            </div>
        </PierreScrollRootContext.Provider>
    );
}
