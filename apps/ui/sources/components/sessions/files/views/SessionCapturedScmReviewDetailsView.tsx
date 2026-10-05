import * as React from 'react';
import { View } from 'react-native';
import type { SessionScmReviewDetailsViewProps } from './SessionScmReviewDetailsView';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionScmReviewDetailsTab, type SessionScmReviewComparison, type SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { useSessionCapturedScmComparison } from '@/components/sessions/files/comparison/useSessionCapturedScmComparison';
import { CapturedComparisonFilesView } from '@/components/sessions/files/comparison/CapturedComparisonFilesView';
import { ScmComparisonBar, ScmComparisonExplainToggle, ScmComparisonStartReview, ScmComparisonViewSwitch } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { ScmComparisonScopePicker } from '@/components/sessions/files/comparison/ScmComparisonScopePicker';
import { ScmComparisonPhoneHeader } from '@/components/sessions/files/comparison/ScmComparisonPhoneHeader';
import { ScmComparisonHeader } from '@/components/sessions/files/comparison/ScmComparisonHeader';
import { listFilesComparisonScopeOptions, resolveFilesComparisonLabel } from '@/components/sessions/files/comparison/filesComparison';
import { useSessionScmReviewTabState } from '@/components/sessions/files/comparison/useSessionScmReviewTabState';
import { SessionWalkthroughView } from '@/components/sessions/files/walkthrough/SessionWalkthroughView';
import { useSessionScmWalkthrough } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';
import { buildWalkthroughReading } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { WalkthroughExplainNotes, WALKTHROUGH_EXPLAIN_COLUMN_WIDTH_PX } from '@/components/sessions/files/walkthrough/WalkthroughExplainNotes';
import { WalkthroughAnalysisFact, WalkthroughReviewedFact } from '@/components/sessions/files/walkthrough/WalkthroughAtoms';
import { useWalkthroughReviewedMarks } from '@/components/sessions/files/walkthrough/useWalkthroughReviewedMarks';
import { ChangedFilesLayoutSwitch } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { presentStartReviewDialog } from '@/components/sessions/reviews/walkthrough/StartReviewDialog';
import { useReviewComposerHandoff } from '@/components/sessions/reviews/comments/useReviewComposerHandoff';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { WalkthroughNotice } from '@/components/sessions/files/walkthrough/WalkthroughLifecycle';
import { useSession, useSetting } from '@/sync/domains/state/storage';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { t } from '@/text';
import type { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';

const VIEWS: readonly SessionScmReviewView[] = ['files', 'walkthrough'];
const NO_LOCAL_SCOPES = { showTurnViewToggle: false, showTurnAgentReportedViewToggle: false, showTurnCheckpointViewToggle: false, showSessionViewToggle: false };

/** Historical comparisons never mount the live checkout status, polling, selection or discard owners. */
export function SessionCapturedScmReviewDetailsView(props: SessionScmReviewDetailsViewProps & Readonly<{ comparison: SessionScmReviewComparison }>) {
    const session = useSession(props.sessionId);
    const latestTurnId = (!props.serverId || session?.serverId === props.serverId) ? session?.latestTurnId ?? null : null;
    const pane = useAppPaneScope(props.scopeId);
    const goToComposer = useReviewComposerHandoff(props.scopeId);
    const { machineReachable } = useSessionMachineReachability(props.sessionId, props.serverId);
    const reviewDisabledReason = machineReachable ? null : t('walkthrough.notice.offlineA11y');
    const view = props.target?.view === 'walkthrough' ? 'walkthrough' : 'files';
    const walkthrough = useSessionScmWalkthrough(props.sessionId, props.comparison, 'walkthrough', props.serverId);
    const captured = useSessionCapturedScmComparison({ sessionId: props.sessionId, serverId: props.serverId,
        comparison: props.comparison, active: props.active !== false,
        knownComparison: view === 'walkthrough' || props.comparison.comparisonId ? walkthrough?.comparison : null });
    const comparison = React.useMemo(() => captured.comparison
        ? { ...props.comparison, comparisonId: captured.comparison.id } : props.comparison, [props.comparison, captured.comparison?.id]);
    const scopeLabel = resolveFilesComparisonLabel(comparison, null);
    const marks = useWalkthroughReviewedMarks({ comparison: view === 'files' ? captured.comparison : null, serverId: props.serverId ?? null });
    const marksAvailable = marks.record?.comparisonId === captured.comparison?.id && marks.record !== null && marks.unavailableReason === null;
    const reading = React.useMemo(() => walkthrough?.comparison && walkthrough.comparison.id === comparison.comparisonId && walkthrough.outputs?.walkthrough?.value
        ? buildWalkthroughReading({ comparison: walkthrough.comparison, walkthrough: walkthrough.outputs.walkthrough,
            analysis: walkthrough.analysis, reviewed: marksAvailable ? marks.record : null }) : null, [walkthrough, comparison.comparisonId, marksAvailable, marks.record]);
    const [width, setWidth] = React.useState(0);
    const phone = width > 0 && width < 560;
    const indexPlacement = width >= 860 ? 'rail' : phone ? 'phone' : 'stream';
    const maxFilesSetting = useSetting('scmReviewMaxFiles');
    const maxLinesSetting = useSetting('scmReviewMaxChangedLines');
    const { mountedInitialReviewState, explain, setExplain,
        onCollapsedPathsChange, onScrollTopChange } = useSessionScmReviewTabState(props.sessionId, pane, props.target);
    const selectView = React.useCallback((next: SessionScmReviewView) => pane.openDetailsTab(
        createSessionScmReviewDetailsTab({ ...props.target, comparison, view: next }), { intent: 'pinned' }), [pane.openDetailsTab, props.target, comparison]);
    const openReview = React.useCallback(() => {
        if (!captured.comparison || !machineReachable) return;
        presentStartReviewDialog({ sessionId: props.sessionId, serverId: props.serverId ?? null,
            cwd: captured.comparison.repository.rootPath, comparison, scopeLabel, defaultWalkthrough: true,
            onStarted: (started, narration) => { if (narration) pane.openDetailsTab(createSessionScmReviewDetailsTab({
                ...props.target, comparison: { ...comparison, comparisonId: started.comparisonId }, view: 'walkthrough' }), { intent: 'pinned' }); } });
    }, [captured.comparison, machineReachable, comparison, props.sessionId, props.serverId, props.target, scopeLabel, pane.openDetailsTab]);
    const fileCount = captured.comparison?.inventory.files.length ?? null;
    const scopeOptions = React.useMemo(() => listFilesComparisonScopeOptions(NO_LOCAL_SCOPES, latestTurnId, comparison,
        { currentFileCount: fileCount ?? undefined }), [comparison, fileCount, latestTurnId]);
    const selectComparison = React.useCallback((next: SessionScmReviewComparison) => pane.openDetailsTab(
        createSessionScmReviewDetailsTab({ ...props.target, comparison: next, view }), { intent: 'pinned' }), [pane.openDetailsTab, props.target, view]);
    const renderPhoneHeader = React.useCallback((count: number | null, actions?: React.ReactNode) => <ScmComparisonPhoneHeader
        view={view} views={VIEWS} scope={{ current: comparison, currentLabel: scopeLabel, fileCount: count,
            options: scopeOptions, onSelect: selectComparison }} onSelectView={selectView} onBack={pane.closeDetails}
        onStartReview={openReview} reviewDisabled={!captured.comparison || !machineReachable} reviewDisabledReason={reviewDisabledReason} extraActions={actions} />,
    [view, comparison, scopeLabel, scopeOptions, selectComparison, selectView, pane.closeDetails, openReview, captured.comparison, machineReachable, reviewDisabledReason]);
    const leading = React.useMemo(() => <><ScmComparisonViewSwitch view={view} views={VIEWS} onSelect={selectView} />
        <ScmComparisonScopePicker current={comparison} currentLabel={scopeLabel} fileCount={fileCount}
            options={scopeOptions} onSelect={selectComparison} /></>,
    [view, selectView, comparison, scopeLabel, fileCount, scopeOptions, selectComparison]);
    const reviewDisabled = !captured.comparison || !machineReachable;
    const trailing = React.useMemo(() => <ScmComparisonStartReview disabled={reviewDisabled}
        disabledReason={reviewDisabledReason} onPress={openReview} />, [reviewDisabled, reviewDisabledReason, openReview]);
    const chrome = React.useMemo<NonNullable<React.ComponentProps<typeof ChangedFilesReview>['comparisonChrome']>>(() => ({
        renderBarLeading: () => leading, barTrailing: trailing, indexPlacement,
        renderBar: phone ? (coverage, actions) => renderPhoneHeader(coverage.fileCount, actions) : undefined,
        renderHeader: (coverage) => <ScmComparisonHeader viewLabel={t('scmComparison.view.files')} scopeLabel={scopeLabel}
            title={reading?.title} coverage={coverage} changeCount={captured.comparison?.inventory.files.reduce((sum, file) => sum + file.occurrences.length, 0)}
            analysis={reading?.analysis ? <WalkthroughAnalysisFact analysed={reading.analysis.analysed} total={reading.analysis.total} parts={reading.analysis.parts}
                model={walkthrough?.producer?.modelId} stopped={reading.phase === 'cancelled' || reading.phase === 'failed'} unavailableCount={reading.source.unavailableCount} /> : null}
            reviewed={reading && marksAvailable ? <WalkthroughReviewedFact count={reading.reviewedCount} total={reading.stops.length} /> : null}
            stacked={phone} accessory={<>{reading ? <ScmComparisonExplainToggle value={explain}
                onChange={setExplain} /> : null}
                {phone ? <ChangedFilesLayoutSwitch testIDPrefix="scm-comparison-layout" /> : null}</>} />,
        hunkNotesColumnWidth: WALKTHROUGH_EXPLAIN_COLUMN_WIDTH_PX,
        renderHunkNotes: explain && reading ? (path, hunkIndex, placement) => <WalkthroughExplainNotes reading={reading} path={path} hunkIndex={hunkIndex} placement={placement}
            onReadInWalkthrough={() => selectView('walkthrough')} /> : null,
    }), [leading, trailing, indexPlacement, scopeLabel, reading, marksAvailable, walkthrough?.producer?.modelId, phone, explain, setExplain, selectView, captured.comparison, renderPhoneHeader]);
    return <View style={{ flex: 1, minHeight: 0 }} onLayout={(event) => setWidth(Math.round(event.nativeEvent.layout.width))}>
        {view === 'walkthrough' ? <SessionWalkthroughView sessionId={props.sessionId} serverId={props.serverId} comparison={comparison}
            scopeLabel={scopeLabel} layout={phone ? 'phone' : indexPlacement === 'rail' ? 'wide' : 'narrow'} active={props.active !== false}
            renderBar={(actions) => phone ? renderPhoneHeader(fileCount, actions) : <ScmComparisonBar leading={leading} trailing={<>{actions}{trailing}</>} />}
            onShowFiles={() => selectView('files')} onOpenFile={() => selectView('files')} onOpenComposer={goToComposer} /> : <>
            {captured.error ? <WalkthroughNotice testID="captured-comparison-error" tone="warning" icon="warning" message={captured.error} /> : null}
            {captured.comparison ? <CapturedComparisonFilesView comparison={captured.comparison} sessionId={props.sessionId}
                comparisonChrome={chrome} initialCollapsedPaths={mountedInitialReviewState.collapsedPaths}
                onCollapsedPathsChange={onCollapsedPathsChange} initialScrollTop={mountedInitialReviewState.scrollTop}
                onScrollTopChange={onScrollTopChange} maxFiles={typeof maxFilesSetting === 'number' ? maxFilesSetting : 25}
                maxChangedLines={typeof maxLinesSetting === 'number' ? maxLinesSetting : 2000} /> : <>
                {phone ? renderPhoneHeader(fileCount) : <ScmComparisonBar leading={leading} trailing={trailing} />}
                <SurfaceStateCard testID="captured-comparison-loading" kind={captured.loading ? 'loading' : 'error'}
                    title={captured.loading ? t('common.loading') : scopeLabel}
                    reason={captured.error ?? t('scmComparison.scopePicker.unavailable')}
                    action={!captured.loading ? { label: t('common.retry'), onPress: captured.retry } : undefined} />
            </>}
        </>}
    </View>;
}
