import * as React from 'react';

import { PluginReactNativeUnavailable } from './PluginReactNativeUnavailable';

type PluginUiBoundaryProps = Readonly<{
    surfaceId: string;
    /** Immutable artifact identity; changing it permits a fresh render attempt. */
    resetKey?: string;
    children: React.ReactNode;
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
            )
        ) {
            this.setState({ error: null });
        }
    }

    render(): React.ReactNode {
        if (this.state.error) {
            return <PluginReactNativeUnavailable />;
        }
        return this.props.children;
    }
}
