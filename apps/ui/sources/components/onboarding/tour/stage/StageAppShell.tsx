import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MainAppTabBar } from '@/components/navigation/mobile/chrome/bars/MainAppTabBar';
import { CockpitTabBarActionView } from '@/components/navigation/mobile/chrome/bars/CockpitTabBar';
import type { TabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { t } from '@/text';
import { AppRail } from '@/components/navigation/shell/appRail/AppRail';
import { AppShellColumn } from '@/components/navigation/shell/appRail/AppShellColumn';
import { builtinAppShellColumn } from '@/components/navigation/shell/appRail/appRailModel';

import type { StageDevice } from './DeviceFrame';
import { stageVisualTokens } from './stageVisualTokens';

// The demo phone is a static presentation: no navigation is wired, so tab
// presses are inert. The bar is present for real-app fidelity (spec §3), and
// the cockpit beat spotlights it.
function noopTabPress(): void {}
const renderStageMore = (metrics: TabBarMetrics) => (
    <CockpitTabBarActionView testID="demo-stage-tab-more" label={t('common.more')} icon="dots-three" metrics={metrics} onPress={noopTabPress} />
);

const SESSIONS_COLUMN = builtinAppShellColumn('sessions');

type AppShellStageSurfaceId = 'sessions-list' | 'session-view';

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
    detail: {
        borderLeftColor: theme.colors.border.default,
        borderLeftWidth: StyleSheet.hairlineWidth,
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
    },
    phone: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        position: 'relative',
    },
    phoneTabBar: {
        bottom: 0,
        left: 0,
        position: 'absolute',
        right: 0,
    },
}));

/**
 * The stage reuses the real app shell (rail and Sessions column) and session-detail owners. It only
 * composes them into the desktop split that normally surrounds those screens.
 */
export function StageAppShell(props: StageAppShellProps): React.ReactElement {
    const styles = stylesheet;

    if (props.device === 'phone') {
        return (
            <View testID={`demo-stage-app-shell-phone-${props.surface}`} style={styles.phone}>
                {props.surface === 'session-view' ? (
                    props.detail
                ) : (
                    <AppShellColumn column={SESSIONS_COLUMN} />
                )}
                <View testID="demo-stage-phone-tab-bar" pointerEvents="none" style={styles.phoneTabBar}>
                    <MainAppTabBar activeTab="sessions" onTabPress={noopTabPress} more={renderStageMore} />
                </View>
            </View>
        );
    }

    return (
        <View testID="demo-stage-app-shell" style={styles.root}>
            <AppRail />
            <View testID="demo-stage-app-shell-sidebar" style={styles.sidebar}>
                <AppShellColumn column={SESSIONS_COLUMN} />
            </View>
            <View testID={props.detailTestID ?? 'demo-stage-app-shell-detail'} style={styles.detail}>
                {props.detail}
            </View>
        </View>
    );
}
