import * as React from 'react';
import { View } from 'react-native';

import { ScmComparisonBar, ScmComparisonExplainToggle, ScmComparisonStartReview, ScmComparisonViewSwitch } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { ScmComparisonHeader } from '@/components/sessions/files/comparison/ScmComparisonHeader';
import { ScmComparisonPhoneHeader } from '@/components/sessions/files/comparison/ScmComparisonPhoneHeader';
import { ScmComparisonScopePicker } from '@/components/sessions/files/comparison/ScmComparisonScopePicker';
import type { FilesComparisonScopeOption } from '@/components/sessions/files/comparison/filesComparison';
import { WalkthroughAnalysisFact, WalkthroughReviewedFact } from '@/components/sessions/files/walkthrough/WalkthroughAtoms';
import { WalkthroughExplainNotes, WALKTHROUGH_EXPLAIN_COLUMN_WIDTH_PX } from '@/components/sessions/files/walkthrough/WalkthroughExplainNotes';
import type { WalkthroughReading } from '@/components/sessions/files/walkthrough/walkthroughReading';
import type { WalkthroughViewLayout } from '@/components/sessions/files/walkthrough/WalkthroughView';
import { ChangedFilesLayoutSwitch } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { resolveSessionScmReviewViewLabel, type SessionScmReviewComparison, type SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import { acknowledgeActiveReviewFileRequest, publishActiveReviewFile, readActiveReviewFile, requestActiveReviewFile, useActiveReviewFileRequest } from '@/components/workspaces/scm/review/activeReviewFile';
import { scmComparisonKey } from '@/components/sessions/files/comparison/filesComparison';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

export type ScmReviewComparisonChrome = NonNullable<React.ComponentProps<typeof ChangedFilesReview>['comparisonChrome']>;
export type ScmReviewViewContext = Readonly<{
    layout: WalkthroughViewLayout;
    renderBar: (actions?: React.ReactNode) => React.ReactNode;
    onShowFiles: () => void;
}>;

export type WorkspaceScmReviewBodyProps = Readonly<{
    comparison: SessionScmReviewComparison | null;
    view: SessionScmReviewView;
    views?: readonly SessionScmReviewView[];
    scopeLabel: string;
    scopeDetail?: string | null;
    scopeOptions: readonly FilesComparisonScopeOption[];
    onSelectComparison: (comparison: SessionScmReviewComparison) => void;
    onSelectView: (view: SessionScmReviewView) => void;
    onClose?: () => void;
    activeReviewFile?: Readonly<{ key: string; presented: boolean }>;
    rootPath?: string | null;
    fileCount?: number | null;
    changeCount?: number | null;
    reading?: WalkthroughReading | null;
    modelLabel?: string | null;
    marksAvailable?: boolean;
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
    filesState?: React.ReactNode;
    renderWalkthrough: (context: ScmReviewViewContext) => React.ReactNode;
    renderCommits?: (context: ScmReviewViewContext) => React.ReactNode;
}>;

const REVIEW_VIEWS: readonly SessionScmReviewView[] = ['files', 'walkthrough'];
// Existing comparison geometry, shared by every host rather than decided in each adapter.
const COMPARISON_RAIL_MIN_WIDTH_PX = 860;
const COMPARISON_STACKED_MAX_WIDTH_PX = 560;

/** One comparison's Files/Walkthrough presentation. Hosts supply admitted evidence and effects. */
export const WorkspaceScmReviewBody = React.memo(function WorkspaceScmReviewBody(props: WorkspaceScmReviewBodyProps) {
    const activeKey = props.activeReviewFile?.key ?? null;
    const presented = props.activeReviewFile?.presented === true;
    const focus = useActiveReviewFileRequest(activeKey);
    React.useEffect(() => {
        if (!activeKey) return;
        publishActiveReviewFile(activeKey, { presented, activePath: readActiveReviewFile(activeKey).activePath });
        return () => { publishActiveReviewFile(activeKey, { presented: false, activePath: null }); };
    }, [activeKey, presented]);
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
        if (activeKey && focus.comparison) acknowledgeActiveReviewFileRequest(activeKey, focus.nonce);
        props.onSelectView('files');
    }, [focus, presented, activeKey, props.comparison, props.view, props.onSelectComparison, props.onSelectView]);
    const [width, setWidth] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setWidth((previous) => previous === next ? previous : next);
    }, []);
    const stacked = width !== null && width < COMPARISON_STACKED_MAX_WIDTH_PX;
    const rail = width !== null && width >= COMPARISON_RAIL_MIN_WIDTH_PX;
    const views = props.views ?? REVIEW_VIEWS;
    const reading = props.reading;
    const showFiles = React.useCallback(() => {
        if (activeKey) {
            const path = readActiveReviewFile(activeKey).activePath;
            if (path) requestActiveReviewFile(activeKey, path);
        }
        props.onSelectView('files');
    }, [activeKey, props.onSelectView]);
    const readInWalkthrough = React.useCallback(() => props.onSelectView('walkthrough'), [props.onSelectView]);
    const selectView = React.useCallback((view: SessionScmReviewView) => {
        if (view === 'files') showFiles();
        else props.onSelectView(view);
    }, [showFiles, props.onSelectView]);
    const renderLeading = (fileCount: number | null) => <>
        <ScmComparisonViewSwitch view={props.view} views={views} onSelect={selectView} commitsCount={props.commitsCount} />
        <ScmComparisonScopePicker options={props.scopeOptions} current={props.comparison} currentLabel={props.scopeLabel}
            fileCount={fileCount} onSelect={props.onSelectComparison} />
    </>;
    const trailing = <>
        {props.onStartReview ? <ScmComparisonStartReview disabled={props.reviewDisabled} disabledReason={props.reviewDisabledReason}
            onPress={props.onStartReview} /> : null}
        {props.proposeCommits}
    </>;
    const renderPhoneHeader = (fileCount: number | null, actions?: React.ReactNode) => <ScmComparisonPhoneHeader
        view={props.view} views={views} scope={{ options: props.scopeOptions, current: props.comparison,
            currentLabel: props.scopeLabel, fileCount, onSelect: props.onSelectComparison }}
        onSelectView={selectView} onBack={props.onClose ?? (() => {})}
        onStartReview={props.onStartReview ?? (() => {})} reviewDisabled={props.reviewDisabled || !props.onStartReview}
        reviewDisabledReason={props.reviewDisabledReason} onProposeCommits={props.onProposeCommits} extraActions={<>{actions}{trailing}</>} />;
    const renderBar = (actions?: React.ReactNode) => stacked
        ? renderPhoneHeader(props.fileCount ?? reading?.source.fileCount ?? null, actions)
        : <ScmComparisonBar leading={renderLeading(props.fileCount ?? null)} trailing={<>{actions}{trailing}</>} />;
    const chrome: ScmReviewComparisonChrome = {
        renderBar: stacked ? (coverage, actions) => renderPhoneHeader(coverage.fileCount, actions) : undefined,
        renderBarLeading: (coverage) => renderLeading(coverage.fileCount),
        barTrailing: trailing,
        renderHeader: (coverage) => <><ScmComparisonHeader
            viewLabel={resolveSessionScmReviewViewLabel(props.view)} scopeLabel={props.scopeLabel} scopeDetail={props.scopeDetail}
            title={reading?.title ?? null} coverage={coverage} changeCount={props.changeCount ?? reading?.source.changeCount ?? null}
            analysis={reading?.analysis ? <WalkthroughAnalysisFact parts={reading.analysis.parts} analysed={reading.analysis.analysed}
                total={reading.analysis.total} model={props.modelLabel} stopped={reading.phase === 'cancelled' || reading.phase === 'failed'}
                unavailableCount={reading.source.unavailableCount} /> : null}
            reviewed={reading && props.marksAvailable ? <WalkthroughReviewedFact count={reading.reviewedCount} total={reading.stops.length} /> : null}
            stacked={stacked} accessory={<>
                {reading ? <ScmComparisonExplainToggle value={props.explain} onChange={props.onExplainChange} /> : null}
                {stacked ? <ChangedFilesLayoutSwitch testIDPrefix="scm-comparison-layout" /> : null}
            </>} />
            {/* No walkthrough from the session that made these changes: Files offers one (lab p-changes FILES). */}
            {!reading && props.onExplainDraft ? <View style={{ paddingVertical: 8 }}>
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
    };
    const context: ScmReviewViewContext = { layout: stacked ? 'phone' : rail ? 'wide' : 'narrow', renderBar, onShowFiles: showFiles };
    return <View style={{ flex: 1, minHeight: 0 }} onLayout={onLayout}>
        {props.view === 'walkthrough' ? props.renderWalkthrough(context)
            : props.view === 'commits' && props.renderCommits ? props.renderCommits(context)
                : props.filesState ? <>{renderBar()}{props.filesState}</> : props.renderFiles(chrome)}
    </View>;
});
