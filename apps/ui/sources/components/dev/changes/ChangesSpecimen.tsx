import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScmComparisonHeader } from '@/components/sessions/files/comparison/ScmComparisonHeader';
import { ScmComparisonScopePicker } from '@/components/sessions/files/comparison/ScmComparisonScopePicker';
import { ScmComparisonPhoneHeader } from '@/components/sessions/files/comparison/ScmComparisonPhoneHeader';
import { listFilesComparisonScopeOptions } from '@/components/sessions/files/comparison/filesComparison';
import { TurnChangesCard } from '@/components/sessions/files/turnChanges/TurnChangesCard';
import { ChangedFilesLayoutSwitch } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { ChangedFilesReview, type ChangedFilesReviewCoverage } from '@/components/workspaces/scm/review/ChangedFilesReview';
import { Typography } from '@/constants/Typography';
import type { SessionAttributedFile } from '@/scm/scmAttribution';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { ScmComparisonExplainToggle, ScmComparisonStartReview, ScmComparisonViewSwitch } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { WalkthroughExplainNotes, WALKTHROUGH_EXPLAIN_COLUMN_WIDTH_PX } from '@/components/sessions/files/walkthrough/WalkthroughExplainNotes';
import { WalkthroughAnalysisFact, WalkthroughReviewedFact } from '@/components/sessions/files/walkthrough/WalkthroughAtoms';
import { buildWalkthroughReading } from '@/components/sessions/files/walkthrough/walkthroughReading';

import { WALKTHROUGH_SPECIMEN_FRAMES } from './WalkthroughSpecimen';
import { COMMITS_SPECIMEN_FRAMES } from './CommitsSpecimen';
import { REVIEW_WALKTHROUGH_SPECIMEN_FRAMES } from './ReviewWalkthroughSpecimen';
import { PULL_REQUEST_SPECIMEN_FRAMES } from './PullRequestSpecimen';
import { SPECIMEN_ANALYSIS_COMPLETE, SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH, specimenReviewedRefs } from './walkthroughSpecimenFixture';

/**
 * Dev-only specimen of the turn-end changes card (Walkthrough lab WT9-R) and the Files view (WT8) drawn
 * through the real components at static props, so they can be compared with the lab without a
 * reachable Home. The content is the lab's illustration (the settings-modal change), not product data.
 */
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

const TURN_FOUR = [
    file('apps/ui/sources/app/(app)/settings.tsx', 'modified', 2, 2),
    file('apps/ui/sources/components/settings/SettingsModal.test.tsx', 'modified', 38, 1),
    file('apps/ui/sources/components/settings/SettingsModal.tsx', 'modified', 4, 2),
    file('apps/ui/sources/components/settings/useSettingsRouteKey.ts', 'added', 21, 0),
];

const PAGES = ['Account', 'Appearance', 'Backup', 'ConnectedServices', 'Developer', 'Devices', 'Features', 'Keyboard', 'Machines', 'Notifications', 'Privacy', 'Profiles'];
function many(folder: string, count: number, prefix: string): ScmFileStatus[] {
    return Array.from({ length: count }, (_, index) => file(`${folder}/${PAGES[index % PAGES.length]}${prefix}${index}.tsx`, 'modified', 10 + (index % 30), 4 + (index % 20)));
}
const TURN_BIG: ScmFileStatus[] = [
    file('apps/ui/sources/components/settings/SettingsPageShell.tsx', 'added', 212, 0),
    file('apps/ui/sources/components/settings/SettingsModal.tsx', 'modified', 18, 31),
    file('apps/ui/sources/components/settings/settingsRoutes.ts', 'modified', 9, 4),
    ...many('apps/ui/sources/components/settings/pages', 64, 'SettingsPage'),
    ...many('apps/ui/sources/components/settings/sections', 21, 'Section'),
    ...many('apps/ui/sources/components/settings/shell', 21, 'Shell'),
    ...many('apps/ui/sources/components/settings/rows', 19, 'Row'),
    ...many('apps/ui/sources/components/ui', 41, 'Control'),
    ...many('apps/ui/sources/text/translations', 27, 'Copy'),
    ...many('packages/protocol/src/settings', 12, 'Schema'),
    ...many('docs', 5, 'Doc'),
    file('yarn.lock', 'modified', 0, 0),
].slice(0, 214);

const SESSION_FILES = [
    file('apps/ui/sources/app/(app)/settings.tsx', 'modified', 2, 2),
    file('apps/ui/sources/components/settings/SettingsModal.test.tsx', 'modified', 38, 1),
    file('apps/ui/sources/components/settings/SettingsModal.tsx', 'modified', 4, 2),
    file('apps/ui/sources/components/settings/SettingsSheet.tsx', 'modified', 1, 2),
    file('apps/ui/sources/components/settings/settingsRoutes.ts', 'modified', 3, 2),
    file('apps/ui/sources/components/settings/useSettingsRouteKey.ts', 'added', 21, 0),
    file('apps/ui/sources/components/ui/modal/useModalLayout.ts', 'modified', 4, 1),
    file('apps/ui/sources/text/en.ts', 'modified', 2, 0),
    file('yarn.lock', 'modified', 37, 8),
];
const SESSION_ATTRIBUTED: SessionAttributedFile[] = SESSION_FILES.map((entry) => ({
    file: entry,
    turns: ['turn-1', 'turn-2', 'turn-3'],
    content: { source: 'scm_checkpoint', confidence: 'exact' },
    attribution: { confidence: 'session_likely', reason: 'checkpoint_no_happier_overlap_observed' },
    checkpointOverlap: 'not_observed',
    evidence: [],
}));

function snapshotOf(files: readonly ScmFileStatus[]): ScmWorkingSnapshot {
    return {
        projectKey: 'specimen:/repo',
        fetchedAt: 0,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        branch: { head: 'settings-modal', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries: files.map((entry) => ({
            path: entry.fullPath,
            previousPath: null,
            kind: entry.status,
            includeStatus: '',
            pendingStatus: 'M',
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: entry.linesAdded, pendingRemoved: entry.linesRemoved, isBinary: false },
        })),
        totals: { includedFiles: 0, pendingFiles: files.length, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    };
}

const noop = () => {};
const AVAILABILITY = { showTurnViewToggle: true, showTurnAgentReportedViewToggle: false, showTurnCheckpointViewToggle: false, showSessionViewToggle: true };
const SCOPE_OPTIONS = listFilesComparisonScopeOptions(AVAILABILITY, 'turn-3', null, { pendingFileCount: 9, sessionFileCount: 9, latestTurnFileCount: 4 });
const SESSION_COMPARISON = { kind: 'session' } as const;

const EXPLAIN_READING = buildWalkthroughReading({
    comparison: SPECIMEN_COMPARISON,
    walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH },
    analysis: SPECIMEN_ANALYSIS_COMPLETE,
    reviewed: { v: 1, comparisonId: SPECIMEN_COMPARISON.id, reviewedChangeRefs: specimenReviewedRefs(2) },
});
const EXPLAIN_FILES: ScmFileStatus[] = SESSION_FILES.flatMap((entry) => {
    const row = EXPLAIN_READING.inventory.find((item) => item.path === entry.fullPath);
    return row ? [file(row.path, row.changeKind === 'added' ? 'added' : 'modified', row.added, row.removed)] : [];
});
const EXPLAIN_DIFFS: ReadonlyMap<string, string | null> = new Map(SPECIMEN_COMPARISON.inventory.files.map((entry) => [entry.path, entry.evidence.unifiedDiff ?? null] as const));
const EXPLAIN_SNAPSHOT = snapshotOf(EXPLAIN_FILES);
const EXPLAIN_ATTRIBUTED: SessionAttributedFile[] = EXPLAIN_FILES.map((entry) => ({ ...SESSION_ATTRIBUTED[0]!, file: entry }));

function FilesFrame(props: Readonly<{ stacked: boolean; explain?: boolean }>) {
    const { theme } = useUnistyles();
    const [explain, setExplain] = React.useState(props.explain === true);
    const chrome = React.useMemo(() => ({
        renderBar: props.stacked ? (coverage: ChangedFilesReviewCoverage, actions: React.ReactNode) => <ScmComparisonPhoneHeader
            view="files" views={['files', 'walkthrough']} scope={{ options: SCOPE_OPTIONS, current: SESSION_COMPARISON,
                currentLabel: t('scmComparison.scope.session'), fileCount: coverage.fileCount, onSelect: noop }}
            onSelectView={noop} onBack={noop} onStartReview={noop} extraActions={actions} /> : undefined,
        renderBarLeading: (coverage: ChangedFilesReviewCoverage) => (
            <>
            <ScmComparisonViewSwitch view="files" views={['files', 'walkthrough']} onSelect={noop} />
            <ScmComparisonScopePicker
                options={SCOPE_OPTIONS}
                current={SESSION_COMPARISON}
                currentLabel={t('scmComparison.scope.session')}
                fileCount={coverage.fileCount}
                onSelect={noop}
            />
            </>
        ),
        barTrailing: <ScmComparisonStartReview onPress={noop} />,
        renderHeader: (coverage: ChangedFilesReviewCoverage) => (
            <ScmComparisonHeader
                viewLabel={t('scmComparison.view.files')}
                scopeLabel={t('scmComparison.scope.session')}
                scopeDetail={`${t('scmComparison.since', { time: '09:40' })} · ${t('scmComparison.turnsWithChanges', { count: 3 })}`}
                title={EXPLAIN_READING.title}
                coverage={coverage}
                changeCount={EXPLAIN_READING.source.changeCount}
                analysis={EXPLAIN_READING.analysis ? <WalkthroughAnalysisFact analysed={EXPLAIN_READING.analysis.analysed} total={EXPLAIN_READING.analysis.total} model="Opus 5.5" /> : null}
                reviewed={<WalkthroughReviewedFact count={EXPLAIN_READING.reviewedCount} total={EXPLAIN_READING.stops.length} />}
                stacked={props.stacked}
                accessory={(
                    <>
                        <ScmComparisonExplainToggle value={explain} onChange={setExplain} />
                        {props.stacked ? <ChangedFilesLayoutSwitch testIDPrefix="scm-comparison-layout" /> : null}
                    </>
                )}
            />
        ),
        indexPlacement: props.stacked ? 'phone' as const : 'rail' as const,
        rootPath: '/repo',
        hunkNotesColumnWidth: WALKTHROUGH_EXPLAIN_COLUMN_WIDTH_PX,
        renderHunkNotes: explain
            ? (path: string, hunkIndex: number, placement: 'column' | 'inline') => <WalkthroughExplainNotes reading={EXPLAIN_READING} path={path} hunkIndex={hunkIndex} placement={placement} onReadInWalkthrough={noop} />
            : null,
    }), [explain, props.stacked]);
    return (
        <ChangedFilesReview
            comparisonChrome={chrome}
            detailsHeader={DETAILS_HEADER}
            theme={theme}
            sessionId="specimen-session"
            snapshot={EXPLAIN_SNAPSHOT}
            changedFilesViewMode="session"
            allRepositoryChangedFiles={EXPLAIN_FILES}
            sessionAttributedFiles={EXPLAIN_ATTRIBUTED}
            repositoryOnlyFiles={[]}
            maxFiles={50}
            maxChangedLines={5000}
            onFilePress={noop}
            rowDensity="compact"
            providerDiffByPath={EXPLAIN_DIFFS}
        />
    );
}
const DETAILS_HEADER = { isSelectedForCommit: null } as const;
/** Walkthrough frames own a pinned phone bar, so on a phone they fill the viewport exactly. */
const WALKTHROUGH_FRAME_IDS = new Set([...WALKTHROUGH_SPECIMEN_FRAMES, ...COMMITS_SPECIMEN_FRAMES, ...REVIEW_WALKTHROUGH_SPECIMEN_FRAMES, ...PULL_REQUEST_SPECIMEN_FRAMES].map((frame) => frame.id));

type Frame = Readonly<{ id: string; title: string; render: (phone: boolean) => React.ReactElement; tall?: boolean }>;

const FRAMES: readonly Frame[] = [
    { id: 'T1', title: 'WT9-T1 · collapsed', render: () => <TurnChangesCard files={TURN_FOUR} onOpenFile={noop} onWalkThrough={noop} onOpenInFiles={noop} /> },
    { id: 'T2', title: 'WT9-T2/T3 · open (list | tree follows the shared preference)', render: () => <TurnChangesCard files={TURN_FOUR} onOpenFile={noop} onWalkThrough={noop} onOpenInFiles={noop} initiallyOpen /> },
    { id: 'T4', title: 'WT9-T4 · 214 files open', render: () => <TurnChangesCard files={TURN_BIG} onOpenFile={noop} onWalkThrough={noop} onOpenInFiles={noop} initiallyOpen />, tall: true },
    { id: 'T4c', title: 'WT9-T4c · 214 files collapsed', render: () => <TurnChangesCard files={TURN_BIG} onOpenFile={noop} onWalkThrough={noop} onOpenInFiles={noop} /> },
    { id: 'F1', title: 'WT8-F1/F3 · Files (rail on wide, stream list on narrow)', render: (phone) => <FilesFrame stacked={phone} />, tall: true },
    { id: 'F2', title: 'WT8-F2 · Files with Explain', render: (phone) => <FilesFrame stacked={phone} explain />, tall: true },
    ...WALKTHROUGH_SPECIMEN_FRAMES.map((frame) => ({ ...frame, tall: true })),
    ...COMMITS_SPECIMEN_FRAMES.map((frame) => ({ ...frame, tall: true })),
    ...REVIEW_WALKTHROUGH_SPECIMEN_FRAMES.map((frame) => ({ ...frame, tall: true })),
    ...PULL_REQUEST_SPECIMEN_FRAMES.map((frame) => ({ ...frame, tall: true })),
];

export function ChangesSpecimen(props: Readonly<{ only: string | null; phone: boolean }>) {
    const frames = props.only ? FRAMES.filter((frame) => frame.id === props.only) : FRAMES;
    // Files and Walkthrough frames fill the viewport like a details tab; cards sit in a transcript column.
    const isFiles = (frame: Frame) => !frame.id.startsWith('T');
    const content = (
        <View style={styles.grid}>
            {frames.map((frame) => (
                <View
                    key={frame.id}
                    testID={`changes-specimen-${frame.id}`}
                    style={isFiles(frame)
                        ? (props.phone ? (WALKTHROUGH_FRAME_IDS.has(frame.id) ? styles.walkthroughFramePhone : styles.filesFramePhone) : styles.filesFrame)
                        : (props.phone ? styles.cardFramePhone : styles.cardFrame)}
                >
                    {props.only ? null : <Text style={styles.caption}>{frame.title}</Text>}
                    {frame.render(props.phone)}
                </View>
            ))}
        </View>
    );
    const body = props.only && frames.every(isFiles)
        ? <View style={[styles.root, styles.contentFlush]}>{content}</View>
        : <ScrollView style={styles.root} contentContainerStyle={props.only ? styles.contentFlush : styles.content}>{content}</ScrollView>;
    return props.phone ? <SurfaceStateSizeProvider size="phone">{body}</SurfaceStateSizeProvider> : body;
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.base },
    content: { padding: 16, gap: 24 },
    contentFlush: { flex: 1, padding: 0 },
    grid: { flex: 1, gap: 24 },
    caption: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.text.secondary, paddingVertical: 8 },
    // The transcript column the lab draws the card in (about 640 px of a 1440 desktop).
    cardFrame: { width: 666, alignSelf: 'center', paddingVertical: 12 },
    cardFramePhone: { width: '100%', paddingHorizontal: 16, paddingVertical: 12 },
    filesFrame: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
    filesFramePhone: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
    walkthroughFramePhone: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
}));
