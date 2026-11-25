import * as React from 'react';

import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

export type SessionPaneLazyLoaderProps<TProps extends object> = Readonly<{
    testID: string;
    load: () => Promise<React.ComponentType<TProps>>;
    props: TProps;
    loadingFallback?: React.ReactElement;
}>;

type PaneFailureCode = 'pane_module_load_failed' | 'pane_render_failed';

// Module identity survives a pane's view lifetime. No view state or output is retained here.
const resolvedPanes = new WeakMap<object, unknown>();

/** A pane whose code failed to load or whose render threw: it fails alone, says so and retries. */
function PaneFailure(props: Readonly<{ testID: string; code: PaneFailureCode; onRetry: () => void }>) {
    return (
        <SurfaceStateCard
            testID={`${props.testID}-error`}
            kind="error"
            title={t('surfaceState.paneFailedTitle')}
            reason={t('surfaceState.paneFailedReason')}
            diagnosticCode={props.code}
            action={{ label: t('surfaceState.tryAgain'), onPress: props.onRetry }}
        />
    );
}

export class SessionPaneErrorBoundary extends React.Component<
    Readonly<{ testID: string; children: React.ReactNode }>,
    Readonly<{ failed: boolean }>
> {
    state = { failed: false };

    static getDerivedStateFromError() { return { failed: true }; }

    render() {
        return this.state.failed
            ? <PaneFailure testID={this.props.testID} code="pane_render_failed" onRetry={() => this.setState({ failed: false })} />
            : this.props.children;
    }
}

export function SessionPaneLazyLoader<TProps extends object>(input: SessionPaneLazyLoaderProps<TProps>) {
    // The loader function is the key for its exact component/props pair.
    const resolved = resolvedPanes.get(input.load) as React.ComponentType<TProps> | undefined;
    const [loaded, setLoaded] = React.useState<Readonly<{ load: typeof input.load; Impl: React.ComponentType<TProps> }> | null>(null);
    const Impl = resolved ?? (loaded?.load === input.load ? loaded.Impl : null);
    const [retryNonce, setRetryNonce] = React.useState(0);
    const [error, setError] = React.useState<unknown>(null);

    React.useEffect(() => {
        if (resolvedPanes.has(input.load)) return;
        let cancelled = false;
        setError(null);
        void input.load()
            .then((mod) => {
                resolvedPanes.set(input.load, mod);
                if (cancelled) return;
                setLoaded({ load: input.load, Impl: mod });
            })
            .catch((loadError) => {
                if (cancelled) return;
                setError(loadError);
            });
        return () => {
            cancelled = true;
        };
    }, [input.load, retryNonce]);

    if (error) return <PaneFailure testID={input.testID} code="pane_module_load_failed" onRetry={() => {
        setLoaded(null);
        setError(null);
        setRetryNonce((value) => value + 1);
    }} />;

    if (!Impl) return input.loadingFallback ?? <PaneLoadingFallback testID={input.testID} />;

    return <SessionPaneErrorBoundary testID={input.testID}>{React.createElement(Impl, input.props)}</SessionPaneErrorBoundary>;
}
