import * as React from 'react';
import { View } from 'react-native';

import { ScmComparisonBar, SCM_COMPARISON_ACTIONS_GAP_PX, ScmComparisonExplainToggle, ScmComparisonStartReview, ScmComparisonViewSwitch } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { ScmComparisonHeader } from '@/components/sessions/files/comparison/ScmComparisonHeader';
import { ScmComparisonPhoneHeader, type ScmComparisonMenuSection } from '@/components/sessions/files/comparison/ScmComparisonPhoneHeader';
import { ScmComparisonMoreMenu } from '@/components/sessions/files/comparison/ScmComparisonMoreMenu';
import { ScmComparisonScopePicker } from '@/components/sessions/files/comparison/ScmComparisonScopePicker';
import type { FilesComparisonScopeOption } from '@/components/sessions/files/comparison/filesComparison';
import { WalkthroughAnalysisFact, WalkthroughReviewedFact } from '@/components/sessions/files/walkthrough/WalkthroughAtoms';
import { WalkthroughExplainNotes, WalkthroughFileStops, WALKTHROUGH_EXPLAIN_COLUMN_WIDTH_PX } from '@/components/sessions/files/walkthrough/WalkthroughExplainNotes';
import type { WalkthroughReading } from '@/components/sessions/files/walkthrough/walkthroughReading';
import type { WalkthroughViewLayout } from '@/components/sessions/files/walkthrough/WalkthroughView';
import { ChangedFilesLayoutSwitch } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { useScmComparisonLayout } from './useScmComparisonLayout';
import { resolveSessionScmReviewViewLabel, type SessionScmReviewComparison, type SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import { acknowledgeActiveReviewFileRequest, publishActiveReviewFile, readActiveReviewFile, requestActiveReviewFile, useActiveReviewFileRequest } from '@/components/workspaces/scm/review/activeReviewFile';
import { scmComparisonKey } from '@/components/sessions/files/comparison/filesComparison';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

export type ScmReviewComparisonChrome = NonNullable<React.ComponentProps<typeof ChangedFilesReview>['comparisonChrome']>;
export type ScmReviewViewContext = Readonly<{
    layout: WalkthroughViewLayout;
    /**
     * The bar with a view's own actions and its menu rows (the wide `⋯`; on a phone, rows of the comparison menu).
     * `review` is the review's status once one exists (lab WT5-R6): it takes Start review's place on the wide bar,
     * and Start review moves into the `⋯`.
     */
    renderBar: (actions?: React.ReactNode, sections?: readonly ScmComparisonMenuSection[], review?: React.ReactNode) => React.ReactNode;
    onShowFiles: () => void;
}>;

export type WorkspaceScmReviewBodyProps = Readonly<{
    comparison: SessionScmReviewComparison | null;
    view: SessionScmReviewView;
    views?: readonly SessionScmReviewView[];
    scopeLabel: string;
    scopeDetail?: string | null;
    scopeOptions: readonly FilesComparisonScopeOption[];
    evidenceSessionId?: string;
    onSelectComparison: (comparison: SessionScmReviewComparison, evidenceSessionId?: string) => void;
    onSelectView: (view: SessionScmReviewView) => void;
    activeReviewFile?: Readonly<{ key: string; navigationKey?: string; presented: boolean }>;
    rootPath?: string | null;
    fileCount?: number | null;
    changeCount?: number | null;
    reading?: WalkthroughReading | null;
    modelLabel?: string | null;
    /** The writing Agent's mark beside "Opus 5.5 read all 14", when its run names one. */
    analysisMark?: React.ReactNode;
    marksAvailable?: boolean;
    /** The Account marks are still being read: the reviewed fact holds its room, unseen. */
    marksPending?: boolean;
    explain: boolean;
    onExplainChange: (value: boolean) => void;
    onExplainDraft?: () => void;
    commitsCount?: number | null;
    onProposeCommits?: (() => void) | null;
    proposeCommits?: React.ReactNode;
    onStartReview?: () => void;
    reviewDisabled?: boolean;
    reviewDisabledReason?: string | null;
    renderFiles: (chrome: ScmReviewComparisonChrome) => React.ReactNode;
    onVisibleFileRowCountChange?: (count: number) => void;
    filesState?: React.ReactNode;
    renderWalkthrough: (context: ScmReviewViewContext) => React.ReactNode;
    renderCommits?: (context: ScmReviewViewContext) => React.ReactNode;
    /**
     * The host's mode control (the Project page's Review | Git). It leads the one comparison bar, so a
     * host's mode and the review's views sit on one line; a stacked header keeps it on its own line above.
     */
    hostSwitch?: React.ReactNode;
    /** The host's own Files bar actions (the review comments disclosure), first in the bar's action group. */
    barActions?: React.ReactNode;
    /** The region a bar action opens (review comments): drawn under the Files bar, above the files. */
    barPanel?: React.ReactNode;
    /** The host's own switch beside the header's facts (a Review's Hide viewed), after Explain. */
    headerAccessory?: React.ReactNode;
    /** The same host actions as rows of the Files menu (the bar's ⋯, or the phone header's menu). */
    barMenuSection?: ScmComparisonMenuSection | null;
}>;

const REVIEW_VIEWS: readonly SessionScmReviewView[] = ['files', 'walkthrough'];
// The host control and the view switch read as one group, divided like the view switch from the scope.
const HOST_SWITCH_STYLE = { flexDirection: 'row', alignItems: 'center' } as const;
const HOST_SWITCH_STACKED_STYLE = { paddingHorizontal: 12, paddingTop: 8 } as const;

/** Explicit list navigation may choose a comparison; restoration stays on the tab's own channel. */
function useReviewFileRequest(requestKey: string | null, activeKey: string | null,
    props: WorkspaceScmReviewBodyProps, presented: boolean) {
    const focus = useActiveReviewFileRequest(requestKey);
    const handledFocus = React.useRef(focus?.comparison ? null : focus?.nonce ?? null);
    React.useEffect(() => {
        if (!focus || !presented || handledFocus.current === focus.nonce) return;
        if (focus.comparison && (!props.comparison || scmComparisonKey(focus.comparison) !== scmComparisonKey(props.comparison))) {
            props.onSelectComparison(focus.comparison);
            return;
        }
        if (focus.comparison && props.view !== 'files') {
            props.onSelectView('files');
            return;
        }
        handledFocus.current = focus.nonce;
        if (requestKey && focus.comparison) acknowledgeActiveReviewFileRequest(requestKey, focus.nonce);
        if (activeKey && requestKey !== activeKey) requestActiveReviewFile(activeKey, focus.path);
        props.onSelectView('files');
    }, [focus, presented, requestKey, activeKey, props.comparison, props.view, props.onSelectComparison, props.onSelectView]);
}

/** One comparison's Files/Walkthrough presentation. Hosts supply admitted evidence and effects. */
export const WorkspaceScmReviewBody = React.memo(function WorkspaceScmReviewBody(props: WorkspaceScmReviewBodyProps) {
    const activeKey = props.activeReviewFile?.key ?? null;
    const navigationKey = props.activeReviewFile?.navigationKey ?? null;
    const presenterId = React.useId();
    const presented = props.activeReviewFile?.presented === true;
    React.useEffect(() => {
        if (!activeKey) return;
        const activePath = readActiveReviewFile(activeKey).activePath;
        for (const key of [activeKey, navigationKey]) {
            if (key) publishActiveReviewFile(key, { presented, activePath, presenterId });
        }
        return () => {
            for (const key of [activeKey, navigationKey]) {
                if (key) publishActiveReviewFile(key, { presented: false, activePath: null, presenterId });
            }
        };
    }, [activeKey, navigationKey, presented, presenterId]);
    useReviewFileRequest(activeKey, activeKey, props, presented);
    useReviewFileRequest(navigationKey, activeKey, props, presented);
    const { onLayout, stacked, rail, visibleFileRowCount } = useScmComparisonLayout();
    React.useEffect(() => {
        if (presented && props.view === 'files' && visibleFileRowCount !== null) props.onVisibleFileRowCountChange?.(visibleFileRowCount);
    }, [presented, props.view, visibleFileRowCount, props.onVisibleFileRowCountChange]);
    const views = props.views ?? REVIEW_VIEWS;
    const reading = props.reading;
    // Explicit code navigation reveals the active file; a view switch retains Files' own scroll and folding.
    const showFiles = React.useCallback(() => {
        if (activeKey) {
            const path = readActiveReviewFile(activeKey).activePath;
            if (path) requestActiveReviewFile(activeKey, path);
        }
        props.onSelectView('files');
    }, [activeKey, props.onSelectView]);
    const readInWalkthrough = React.useCallback(() => props.onSelectView('walkthrough'), [props.onSelectView]);
    const { chrome, renderBar, renderStateBar } = React.useMemo(() => {
        // An empty comparison says so once, in the review's own empty state: the bar and the stacked header
        // keep the scope's name but don't add "0 files" beside it.
        const countShown = (fileCount: number | null) => (fileCount === 0 ? null : fileCount);
        const renderLeading = (fileCount: number | null) => <>
            {props.hostSwitch ? <View style={HOST_SWITCH_STYLE}>{props.hostSwitch}</View> : null}
            <ScmComparisonViewSwitch view={props.view} views={views} onSelect={props.onSelectView} commitsCount={props.commitsCount} />
            <ScmComparisonScopePicker options={props.scopeOptions} current={props.comparison} currentLabel={props.scopeLabel}
                currentEvidenceSessionId={props.evidenceSessionId}
                fileCount={countShown(fileCount)} onSelect={props.onSelectComparison} />
        </>;
        // A comparison with no changes has nothing to review or to commit: no action is offered for it.
        const noChanges = props.fileCount === 0;
        const onStartReview = noChanges ? undefined : props.onStartReview;
        const proposeCommits = noChanges ? null : props.proposeCommits;
        const onProposeCommits = noChanges ? null : props.onProposeCommits;
        const trailing = <>
            {onStartReview ? <ScmComparisonStartReview disabled={props.reviewDisabled} disabledReason={props.reviewDisabledReason}
                onPress={onStartReview} /> : null}
            {proposeCommits}
        </>;
        // Once a review exists its status holds Start review's place (lab WT5-R6), so the bar stays one row; a
        // second review is still one choice away, as the first row of the `⋯`.
        const startReviewSection: ScmComparisonMenuSection | null = onStartReview ? {
            id: 'review',
            items: [{ id: 'start', testID: 'scm-comparison-start-review', title: t('scmComparison.startReview'),
                disabled: props.reviewDisabled, subtitle: props.reviewDisabledReason ?? undefined }],
            onSelect: () => { if (!props.reviewDisabled) onStartReview(); },
        } : null;
        // The phone menu already lists Start review and Propose commits as rows; only the view's own parts join it.
        const renderPhoneHeader = (fileCount: number | null, actions?: React.ReactNode, sections?: readonly ScmComparisonMenuSection[], fileActions = true) => <ScmComparisonPhoneHeader
            view={props.view} views={views} scope={{ options: props.scopeOptions, current: props.comparison,
                currentEvidenceSessionId: props.evidenceSessionId,
                currentLabel: props.scopeLabel, fileCount: countShown(fileCount), onSelect: props.onSelectComparison }}
            onSelectView={props.onSelectView}
            onStartReview={noChanges ? null : onStartReview ?? (() => {})} reviewDisabled={props.reviewDisabled || !onStartReview || !fileActions}
            reviewDisabledReason={props.reviewDisabledReason} onProposeCommits={fileActions ? onProposeCommits : null} extraActions={actions} sections={sections} />;
        // The host's actions belong to the files they act on (the review comments panel opens over Files).
        const withBarMenu = (sections?: readonly ScmComparisonMenuSection[]) => props.barMenuSection ? [props.barMenuSection, ...(sections ?? [])] : sections;
        const renderBar = (actions?: React.ReactNode, sections?: readonly ScmComparisonMenuSection[], review?: React.ReactNode) => {
            if (stacked) return renderPhoneHeader(props.fileCount ?? reading?.source.fileCount ?? null, <>{actions}{review}</>, sections);
            const menu = review && startReviewSection ? [startReviewSection, ...(sections ?? [])] : sections;
            return <ScmComparisonBar leading={renderLeading(props.fileCount ?? null)}
                trailing={<>{actions}{review ? <>{review}{proposeCommits}</> : trailing}{menu ? <ScmComparisonMoreMenu sections={menu} interactiveTargetGapPx={SCM_COMPARISON_ACTIONS_GAP_PX} /> : null}</>} />;
        };
        // While a state stands in for the files (loading, not a repository, unreachable), the bar keeps its
        // place and its views, but nothing offers to act on files that are not there.
        const renderStateBar = () => stacked
            ? renderPhoneHeader(null, undefined, undefined, false)
            : <ScmComparisonBar leading={renderLeading(null)} trailing={props.barActions} />;
        const chrome: ScmReviewComparisonChrome = {
            // On a phone the stacked header under this one counts the files; the phone header names only the scope.
            renderBar: stacked ? (_coverage, actions, sections) => renderPhoneHeader(null, actions, withBarMenu(sections)) : undefined,
            renderBarLeading: (coverage) => renderLeading(coverage.fileCount),
            barTrailing: <>{props.barActions}{trailing}</>,
            belowBar: props.barPanel,
            menuSections: props.barMenuSection ? [props.barMenuSection] : undefined,
            // An empty comparison has nothing to head or explain: the review's own empty state stands alone.
            renderHeader: (coverage, facts) => coverage.fileCount === 0 && !reading ? null : <><ScmComparisonHeader
                viewLabel={resolveSessionScmReviewViewLabel(props.view)} scopeLabel={props.scopeLabel} scopeDetail={props.scopeDetail}
                title={reading?.title ?? null} coverage={coverage} changeCount={props.changeCount ?? reading?.source.changeCount ?? null}
                analysis={reading?.analysis ? <WalkthroughAnalysisFact parts={reading.analysis.parts} analysed={reading.analysis.analysed}
                    total={reading.analysis.total} model={props.modelLabel} stopped={reading.phase === 'cancelled' || reading.phase === 'failed'}
                    unavailableCount={reading.source.unavailableCount} mark={props.analysisMark} /> : null}
                reviewed={<>{reading && (props.marksAvailable || props.marksPending) ? <WalkthroughReviewedFact count={reading.reviewedCount} total={reading.stops.length} pending={!props.marksAvailable} /> : null}
                    {facts?.viewed ?? null}</>}
                stacked={stacked} accessory={<>
                    {reading ? <ScmComparisonExplainToggle value={props.explain} onChange={props.onExplainChange} /> : null}
                    {props.headerAccessory ?? null}
                    {stacked ? <ChangedFilesLayoutSwitch testIDPrefix="scm-comparison-layout" /> : null}
                </>} />
                {/* No walkthrough from the session that made these changes: Files offers one (lab p-changes FILES). */}
                {/* On the header's own inset, so its mark and Explain line up with "Files" above, not the rail's edge. */}
                {!reading && props.onExplainDraft ? <View style={{ paddingVertical: 8, paddingHorizontal: stacked ? 16 : 24 }}>
                    <SurfaceStateCard testID="scm-comparison-explain-with-agent" kind="empty" layout="inline" iconName="sparkle"
                        title={t('projects.review.noWalkthroughTitle')}
                        reason={t('projects.review.noWalkthroughBody', { count: coverage.fileCount ?? 0 })}
                        action={{ label: t('projects.review.explain'), onPress: props.onExplainDraft,
                            testID: 'scm-comparison-explain-with-agent-action' }} />
                </View> : null}</>,
            indexPlacement: stacked ? 'phone' : rail ? 'rail' : 'stream',
            rootPath: props.rootPath,
            renderHunkNotes: props.explain && reading ? (path, hunkIndex, placement) => <WalkthroughExplainNotes
                reading={reading} path={path} hunkIndex={hunkIndex} placement={placement} onReadInWalkthrough={readInWalkthrough} /> : null,
            hunkNotesColumnWidth: WALKTHROUGH_EXPLAIN_COLUMN_WIDTH_PX,
            renderIndexAccessory: props.explain && reading ? (path) => <WalkthroughFileStops reading={reading} path={path} /> : null,
        };
        return { chrome, renderBar, renderStateBar };
    }, [stacked, rail, views, reading, readInWalkthrough, props.hostSwitch, props.view, props.onSelectView,
        props.commitsCount, props.scopeOptions, props.comparison, props.scopeLabel, props.evidenceSessionId,
        props.onSelectComparison, props.fileCount, props.onStartReview, props.proposeCommits, props.onProposeCommits,
        props.reviewDisabled, props.reviewDisabledReason, props.barMenuSection, props.barActions, props.barPanel, props.headerAccessory,
        props.scopeDetail, props.changeCount, props.modelLabel, props.analysisMark, props.marksAvailable,
        props.marksPending, props.explain, props.onExplainChange, props.onExplainDraft, props.rootPath]);
    const context: ScmReviewViewContext = { layout: stacked ? 'phone' : rail ? 'wide' : 'narrow', renderBar, onShowFiles: showFiles };
    return <View style={{ flex: 1, minHeight: 0 }} onLayout={onLayout}>
        {stacked && props.hostSwitch ? <View style={HOST_SWITCH_STACKED_STYLE}>{props.hostSwitch}</View> : null}
        {props.view === 'walkthrough' ? props.renderWalkthrough(context)
            : props.view === 'commits' && props.renderCommits ? props.renderCommits(context)
                : props.filesState ? <>{renderStateBar()}{props.filesState}</> : props.renderFiles(chrome)}
    </View>;
});
