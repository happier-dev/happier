import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MainAppTabBar } from '@/components/navigation/mobile/chrome/bars/MainAppTabBar';
import { SidebarView } from '@/components/navigation/shell/SidebarView';
import { SessionView } from '@/components/sessions/shell/SessionView';
import { DEMO_RICH_SESSION_ID } from '@/demoMode/world/buildDemoWorld';

import type { StageDevice } from './DeviceFrame';
import { stageVisualTokens } from './stageVisualTokens';

// The demo phone is a static presentation: no navigation is wired, so tab
// presses are inert. The bar is present for real-app fidelity (spec §3), and
// the cockpit beat spotlights it.
function noopTabPress(): void {}

type AppShellStageSurfaceId = 'sessions-list' | 'session-view';

export type StageAppShellProps = Readonly<{
    device: StageDevice;
    surface: AppShellStageSurfaceId;
    // Feature beats reuse the real desktop split (sidebar + detail) but swap the
    // detail owner: a different seeded session (review) or a real feature pane
    // (voice). Defaults preserve the canonical rich-session cockpit exactly.
    sessionId?: string;
    detail?: React.ReactNode;
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

function RichSessionDetail(props: Readonly<{ sessionId?: string }>): React.ReactElement {
    return (
        <SessionView
            id={props.sessionId ?? DEMO_RICH_SESSION_ID}
            surfaceFocusedOverride
            surfaceVisibleOverride
            routeAnchorOverride
            safeAreaTopMode="external"
            headerSafeAreaTopMode="external"
            chatBottomSpacing="none"
        />
    );
}

/**
 * The stage reuses the real sidebar/list and session-detail owners. It only
 * composes them into the desktop split that normally surrounds those screens.
 */
export function StageAppShell(props: StageAppShellProps): React.ReactElement {
    const styles = stylesheet;
    const detail = props.detail ?? <RichSessionDetail sessionId={props.sessionId} />;

    if (props.device === 'phone') {
        return (
            <View testID={`demo-stage-app-shell-phone-${props.surface}`} style={styles.phone}>
                {props.surface === 'session-view' ? (
                    detail
                ) : (
                    <SidebarView desktopWindowControls={null} desktopUpdateIndicator={null} />
                )}
                <View testID="demo-stage-phone-tab-bar" pointerEvents="none" style={styles.phoneTabBar}>
                    <MainAppTabBar activeTab="sessions" onTabPress={noopTabPress} />
                </View>
            </View>
        );
    }

    return (
        <View testID="demo-stage-app-shell" style={styles.root}>
            <View testID="demo-stage-app-shell-sidebar" style={styles.sidebar}>
                <SidebarView
                    sidebarWidthPx={stageVisualTokens.appShell.sidebarWidth}
                    desktopWindowControls={null}
                    desktopUpdateIndicator={null}
                />
            </View>
            <View testID={props.detailTestID ?? 'demo-stage-app-shell-detail'} style={styles.detail}>
                {detail}
            </View>
        </View>
    );
}
