import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionItem } from '@/components/sessions/shell/SessionItem';
import { createSessionItemRowViewModel } from '@/components/sessions/shell/sessionItemRowViewModelTestFixture';
import type { SessionListRowContextPresentation, SessionListRowViewModel } from '@/components/sessions/shell/sessionListRowViewModels';
import { Text } from '@/components/ui/text/Text';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';

/**
 * Dev-only specimen of Session row status (lab ideas-1118-shell scene 7): the real `SessionItem` at Lines 1, 2 and 3
 * in a 300 px column, one row per lab state. Row facts come from the session fixtures and the real awareness owner;
 * the now line, count and note age are the owner's projected fields, set as fixture data. `?only=phone` draws the
 * Lines 2 column alone at phone width.
 */
type RowState = Readonly<{
    id: string;
    name: string;
    flavor: 'claude' | 'codex' | 'gemini';
    working?: boolean;
    needsYou?: boolean;
    unread?: boolean;
    activityMinutesAgo?: number;
    nowLine?: string;
    nowLineKind?: 'note' | 'task' | 'goal';
    noteSetDaysAgo?: number;
    progress?: Readonly<{ done: number; total: number; label?: string; dim: boolean; complete: boolean }>;
    reports?: NonNullable<Session['managedSessions']>;
    branch?: string;
    machine?: string;
    pullRequest?: NonNullable<SessionListRowContextPresentation['pullRequest']>;
    changes?: readonly [number, number];
}>;

const NOW = Date.now();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const STATES: readonly RowState[] = [
    { id: 'task', name: 'Fix settings modal remount when switching tabs', flavor: 'claude', working: true, nowLine: 'Lift the draft into useSettingsDraft and key the sheet by route', nowLineKind: 'task', progress: { done: 3, total: 7, dim: false, complete: false }, branch: 'fix/settings-remount', pullRequest: { number: 2490, state: 'draft', checks: 'pending' }, changes: [118, 21] },
    { id: 'explicit', name: 'QA sweep: checkout flows', flavor: 'codex', working: true, nowLine: 'Scenario 2: guest checkout with a saved card', nowLineKind: 'note', progress: { done: 1, total: 24, label: 'QA', dim: false, complete: false }, branch: 'qa/checkout' },
    { id: 'needs', name: 'Retry reconnect with exponential backoff', flavor: 'codex', needsYou: true, activityMinutesAgo: 4, nowLine: 'Scenario 7: reset the test account', nowLineKind: 'note', progress: { done: 9, total: 24, label: 'QA', dim: true, complete: false }, branch: 'fix/reconnect-backoff', pullRequest: { number: 2481, state: 'open', checks: 'failure' }, changes: [64, 12] },
    { id: 'aged', name: 'Migrate invoices to the new API', flavor: 'claude', activityMinutesAgo: 20, nowLine: 'Waiting on the staging deploy', nowLineKind: 'note', noteSetDaysAgo: 1, progress: { done: 9, total: 24, dim: true, complete: false }, branch: 'feat/invoices-api-v2', machine: 'build-box', changes: [342, 97] },
    { id: 'plugin', name: 'Pricing page copy', flavor: 'claude', unread: true, activityMinutesAgo: 12, nowLine: 'Preview ready', nowLineKind: 'note' },
    { id: 'complete', name: 'Release notes draft for 0.3', flavor: 'claude', unread: true, activityMinutesAgo: 60, progress: { done: 12, total: 12, dim: true, complete: true }, branch: 'docs/release-0.3-notes', pullRequest: { number: 2466, state: 'merged', checks: 'success' }, changes: [210, 4] },
    { id: 'opened', name: 'Release notes draft', flavor: 'claude', activityMinutesAgo: 60 },
    { id: 'lead', name: 'Ship reconnect backoff', flavor: 'claude', working: true, nowLine: 'Merge the jitter branch into main', nowLineKind: 'task', progress: { done: 3, total: 5, dim: false, complete: false }, reports: { total: 5, finished: 3, working: 1, needsYou: 1, stalled: 0, attentionPrimary: 'permission_required' } },
    { id: 'goal', name: 'Docs search index', flavor: 'gemini', activityMinutesAgo: 35, nowLine: 'rebuild the index without downtime', nowLineKind: 'goal' },
    { id: 'calm', name: 'Dark mode toggle', flavor: 'gemini', activityMinutesAgo: 24 * 60, branch: 'feat/dark-toggle' },
];

function buildRow(state: RowState): Readonly<{ session: Session; rowViewModel: SessionListRowViewModel }> {
    const activeAt = NOW - (state.activityMinutesAgo ?? 0) * MINUTE;
    const session = createSessionFixture({
        id: `row-status-${state.id}`,
        active: state.working === true || state.needsYou === true,
        activeAt,
        updatedAt: activeAt,
        thinking: state.working === true,
        thinkingAt: state.working === true ? NOW : 0,
        presence: 'online',
        metadata: { path: '/src/happier', host: 'mac.local', homeDir: '/Users/lee', machineId: 'machine-1', name: state.name, flavor: state.flavor },
        ...(state.needsYou ? { agentState: { requests: { 'request-1': { tool: 'Bash', arguments: { command: 'pnpm reset:test-account' }, createdAt: NOW - 4 * MINUTE } } } } : {}),
        ...(state.reports ? { managedSessions: state.reports } : {}),
    } as Partial<Session>);
    const base = createSessionItemRowViewModel({ session, serverId: 'row-status-specimen' });
    const awareness = {
        ...base.sessionStatus!.awareness,
        ...(state.nowLine ? { nowLine: state.nowLine, nowLineKind: state.nowLineKind ?? 'task' } : {}),
        ...(state.noteSetDaysAgo ? { statusReasonSetAt: NOW - state.noteSetDaysAgo * DAY } : {}),
        ...(state.progress ? { progress: state.progress } : {}),
    };
    return {
        session,
        rowViewModel: {
            ...base,
            sessionStatus: { ...base.sessionStatus!, awareness },
            hasUnreadMessages: state.unread === true,
            activityAt: activeAt,
            identityDisplay: 'agentLogo',
            rowContext: state.branch ? {
                leadingMark: 'agent', leadingMarkShowsProject: false, projectPlacement: 'none', project: null, projectFaviconSource: null,
                checkout: { kind: 'branch', label: state.branch }, machine: state.machine ?? null,
                pullRequest: state.pullRequest ?? null,
                changes: state.changes ? { changedFiles: 1, linesAdded: state.changes[0], linesRemoved: state.changes[1] } : null,
                pluginContext: null, pluginMark: null,
                accessibleLabel: [state.branch, state.machine].filter(Boolean).join(', '), statusWords: false,
                currentWork: true, progress: true,
            } : null,
        },
    };
}

const LINES = [
    { lines: 1, compact: true, compactMinimal: true, label: '1 line' },
    { lines: 2, compact: true, compactMinimal: false, label: '2 lines' },
    { lines: 3, compact: false, compactMinimal: false, label: '3 lines' },
] as const;

export function SessionRowStatusSpecimen(props: Readonly<{ only: string | null }>) {
    const rows = React.useMemo(() => STATES.map(buildRow), []);
    const columns = props.only === 'phone' ? LINES.filter((column) => column.lines === 2) : LINES;
    return (
        <ScrollView contentContainerStyle={styles.page}>
            <View style={styles.columns}>
                {columns.map((column) => (
                    <View key={column.lines} style={props.only === 'phone' ? styles.phoneColumn : styles.column} testID={`row-status-lines-${column.lines}`}>
                        <Text variant="label" style={styles.heading}>{column.label}</Text>
                        {rows.map(({ session, rowViewModel }) => (
                            <SessionItem
                                key={session.id}
                                session={session}
                                rowViewModel={rowViewModel}
                                serverId="row-status-specimen"
                                compact={column.compact}
                                compactMinimal={column.compactMinimal}
                            />
                        ))}
                    </View>
                ))}
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: { padding: theme.space.s24, backgroundColor: theme.colors.surface.base },
    columns: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s32, alignItems: 'flex-start' },
    column: { width: 300 },
    phoneColumn: { width: '100%', maxWidth: 390 },
    heading: { marginBottom: theme.space.s8, color: theme.colors.text.primary },
}));
