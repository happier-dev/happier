import * as React from 'react';

import { PluginReactNativeUnavailable } from './PluginReactNativeUnavailable';

type PluginUiBoundaryProps = Readonly<{
    surfaceId: string;
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

    render(): React.ReactNode {
        if (this.state.error) {
            return <PluginReactNativeUnavailable />;
        }
        return this.props.children;
    }
}
