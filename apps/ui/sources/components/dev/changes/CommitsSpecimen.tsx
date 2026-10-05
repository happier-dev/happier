import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ScmCommitPlanApplication, ScmComparison, ScmDiffSummaryCommitPlan } from '@happier-dev/protocol';
import type { ScmCommitPublication } from '@happier-dev/protocol/scm';

import { buildCommitProposal, type CommitProposal } from '@/components/sessions/files/commits/commitProposal';
import { CommitGroupCard, CommitProposalView, type CommitProposalActions } from '@/components/sessions/files/commits/CommitProposalView';
import { CommitPlanOutcomeBanner } from '@/components/sessions/files/commits/CommitPlanOutcome';
import { ScmComparisonBar, ScmComparisonViewSwitch } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { ScmComparisonScopePicker } from '@/components/sessions/files/comparison/ScmComparisonScopePicker';
import { ScmComparisonPhoneHeader } from '@/components/sessions/files/comparison/ScmComparisonPhoneHeader';
import { listFilesComparisonScopeOptions } from '@/components/sessions/files/comparison/filesComparison';
import { GitProposedCommitsCard } from '@/components/sessions/panes/git/GitProposedCommitsCard';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { ScmChangeRow } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { Typography } from '@/constants/Typography';
import { projectChangedFilesAsScmSnapshot, type ScmFileStatus } from '@/scm/scmStatusFiles';
import { GitChangesTree } from '@/components/sessions/panes/git/display/GitChangesTree';
import { resolveScmChangePathTag } from '@/scm/scmChangePathTag';
import { t } from '@/text';

import { SPECIMEN_COMPARISON } from './walkthroughSpecimenFixture';

/**
 * Dev-only: the Commits view and the Git pane's proposal (Walkthrough lab WT4) drawn through the real
 * components at static props. The proposal and every applying state are illustration, not product data.
 */
const noop = () => {};
const PENDING: ScmComparison = { ...SPECIMEN_COMPARISON, id: 'specimen-pending', source: { kind: 'workingTree' } };
const ref = (path: string, position: number) => `${path}#${position}`;
const MODAL = 'apps/ui/sources/components/settings/SettingsModal.tsx';
const KEY = 'apps/ui/sources/components/settings/useSettingsRouteKey.ts';
const ROUTES = 'apps/ui/sources/components/settings/settingsRoutes.ts';
const SHEET = 'apps/ui/sources/components/settings/SettingsSheet.tsx';
const SCREEN = 'apps/ui/sources/app/(app)/settings.tsx';
const TEST = 'apps/ui/sources/components/settings/SettingsModal.test.tsx';
const LAYOUT = 'apps/ui/sources/components/ui/modal/useModalLayout.ts';
const COPY = 'apps/ui/sources/text/en.ts';

const PLAN: ScmDiffSummaryCommitPlan = {
    groups: [
        { id: 'route-key', message: 'Key the settings modal by route, not window width', rationale: 'The fix: the hook, the route kind it needs, and both places that keyed by size.',
            changeRefs: [ref(KEY, 0), ref(ROUTES, 0), ref(MODAL, 0), ref(MODAL, 1), ref(SHEET, 0)] },
        { id: 'compact', message: 'Pass the compact layout as a prop', rationale: 'Same modal on narrow windows; the breakpoint moves next to the layout hook.',
            changeRefs: [ref(MODAL, 2), ref(LAYOUT, 0), ref(LAYOUT, 1), ref(SCREEN, 0), ref(SCREEN, 1), ref(COPY, 0)] },
        { id: 'test', message: 'Test that resizing keeps the settings draft', rationale: 'Proves the fix at the component boundary.', changeRefs: [ref(TEST, 0), ref(TEST, 1)] },
    ],
    leftOutChangeRefs: [ref('yarn.lock', 0)],
};
const SHA1 = '4f2a91c0b6e1d2f3a4b5c6d7e8f9a0b1c2d3e4f5';
const SHA2 = '9c03b7e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7';
const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);

function application(patch: Partial<ScmCommitPlanApplication>): ScmCommitPlanApplication {
    return {
        acceptedRevision: 4,
        acceptance: { comparisonId: PENDING.id, repositoryRootPath: '/repo', expectedHeadOid: TREE_A, expectedRef: 'refs/heads/v0.3', ...PLAN },
        status: 'applying',
        steps: PLAN.groups.map((group) => ({ groupId: group.id, state: 'pending' as const })),
        nextGroupIndex: 0,
        stopAfterCurrent: false,
        ...patch,
    };
}
/** 11:02 today, as the lab's landed line reads. */
const AT_1102 = new Date(new Date().setHours(11, 2, 0, 0)).getTime();
const writer = (patch: Partial<ScmCommitPublication>): ScmCommitPublication => ({ state: 'not_published', expectedHeadOid: TREE_A, expectedRef: 'refs/heads/v0.3', indexReconciliation: 'not_required', ...patch });
const landed1 = { groupId: 'route-key', state: 'published' as const, commitSha: SHA1,
    publication: writer({ state: 'published', candidateOid: SHA1, indexReconciliation: 'reconciled', committedAtMs: AT_1102, signed: true }) };
const proposal = (app: ScmCommitPlanApplication | null): CommitProposal => buildCommitProposal({ comparison: PENDING, plan: PLAN, application: app });

const EDITING = proposal(null);
const CREATING = proposal(application({ nextGroupIndex: 1, steps: [landed1, { groupId: 'compact', state: 'writing' }, { groupId: 'test', state: 'pending' }] }));
const HOOK_CHANGED = proposal(application({ status: 'paused', reason: 'hook_content_changed', nextGroupIndex: 1, steps: [landed1,
    { groupId: 'compact', state: 'not_published', publication: writer({ hookName: 'pre-commit' }), hookContentChanges: { beforeTreeOid: TREE_A, afterTreeOid: TREE_B, changes: [{ path: SCREEN, kind: 'modified' }, { path: COPY, kind: 'modified' }] } },
    { groupId: 'test', state: 'pending' }] }));
const SIGNING = proposal(application({ status: 'failed', reason: 'signing_failed', steps: [{ groupId: 'route-key', state: 'not_published', error: 'gpg: signing failed: No secret key' }, { groupId: 'compact', state: 'pending' }, { groupId: 'test', state: 'pending' }] }));
const HOOK_FAILED = proposal(application({ status: 'failed', reason: 'hook_failed', nextGroupIndex: 1, steps: [landed1,
    { groupId: 'compact', state: 'not_published', publication: writer({ hookName: 'pre-commit' }), error: "apps/ui/…/useModalLayout.ts\n  2:14  error  'COMPACT_MODAL_WIDTH' is exported but never used  unused-exports" },
    { groupId: 'test', state: 'pending' }] }));
const REWRITTEN = proposal(application({ nextGroupIndex: 1, steps: [{ ...landed1, publication: { ...landed1.publication, signed: false }, actualMessage: 'Key the settings modal by route, not window width\n\nRefs: HAP-212' }, { groupId: 'compact', state: 'writing' }, { groupId: 'test', state: 'pending' }] }));
const HEAD_MOVED = proposal(application({ status: 'failed', reason: 'head_moved', nextGroupIndex: 1, steps: [landed1, { groupId: 'compact', state: 'pending' }, { groupId: 'test', state: 'pending' }] }));
const STOPPED = proposal(application({ status: 'stopped', reason: 'stopped', nextGroupIndex: 2, steps: [landed1,
    { groupId: 'compact', state: 'published', commitSha: SHA2, publication: writer({ state: 'published', candidateOid: SHA2, indexReconciliation: 'reconciled', committedAtMs: AT_1102 + 60_000, signed: true }) },
    { groupId: 'test', state: 'pending' }] }));
const UNKNOWN = proposal(application({ status: 'unknown', reason: 'outcome_unknown', nextGroupIndex: 1, steps: [landed1, { groupId: 'compact', state: 'unknown' }, { groupId: 'test', state: 'pending' }] }));

const EDIT_ACTIONS: CommitProposalActions = {
    onEditMessage: noop, onMove: noop, onMoveGroup: noop, onMergeWithNext: noop, onCreate: noop, onDiscard: noop, onRegenerate: noop,
};
const RUN_ACTIONS: CommitProposalActions = {
    onStopAfterCurrent: noop, onIncludeHookChanges: noop, onCancel: noop, onRecover: noop, onCreate: noop, onProposeAgain: noop,
    onAskSession: noop, onShowInGit: noop, onEditMessage: noop, onMove: noop,
};

const AVAILABILITY = { showTurnViewToggle: true, showTurnAgentReportedViewToggle: false, showTurnCheckpointViewToggle: false, showSessionViewToggle: true };
const SCOPE_OPTIONS = listFilesComparisonScopeOptions(AVAILABILITY, 'turn-3', null, { pendingFileCount: 9, sessionFileCount: 9, latestTurnFileCount: 4 });
const PENDING_SCOPE = { kind: 'workingTree' } as const;

function CommitsBar() {
    const { theme } = useUnistyles();
    return (
        <ScmComparisonBar
            leading={(
                <>
                    <ScmComparisonViewSwitch view="commits" views={['files', 'walkthrough', 'commits']} commitsCount={3} onSelect={noop} />
                    <ScmComparisonScopePicker options={SCOPE_OPTIONS} current={PENDING_SCOPE} currentLabel={t('scmComparison.scope.workingTree')} fileCount={9} onSelect={noop} />
                </>
            )}
            trailing={(
                <RoundButton size="small" display="secondary" title={t('scmComparison.startReview')}
                    leading={<Icon name="shield-check" size={ICON_SIZE.xs} color={theme.colors.text.primary} />} onPress={noop} />
            )}
        />
    );
}

function CommitsFrame(props: Readonly<{ proposal: CommitProposal; phone: boolean; actions: CommitProposalActions }>) {
    return (
        <View style={styles.fill}>
            {props.phone ? <ScmComparisonPhoneHeader view="commits" views={['files', 'walkthrough', 'commits']}
                scope={{ options: SCOPE_OPTIONS, current: PENDING_SCOPE, currentLabel: t('scmComparison.scope.workingTree'), fileCount: 9, onSelect: noop }}
                onSelectView={noop} onBack={noop} onStartReview={noop} /> : <CommitsBar />}
            <CommitProposalView proposal={props.proposal} phase="ready" branch="v0.3" modelLabel="Opus 5.5"
                layout={props.phone ? 'phone' : 'wide'} actions={props.actions} active={false} />
        </View>
    );
}

function Card(props: Readonly<{ proposal: CommitProposal; groupId: string; open: boolean }>) {
    const group = props.proposal.groups.find((candidate) => candidate.id === props.groupId)!;
    return (
        <CommitGroupCard group={group} proposal={props.proposal} choices={null} open={props.open} onToggle={noop}
            focusedKey={null} onFocusKey={noop} actions={RUN_ACTIONS} phone={false} />
    );
}

function Cell(props: Readonly<{ caption: string; detail: string; children: React.ReactNode }>) {
    return (
        <View style={styles.cell}>
            <Text style={styles.cellCaption}>
                {props.caption}
                <Text style={styles.cellDetail}>{` · ${props.detail}`}</Text>
            </Text>
            <View style={styles.cellFrame}>{props.children}</View>
        </View>
    );
}

/** WT4-C4 board: each divergence as the Commits view draws it, cut to the part that changes. */
function Divergences() {
    return (
        <ScrollView style={styles.fill} contentContainerStyle={styles.grid}>
            <Cell caption="Signing unavailable" detail="checked before the first commit">
                <CommitPlanOutcomeBanner proposal={SIGNING} branch="v0.3" actions={RUN_ACTIONS} />
            </Cell>
            <Cell caption="A hook changed files" detail="shown, then your call"><Card proposal={HOOK_CHANGED} groupId="compact" open /></Cell>
            <Cell caption="A hook failed" detail="output, earlier commits stay, the rest stay editable"><Card proposal={HOOK_FAILED} groupId="compact" open={false} /></Cell>
            <Cell caption="A hook rewrote the message" detail="allowed, shown"><Card proposal={REWRITTEN} groupId="route-key" open={false} /></Cell>
            <Cell caption="The branch moved while committing" detail="refuse the next, show landed vs remaining, no rollback">
                <View style={styles.stack}>
                    <CommitPlanOutcomeBanner proposal={HEAD_MOVED} branch="v0.3" actions={RUN_ACTIONS} />
                    {HEAD_MOVED.groups.map((group) => <Card key={group.id} proposal={HEAD_MOVED} groupId={group.id} open={false} />)}
                </View>
            </Cell>
            <Cell caption="Stopped partway" detail="the summary after any stop">
                <CommitPlanOutcomeBanner proposal={STOPPED} branch="v0.3" actions={RUN_ACTIONS} />
            </Cell>
            <Cell caption="Unknown outcome" detail="checked, never retried">
                <CommitPlanOutcomeBanner proposal={UNKNOWN} branch="v0.3" actions={RUN_ACTIONS} />
            </Cell>
        </ScrollView>
    );
}

function file(path: string, status: ScmFileStatus['status'], added: number, removed: number, isIncluded = true): ScmFileStatus {
    const slash = path.lastIndexOf('/');
    return { fileName: path.slice(slash + 1), filePath: slash >= 0 ? path.slice(0, slash) : '', fullPath: path, status, isIncluded, linesAdded: added, linesRemoved: removed };
}
const GIT_FILES = [
    file(MODAL, 'modified', 4, 2), file(KEY, 'added', 21, 0), file(ROUTES, 'modified', 3, 2), file(SHEET, 'modified', 1, 2),
    file(SCREEN, 'modified', 2, 2), file(TEST, 'modified', 38, 1), file(LAYOUT, 'modified', 4, 1), file(COPY, 'modified', 2, 0), file('yarn.lock', 'modified', 37, 8, false),
];

/** WT4-C2: the Git pane's changed files with the proposal in the commit card's place. */
function GitPane(props: Readonly<{ selected: string | null; phone: boolean }>) {
    const { theme } = useUnistyles();
    const group = props.selected ? EDITING.groups.find((candidate) => candidate.id === props.selected) ?? null : null;
    const paths = new Set(group?.changes.map((change) => change.path) ?? []);
    const notes = new Map(group?.changes.flatMap((change) => change.part ? [[change.path, t('commitProposal.part', change.part)] as const] : []) ?? []);
    return (
        <View style={[styles.gitPane, props.phone ? styles.gitPanePhone : null]}>
            <View style={styles.gitSection}>
                <Text style={styles.gitSectionTitle}>Changed in this session</Text>
                <Text style={styles.gitSectionCount}>9</Text>
                {group ? <Text style={[styles.gitSectionCount, styles.gitInCommit]}>{t('commitProposal.gitPane.inCommit', { count: paths.size, number: group.number })}</Text> : null}
            </View>
            <ScrollView style={styles.fill}>
                {GIT_FILES.map((entry) => (
                    <ScmChangeRow
                        key={entry.fullPath}
                        theme={theme}
                        file={entry}
                        layout="stacked"
                        onPress={noop}
                        tag={resolveScmChangePathTag(entry.fullPath)}
                        proposalEmphasis={group ? (paths.has(entry.fullPath) ? 'in' : 'out') : null}
                        proposalNote={notes.get(entry.fullPath) ?? null}
                    />
                ))}
            </ScrollView>
            <GitProposedCommitsCard proposal={EDITING} selectedGroupId={props.selected} onSelectGroup={noop} onOpenGroup={noop} onReview={noop}
                onCreate={noop} onDiscard={noop} onRegenerate={noop} phone={props.phone} />
        </View>
    );
}

const GIT_SNAPSHOT = projectChangedFilesAsScmSnapshot(GIT_FILES, { projectKey: 'specimen:/repo', rootPath: '/repo' });
const GIT_STAGED = new Set(GIT_FILES.filter((entry) => entry.isIncluded).map((entry) => entry.fullPath));

/** WT4-C2 in tree layout: the same proposal selection through the Git tree's rows. */
function GitPaneTree(props: Readonly<{ selected: string | null; phone: boolean }>) {
    const { theme } = useUnistyles();
    const group = props.selected ? EDITING.groups.find((candidate) => candidate.id === props.selected) ?? null : null;
    const proposal = React.useMemo(() => (group ? {
        paths: new Set(group.changes.map((change) => change.path)),
        notes: new Map(group.changes.flatMap((change) => change.part ? [[change.path, t('commitProposal.part', change.part)] as const] : [])),
    } : null), [group]);
    return (
        <View style={[styles.gitPane, props.phone ? styles.gitPanePhone : null]}>
            <View style={styles.fill}>
                <GitChangesTree theme={theme} sessionId="specimen-session" snapshot={GIT_SNAPSHOT} files={GIT_FILES} selectedPaths={GIT_STAGED}
                    selectionEnabled selectionReadOnly={Boolean(group)} proposal={proposal}
                    onToggleFile={noop} onToggleFolder={noop} onOpenFile={noop} />
            </View>
            <GitProposedCommitsCard proposal={EDITING} selectedGroupId={props.selected} onSelectGroup={noop} onOpenGroup={noop} onReview={noop}
                onCreate={noop} onDiscard={noop} onRegenerate={noop} phone={props.phone} />
        </View>
    );
}

export type CommitsSpecimenFrame = Readonly<{ id: string; title: string; render: (phone: boolean) => React.ReactElement }>;

export const COMMITS_SPECIMEN_FRAMES: readonly CommitsSpecimenFrame[] = [
    { id: 'C1', title: 'WT4-C1 · proposal', render: (phone) => <CommitsFrame proposal={EDITING} phone={phone} actions={EDIT_ACTIONS} /> },
    { id: 'C2', title: 'WT4-C2 · Git pane, commit 1 selected', render: (phone) => <GitPane selected="route-key" phone={phone} /> },
    { id: 'C2a', title: 'WT4-C2a · Git pane, nothing selected', render: (phone) => <GitPane selected={null} phone={phone} /> },
    { id: 'C2t', title: 'WT4-C2 · Git pane tree, commit 1 selected', render: (phone) => <GitPaneTree selected="route-key" phone={phone} /> },
    { id: 'C3', title: 'WT4-C3 · creating', render: (phone) => <CommitsFrame proposal={CREATING} phone={phone} actions={RUN_ACTIONS} /> },
    { id: 'C4', title: 'WT4-C4 · every divergence', render: (phone) => (phone ? <CommitsFrame proposal={HOOK_CHANGED} phone actions={RUN_ACTIONS} /> : <Divergences />) },
];

const styles = StyleSheet.create((theme) => ({
    fill: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
    grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 28, rowGap: 22, padding: 24 },
    cell: { width: 470, gap: 10 },
    stack: { gap: 12 },
    cellCaption: { fontSize: 13, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    cellDetail: { color: theme.colors.text.secondary, ...Typography.default() },
    cellFrame: {
        padding: 14,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    gitPane: { width: 340, alignSelf: 'flex-end', flex: 1, minHeight: 0, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.default, backgroundColor: theme.colors.surface.base },
    gitPanePhone: { width: '100%', borderLeftWidth: 0 },
    gitSection: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6 },
    gitSectionTitle: { fontSize: 12, color: theme.colors.text.secondary, ...Typography.default('semiBold') },
    gitSectionCount: { fontSize: 12, color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'], ...Typography.default() },
    gitInCommit: { marginLeft: 'auto', color: theme.colors.state.active.foreground, ...Typography.default('semiBold') },
}));
