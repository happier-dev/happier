import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CockpitTabBar, type CockpitTabBarTabDefinition } from '@/components/navigation/mobile/chrome/bars/CockpitTabBar';
import { SessionSwitcherPanel, SessionSwitcherStayPill } from '@/components/navigation/mobile/chrome/lateralSwipe/SessionSwitcherPanel';
import { layoutSessionSwitcherPanel, SESSION_SWITCHER_DOCKED_HEADER_HEIGHT } from '@/components/navigation/mobile/chrome/lateralSwipe/sessionSwitcherPanelLayout';
import { resolveSessionSwitcherContentMotion } from '@/components/navigation/mobile/chrome/lateralSwipe/sessionSwitcherMotion';
import type { SessionSwitcherRow } from '@/components/navigation/mobile/chrome/lateralSwipe/sessionSwitcherRows';
import type { SessionSwitcherMode } from '@/components/navigation/mobile/chrome/lateralSwipe/useSessionSwitcher';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * Dev-only: the phone session switcher (lab `phone-nav2`, frames G, W, D) frozen mid-gesture on the
 * lab's sessions and tabs, so the build can be paired against the lab on web, where the bar's
 * native gestures do not run. The real panel, rows, layout and bar render at static shared values.
 */

type Frame = 'ghost' | 'lock' | 'scrub' | 'side' | 'sideEnd' | 'dock';

const NOW = Date.now();

function session(key: string, title: string, agentId: string, extra: Partial<SessionSwitcherRow> = {}): SessionSwitcherRow {
    return {
        key, section: 'recent', target: { kind: 'session', sessionId: key, serverId: 'specimen', tabId: null },
        title, agentId, machineId: null, serverId: 'specimen', icon: null, status: null, timeLabel: '', excerpt: null,
        draft: null, unavailable: false, ...extra,
    };
}

function tabRow(key: string, title: string, icon: SessionSwitcherRow['icon'], extra: Partial<SessionSwitcherRow> = {}): SessionSwitcherRow {
    return {
        key, section: 'openTabs', target: { kind: 'tab', tabId: key }, title, agentId: null, machineId: null, serverId: null,
        icon, status: null, timeLabel: '', excerpt: null, draft: null, unavailable: false, ...extra,
    };
}

const CURRENT = session('fix', 'Fix settings modal remount', 'claude', { status: { text: 'Working', tone: 'working' } });

/** Drag up, Recent: open tabs (most recent first), then this phone's recents. */
const UP_ROWS: readonly SessionSwitcherRow[] = [
    { ...session('review', 'Review #2481', 'codex', {
        status: { text: 'Needs you · wants to run yarn test:e2e', tone: 'attention' }, timeLabel: '4 min',
        excerpt: 'I’d like to run the end-to-end suite before approving. It takes about six minutes.',
    }), section: 'openTabs', target: { kind: 'session', sessionId: 'review', serverId: 'specimen', tabId: 'review' } },
    tabRow('prs', 'PRs & Issues', 'git-pull-request', { status: { text: '4 new since this morning', tone: 'quiet' } }),
    tabRow('pr2502', '#2502 Key the settings modal by route', 'git-pull-request', { status: { text: '1 failing check', tone: 'failed' } }),
    tabRow('board', 'Release board', 'squares-four', { status: { text: '3 in progress', tone: 'quiet' }, excerpt: 'Ship 0.3 · 3 in progress, 2 waiting for review.' }),
    tabRow('term', 'zsh · Studio', 'terminal', { unavailable: true, status: { text: 'Studio is offline', tone: 'offline' } }),
    tabRow('appearance', 'Appearance', 'palette', { status: { text: 'Theme, text size, tab bar', tone: 'quiet' } }),
    session('relay', 'Relay retries spike', 'claude', { timeLabel: '40 min', draft: 'Also check whether the retry budget resets on reconnect' }),
    session('nightly', 'Nightly release · run 214', 'codex', { status: { text: 'Failed at Publish · 07:12', tone: 'failed' }, timeLabel: '07:12' }),
    session('docs', 'Docs search index', 'claude', {
        status: { text: 'Studio is offline · last seen 09:12', tone: 'offline' }, timeLabel: 'Yesterday',
        excerpt: 'The index rebuild finished; 1,284 pages, 3 skipped for missing front matter.',
    }),
    session('acme', 'Acme onboarding copy', 'claude', { status: { text: 'Working · 6 min', tone: 'working' }, timeLabel: '6 min' }),
];

/** Sideways, Session list: the next ones down the list. */
const NEXT_ROWS: readonly SessionSwitcherRow[] = [
    { ...UP_ROWS[8]!, section: 'list' },
    { ...session('wal', 'Spike: SQLite WAL size', 'claude', { status: { text: 'Done · yesterday', tone: 'quiet' }, timeLabel: 'Yesterday' }), section: 'list' },
];

const TABS: readonly CockpitTabBarTabDefinition<string>[] = [
    { id: 'chat', label: 'Chat', icon: { render: ({ size }) => <SessionAgentCatalogIdentityIcon agentId="claude" machineId={null} serverId={null} size={size} /> } },
    { id: 'files', label: 'Files', icon: 'folder' },
    { id: 'git', label: 'Git', icon: 'git-branch', badge: { kind: 'count', value: 14 } },
    { id: 'companion', label: 'Companion', icon: 'stack-simple', badge: { kind: 'attention' } },
    { id: 'terminal', label: 'Terminal', icon: 'terminal' },
];

const FRAMES: Readonly<Record<Frame, { mode: SessionSwitcherMode; docked: boolean; ghost: number; index: number; rows: readonly SessionSwitcherRow[] }>> = {
    ghost: { mode: 'up', docked: false, ghost: 0.55, index: 0, rows: UP_ROWS },
    lock: { mode: 'up', docked: false, ghost: 1, index: 0, rows: UP_ROWS },
    scrub: { mode: 'up', docked: false, ghost: 1, index: 3, rows: UP_ROWS },
    side: { mode: 'next', docked: false, ghost: 1, index: 0, rows: NEXT_ROWS },
    sideEnd: { mode: 'previous', docked: false, ghost: 1, index: -1, rows: [] },
    dock: { mode: 'up', docked: true, ghost: 1, index: -1, rows: UP_ROWS },
};

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
        overflow: 'hidden',
    },
    session: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        paddingTop: 64,
        paddingHorizontal: 18,
        gap: 18,
        backgroundColor: theme.colors.surface.base,
    },
    title: { fontSize: 17, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    message: { fontSize: 15, lineHeight: 21, color: theme.colors.text.primary, ...Typography.default() },
    scrim: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: theme.colors.overlay.scrimSoft },
    band: { position: 'absolute', left: 0, right: 0, bottom: 0 },
    panelSlot: { position: 'absolute', left: 12, right: 12, bottom: '100%', marginBottom: theme.space.s8 },
    stay: { position: 'absolute', left: 16, right: 16, top: 4, bottom: 8 },
}));

export function PhoneSwitcherSpecimen(props: Readonly<{ frame: string | null }>): React.ReactElement {
    const { theme } = useUnistyles();
    const window = useWindowDimensions();
    const frame = FRAMES[(props.frame as Frame) in FRAMES ? props.frame as Frame : 'scrub'];
    const lift = frame.mode === 'up' && !frame.docked ? Math.min(1, frame.ghost) * 120 * 0.6 : 0;
    const ghost = useSharedValue(frame.ghost);
    const liftValue = useSharedValue(lift);
    const index = useSharedValue(frame.index);
    const scroll = useSharedValue(0);
    const layout = React.useMemo(() => layoutSessionSwitcherPanel({
        mode: frame.mode, rows: frame.rows, current: CURRENT, source: frame.mode === 'up' ? 'recent' : 'list', syncOn: true,
    }), [frame]);
    const room = window.height - 44 - 90 - 8 - (frame.mode === 'up' && !frame.docked ? 72 : 0) - 132;
    const viewportHeight = Math.max(Math.min(200, layout.contentHeight), Math.min(layout.contentHeight + (frame.docked ? SESSION_SWITCHER_DOCKED_HEADER_HEIGHT : 0), room));
    const selected = frame.index >= 0 ? frame.rows[frame.index] ?? null : null;
    const recede = resolveSessionSwitcherContentMotion(frame.ghost, false);
    const sessionStyle = useAnimatedStyle(() => ({ transform: [{ translateY: recede.translateY }, { scale: recede.scale }] }));
    return (
        <View style={styles.root} testID="phone-switcher-specimen">
            <Animated.View style={[styles.session, sessionStyle]}>
                <Text style={styles.title}>{CURRENT.title}</Text>
                <Text style={styles.message}>The settings modal flickers when the window resizes. Find out why and fix it.</Text>
                <Text style={[styles.message, { color: theme.colors.text.secondary }]}>It remounts because SettingsModal’s key includes the window width, so every resize throws the form state away.</Text>
            </Animated.View>
            <View style={[styles.scrim, { opacity: frame.ghost }]} />
            <View style={styles.band}>
                <View pointerEvents="box-none" style={styles.panelSlot}>
                    <SessionSwitcherPanel
                        mode={frame.mode}
                        docked={frame.docked}
                        layout={layout}
                        viewportHeight={viewportHeight}
                        selected={frame.ghost >= 1 ? selected : null}
                        ghost={ghost}
                        lift={liftValue}
                        index={index}
                        scroll={scroll}
                        reducedMotion={false}
                        onOpenRow={() => {}}
                        onAllSessions={() => {}}
                    />
                </View>
                <View style={{ transform: [{ translateY: -lift }] }}>
                    <CockpitTabBar
                        activeSurface="chat"
                        barTestId="phone-switcher-specimen-bar"
                        tabs={TABS}
                        tabTestIdPrefix="phone-switcher-specimen-tab-"
                        onSurfacePress={() => {}}
                    />
                    {frame.mode === 'up' && !frame.docked && frame.ghost >= 1 ? (
                        <View style={styles.stay}><SessionSwitcherStayPill title={CURRENT.title} /></View>
                    ) : null}
                </View>
            </View>
        </View>
    );
}
