import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type {
    ActionExecutorContext,
} from '@happier-dev/protocol';

import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { useEndpointStatus } from '@/sync/domains/state/storage';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    createAppScopePluginSurfaceHostApi,
    type AppScopePluginActionExecute,
} from './appScopePluginHostActions';
import { RightSidebarIconTabBar } from './RightSidebarIconTabBar';
import {
    resolveRightSidebarActiveTab,
    resolveRightSidebarTabs,
} from './rightSidebarTabRegistry';
import type {
    RightSidebarPluginTabDefinition,
    RightSidebarTabDefinition,
} from './rightSidebarBuiltinTabs';

/**
 * App-shell consumer for `app.rightSidebarTab` plugin placements (Seam 1).
 *
 * Resolves app-scope plugin tabs through the SAME canonical registry/selector that
 * session/project right sidebars use (`resolveRightSidebarTabs({ scope: 'app' })` +
 * `selectPluginRightSidebarTabPlacements(model, 'app')`) and renders the active tab's
 * surface through the canonical `PluginSurfacePlacementHost`. App-scope plugin tabs
 * mount fail-closed (policy + availability gated) exactly like session/project tabs.
 *
 * There are no app-scope built-in tabs today, so this surface only appears when a
 * first-party plugin contributes an `app.rightSidebarTab` placement.
 */

export type AppScopeRightSidebarProps = Readonly<{
    pluginUiProjection?: PluginUiProjectionModel | null;
    machineId?: string | null;
    serverId?: string | null;
    platform?: LocalServicePreviewPlatform;
    executeAction?: AppScopePluginActionExecute;
    testID?: string;
}>;

function isPluginTab(tab: RightSidebarTabDefinition): tab is RightSidebarPluginTabDefinition {
    return tab.owner === 'plugin';
}

export function AppScopeRightSidebar(props: AppScopeRightSidebarProps): React.ReactElement | null {
    const { theme } = useUnistyles();
    const endpointStatus = useEndpointStatus();
    const pluginProjection = useAppShellPluginUiProjection();
    const projection = props.pluginUiProjection ?? pluginProjection.pluginUiProjection;
    const machineId = props.machineId ?? pluginProjection.machineId;
    const serverId = props.serverId ?? pluginProjection.serverId;
    const platform = props.platform ?? pluginProjection.platform;

    const placements = React.useMemo(() => (
        projection ? selectPluginRightSidebarTabPlacements(projection, 'app') : []
    ), [projection]);

    const tabs = React.useMemo(() => resolveRightSidebarTabs({
        scope: 'app',
        pluginPlacements: placements,
        projectionGeneration: projection?.generation ?? null,
    }), [placements, projection?.generation]);

    const [activeTabId, setActiveTabId] = React.useState<string | null>(null);
    const resolvedActiveTabId = tabs.length > 0
        ? resolveRightSidebarActiveTab<string>(activeTabId, tabs)
        : null;
    const activeTab = resolvedActiveTabId
        ? tabs.find((tab) => tab.id === resolvedActiveTabId)
        : null;
    const activePlacement = activeTab && isPluginTab(activeTab) ? activeTab.placement : null;
    const executeAction = React.useMemo<AppScopePluginActionExecute>(() => {
        if (props.executeAction) {
            return props.executeAction;
        }
        let executor: Readonly<{ execute: AppScopePluginActionExecute }> | null = null;
        return async (actionId, input, context) => {
            if (!executor) {
                const module = await import('@/sync/ops/actions/defaultActionExecutor');
                executor = module.createDefaultActionExecutor() as Readonly<{ execute: AppScopePluginActionExecute }>;
            }
            const target = executor;
            return target.execute(actionId, input, context);
        };
    },
        [props.executeAction],
    );
    const actionExecutorContext = React.useMemo<ActionExecutorContext>(
        () => ({
            surface: 'ui',
            ...(serverId ? { serverId } : {}),
        }),
        [serverId],
    );
    const hostApi = React.useMemo(() => (
        activePlacement && endpointStatus === 'online'
            ? createAppScopePluginSurfaceHostApi({
                placement: activePlacement,
                platform,
                executeAction,
                actionExecutorContext,
            })
            : undefined
    ), [activePlacement, actionExecutorContext, endpointStatus, executeAction, platform]);

    if (tabs.length === 0 || !resolvedActiveTabId) {
        return (
            <View testID={props.testID} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Text style={{ color: theme.colors.text.secondary, fontSize: 13, ...Typography.default(), textAlign: 'center' }}>
                    {t('pluginSurfaces.appScopeRightSidebar.empty')}
                </Text>
            </View>
        );
    }

    return (
        <View testID={props.testID} style={{ flex: 1 }}>
            <RightSidebarIconTabBar
                tabs={tabs}
                activeTabId={resolvedActiveTabId}
                onSelectTab={setActiveTabId}
                testIDPrefix="app-scope-right-sidebar-tab"
            />
            <View style={{ flex: 1 }}>
                {activePlacement ? (
                    <PluginSurfacePlacementHost
                        placement={activePlacement}
                        pluginUiProjection={projection}
                        machineId={machineId}
                        serverId={serverId}
                        platform={platform}
                        hostApi={hostApi}
                        projectionInteractionEnabled={pluginProjection.interactionEnabled}
                    />
                ) : null}
            </View>
        </View>
    );
}
