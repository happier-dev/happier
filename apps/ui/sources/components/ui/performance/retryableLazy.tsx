import * as React from 'react';

type LazyModule<Props> = { default: React.ComponentType<Props> };

export type RetryableLazyComponent<Props extends object> = React.ComponentType<Props> & Readonly<{
    /**
     * Starts the chunk without rendering. The first render consumes the same load; a rejected
     * preload is dropped so that render loads again and reports through the existing boundary.
     */
    preload: () => void;
}>;

export function retryableLazy<Props extends object>(
    load: () => Promise<LazyModule<Props>>,
): RetryableLazyComponent<Props> {
    let rejected = false;
    // One load at a time is shared by preload and the lazy component.
    let pending: Promise<LazyModule<Props>> | null = null;
    // The attempt the current lazy component holds; only its rejection retires that component.
    let consumed: Promise<LazyModule<Props>> | null = null;
    const loadShared = () => {
        if (pending) return pending;
        const attempt: Promise<LazyModule<Props>> = load().catch((error: unknown) => {
            if (pending === attempt) pending = null;
            if (consumed === attempt) rejected = true;
            throw error;
        });
        pending = attempt;
        return attempt;
    };
    const loadNext = () => {
        consumed = loadShared();
        return consumed;
    };
    let Content = React.lazy(loadNext);
    class DemandBoundary extends React.Component<{ contentProps: Props }, { failed: boolean }> {
        state = { failed: false };

        static getDerivedStateFromError() {
            return { failed: true };
        }

        componentDidCatch(error: unknown) {
            // Retire only a committed rejection. Resetting during rendering or
            // promise settlement would silently retry during Suspense recovery.
            if (rejected) {
                rejected = false;
                Content = React.lazy(loadNext);
            }
            throw error;
        }

        render() {
            // Forward to the existing boundary and its retry UI. This host adds
            // no fallback and keeps successful component identities unchanged.
            if (this.state.failed) return null;
            return React.createElement(Content, this.props.contentProps);
        }
    }
    // Keep refs in the forwarded props rather than attaching them to the boundary.
    return Object.assign(function RetryableLazy(props: Props) {
        return React.createElement(DemandBoundary, { contentProps: props });
    }, {
        // The rendered view's own load reports a failure; a preload has no surface to report on.
        preload: () => { void loadShared().catch(() => undefined); },
    });
}
