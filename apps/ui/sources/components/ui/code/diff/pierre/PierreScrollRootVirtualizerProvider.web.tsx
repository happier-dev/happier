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
    let el: HTMLElement | null = anchor.parentElement;
    let steps = 0;
    while (el && steps < 30) {
        if (isElementScrollable(el)) return el;
        el = el.parentElement;
        steps += 1;
    }
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

        const root = findNearestScrollRoot(anchor);
        try {
            instance.cleanUp();
        } catch {
            // ignore
        }

        try {
            instance.setup(root as any, anchor);
        } catch {
            // Fail closed: virtualization is best-effort, never crash the UI.
        }

        return () => {
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
