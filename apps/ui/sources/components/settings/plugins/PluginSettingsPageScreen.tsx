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
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
    useScopedPluginSettingsDaemonTargetBinding,
} from '@/sync/domains/machines/administration/scopedPluginSettingsTarget';
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
    // One administration-target owner for every plugin Settings surface. A
    // deep-linked page addresses the same machine the plugin home and detail
    // screens administer, through the same currentness fence, and the selector
    // below names it so the reader can see which machine they are editing.
    const administration = useScopedPluginSettingsDaemonTargetBinding(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins,
    );
    const daemonSettingsTarget = administration.target;
    const isDaemonSettingsTargetCurrent = administration.isTargetCurrent;
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
            {/*
              * The administration target is a different fact from the plugin's
              * execution origin, and a deep link arrives with neither on
              * screen. Name the machine this page's fields, secrets and
              * lifecycle operations address before the fields themselves.
              */}
            <MachineAdministrationTargetSelector
                selection={administration.selection}
                testIDPrefix="settings.plugins.page.administration.target"
            />
            {/*
              * A focused Settings route is this subtree's one semantic current
              * owner, exactly as the App Page route is for its own. Without the
              * second fact the mounted surface stays presentation-eligible but
              * permanently current-context-ineligible, so its published entity
              * and commands never reach the current-context reader or Voice.
              */}
            <PluginSurfaceFocusEligibilityProvider
                active={isFocused}
                currentUiContextActive={isFocused}
            >
                <PluginSettingsPageHost
                    page={destination.page}
                    pluginUiProjection={appShell.pluginUiProjection}
                    machineId={appShell.machineId}
                    serverId={appShell.serverId}
                    daemonSettingsTarget={daemonSettingsTarget}
                    perActiveServerIdentityId={administration.selectedServerIdentityId}
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
