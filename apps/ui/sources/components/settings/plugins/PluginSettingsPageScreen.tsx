import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import { Stack, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginSettingsPageHost } from '@/components/plugins/surfaces';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import type { ScopedPluginSettingsDaemonTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import {
    resolveAdmittedPluginSettingsPage,
    type ResolvedPluginSettingsPageDestination,
} from '@/components/settings/catalog/runtime/pluginSettingsPageCatalog';
import { getPreferredLanguage, t } from '@/text';
import { buildPluginDetailRoute } from '@/components/settings/plugins/model/pluginDetailRoute';

export const PluginSettingsPageScreen = React.memo(function PluginSettingsPageScreen(props: Readonly<{
    pluginId: string | null;
    pageId: string | null;
}>): React.ReactElement {
    const isFocused = useIsFocused();
    const { theme } = useUnistyles();
    const router = useRouter();
    const appShell = useAppShellPluginUiProjection();
    const daemonTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins,
    );
    const daemonExecutionTarget = daemonTargetSelection.resolveExecutionTarget();
    const daemonSettingsTarget = React.useMemo<ScopedPluginSettingsDaemonTarget | null>(() => {
        if (!daemonExecutionTarget) return null;
        return Object.freeze({
            kind: 'daemon',
            serverIdentityId: daemonExecutionTarget.target.serverIdentityId,
            machineId: daemonExecutionTarget.machine.id,
            serverId: daemonExecutionTarget.serverId,
        });
    }, [
        daemonExecutionTarget?.machine.id,
        daemonExecutionTarget?.serverId,
        daemonExecutionTarget?.target.serverIdentityId,
    ]);
    const isDaemonSettingsTargetCurrent = React.useCallback((target: ScopedPluginSettingsDaemonTarget): boolean => {
        const current = daemonTargetSelection.resolveExecutionTarget();
        return current !== null
            && daemonExecutionTarget !== null
            && current.target.serverIdentityId === daemonExecutionTarget.target.serverIdentityId
            && current.machine.id === daemonExecutionTarget.machine.id
            && current.serverId === daemonExecutionTarget.serverId
            && current.machine.daemonStateVersion === daemonExecutionTarget.machine.daemonStateVersion
            && target.serverIdentityId === daemonExecutionTarget.target.serverIdentityId
            && target.machineId === daemonExecutionTarget.machine.id
            && target.serverId === daemonExecutionTarget.serverId;
    }, [daemonExecutionTarget, daemonTargetSelection]);
    const locale = getPreferredLanguage();
    const appTargetBinding = usePluginSurfaceDestinationNavigationBinding();
    const binding = React.useMemo<BoundPluginSurfaceBinding>(
        () => appTargetBinding ? { openSurface: appTargetBinding.openSurface } : {},
        [appTargetBinding],
    );
    const destination = React.useMemo<ResolvedPluginSettingsPageDestination | null>(() => (
        props.pluginId && props.pageId
            ? resolveAdmittedPluginSettingsPage({
                projection: appShell.pluginUiProjection,
                pluginId: props.pluginId,
                pageId: props.pageId,
                locale,
            })
            : null
    ), [appShell.pluginUiProjection, locale, props.pageId, props.pluginId]);
    const recoveryAction = React.useMemo(() => {
        const pluginId = props.pluginId;
        return pluginId
            ? {
                label: t('settingsPlugins.managePlugin'),
                onPress: () => { router.push(buildPluginDetailRoute(pluginId)); },
            }
            : undefined;
    }, [props.pluginId, router]);

    if (
        props.pluginId
        && props.pageId
        && !destination
        && appShell.phase === 'establishing'
    ) {
        return (
            <>
                <Stack.Screen options={{}} />
                <PaneLoadingFallback color={theme.colors.text.secondary} />
            </>
        );
    }

    if (!destination) {
        // A removed, malformed, or stale page remains at its own
        // generic route. It is never redirected to a different plugin/page.
        return <PluginSurfaceFallback testID="plugin-settings-page-unavailable" action={recoveryAction} />;
    }

    if (destination.page.availability.state !== 'available') {
        return (
            <>
                <Stack.Screen options={{ title: destination.title }} />
                <PluginSurfaceFallback
                    testID="plugin-settings-page-unavailable"
                    reasonCode={destination.page.availability.reason}
                    action={recoveryAction}
                />
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: destination.title }} />
            <PluginSurfaceFocusEligibilityProvider active={isFocused}>
                <PluginSettingsPageHost
                    page={destination.page}
                    pluginUiProjection={appShell.pluginUiProjection}
                    machineId={appShell.machineId}
                    serverId={appShell.serverId}
                    daemonSettingsTarget={daemonSettingsTarget}
                    isDaemonSettingsTargetCurrent={isDaemonSettingsTargetCurrent}
                    settingsScopesEnabled={{ account: true, daemon: daemonSettingsTarget !== null }}
                    binding={binding}
                    unavailableAction={recoveryAction}
                    platform={appShell.platform}
                    projectionInteractionEnabled={appShell.phase === 'current'
                        && appShell.interactionEnabled}
                />
            </PluginSurfaceFocusEligibilityProvider>
        </>
    );
});
