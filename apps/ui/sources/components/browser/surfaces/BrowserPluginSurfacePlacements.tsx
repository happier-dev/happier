import type {
    ActionExecutorContext,
    BrowserPlatformV1,
    BrowserViewTargetV1,
    RuntimeActionExecute,
} from '@happier-dev/protocol';
import * as React from 'react';
import { View } from 'react-native';

import { PluginSurfacePlacementHost, type PluginSurfaceHostApi } from '@/components/plugins/surfaces';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import {
    canRenderPluginUiProjectionEntry,
    createPluginUiPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import type {
    PluginUiProjectionModel,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { selectPluginSurfacePlacementsForPlacement } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { useEndpointStatus } from '@/sync/domains/state/storage';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import {
    createBrowserPanelPluginSurfaceHostApi,
    toLocalServicePreviewPlatform,
} from './browserPluginHostActions';

function readTargetMachineId(target: BrowserViewTargetV1 | null | undefined): string | null {
    return target?.kind === 'localServicePreview' ? target.machineId : null;
}

function isRenderableBrowserPanelPlacement(
    placement: PluginUiSurfacePlacementProjection,
    policyContext: PluginUiPolicyEvaluationContext,
): boolean {
    return placement.placement === 'browser.panel'
        && placement.target.kind === 'browser'
        && placement.availability.state === 'available'
        && canRenderPluginUiProjectionEntry(placement, policyContext);
}

export function BrowserPluginSurfacePlacements(props: Readonly<{
    focusedTarget?: BrowserViewTargetV1 | null;
    platform: BrowserPlatformV1;
    pluginUiProjection?: PluginUiProjectionModel | null;
    projectionInteractionEnabled?: boolean;
    localServicePreviewState?: LocalServicePreviewState | null;
    localServicePreviewServerId?: string | null;
    hostApi?: PluginSurfaceHostApi;
    /**
     * Canonical runtime-action dispatch bridge for browser-panel host actions
     * (FINALIZATION-PLAN §3.1/§3.6/§12.6). Defaults to the front-door executor so every dispatch
     * routes through `ActionExecutor.execute` (enablement + approval routing). Overridable for tests.
     */
    runtimeActionExecute?: RuntimeActionExecute;
    isFeatureEnabled?: (featureId: string) => boolean;
    nowMs?: () => number;
    testID?: string;
}>): React.ReactElement | null {
    const endpointStatus = useEndpointStatus();
    const candidateBrowserPanelPlacements = React.useMemo(
        () => props.pluginUiProjection && props.focusedTarget
            ? selectPluginSurfacePlacementsForPlacement(props.pluginUiProjection, 'browser.panel')
                .filter((placement) => placement.placement === 'browser.panel'
                    && placement.target.kind === 'browser'
                    && placement.availability.state === 'available')
            : [],
        [props.focusedTarget, props.pluginUiProjection],
    );

    const browserPanelPlacements = React.useMemo(
        () => candidateBrowserPanelPlacements.filter((placement) => {
            const policyContext = createPluginUiPolicyEvaluationContext({
                platform: toLocalServicePreviewPlatform(props.platform),
                channel: props.hostApi?.channel ?? 'internal',
                ...(props.isFeatureEnabled ? { isFeatureEnabled: props.isFeatureEnabled } : {}),
            });
            return isRenderableBrowserPanelPlacement(placement, policyContext);
        }),
        [candidateBrowserPanelPlacements, props.hostApi?.channel, props.isFeatureEnabled, props.platform],
    );

    // Single front door (FINALIZATION-PLAN §3.1/§12.6): browser-panel host actions dispatch through
    // ActionExecutor.execute via the canonical bridge so ActionsSettings enablement and approval
    // routing apply. This is a user-driven UI surface, so dispatches carry surface 'ui'.
    const runtimeActionExecute = React.useMemo(
        () => props.runtimeActionExecute ?? createFrontDoorRuntimeActionExecutor(),
        [props.runtimeActionExecute],
    );
    const actionExecutorContext = React.useMemo<ActionExecutorContext>(
        () => ({
            surface: 'ui',
            ...(props.localServicePreviewServerId ? { serverId: props.localServicePreviewServerId } : {}),
        }),
        [props.localServicePreviewServerId],
    );

    if (browserPanelPlacements.length === 0) {
        return null;
    }

    return (
        <>
            {browserPanelPlacements.map((placement) => (
                <View
                    key={placement.id}
                    testID={`${props.testID ?? 'browser-surface'}-plugin-placement-${placement.id}`}
                >
                    <PluginSurfacePlacementHost
                        placement={placement}
                        resourceBrowserTarget={props.focusedTarget}
                        machineId={readTargetMachineId(props.focusedTarget)}
                        serverId={props.localServicePreviewServerId}
                        pluginUiProjection={props.pluginUiProjection}
                        projectionInteractionEnabled={props.projectionInteractionEnabled}
                        localServicePreviewState={props.localServicePreviewState}
                        platform={toLocalServicePreviewPlatform(props.platform)}
                        nowMs={props.nowMs}
                        policyContext={createPluginUiPolicyEvaluationContext({
                            platform: toLocalServicePreviewPlatform(props.platform),
                            channel: props.hostApi?.channel ?? 'internal',
                            ...(props.isFeatureEnabled ? { isFeatureEnabled: props.isFeatureEnabled } : {}),
                        })}
                        hostApi={endpointStatus === 'online'
                            ? createBrowserPanelPluginSurfaceHostApi({
                                focusedTarget: props.focusedTarget,
                                fallbackHostApi: props.hostApi,
                                placement,
                                platform: props.platform,
                                runtimeActionExecute,
                                actionExecutorContext,
                                ...(props.isFeatureEnabled ? { isFeatureEnabled: props.isFeatureEnabled } : {}),
                            })
                            : undefined}
                    />
                </View>
            ))}
        </>
    );
}
