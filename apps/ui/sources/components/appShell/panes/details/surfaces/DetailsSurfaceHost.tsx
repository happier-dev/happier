import * as React from 'react';

import type { DetailsTabState } from '../workspace/detailsWorkspaceTypes';
import { DetailsSurfaceFallback } from './DetailsSurfaceFallback';
import {
    createDetailsSurfaceDescriptor,
    resolveDetailsSurfaceRenderer,
} from './detailsSurfaceRegistry';
import type {
    DetailsSurfaceDescriptorV1,
    DetailsSurfaceHostCallbacksV1,
    DetailsSurfaceRegionV1,
    DetailsSurfaceRendererV1,
    DetailsSurfaceScopeV1,
} from './types';

type DetailsSurfaceRenderBoundaryProps = Readonly<{
    children: React.ReactNode;
}>;

type DetailsSurfaceRenderBoundaryState = Readonly<{
    hasError: boolean;
}>;

class DetailsSurfaceRenderBoundary extends React.Component<
    DetailsSurfaceRenderBoundaryProps,
    DetailsSurfaceRenderBoundaryState
> {
    state: DetailsSurfaceRenderBoundaryState = { hasError: false };

    static getDerivedStateFromError(): DetailsSurfaceRenderBoundaryState {
        return { hasError: true };
    }

    render(): React.ReactNode {
        if (this.state.hasError) {
            return <DetailsSurfaceFallback status="renderer-error" onRetry={() => this.setState({ hasError: false })} />;
        }
        return this.props.children;
    }
}

function DetailsSurfaceRendererContent(props: Readonly<{
    renderer: DetailsSurfaceRendererV1;
    input: Parameters<DetailsSurfaceRendererV1['render']>[0];
}>): React.ReactElement {
    const surface = props.renderer.render(props.input);
    return surface == null
        ? <DetailsSurfaceFallback status="unsupported" />
        : <>{surface}</>;
}

/**
 * Memoized: the Details panels rebuild this element on every pane, store and presentation commit, while a tab's
 * page (a file's header and body) only changes with its tab, scope, renderers or callbacks.
 */
export const DetailsSurfaceHost = React.memo(function DetailsSurfaceHost(props: Readonly<{
    tab: DetailsTabState;
    scope: DetailsSurfaceScopeV1;
    region: DetailsSurfaceRegionV1;
    descriptor?: DetailsSurfaceDescriptorV1;
    renderers: readonly DetailsSurfaceRendererV1[];
    callbacks?: DetailsSurfaceHostCallbacksV1;
    active?: boolean;
}>): React.ReactElement {
    const descriptor = props.descriptor ?? createDetailsSurfaceDescriptor({
        tab: props.tab,
        scope: props.scope,
        region: props.region,
    });
    const renderInput = {
        tab: props.tab,
        descriptor,
        scope: props.scope,
        region: props.region,
        active: props.active ?? true,
        callbacks: props.callbacks ?? {},
    };

    if (descriptor.status !== 'available') {
        return <DetailsSurfaceFallback status={descriptor.status} reason={descriptor.disabledReason} />;
    }

    const renderer = resolveDetailsSurfaceRenderer({
        renderers: props.renderers,
        renderInput,
    });
    if (!renderer) {
        return <DetailsSurfaceFallback status="unsupported" />;
    }

    return (
        <DetailsSurfaceRenderBoundary key={`${descriptor.surfaceId}:${renderer.id}`}>
            <DetailsSurfaceRendererContent renderer={renderer} input={renderInput} />
        </DetailsSurfaceRenderBoundary>
    );
});
