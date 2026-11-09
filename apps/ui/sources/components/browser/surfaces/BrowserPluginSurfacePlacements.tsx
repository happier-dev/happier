import type {
    BrowserPlatformV1} from '@happier-dev/protocol/browser/view/v1';
import type {
    BrowserViewTargetV1,
} from '@happier-dev/protocol/browser/target/v1';
import type { PluginUiChannelV1 } from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import {
    createPluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import type {
    PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { selectRenderablePluginSurfacePlacementsForBinding } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import type { PluginSurfaceHostActionExecute } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';

const stylesheet = StyleSheet.create(() => ({
    // One of the Browser shell column's flexible regions (rendered through `BrowserShell.panels`).
    // Its basis is its share of the column, not its content: a content-sized panel is as tall as
    // its whole document and never yields, so a short pane starved the page instead. With a share
    // it gives way in proportion with the page and the diagnostics body, and clips inside its box.
    region: {
        flexGrow: 0,
        flexShrink: 1,
        flexBasis: '40%',
        minHeight: 0,
        overflow: 'hidden',
    },
}));

type BrowserPluginSurfacePlacementsProps = Readonly<{
    browserSessionId: string;
    focusedTarget?: BrowserViewTargetV1 | null;
    platform: BrowserPlatformV1;
    channel?: PluginUiChannelV1;
    pluginUiProjection?: PluginUiProjectionModel | null;
    projectionInteractionEnabled?: boolean;
    localServicePreviewState?: LocalServicePreviewState | null;
    /**
     * The exact admitted execution binding. The Browser target is public subject
     * context only and never decides where host effects execute.
     */
    executionMachineId?: string | null;
    executionServerId?: string | null;
    executionSessionId?: string | null;
    /**
     * The canonical `ActionExecutor.execute` front door to inject. Omitted in
     * production: the bound controller resolves the same canonical front door, so
     * every dispatch carries ActionsSettings enablement and approval routing.
     */
    executeAction?: PluginSurfaceHostActionExecute;
    isFeatureEnabled?: (featureId: string) => boolean;
    nowMs?: () => number;
    testID?: string;
}>;

export function BrowserPluginSurfacePlacements(props: BrowserPluginSurfacePlacementsProps): React.ReactElement | null {
    const channel = props.channel ?? 'internal';
    const browserPanelPlacements = React.useMemo(
        () => props.pluginUiProjection && props.focusedTarget
            ? selectRenderablePluginSurfacePlacementsForBinding(props.pluginUiProjection, {
                container: 'browserPanel',
                targetKind: 'browser',
            }, createPluginUiPolicyEvaluationContext({
                platform: props.platform,
                channel,
                ...(props.isFeatureEnabled ? { isFeatureEnabled: props.isFeatureEnabled } : {}),
            }))
            : [],
        [channel, props.focusedTarget, props.isFeatureEnabled, props.platform, props.pluginUiProjection],
    );

    if (browserPanelPlacements.length === 0) return null;
    return <BrowserPanelPlacements {...props} placements={browserPanelPlacements} />;
}

function BrowserPanelPlacements(props: BrowserPluginSurfacePlacementsProps & Readonly<{
    placements: ReturnType<typeof selectRenderablePluginSurfacePlacementsForBinding>;
}>): React.ReactElement | null {
    const channel = props.channel ?? 'internal';
    const pane = useAppPaneScope(`browser-panels:${props.browserSessionId}`);
    const openPlacements = props.placements.filter((placement) => {
        const state = pane.scopeState?.right.tabState[placement.id];
        return typeof state === 'object' && state !== null && 'isOpen' in state && state.isOpen === true;
    });

    // §3.1: the panel supplies facts only. The host-ActionSpec front door, the
    // contributed-action branch, the resource snapshot authority, the surface
    // context and every method's lifetime belong to the bound controller inside
    // `PluginSurfacePlacementHost`.
    const binding = React.useMemo<BoundPluginSurfaceBinding | undefined>(
        () => (props.executeAction ? { executeHostAction: props.executeAction } : undefined),
        [props.executeAction],
    );

    if (openPlacements.length === 0) {
        return null;
    }

    return (
        <PluginSurfaceFocusEligibilityProvider active>
            {openPlacements.map((placement) => (
                <View
                    key={placement.id}
                    style={stylesheet.region}
                    testID={`${props.testID ?? 'browser-surface'}-plugin-placement-${placement.id}`}
                >
                    <PluginSurfacePlacementHost
                        placement={placement}
                        resourceBrowserTarget={props.focusedTarget ?? null}
                        machineId={props.executionMachineId ?? null}
                        serverId={props.executionServerId ?? null}
                        sessionId={props.executionSessionId ?? null}
                        pluginUiProjection={props.pluginUiProjection ?? null}
                        projectionInteractionEnabled={props.projectionInteractionEnabled}
                        localServicePreviewState={props.localServicePreviewState ?? null}
                        platform={props.platform}
                        channel={channel}
                        nowMs={props.nowMs}
                        policyContext={createPluginUiPolicyEvaluationContext({
                            platform: props.platform,
                            channel,
                            ...(props.isFeatureEnabled ? { isFeatureEnabled: props.isFeatureEnabled } : {}),
                        })}
                        binding={binding}
                    />
                </View>
            ))}
        </PluginSurfaceFocusEligibilityProvider>
    );
}
