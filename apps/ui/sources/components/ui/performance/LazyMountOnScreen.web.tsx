import * as React from 'react';

type LazyMountOnScreenProps = Readonly<{
    children: React.ReactNode;
    placeholder?: React.ReactNode;
    rootMargin?: string;
}>;

export function LazyMountOnScreen(props: LazyMountOnScreenProps) {
    const [visible, setVisible] = React.useState(false);
    const ref = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        if (visible) return;
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            setVisible(true);
            return;
        }
        const IO: any = (globalThis as any).IntersectionObserver;
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
        const observer = new IO((entries: any[]) => {
            if (done) return;
            const entry = entries?.[0];
            if (entry?.isIntersecting) {
                done = true;
                setVisible(true);
                try {
                    observer.disconnect();
                } catch {
                    // ignore
                }
            }
        }, {
            root: null,
            rootMargin: props.rootMargin ?? '800px 0px 800px 0px',
            threshold: 0,
        });

        try {
            observer.observe(node);
        } catch {
            setVisible(true);
        }

        return () => {
            try {
                observer.disconnect();
            } catch {
                // ignore
            }
        };
    }, [props.rootMargin, visible]);

    return (
        <div ref={ref}>
            {visible ? props.children : (props.placeholder ?? null)}
        </div>
    );
}
