import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import {
    BottomTabView,
    type BottomTabNavigationEventMap,
    type BottomTabNavigationOptions,
    type BottomTabNavigationProp,
    type BottomTabNavigatorProps,
} from '@react-navigation/bottom-tabs';
import {
    createNavigatorFactory,
    TabRouter,
    useNavigationBuilder,
    type NavigatorTypeBagBase,
    type ParamListBase,
    type StaticConfig,
    type TabActionHelpers,
    type TabNavigationState,
    type TabRouterOptions,
    type TypedNavigator,
} from '@react-navigation/native';

import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';

/**
 * A scene the cockpit hosts beside the tab view rather than inside it, so the scene can rise over the focused one
 * (the phone Ask sheet raises Chat over the File page) without leaving its parent: its node, state and draft
 * survive every switch. `Frame` is one stable component whose presentation follows `raised`.
 */
export type SessionCockpitRaisedScene = Readonly<{
    routeName: string;
    raised: boolean;
    Frame: React.ComponentType<React.PropsWithChildren<Readonly<{ raised: boolean }>>>;
}>;

type SessionCockpitTabsProps = BottomTabNavigatorProps & Readonly<{ raisedScene?: SessionCockpitRaisedScene }>;

const renderNothing = (): React.JSX.Element => <React.Fragment />;

function SessionCockpitTabsNavigator({
    id, initialRouteName, backBehavior, UNSTABLE_routeNamesChangeBehavior, children, layout,
    screenListeners, screenOptions, screenLayout, UNSTABLE_router, raisedScene, ...rest
}: SessionCockpitTabsProps) {
    const { state, descriptors, navigation, NavigationContent } = useNavigationBuilder<
        TabNavigationState<ParamListBase>,
        TabRouterOptions,
        TabActionHelpers<ParamListBase>,
        BottomTabNavigationOptions,
        BottomTabNavigationEventMap
    >(TabRouter, {
        id, initialRouteName, backBehavior, UNSTABLE_routeNamesChangeBehavior, children, layout,
        screenListeners, screenOptions, screenLayout, UNSTABLE_router,
    });
    const hostedKey = raisedScene ? state.routes.find((route) => route.name === raisedScene.routeName)?.key : undefined;
    const focused = hostedKey !== undefined && state.routes[state.index]?.key === hostedKey;
    const raised = hostedKey !== undefined && !focused && raisedScene?.raised === true;
    const visible = focused || raised;
    // Lazy like the tab view's own scenes: mounted once first shown (or preloaded), then kept.
    const [hostedLoaded, setHostedLoaded] = React.useState(false);
    const hosted = hostedKey ? descriptors[hostedKey] : undefined;
    if (hosted && !hostedLoaded && (visible || hosted.options.lazy === false || state.preloadedRouteKeys.includes(hostedKey!))) {
        setHostedLoaded(true);
    }
    // The tab view keeps the hosted route (focus, history, Back) but draws nothing for it.
    const tabDescriptors = hostedKey && hosted
        ? { ...descriptors, [hostedKey]: { ...hosted, render: renderNothing } }
        : descriptors;
    const Frame = raisedScene?.Frame;
    return (
        <NavigationContent>
            <View style={styles.root}>
                <BottomTabView {...rest} state={state} navigation={navigation} descriptors={tabDescriptors} />
                {hosted && Frame && hostedLoaded ? (
                    <View
                        style={[StyleSheet.absoluteFill, visible ? null : styles.hidden]}
                        pointerEvents={visible ? 'box-none' : 'none'}
                    >
                        <Frame raised={raised}>
                            {/* Withdraws the scene's presentation before freezing it, so what the scene presented (a
                                sheet portaled out of it) leaves with it instead of staying over the next scene. */}
                            <RetainedPanelSurface isActive={visible} suspendWhenHidden={hosted.options.freezeOnBlur === true}>
                                {hosted.render()}
                            </RetainedPanelSurface>
                        </Frame>
                    </View>
                ) : null}
            </View>
        </NavigationContent>
    );
}

export function createSessionCockpitTabNavigator<
    const ParamList extends ParamListBase,
    const NavigatorID extends string | undefined = string | undefined,
    const TypeBag extends NavigatorTypeBagBase = {
        ParamList: ParamList;
        NavigatorID: NavigatorID;
        State: TabNavigationState<ParamList>;
        ScreenOptions: BottomTabNavigationOptions;
        EventMap: BottomTabNavigationEventMap;
        NavigationList: {
            [RouteName in keyof ParamList]: BottomTabNavigationProp<ParamList, RouteName, NavigatorID>;
        };
        Navigator: typeof SessionCockpitTabsNavigator;
    },
    const Config extends StaticConfig<TypeBag> = StaticConfig<TypeBag>,
>(config?: Config): TypedNavigator<TypeBag, Config> {
    return createNavigatorFactory(SessionCockpitTabsNavigator)(config);
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    hidden: { display: 'none' },
});
