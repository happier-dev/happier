import * as React from 'react';
import { Stack, usePathname } from '@/components/appShell/workspace/destinationRoute';
import { View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierListDetailLayout, useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';

import {
    getSettingsStackScreenDefinitions,
    type SettingsNestedNavigator,
} from '@/components/settings/navigation/settingsRouteRegistry';
import { SettingsFloatingControlsHost } from '@/components/settings/shell/SettingsModalFloatingControls';
import { getPreferredLanguage, t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

export type SettingsCollectionLayoutProps = Readonly<{
    navigator: SettingsNestedNavigator;
    /** The collection's own route (`/settings/machines`): the back control of its details stops here. */
    rootPathname: string;
    /** The nested stack screen (registry name) shown at `pathname`, so the phone header follows it. */
    resolveChildRoute: (pathname: string) => string;
    /**
     * The collection's rail; rendered only beside a detail. `null` for a page that is itself the
     * collection's list (People before a person is open): no rail column is reserved then.
     */
    rail: React.ReactNode;
    /** Rail width at normal text scale. */
    railWidthPx: number;
    /** The narrowest detail that still fits the collection's widest row beside its label. */
    detailMinWidthPx: number;
    /** Test id prefix: `<testID>-layout`, `-list-pane`, `-detail-pane`. */
    testID: string;
    /** Content above every detail (a banner about the whole collection). */
    detailTop?: React.ReactNode;
    /** Collection identity above both panes on desktop; phone list pages retain their own header. */
    collectionHeader?: React.ReactNode;
}>;

/**
 * A settings collection beside its selected detail: the Collection's `split` geometry with the
 * expo-router nested Stack as its detail (the `push` composition on narrow screens). Wide: the rail
 * beside the nested detail stack. Narrow: the detail stack alone, whose index page lists the
 * collection and pushes each detail. The detail stack stays mounted across the change, so an open
 * detail keeps its editor state. The layout mode is the split geometry's own; pages inside read it
 * with `useHappierCollectionLayout`.
 */
export const SettingsCollectionLayout = React.memo(function SettingsCollectionLayout(props: SettingsCollectionLayoutProps) {
    const pathname = usePathname().replace(/\/+$/, '');
    const { theme } = useUnistyles();
    const { fontScale } = useWindowDimensions();
    const isModalPresentation = useDeviceType() !== 'phone';
    const preferredLanguage = getPreferredLanguage();
    const routes = React.useMemo(() => getSettingsStackScreenDefinitions(t, {
        navigator: props.navigator, isModalPresentation,
    }), [isModalPresentation, preferredLanguage, props.navigator]);
    const currentRoute = props.resolveChildRoute(pathname);
    const scale = Math.max(1, fontScale);
    const hasRail = props.rail !== null && props.rail !== undefined;

    return <>
        {/* One phone header stays above both panes and follows the active child route. */}
        <Stack.Screen options={routes.find((route) => route.name === currentRoute)?.options} />
        <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base }}>
            {isModalPresentation ? props.collectionHeader : null}
            <HappierListDetailLayout
                testID={`${props.testID}-layout`}
                listTestID={`${props.testID}-list-pane`}
                detailTestID={`${props.testID}-detail-pane`}
                minListWidth={hasRail ? props.railWidthPx * scale : 0}
                minDetailWidth={props.detailMinWidthPx * scale}
                // The rail keeps its own width; every extra pixel goes to the detail.
                preferredListRatio={0}
                gap={0}
                listStyle={hasRail ? { borderRightWidth: 1, borderRightColor: theme.colors.border.default } : undefined}
                // The rail exists only beside a detail; when stacked, the index page lists the collection instead.
                list={(layout) => (layout?.mode === 'split' ? props.rail : null)}
                detailActive
                // Narrow screens show the detail stack only: its index page is the list.
                stackedPane="detail"
                detail={<View style={{ flex: 1, minHeight: 0 }}>
                    {props.detailTop}
                    <CollectionDetailControlsHost enabled={isModalPresentation} rootPathname={props.rootPathname}>
                        <Stack screenOptions={{ headerShown: false }}>
                            {routes.map((route) => <Stack.Screen key={route.name} name={route.name} />)}
                        </Stack>
                    </CollectionDetailControlsHost>
                </View>}
            />
        </View>
    </>;
});

/** Beside the rail, the settings back control belongs to the detail pane, never over the rail. */
const CollectionDetailControlsHost = React.memo(function CollectionDetailControlsHost(props: Readonly<{
    enabled: boolean;
    rootPathname: string;
    children: React.ReactNode;
}>) {
    const split = useHappierCollectionLayout()?.mode === 'split';
    return (
        <SettingsFloatingControlsHost enabled={props.enabled && split} collectionRootPathname={props.rootPathname}>
            {props.children}
        </SettingsFloatingControlsHost>
    );
});
