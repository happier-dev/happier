import * as React from 'react';

import type { PluginReactNativeCompatibilityDecision } from './compatibility';
import { PluginReactNativeUnavailable } from './PluginReactNativeUnavailable';
import { PluginUiBoundary } from './PluginUiBoundary';

export type PluginReactNativeSurfaceModule = Readonly<{
    renderSurface: () => React.ReactElement;
}>;

type PluginReactNativeSurfaceProps = Readonly<{
    surfaceId: string;
    decision: PluginReactNativeCompatibilityDecision;
    module?: PluginReactNativeSurfaceModule | null;
    load?: () => PluginReactNativeSurfaceModule | Promise<PluginReactNativeSurfaceModule>;
    loadTimeoutMs?: number;
    onCrash?: (surfaceId: string, error: Error) => void;
}>;

const DEFAULT_LOAD_TIMEOUT_MS = 5000;

export function PluginReactNativeSurface(props: PluginReactNativeSurfaceProps): React.ReactElement {
    const [loadedModule, setLoadedModule] = React.useState<PluginReactNativeSurfaceModule | null>(props.module ?? null);
    const [loadFailed, setLoadFailed] = React.useState(false);

    React.useEffect(() => {
        if (props.decision.state !== 'load' || props.module || !props.load) {
            return undefined;
        }

        let cancelled = false;
        const timeout = setTimeout(() => {
            if (!cancelled) {
                setLoadFailed(true);
            }
        }, props.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);

        Promise.resolve()
            .then(() => props.load?.())
            .then((nextModule) => {
                if (!cancelled && nextModule) {
                    clearTimeout(timeout);
                    setLoadedModule(nextModule);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    clearTimeout(timeout);
                    setLoadFailed(true);
                }
            });

        return () => {
            cancelled = true;
            clearTimeout(timeout);
        };
    }, [props.decision.state, props.load, props.loadTimeoutMs, props.module]);

    if (props.decision.state !== 'load' || loadFailed) {
        return <PluginReactNativeUnavailable />;
    }

    const module = props.module ?? loadedModule;
    if (!module) {
        return <PluginReactNativeUnavailable />;
    }

    return (
        <PluginUiBoundary surfaceId={props.surfaceId} onCrash={props.onCrash}>
            {module.renderSurface()}
        </PluginUiBoundary>
    );
}
