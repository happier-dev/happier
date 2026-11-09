import * as React from 'react';

import { useAppShellPluginUiProjection, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiProjectionModel, PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { resolveRightSidebarTabs } from './rightSidebarTabRegistry';
import type { PluginUiInstanceKeyV1, PluginUiLaunchInputV1 } from '@happier-dev/protocol/plugins/ui';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

/**
 * The App's own right-sidebar tabs (`rightSidebarTab × app`, design §3.3): every page's right sidebar
 * lists them — the App page's own, and a Session's or Project's after their scoped tabs — from the
 * one app-shell projection, never from a Session's or Project's machine projection.
 */
export function useAppRightSidebarTabInputs(serverId?: string | null): Readonly<{
    appPluginPlacements: readonly PluginUiSurfacePlacementProjection[];
    appLocalize: PluginLocalizedTextResolver;
    browserFeatureEnabled: boolean;
}> {
    const browserFeatureEnabled = useFeatureDecision('browser', serverId
        ? { scopeKind: 'spawn', serverId } : { scopeKind: 'runtime' })?.state === 'enabled';
    const projection = useAppShellPluginUiProjection().pluginUiProjection;
    const appLocalize = useProjectedPluginLocalizedTextResolver();
    const appPluginPlacements = React.useMemo(
        () => (projection ? selectPluginRightSidebarTabPlacements(projection, 'app') : []),
        [projection],
    );
    return React.useMemo(() => ({
        appPluginPlacements,
        appLocalize,
        browserFeatureEnabled,
    }), [appLocalize, appPluginPlacements, browserFeatureEnabled]);
}

/** The App rail and its pane adapter read one catalog, not separate tab-availability rules. */
export function useAppRightSidebarTabs() {
    const inputs = useAppRightSidebarTabInputs();
    return React.useMemo(() => resolveRightSidebarTabs({
        scope: 'app',
        pluginPlacements: inputs.appPluginPlacements,
        localize: inputs.appLocalize,
    }), [inputs.appLocalize, inputs.appPluginPlacements]);
}

export type AppRightSidebarTabFacts = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    machineId: string | null;
    serverId: string | null;
    platform: LocalServicePreviewPlatform;
    interactionEnabled: boolean;
}>;

/**
 * One App panel's mount, wherever its sidebar stands: an app-target surface with the app-shell
 * projection's facts (no Session or Project id), unless the App sidebar supplies its own.
 */
export const AppRightSidebarTabSurface = React.memo(function AppRightSidebarTabSurface(props: Readonly<{
    placement: PluginUiSurfacePlacementProjection;
    facts?: AppRightSidebarTabFacts;
    binding?: BoundPluginSurfaceBinding;
    launchInput?: PluginUiLaunchInputV1;
    mountInstanceKey?: PluginUiInstanceKeyV1;
    /** The containing Session's initial execution target; never a Session target binding. */
    executionTarget?: Readonly<{ serverId: string; machineId: string }> | null;
}>) {
    const shell = useAppShellPluginUiProjection();
    const facts = props.facts ?? {
        pluginUiProjection: shell.pluginUiProjection,
        machineId: shell.machineId,
        serverId: shell.serverId,
        platform: shell.platform,
        interactionEnabled: shell.phase === 'current' && shell.interactionEnabled === true,
    };
    const hasExecutionTarget = props.executionTarget !== undefined;
    const targetServerId = props.executionTarget?.serverId;
    const targetMachineId = props.executionTarget?.machineId;
    const contextualTarget = React.useMemo(() => !hasExecutionTarget ? undefined
        : targetServerId && targetMachineId ? { serverIdentityId: resolveServerProfileScopeIdForIdentifier(targetServerId),
            machineId: targetMachineId } : null,
    [hasExecutionTarget, targetMachineId, targetServerId]);
    return (
        <PluginSurfaceFocusEligibilityProvider active>
            <PluginSurfacePlacementHost
                placement={props.placement}
                pluginUiProjection={facts.pluginUiProjection}
                machineId={facts.machineId}
                serverId={facts.serverId}
                platform={facts.platform}
                projectionInteractionEnabled={facts.interactionEnabled}
                binding={props.binding}
                launchInput={props.launchInput}
                mountInstanceKey={props.mountInstanceKey}
                contextualExecutionTarget={contextualTarget}
            />
        </PluginSurfaceFocusEligibilityProvider>
    );
});
