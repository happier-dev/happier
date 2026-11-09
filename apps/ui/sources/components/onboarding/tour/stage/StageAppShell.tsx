import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MainAppTabBar } from '@/components/navigation/mobile/chrome/bars/MainAppTabBar';
import { CockpitTabBarActionView } from '@/components/navigation/mobile/chrome/bars/CockpitTabBar';
import type { TabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { t } from '@/text';
import { AppRail } from '@/components/navigation/shell/appRail/AppRail';
import { APP_RAIL_WIDTH_PX } from '@/components/navigation/shell/appRail/appRailMetrics';
import { AppShellColumn } from '@/components/navigation/shell/appRail/AppShellColumn';
import { builtinAppShellColumn } from '@/components/navigation/shell/appRail/appRailModel';
import { MainView } from '@/components/navigation/shell/MainView';
import { PhoneMainTabShell } from '@/components/navigation/shell/PhoneMainTabLine';
import { DestinationInstanceContext, type DestinationInstanceContextValue } from '@/components/appShell/workspace/destinationInstanceContext';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import type { StageDevice } from './DeviceFrame';
import { stageVisualTokens } from './stageVisualTokens';
import { StagePhoneCaptureContext } from './StagePhoneCaptureContext';

// The demo phone is a static presentation: no navigation is wired, so tab
// presses are inert. The bar is present for real-app fidelity (spec §3), and
// the cockpit beat spotlights it.
function noopTabPress(): void {}
const renderStageMore = (metrics: TabBarMetrics) => (
    <CockpitTabBarActionView testID="demo-stage-tab-more" label={t('common.more')} icon="dots-three" metrics={metrics} onPress={noopTabPress} />
);

const SESSIONS_COLUMN = builtinAppShellColumn('sessions');
// SafeAreaView forwards styles through a third-party component, outside the
// Unistyles View transform. Keep its capture-only containment as plain RN style.
const PHONE_CAPTURE_SAFE_AREA_STYLE = { flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' } as const;
const PHONE_CAPTURE_TOP_EDGE = { top: 'additive', bottom: 'off', left: 'off', right: 'off' } as const;
// The phone list is the app's root destination, not the stage route that hosts it.
const PHONE_ROOT_DESTINATION: DestinationInstanceContextValue = {
    tabId: 'demo-stage-sessions', ref: { kind: 'sessions', params: {} }, pathname: '/',
    focused: true, visible: true, isFocused: () => true,
};

type AppShellStageSurfaceId = 'sessions-list' | 'session-view' | 'home';

export type StageAppShellProps = Readonly<{
    device: StageDevice;
    surface: AppShellStageSurfaceId;
    // Feature beats reuse the real desktop split (sidebar + detail) but swap the
    // detail owner: a different seeded session (review) or a real feature pane
    // (voice). The detail is always supplied by the surface loader so this shell
    // never drags the session cockpit's import graph into a list-only beat.
    detail: React.ReactNode;
    detailTestID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        backgroundColor: theme.colors.background.canvas,
        flex: 1,
        flexDirection: 'row',
        minHeight: 0,
        minWidth: 0,
    },
    sidebar: {
        flexShrink: 0,
        minHeight: 0,
        overflow: 'hidden',
        width: stageVisualTokens.appShell.sidebarWidth,
    },
    rail: {
        width: APP_RAIL_WIDTH_PX,
        flexShrink: 0,
    },
    detail: {
        borderLeftColor: theme.colors.border.default,
        borderLeftWidth: StyleSheet.hairlineWidth,
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
    },
    phone: {
        backgroundColor: theme.colors.surface.base,
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        position: 'relative',
    },
    phoneTabBar: {
        flexShrink: 0,
    },
}));

/**
 * The stage reuses the real app shell (rail and Sessions column) and session-detail owners. It only
 * composes them into the desktop split that normally surrounds those screens.
 */
export function StageAppShell(props: StageAppShellProps): React.ReactElement {
    const router = useRouter();
    const phoneCapture = React.useContext(StagePhoneCaptureContext);
    const phoneRootDestination = React.useMemo(() => ({ ...PHONE_ROOT_DESTINATION, navigation: router }), [router]);
    const styles = stylesheet;

    if (props.device === 'phone') {
        return (
            <View testID={`demo-stage-app-shell-phone-${props.surface}`} style={styles.phone}>
                <View style={styles.detail}>
                    {props.surface === 'sessions-list' ? <DestinationInstanceContext.Provider value={phoneRootDestination}>
                        <MainView variant="phone" />
                    </DestinationInstanceContext.Provider> : phoneCapture && props.surface === 'home' ? (
                        <SafeAreaView edges={PHONE_CAPTURE_TOP_EDGE} style={PHONE_CAPTURE_SAFE_AREA_STYLE}>
                            <PhoneMainTabShell>{props.detail}</PhoneMainTabShell>
                        </SafeAreaView>
                    ) : props.detail}
                </View>
                {props.surface === 'session-view' ? null : <View testID="demo-stage-phone-tab-bar" pointerEvents="none" style={styles.phoneTabBar}>
                    <MainAppTabBar activeTab="sessions" onTabPress={noopTabPress} more={renderStageMore} />
                </View>}
            </View>
        );
    }

    return (
        <View testID="demo-stage-app-shell" style={styles.root}>
            <View style={styles.rail}><AppRail /></View>
            {props.surface === 'home' ? null : <View testID="demo-stage-app-shell-sidebar" style={styles.sidebar}>
                <AppShellColumn column={SESSIONS_COLUMN} />
            </View>}
            <View testID={props.detailTestID ?? 'demo-stage-app-shell-detail'} style={styles.detail}>
                {props.detail}
            </View>
        </View>
    );
}
