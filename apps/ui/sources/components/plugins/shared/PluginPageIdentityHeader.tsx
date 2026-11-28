import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS, HAPPIER_SEARCH_FIELD_METRICS } from '@happier-dev/plugin-ui/presentation';

import { useClaimedStackHeaderActions } from '@/components/navigation/stackHeaderActions';
import { Text } from '@/components/ui/text/Text';
import { useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { DetailsPaneSlotHost, useDetailsPaneSlotBinding } from '@/components/appShell/panes/details/DetailsPaneSlot';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { PageHeader } from '@/components/ui/layout/PageHeader';

import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';

import { PluginSurfacePageHeaderContext, type PluginSurfacePageIdentity } from './pluginSurfaceInteractionAvailability';

// The App page and its loading frame use the same sheet gutter.
export const pluginPageContentFrameStyle = {
    flex: 1,
    width: '100%',
    paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(),
} as const;

/** Reserve the App page toolbar while its declaration and title are still loading. */
export function PluginAppPageLoadingFrame(props: Readonly<{ testID: string; entryDetail?: boolean }>): React.ReactElement {
    const slot = useDetailsPaneSlotBinding();
    const beside = useDetailsPaneAvailable();
    const frame = <View style={pluginPageContentFrameStyle}>
        <PluginSurfacePageHeaderContext.Provider value={{
            header: <PluginPageIdentityToolbarRow testID={`${props.testID}-toolbar`} entryDetail={props.entryDetail} />,
            loadingFrame: props.entryDetail ? 'collection-detail' : 'collection',
        }}>
            <PluginSurfaceFallback testID={props.testID} state="loading" />
        </PluginSurfacePageHeaderContext.Provider>
    </View>;
    // The chunk and workspace-hydration fallbacks run before the page has installed its slot.
    return props.entryDetail && beside && slot === null ? <DetailsPaneSlotHost>{frame}</DetailsPaneSlotHost> : frame;
}

/**
 * A plugin page route's identity (its title and the package's mark, with the route's own controls such
 * as Run on) for the moment its surface has loaded nothing: a live page draws its own header, a page
 * that never loaded keeps this one above its cold state (`PluginSurfaceInteractionBoundary`).
 */
export function PluginPageIdentityHeaderProvider(props: Readonly<{
    pluginId: string;
    title: string;
    description?: string;
    /** The header the loaded page draws (`PluginAppPage.headerStyle`); the identity is said the same way. */
    headerStyle?: 'toolbar';
    /**
     * The navigation leaves the page's name to its large title (a phone's toolbar page, `PluginPageContent`): the
     * identity is that large title, where the loaded Collection draws it.
     */
    largeTitle?: boolean;
    entryDetail?: boolean;
    /**
     * `host`: the page is a tab of a host page whose own header already names it (a Machine page), so a page that
     * has not loaded draws no second identity above its state. Default `page`.
     */
    identityOwner?: 'page' | 'host';
    children: React.ReactNode;
}>): React.ReactElement {
    const app = useAppShellPluginUiProjection(value => ({
        machineId: value.machineId,
        serverId: value.serverId,
        installedPackage: value.pluginUiProjection?.installedPackagesById[props.pluginId] ?? null,
    }));
    // Where navigation chrome already shows the title (a phone) the page header is the one identity, as for every page.
    const chromeShowsTitle = useNavigationTitleChromeShowsTitle();
    const installedPackage = app.installedPackage;
    const identity = React.useMemo<PluginSurfacePageIdentity | null>(() => {
        if (props.identityOwner === 'host') return null;
        const entryLoading = props.entryDetail ? {
            loadingFrame: 'collection-detail' as const,
            loadingHeader: <PluginPageIdentityToolbarRow testID={`plugin-page-identity-toolbar:${props.pluginId}`} title={props.title} entryDetail />,
        } : {};
        if (props.largeTitle === true) {
            return {
                header: <PageHeader testID={`plugin-page-identity-large-title:${props.pluginId}`} title={props.title} alwaysShowTitle />,
                loadingFrame: 'collection',
                ...entryLoading,
            };
        }
        if (props.headerStyle === 'toolbar' && !chromeShowsTitle) {
            return { header: <PluginPageIdentityToolbarRow testID={`plugin-page-identity-toolbar:${props.pluginId}`} title={props.title} />,
                loadingFrame: 'collection', ...entryLoading };
        }
        return {
            header: (
                <PageHeader
                    testID={`plugin-page-identity-header:${props.pluginId}`}
                    title={props.title}
                    description={props.description}
                    // The route's Run on chip arrives with the plugin, after this header: the title line already
                    // holds its height, so the loaded header carries the same title in the same place.
                    leading={<PluginMark title={props.title} pluginId={props.pluginId} size="page"
                        installedPackage={installedPackage} machineId={app.machineId} serverId={app.serverId} />}
                />
            ),
            loadingFrame: 'column',
            ...entryLoading,
        };
    }, [app.machineId, app.serverId, chromeShowsTitle, installedPackage, props.description, props.headerStyle, props.identityOwner, props.entryDetail, props.largeTitle, props.pluginId, props.title]);
    return <PluginSurfacePageHeaderContext.Provider value={identity}>{props.children}</PluginSurfacePageHeaderContext.Provider>;
}

/**
 * A page that draws a Collection toolbar as its own header leads that row with its name, and the route's controls
 * (Run on) trail it. Its identity is that row, in that place, while the page loads, so the title keeps its size and
 * position when the surface arrives, and its loading frame is the Collection's own (the full content area, not the
 * page column).
 */
function PluginPageIdentityToolbarRow(props: Readonly<{ testID: string; title?: string; entryDetail?: boolean }>): React.ReactElement {
    // The toolbar owns the route's header slot even while the catalog has neither a title nor controls.
    const routeActions = useClaimedStackHeaderActions();
    return (
        <View testID={props.testID} style={[stylesheet.toolbar, props.entryDetail && stylesheet.entryToolbar]}>
            {props.title === undefined ? null : (
                <Text variant="heading" accessibilityRole="header" numberOfLines={1} style={stylesheet.title}>{props.title}</Text>
            )}
            {routeActions}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s8,
        minHeight: HAPPIER_SEARCH_FIELD_METRICS.heightPx,
        // The same top space the loaded Collection page opens with (plugin-ui `Collection`), so the title stays put.
        marginTop: HAPPIER_PAGE_METRICS.pageHeaderUnderChromePaddingTopPx,
    },
    entryToolbar: { marginTop: 0 },
    title: {
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.text.primary,
    },
}));
