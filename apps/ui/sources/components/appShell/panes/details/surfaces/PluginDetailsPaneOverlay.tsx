import * as React from 'react';

import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PluginReactNativeUnavailable } from '@/components/plugins/reactNative/PluginReactNativeUnavailable';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { resolveSelectedPaneDestination } from '@/components/appShell/panes/model/resolveSelectedPaneDestination';
import type { SelectedPaneDestinationV1 } from '@/components/appShell/panes/model/selectedPaneDestination';
import { useDeviceType } from '@/utils/platform/responsive';
import type { DetailsWorkspaceOverlayState } from '../workspace/detailsWorkspaceTypes';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import type {
    DetailsSurfaceHostCallbacksV1,
} from './types';
import {
    usePluginSurfaceDestinationNavigationBinding,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import {
    bindPluginDetailsDestinationOpenSurface,
    usePluginDetailsDestinationOpenSurfaceHandler,
    usePluginDetailsPaneLaunch,
} from './pluginDetailsDestination';
import type {
    PluginDetailsDestinationMountProps,
    PluginDetailsDestinationTargetKind,
} from './pluginDetailsDestination';

/**
 * The one `detailsPane` renderer adapter. It turns the persisted qualified
 * overlay selection back into the current exact registry binding, while the
 * Details workspace remains responsible for its layout, return state, chrome,
 * and unavailable presentation slot.
 */
export const PluginDetailsPaneOverlay = React.memo((props: Readonly<{
    targetKind: PluginDetailsDestinationTargetKind;
    projection: PluginUiProjectionModel | null | undefined;
    mount: PluginDetailsDestinationMountProps;
    overlay: DetailsWorkspaceOverlayState;
    callbacks?: Pick<DetailsSurfaceHostCallbacksV1, 'openOverlay' | 'openTab'>;
}>): React.ReactElement => {
    const deviceType = useDeviceType();
    const runtimeAdmission = React.useMemo(() => Object.freeze({
        platform: props.mount.platform ?? 'web',
        formFactor: props.mount.formFactor ?? resolvePluginUiRuntimeFormFactor({ deviceType }),
    }), [deviceType, props.mount.formFactor, props.mount.platform]);
    const selectedDestination = React.useMemo<SelectedPaneDestinationV1>(() => Object.freeze({
        kind: 'plugin',
        destination: Object.freeze({ ...props.overlay.destination }),
        ...(props.overlay.instanceKey === undefined ? {} : { instanceKey: props.overlay.instanceKey }),
    }), [props.overlay.destination, props.overlay.instanceKey]);
    const selection = React.useMemo(() => resolveSelectedPaneDestination({
        container: 'detailsPane',
        targetKind: props.targetKind,
        projection: props.projection,
        projectionPhase: props.mount.projectionPhase,
        selectedDestination,
        runtimeAdmission,
    }), [props.mount.projectionPhase, props.projection, props.targetKind, runtimeAdmission, selectedDestination]);
    const placement = selection.kind === 'available' ? selection.placement : null;
    const launch = usePluginDetailsPaneLaunch({
        placement,
        targetKind: props.targetKind,
        projection: props.projection,
        mount: props.mount,
        destination: props.overlay.destination,
        ...(props.overlay.instanceKey === undefined ? {} : { instanceKey: props.overlay.instanceKey }),
    });
    const targetNavigationBinding = usePluginSurfaceDestinationNavigationBinding();
    const fallbackOpenSurface = usePluginDetailsDestinationOpenSurfaceHandler({
        targetKind: props.targetKind,
        projection: props.projection,
        mount: props.mount,
        openTab: props.callbacks?.openTab,
        openOverlay: props.callbacks?.openOverlay,
    });
    const openSurface = targetNavigationBinding?.openSurface ?? fallbackOpenSurface;

    if (selection.kind === 'unresolved') {
        return <PaneLoadingFallback color="#888" paddingTop={0} showTypographyMetrics={false} />;
    }
    if (selection.kind !== 'available') {
        return <PluginReactNativeUnavailable diagnostics={[
            selection.kind === 'unavailable'
                ? selection.reason
                : 'details_destination_unavailable',
        ]} />;
    }
    return (
        <PluginSurfaceFocusEligibilityProvider active>
            <PluginSurfacePlacementHost
                {...props.mount}
                formFactor={runtimeAdmission.formFactor}
                placement={selection.placement}
                pluginUiProjection={props.projection}
                projectionInteractionEnabled={props.mount.projectionPhase === 'current'
                    && props.mount.projectionInteractionEnabled === true}
                binding={bindPluginDetailsDestinationOpenSurface({
                    binding: launch?.binding,
                    openSurface,
                })}
                launchInput={launch?.input}
                mountInstanceKey={selection.instanceKey}
            />
        </PluginSurfaceFocusEligibilityProvider>
    );
});
