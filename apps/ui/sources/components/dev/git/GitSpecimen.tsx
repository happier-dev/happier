import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ScmLogEntry } from '@happier-dev/protocol';
import { formatHappierAsOfTime } from '@happier-dev/plugin-ui/presentation';

import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { GitCleanState } from '@/components/sessions/panes/git/GitCleanState';
import { GitConflictNotice } from '@/components/sessions/panes/git/GitConflictNotice';
import { GitBranchButton } from '@/components/sessions/panes/git/branches/GitBranchButton';
import { GitNextActionButton } from '@/components/sessions/panes/git/GitNextActionButton';
import { GitOutcomeLine, type GitOutcomeFacts } from '@/components/sessions/panes/git/GitOutcomeLine';
import { GitTimelineSection } from '@/components/sessions/panes/git/GitTimelineSection';
import { GitDisplayMenu } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { SessionRightPanelGitCommitTab } from '@/components/sessions/panes/git/SessionRightPanelGitCommitTab';
import { resolveSessionGitPaneActions, resolveSessionGitPaneHeaderFacts } from '@/components/sessions/panes/git/sessionGitPaneHeader';
import { ScmCommitSelectionCheckGlyph } from '@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton';
import { WorkspaceScmSubTabsBar } from '@/components/workspaces/scm/WorkspaceScmSubTabsBar';
import { Icon } from '@/components/ui/icons/Icon';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmWriteOperation } from '@/scm/operations/selectScmWriteOperation';
import type { SessionAttributedFile } from '@/scm/scmAttribution';
import type { ScmFileStatus, ScmStatusFiles } from '@/scm/scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

/**
 * Dev-only specimen of the session Git pane (Git lab A, B, C3, S2–S6, CF, ST clean) drawn through the real
 * pane parts at static props, so it can be compared side by side with the lab without a reachable Home. The
 * content is the lab's illustration (the settings-modal change), not product data.
 */
const HOUR = 3_600_000;
function today(h: number, m: number): number {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.getTime();
}
function yesterday(h: number, m: number): number {
    return today(h, m) - 24 * HOUR;
}

function file(path: string, status: ScmFileStatus['status'], added: number, removed: number): ScmFileStatus {
    const slash = path.lastIndexOf('/');
    return {
        fileName: slash >= 0 ? path.slice(slash + 1) : path,
        filePath: slash >= 0 ? path.slice(0, slash) : '',
        fullPath: path,
        status,
        isIncluded: false,
        linesAdded: added,
        linesRemoved: removed,
    };
}

const SESSION_FILES = [
    file('apps/ui/sources/components/settings/modal/SettingsModal.tsx', 'modified', 4, 2),
    file('apps/ui/sources/components/settings/modal/SettingsModal.test.tsx', 'modified', 38, 0),
    file('apps/ui/sources/components/settings/modal/useSettingsRouteKey.ts', 'added', 21, 0),
    file('apps/ui/sources/app/(app)/settings.tsx', 'modified', 2, 2),
];
const ELSEWHERE_FILES = [
    file('.agents/skills/attack-conclusion/SKILL.md', 'modified', 12, 3),
    file('.agents/skills/happier-testing/SKILL.md', 'modified', 8, 8),
    file('.agents/skills/verify-claims/SKILL.md', 'modified', 5, 1),
    file('AGENTS.md', 'modified', 31, 9),
    file('DESIGN.md', 'modified', 6, 2),
    file('apps/ui/sources/components/hub/formatAsOfTime.ts', 'renamed', 3, 1),
    file('.happier/design-lab/app-surfaces/pane-states.css', 'added', 212, 0),
    file('.github/workflows/release.yml', 'modified', 4, 1),
    file('.github/workflows/tests.yml', 'modified', 2, 2),
    file('.gitattributes', 'deleted', 0, 14),
];
const ALL_FILES = [...SESSION_FILES, ...ELSEWHERE_FILES];
const SESSION_ATTRIBUTED: SessionAttributedFile[] = SESSION_FILES.map((entry) => ({
    file: entry,
    turns: ['turn-1'],
    content: { source: 'scm_checkpoint', confidence: 'exact' },
    attribution: { confidence: 'session_likely', reason: 'checkpoint_no_happier_overlap_observed' },
    checkpointOverlap: 'not_observed',
    evidence: [],
}));

function commit(sha: string, subject: string, author: string, timestamp: number): ScmLogEntry {
    return { sha: `${sha}${'0'.repeat(40 - sha.length)}`, shortSha: sha, authorName: author, authorEmail: '', timestamp, subject, body: '' };
}
const HISTORY: ScmLogEntry[] = [
    commit('2c4410a', 'Move settings routes into one table', 'Leeroy', today(10, 5)),
    commit('91be07d', 'Load settings sections lazily', 'Leeroy', today(9, 58)),
    commit('e81f3b2', 'Fix search field focus on Android', 'Ben', today(8, 41)),
    commit('5d1a7c0', 'Merge pull request #2479 from ana/relay-retries', 'Ana', yesterday(17, 12)),
    commit('0b9e4f1', 'Retry relay handshakes with backoff', 'Ana', yesterday(16, 3)),
];
const LANDED = commit('4f2a91c', 'Key the settings modal by route', 'Leeroy', today(10, 44));
const INCOMING: ScmLogEntry[] = [
    commit('c9e10a2', 'Keep the draft when the sheet rotates', 'Ana', today(10, 31)),
    commit('0b7d5e1', 'Settings: read sections from the route table', 'Ana', today(10, 12)),
];

/** The working snapshot the tree reads (the same one `selectScmChangedFiles` counts). */
function snapshotOf(files: readonly ScmFileStatus[]): ScmWorkingSnapshot {
    return {
        projectKey: 'specimen',
        fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: '/Users/leeroy/happier', backendId: 'git', mode: '.git' },
        capabilities: { changeSetModel: 'index' },
        branch: { head: 'v0.3', upstream: 'origin/v0.3', ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries: files.map((entry) => ({
            path: entry.fullPath,
            previousPath: null,
            kind: entry.status === 'added' ? 'untracked' : entry.status,
            includeStatus: '',
            pendingStatus: '',
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: entry.linesAdded, pendingRemoved: entry.linesRemoved, isBinary: false },
        })),
        totals: {},
    } as unknown as ScmWorkingSnapshot;
}

const REMOTE = [
    { key: 'fetch', disabled: false },
    { key: 'pull', disabled: false },
    { key: 'push', disabled: false },
];

type FrameState = Readonly<{
    files: readonly ScmFileStatus[];
    selected: readonly string[];
    message: string;
    ahead: number;
    behind: number;
    upstream: string | null;
    history: readonly ScmLogEntry[];
    incoming: readonly ScmLogEntry[] | null;
    operation: ScmWriteOperation | null;
    facts?: GitOutcomeFacts;
    remote?: readonly { key: string; disabled: boolean }[];
    landedSha?: string | null;
    conflicts?: boolean;
    layout?: 'unified' | 'tabs';
    tab?: 'commit' | 'history';
    prOpen?: number | null;
    tree?: boolean;
    offline?: boolean;
}>;

const NOOP = () => {};
const NOOP_ASYNC = async () => ({ ok: false as const, error: '' });

function GitFrame(props: Readonly<{ state: FrameState; phone: boolean }>) {
    const { theme } = useUnistyles();
    const { state } = props;
    // Replay the captured start facts before its static terminal frame. Product outcomes never infer
    // an old operation's counts from the current tree; this harness supplies the known lab transition.
    const [operation, setOperation] = React.useState<ScmWriteOperation | null>(() => state.operation?.phase === 'succeeded' && state.facts ? { ...state.operation, phase: 'running' } : state.operation);
    React.useLayoutEffect(() => setOperation(state.operation), [state.operation]);
    const selectedSet = React.useMemo(() => new Set(state.selected), [state.selected]);
    const selectedFiles = React.useMemo(() => state.files.filter((entry) => selectedSet.has(entry.fullPath)), [selectedSet, state.files]);
    const conflictPaths = state.conflicts ? state.files.filter((entry) => entry.status === 'conflicted').map((entry) => entry.fullPath) : [];
    const commitReady = selectedFiles.length > 0 && state.message.trim().length > 0;
    const actions = resolveSessionGitPaneActions({
        changedCount: state.files.length,
        ahead: state.ahead,
        behind: state.behind,
        upstream: state.upstream,
        hasConflicts: conflictPaths.length > 0,
        conflictCount: conflictPaths.length,
        prState: state.prOpen ? 'open' : 'none',
        prNumber: state.prOpen ?? null,
        canCreatePr: true,
        commitReady,
        remoteActions: state.remote ?? REMOTE,
        writeOperation: operation,
    });
    const facts = resolveSessionGitPaneHeaderFacts({
        branch: 'v0.3', changedCount: state.files.length, ahead: state.ahead, behind: state.behind, primaryKey: actions.primary.key,
        operation: state.conflicts ? { kind: 'merge', sourceRef: 'origin/v0.3' } : null,
        asOf: state.offline ? today(10, 30) : null,
    });
    const line = {
        leading: <GitBranchButton sessionId="specimen" snapshot={snapshotOf(state.files)} disabled />,
        segments: facts.map((fact) => {
            switch (fact.kind) {
                case 'branch': return null;
                case 'asOf': return t('surfaceState.asOf', { time: formatHappierAsOfTime(fact.at) });
                case 'changed': return t('sessionGitPane.header.changed', { count: formatExactCount(fact.count) });
                case 'clean': return t('sessionGitPane.flow.header.noChanges');
                case 'toPush': return t('sessionGitPane.header.toPush', { count: formatExactCount(fact.count) });
                case 'toPull': return t('sessionGitPane.header.toPull', { count: formatExactCount(fact.count) });
                case 'operation': return t('sessionGitPane.fidelity.operation', { operation: t('sessionGitPane.flow.conflicts.merge'), source: fact.sourceRef ?? '' });
            }
        }).filter((segment) => segment !== null),
    };
    const running = state.operation && (state.operation.phase === 'running' || state.operation.phase === 'queued')
        && (state.operation.action === 'push' || state.operation.action === 'pull') ? state.operation.action : null;
    const timeline = (
        <GitTimelineSection
            changedCount={state.files.length}
            selectedCount={selectedFiles.length}
            ahead={state.ahead}
            behind={state.behind}
            upstream={state.upstream}
            entries={state.history}
            incoming={state.incoming}
            loading={false}
            hasMore
            onLoadMore={NOOP}
            onOpenCommit={NOOP}
            landedSha={state.landedSha ?? null}
        />
    );
    const statusFiles: ScmStatusFiles = {
        includedFiles: [], pendingFiles: [], branch: 'v0.3', upstream: state.upstream, ahead: state.ahead, behind: state.behind,
        detached: false, totalIncluded: 0, totalPending: state.files.length,
    };
    const layout = state.layout ?? 'unified';
    const tab = layout === 'tabs' ? state.tab ?? 'commit' : 'commit';
    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface.base }}>
            <PaneHeader
                title="Git"
                line={line}
                actions={(
                    <GitNextActionButton
                        primary={actions.primary}
                        menu={actions.menu}
                        runningKey={running}
                        upstream={state.upstream}
                        baseBranch="dev"
                        onRun={NOOP}
                    />
                )}
            />
            <GitOutcomeLine
                operation={operation}
                facts={state.facts ?? { ahead: state.ahead, behind: state.behind, selectedCount: selectedFiles.length, upstream: state.upstream }}
                machineName="MacBook Pro"
                machineReachable={!state.offline}
                machineLastSeenAt={state.offline ? today(10, 30) : null}
                recovery={{ fetch: NOOP, retry: NOOP, refresh: NOOP, showConflicts: NOOP, publish: NOOP, pullWith: NOOP, pullThenPush: NOOP, openTerminal: NOOP, undoCommit: NOOP }}
                authenticationCommand={state.operation?.provider === 'GitHub' ? 'gh auth login' : null}
                haptics={false}
            />
            <GitConflictNotice
                sessionId="specimen"
                agentName="Claude"
                operation={state.conflicts ? { kind: 'merge', sourceRef: 'origin/v0.3', unresolvedCount: conflictPaths.length, canContinue: false, canAbort: true } : null}
                conflictPaths={conflictPaths}
                busy={false}
                onContinue={NOOP}
                onAbort={NOOP}
            />
            {layout === 'tabs' ? (
                <WorkspaceScmSubTabsBar
                    tabs={[
                        { id: 'commit', label: t('sessionGitPane.subTabs.changes'), count: formatExactCount(state.files.length) },
                        { id: 'history', label: t('sessionGitPane.subTabs.history') },
                    ]}
                    activeSubTabId={tab}
                    onSelectSubTab={NOOP}
                />
            ) : null}
            <View style={{ flex: 1 }}>
                {tab === 'history' ? (
                    <ScrollView>{timeline}</ScrollView>
                ) : (
                    <SessionRightPanelGitCommitTab
                        theme={theme}
                        phone={props.phone}
                        agentId="claude"
                        completedOperationId={state.operation?.phase === 'succeeded' ? state.operation.id : null}
                        sessionId="specimen"
                        sessionPath="/Users/leeroy/happier"
                        backendLabel="Git"
                        commitActionLabel="Commit"
                        scmSnapshot={state.tree ? snapshotOf(state.files) : null}
                        scmWriteEnabled
                        hasConflicts={conflictPaths.length > 0}
                        scmOperationBusy={false}
                        scmOperationStatus={null}
                        hasGlobalOperationInFlight={false}
                        inFlightScmOperation={null}
                        commitAllowed
                        commitBlockedMessage={null}
                        changedFilesViewMode="repository"
                        sessionAttribution={{ confidence: 'session_likely', reason: 'checkpoint_no_happier_overlap_observed' }}
                        sessionCheckpointOverlap="not_observed"
                        allRepositoryChangedFiles={[...state.files]}
                        selectedRepositoryChangedFiles={selectedFiles}
                        sessionAttributedFiles={state.conflicts ? [] : SESSION_ATTRIBUTED.filter((entry) => state.files.includes(entry.file))}
                        repositoryOnlyFiles={[]}
                        showSessionViewToggle
                        showSelectedViewToggle={selectedFiles.length > 0}
                        repositorySelectedCount={selectedFiles.length}
                        onSelectAll={NOOP}
                        onSelectNone={NOOP}
                        disableSelectAll={false}
                        disableSelectNone={false}
                        onFilePress={NOOP}
                        onFilePressPinned={NOOP}
                        onToggleSelectionForFile={NOOP}
                        renderFileActions={(entry) => <ScmCommitSelectionCheckGlyph state={selectedSet.has(entry.fullPath) ? 'checked' : 'unchecked'} />}
                        renderFileTrailingActions={() => null}
                        commitDraftMessage={state.message}
                        onCommitDraftMessageChange={NOOP}
                        onCommitFromMessage={NOOP}
                        commitMessageGeneratorEnabled
                        onGenerateCommitMessageSuggestion={NOOP_ASYNC}
                        selectionModeActive
                        scmStatusFiles={statusFiles}
                        onToggleGroupSelection={NOOP}
                        listFooter={layout === 'unified' ? timeline : null}
                        scopeAccessory={<GitDisplayMenu />}
                        changesLayout={state.tree ? 'tree' : 'list'}
                        emptyState={(
                            <GitCleanState
                                branch="v0.3"
                                upstream={state.upstream}
                                ahead={state.ahead}
                                behind={state.behind}
                                lastCommitAt={state.history[0]?.timestamp ?? null}
                                lastCommit={state.history[0] ?? null}
                                onOpenCommit={NOOP}
                                lastPushedAt={state.operation?.phase === 'succeeded' && state.operation.action === 'push' ? state.operation.at : null}
                                justCompleted={state.operation?.phase === 'succeeded' && state.operation.action === 'push'}
                                phone={props.phone}
                                onCreatePullRequest={state.prOpen ? null : NOOP}
                                onOpenPullRequest={state.prOpen ? NOOP : null}
                                pullRequestNumber={state.prOpen ?? null}
                            />
                        )}
                    />
                )}
            </View>
        </View>
    );
}

const BASE: FrameState = {
    files: ALL_FILES,
    selected: SESSION_FILES.slice(0, 3).map((entry) => entry.fullPath),
    message: 'Key the settings modal by route',
    ahead: 2,
    behind: 0,
    upstream: 'origin/v0.3',
    history: HISTORY,
    incoming: null,
    operation: null,
};
const AFTER_COMMIT: FrameState = {
    ...BASE,
    files: ALL_FILES.slice(3),
    selected: [],
    message: '',
    ahead: 3,
    history: [LANDED, ...HISTORY],
    landedSha: LANDED.sha,
};
const AT = today(10, 44);

const FRAMES: ReadonlyArray<{ id: string; title: string; state: FrameState }> = [
    { id: 'A', title: 'A · at rest (Unified)', state: BASE },
    { id: 'TV', title: 'TV · tree', state: { ...BASE, tree: true } },
    { id: 'B', title: 'B · Tabs layout, Changes', state: { ...BASE, layout: 'tabs', tab: 'commit' } },
    { id: 'B2', title: 'B · Tabs layout, History', state: { ...BASE, layout: 'tabs', tab: 'history' } },
    {
        id: 'C3', title: 'C3 · committed',
        state: { ...AFTER_COMMIT, operation: { phase: 'succeeded', action: 'commit', id: 'c', at: AT, message: '', result: { sha: LANDED.sha }, outcome: { v: 1, kind: 'succeeded', nextActions: [], effect: { kind: 'commit', commitSha: LANDED.sha } } },
            facts: { ahead: 2, behind: 0, selectedCount: 3, upstream: 'origin/v0.3' } },
    },
    {
        id: 'S1', title: 'S1 · pushing',
        state: { ...AFTER_COMMIT, landedSha: null, operation: { phase: 'running', action: 'push', id: 'p', at: AT } },
    },
    {
        id: 'S2', title: 'S2 · pushed',
        state: { ...AFTER_COMMIT, ahead: 0, landedSha: null, operation: { phase: 'succeeded', action: 'push', id: 'p', at: AT, message: '', outcome: { v: 1, kind: 'succeeded', nextActions: [] } },
            facts: { ahead: 3, behind: 0, selectedCount: 0, upstream: 'origin/v0.3' } },
    },
    {
        id: 'S3', title: 'S3 · something to pull',
        state: { ...AFTER_COMMIT, ahead: 0, behind: 2, landedSha: null, incoming: INCOMING },
    },
    {
        id: 'S3b', title: 'S3 · pulled',
        state: { ...AFTER_COMMIT, ahead: 0, behind: 0, landedSha: null, history: [...INCOMING, LANDED, ...HISTORY],
            operation: { phase: 'succeeded', action: 'pull', id: 'l', at: AT, message: '', outcome: { v: 1, kind: 'succeeded', nextActions: [] } }, facts: { ahead: 0, behind: 2, selectedCount: 0, upstream: 'origin/v0.3' } },
    },
    {
        id: 'S4', title: 'S4 · push rejected',
        state: { ...AFTER_COMMIT, behind: 2, landedSha: null, operation: { phase: 'needs_input', action: 'push', id: 'r', at: AT, message: '', outcome: { v: 1, kind: 'needs_input', errorCode: 'REMOTE_NON_FAST_FORWARD', nextActions: [{ kind: 'choose_reconcile' }] } } },
    },
    {
        id: 'S5', title: 'S5 · can’t sign in to origin',
        state: { ...AFTER_COMMIT, landedSha: null, operation: { phase: 'needs_input', action: 'push', id: 'a', at: AT, message: '', machine: 'MacBook Pro', provider: 'GitHub', outcome: { v: 1, kind: 'needs_input', errorCode: 'REMOTE_AUTH_REQUIRED', nextActions: [{ kind: 'authenticate' }] } } },
    },
    {
        id: 'S6', title: 'S6 · machine offline',
        state: { ...AFTER_COMMIT, landedSha: null, offline: true, remote: REMOTE.map((entry) => ({ ...entry, disabled: true })),
            operation: { phase: 'failed', action: 'push', id: 'o', at: AT, message: '', outcome: { v: 1, kind: 'failed', errorCode: 'BACKEND_UNAVAILABLE', nextActions: [{ kind: 'refresh' }] } } },
    },
    {
        id: 'CF', title: 'CF · conflicts',
        state: { ...BASE, selected: [], message: '', ahead: 3, behind: 2, conflicts: true,
            files: [file('apps/ui/sources/components/settings/modal/SettingsModal.tsx', 'conflicted', 9, 4), file('apps/ui/sources/components/settings/settingsRoutes.ts', 'conflicted', 5, 2), ...ELSEWHERE_FILES.slice(0, 4)] },
    },
    {
        id: 'SX2', title: 'SX2 · all clean after pushing',
        state: { ...BASE, files: [], selected: [], message: '', ahead: 0, behind: 0, history: [LANDED, ...HISTORY], operation: { phase: 'succeeded', action: 'push', id: 'clean-push', at: AT, message: '', outcome: { v: 1, kind: 'succeeded', nextActions: [], effect: { kind: 'remote', remote: 'origin', branch: 'v0.3' } } }, facts: { ahead: 3, behind: 0, selectedCount: 0, upstream: 'origin/v0.3' } },
    },
    {
        id: 'ST', title: 'ST · clean and up to date',
        state: { ...BASE, files: [], selected: [], message: '', ahead: 0, behind: 0, history: [LANDED, ...HISTORY] },
    },
];

export function GitSpecimen(props: Readonly<{ only: string | null; phone: boolean }>) {
    const frames = props.only ? FRAMES.filter((frame) => frame.id === props.only) : FRAMES;
    const grid = (
        <View style={styles.grid}>
            {frames.map((frame) => (
                <View key={frame.id} testID={`git-specimen-${frame.id}`} style={props.phone ? styles.framePhone : styles.frame}>
                    {props.only ? null : <Text style={styles.caption}>{frame.title}</Text>}
                    <View style={styles.frameBody}><GitFrame state={frame.state} phone={props.phone} /></View>
                </View>
            ))}
        </View>
    );
    const content = props.only
        ? <View style={[styles.root, styles.content]}>{grid}</View>
        : <ScrollView style={styles.root} contentContainerStyle={styles.content}>{grid}</ScrollView>;
    return props.phone ? <SurfaceStateSizeProvider size="phone">{content}</SurfaceStateSizeProvider> : content;
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.inset },
    content: { padding: 16, gap: 24 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 22 },
    caption: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.text.secondary, padding: 8 },
    frame: {
        width: 460,
        height: 1260,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    framePhone: {
        width: '100%',
        height: 780,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
    },
    frameBody: { flex: 1, minHeight: 0 },
}));
