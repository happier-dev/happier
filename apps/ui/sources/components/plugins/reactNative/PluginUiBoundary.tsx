import * as React from 'react';

import type { PluginUiInstanceKeyV1 } from '@happier-dev/protocol/plugins/ui';

import { PluginReactNativeUnavailable } from './PluginReactNativeUnavailable';

type PluginUiBoundaryProps = Readonly<{
    surfaceId: string;
    /** Immutable artifact identity; changing it permits a fresh render attempt. */
    resetKey?: string;
    /**
     * Ephemeral mount identity supplied by the bound host. It separates two
     * attempts that happen to render the same artifact-qualified surface; it is
     * deliberately not part of the durable watchdog key.
     */
    mountInstanceKey?: PluginUiInstanceKeyV1;
    children: React.ReactNode;
    /**
     * What this contribution family shows in place of a crashed plugin subtree.
     * Omit it for the generic executable-surface notice; supply the family's own
     * declared fallback (a structured message's `summary` template, or `null`
     * for its `hidden` fallback) when the family owns one. `null` means "render
     * nothing" and is distinct from omitting the prop.
     */
    fallback?: React.ReactNode;
    onCrash?: (surfaceId: string, error: Error) => void;
}>;

type PluginUiBoundaryState = Readonly<{
    error: Error | null;
}>;

export class PluginUiBoundary extends React.Component<PluginUiBoundaryProps, PluginUiBoundaryState> {
    state: PluginUiBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): PluginUiBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error): void {
        this.props.onCrash?.(this.props.surfaceId, error);
    }

    componentDidUpdate(previousProps: PluginUiBoundaryProps): void {
        if (
            this.state.error
            && (
                previousProps.surfaceId !== this.props.surfaceId
                || previousProps.resetKey !== this.props.resetKey
                || previousProps.mountInstanceKey !== this.props.mountInstanceKey
            )
        ) {
            this.setState({ error: null });
        }
    }

    render(): React.ReactNode {
        if (this.state.error) {
            return this.props.fallback === undefined
                ? <PluginReactNativeUnavailable />
                : this.props.fallback;
        }
        return this.props.children;
    }
}
