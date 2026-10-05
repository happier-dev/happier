import { Stack, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import type { SessionSwitcherRow } from '@/components/navigation/mobile/chrome/lateralSwipe/sessionSwitcherRows';
import { SessionHeaderPullHint } from '@/components/sessions/shell/SessionHeaderPull';
import { SessionAllTabsOverviewBody, SessionAllTabsPageView } from '@/components/sessions/shell/SessionAllTabsOverview';
import { buildSessionAllTabsSections } from '@/components/sessions/shell/useSessionAllTabsOpener';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import { resolveSessionHeaderPullFrame, SESSION_HEADER_PULL_ARM_PX, SESSION_HEADER_PULL_OPEN_PX } from '@/components/sessions/shell/sessionHeaderPullGesture';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';

/**
 * Dev-only: All tabs (lab phone-nav2 frame P) with the lab's data, so the build pairs against the lab
 * without a live account. `?frame=pull` freezes the header mid-pull (ready); default renders the real
 * All tabs page (as `/all-tabs` shows it); `?inline=1` renders only its body.
 */

const SERVER = 'dev-fixture';

function session(id: string, section: SessionSwitcherRow['section'], title: string, agentId: string, extra: Partial<SessionSwitcherRow> = {}, tabId: string | null = null): SessionSwitcherRow {
    return {
        key: tabId ? `tab:${tabId}` : buildServerScopedSessionKey(id, SERVER),
        section,
        target: { kind: 'session', sessionId: id, serverId: SERVER, tabId },
        title,
        agentId,
        machineId: null,
        serverId: SERVER,
        icon: null,
        status: null,
        timeLabel: '',
        excerpt: null,
        draft: null,
        unavailable: false,
        ...extra,
    };
}

function tab(tabId: string, title: string, icon: SessionSwitcherRow['icon'], extra: Partial<SessionSwitcherRow> = {}): SessionSwitcherRow {
    return {
        key: `tab:${tabId}`, section: 'openTabs', target: { kind: 'tab', tabId }, title, agentId: null, machineId: null,
        serverId: null, icon, status: null, timeLabel: '', excerpt: null, draft: null, unavailable: false, ...extra,
    };
}

const ROWS: readonly SessionSwitcherRow[] = [
    session('fix', 'openTabs', 'Fix settings modal remount', 'claude', {
        status: { text: 'Working · 2 min', tone: 'working' },
        excerpt: 'Fixed. The modal keeps its scroll position and draft while the window resizes.',
    }, 'fix-tab'),
    tab('prs', 'PRs & Issues', 'git-pull-request', { status: { text: 'Triage', tone: 'quiet' } }),
    session('review', 'openTabs', 'Review #2481', 'codex', {
        status: { text: 'Needs you · wants to run yarn test:e2e', tone: 'attention' },
        excerpt: 'Before I approve: may I run the end-to-end suite? It takes about 6 minutes on MacBook Pro.',
    }, 'review-tab'),
    tab('pr2502', '#2502 Key the settings modal by route', 'git-pull-request', { status: { text: 'Triage', tone: 'quiet' } }),
    tab('board', 'Release board', 'squares-four', { status: { text: 'Boards', tone: 'quiet' } }),
    tab('term', 'zsh · Studio', 'terminal', { unavailable: true, status: { text: 'Not available on this phone', tone: 'offline' } }),
    tab('appearance', 'Appearance', 'palette', { status: { text: 'Settings', tone: 'quiet' } }),
    session('relay', 'recent', 'Relay retries spike', 'claude', {
        timeLabel: '40m',
        draft: 'Also check whether the 502s line up with the deploy',
        excerpt: 'The spike starts at 14:02, right after the relay deploy.',
    }),
    session('docs', 'recent', 'Docs search index', 'claude', {
        status: { text: 'Studio is offline', tone: 'offline' },
        excerpt: 'The index rebuild finished; 1,284 pages, 3 skipped for missing front matter.',
    }),
    session('acme', 'recent', 'Billing webhook retries', 'claude', {
        status: { text: 'Working · 6 min', tone: 'working' },
        excerpt: 'Stripe retries the webhook 3 times; the handler isn’t idempotent on retry 2.',
    }),
    session('wal', 'recent', 'Spike: SQLite WAL size', 'claude', {
        timeLabel: 'Yesterday',
        excerpt: 'WAL stays under 4 MB with checkpointing every 1,000 pages.',
    }),
];

const CURRENT_KEY = buildServerScopedSessionKey('fix', SERVER);

export default function PhoneNavAllTabsDevScreen() {
    const params = useLocalSearchParams<{ frame?: string; inline?: string }>();
    const { theme } = useUnistyles();
    const sections = React.useMemo(() => buildSessionAllTabsSections({ rows: ROWS, synced: true }), []);
    const pulled = resolveSessionHeaderPullFrame({ translationY: SESSION_HEADER_PULL_ARM_PX + SESSION_HEADER_PULL_OPEN_PX + 8 });
    const progress = useSharedValue(pulled.progress);
    const offset = useSharedValue(pulled.offset);
    const frame = params.frame === 'pull' ? 'pull' : 'open';
    const inline = params.inline === '1';


    if (frame === 'pull') {
        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.surface.base }}>
                <View>
                    <SessionHeaderPullHint progress={progress} offset={offset} ready top={0} />
                    <View style={{ transform: [{ translateY: pulled.offset }] }}>
                        <ChatHeaderView title="Fix settings modal remount" subtitle="happier · MacBook Pro" includeTopInset={false} />
                    </View>
                </View>
            </View>
        );
    }
    if (inline) {
        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.surface.inset }}>
                <SessionAllTabsOverviewBody sections={sections} currentKey={CURRENT_KEY} onOpen={() => {}} />
            </View>
        );
    }
    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <SessionAllTabsPageView sections={sections} currentKey={CURRENT_KEY} onOpen={() => {}} onDone={() => {}} />
        </>
    );
}
