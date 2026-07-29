import * as React from 'react';
import { View } from 'react-native';

import type { PluginSurfaceHostApi } from '@/components/plugins/surfaces/PluginSurfaceHost';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import {
    createPluginUiPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    doesPluginSurfacePlacementTargetKindMatch,
    selectRenderablePluginSurfacePlacementsForPlacement,
    type PluginSurfaceTargetKind,
} from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { PluginSurfacePlacementHost } from './PluginSurfaceHost';

export function PluginSurfacePlacementStack(props: Readonly<{
    placement: string;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    machineId?: string | null;
    serverId?: string | null;
    platform?: LocalServicePreviewPlatform;
    nowMs?: () => number;
    hostApi?: PluginSurfaceHostApi;
    projectionInteractionEnabled?: boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
    targetKind?: PluginSurfaceTargetKind;
    testID?: string;
}>): React.ReactElement | null {
    const policyContext = React.useMemo(() => createPluginUiPolicyEvaluationContext(
        props.policyContext,
        {
            platform: props.platform ?? props.hostApi?.platform ?? 'web',
            channel: props.hostApi?.channel ?? 'internal',
        },
    ), [props.hostApi?.channel, props.hostApi?.platform, props.platform, props.policyContext]);
    const placements = React.useMemo(() => (
        props.pluginUiProjection
            ? selectRenderablePluginSurfacePlacementsForPlacement(props.pluginUiProjection, props.placement, policyContext)
                .filter((placement) => !props.targetKind || doesPluginSurfacePlacementTargetKindMatch(placement, props.targetKind))
            : []
    ), [policyContext, props.placement, props.pluginUiProjection, props.targetKind]);

    if (placements.length === 0) {
        return null;
    }

    return (
        <View testID={props.testID}>
            {placements.map((placement) => (
                <View
                    key={placement.id}
                    testID={`${props.testID ?? 'plugin-surface-placement-stack'}-placement-${placement.id}`}
                >
                    <PluginSurfacePlacementHost
                        placement={placement}
                        machineId={props.machineId}
                        serverId={props.serverId}
                        pluginUiProjection={props.pluginUiProjection}
                        localServicePreviewState={props.localServicePreviewState}
                        platform={props.platform}
                        nowMs={props.nowMs}
                        hostApi={props.hostApi}
                        projectionInteractionEnabled={props.projectionInteractionEnabled}
                        policyContext={policyContext}
                    />
                </View>
            ))}
        </View>
    );
}
