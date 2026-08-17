import * as React from 'react';
import { View } from 'react-native';

import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type {
    PluginUiContainerV1,
    PluginUiDestinationRuntimeFormFactorV1,
    PluginUiTargetKindV1,
} from '@happier-dev/protocol/plugins/ui';
import { isPluginUiDestinationBindingAdmittedAtRuntimeV1 } from '@happier-dev/protocol/plugins/ui';
import {
    createPluginUiPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    selectRenderablePluginSurfacePlacementsForBinding,
} from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { PluginSurfacePlacementHost } from './PluginSurfaceHost';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { useDeviceType } from '@/utils/platform/responsive';

export function PluginSurfacePlacementStack(props: Readonly<{
    container: PluginUiContainerV1;
    targetKind: PluginUiTargetKindV1;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    agentId?: string | null;
    /** §3.2: the exact identities this stack's placements are about. */
    projectId?: string | null;
    platform?: LocalServicePreviewPlatform;
    /** Runtime-only final admission observation; no plugin declaration carries it. */
    formFactor?: PluginUiDestinationRuntimeFormFactorV1;
    nowMs?: () => number;
    projectionInteractionEnabled?: boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
    testID?: string;
}>): React.ReactElement | null {
    const deviceType = useDeviceType();
    const surfacePlatform = props.platform ?? 'web';
    const runtimeFormFactor = props.formFactor ?? resolvePluginUiRuntimeFormFactor({ deviceType });
    const policyContext = React.useMemo(() => createPluginUiPolicyEvaluationContext(
        props.policyContext,
        {
            platform: surfacePlatform,
            // No stack caller mounts an external channel today; a placement that
            // needs one supplies it through `PluginSurfacePlacementHost` directly
            // rather than through a prop nothing sets.
            channel: 'internal',
        },
    ), [props.policyContext, surfacePlatform]);
    const placements = React.useMemo(() => (
        props.pluginUiProjection
            ? selectRenderablePluginSurfacePlacementsForBinding(props.pluginUiProjection, {
                container: props.container,
                targetKind: props.targetKind,
            }, policyContext).filter((placement) => (
                isPluginUiDestinationBindingAdmittedAtRuntimeV1({
                    binding: placement.binding,
                    platform: surfacePlatform,
                    formFactor: runtimeFormFactor,
                })
            ))
            : []
    ), [
        policyContext,
        props.container,
        props.pluginUiProjection,
        props.targetKind,
        runtimeFormFactor,
        surfacePlatform,
    ]);

    if (placements.length === 0) {
        return null;
    }

    return (
        <PluginSurfaceFocusEligibilityProvider active>
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
                            sessionId={props.sessionId}
                            agentId={props.agentId}
                            projectId={props.projectId}
                            pluginUiProjection={props.pluginUiProjection}
                            localServicePreviewState={props.localServicePreviewState}
                            platform={props.platform}
                            formFactor={runtimeFormFactor}
                            nowMs={props.nowMs}
                            projectionInteractionEnabled={props.projectionInteractionEnabled}
                            policyContext={policyContext}
                        />
                    </View>
                ))}
            </View>
        </PluginSurfaceFocusEligibilityProvider>
    );
}
