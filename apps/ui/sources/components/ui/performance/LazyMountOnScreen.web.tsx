import * as React from 'react';

type LazyMountOnScreenProps = Readonly<{
    children: React.ReactNode;
    initiallyVisible?: boolean;
    /** Decorative previews release their renderers when clipped; ordinary content stays mounted. */
    unmountWhenHidden?: boolean;
    placeholder?: React.ReactNode;
    rootMargin?: string;
    style?: React.CSSProperties;
}>;

/**
 * The nearest ancestor that really scrolls its content. An observer rooted at the viewport sees a placeholder only
 * where the scroller does not clip it, so the overscan margin never reaches content the scroller has scrolled away.
 */
function nearestScrollingAncestor(node: HTMLElement): HTMLElement | null {
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const { overflowY } = window.getComputedStyle(ancestor);
        if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && ancestor.scrollHeight > ancestor.clientHeight) return ancestor;
    }
    return null;
}

export function LazyMountOnScreen(props: LazyMountOnScreenProps) {
    const [visible, setVisible] = React.useState(props.initiallyVisible === true);
    const ref = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        if (props.initiallyVisible === true && !props.unmountWhenHidden) {
            setVisible(true);
            return;
        }
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            setVisible(true);
            return;
        }
        const IO = globalThis.IntersectionObserver;
        if (typeof IO !== 'function') {
            setVisible(true);
            return;
        }

        const node = ref.current;
        if (!node) {
            setVisible(true);
            return;
        }

        let done = false;
        const observer = new IO((entries) => {
            if (done) return;
            const entry = entries?.[0];
            if (props.unmountWhenHidden) {
                if (entry) setVisible(entry.isIntersecting);
            } else if (entry?.isIntersecting) {
                done = true;
                setVisible(true);
                try {
                    observer.disconnect();
                } catch {
                    // ignore
                }
            }
        }, {
            root: nearestScrollingAncestor(node),
            rootMargin: props.rootMargin ?? '800px 0px 800px 0px',
            threshold: 0,
        });

        try {
            observer.observe(node);
        } catch {
            setVisible(true);
        }

        return () => {
            done = true;
            try {
                observer.disconnect();
            } catch {
                // ignore
            }
        };
    }, [props.initiallyVisible, props.rootMargin, props.unmountWhenHidden]);

    return (
        <div ref={ref} style={props.style}>
            {visible ? props.children : (props.placeholder ?? null)}
        </div>
    );
}
