import * as React from 'react';
import type { SessionScmReviewDetailsViewProps } from './SessionScmReviewDetailsView';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionScmReviewDetailsTab, type SessionScmReviewComparison, type SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { useSessionCapturedScmComparison } from '@/components/sessions/files/comparison/useSessionCapturedScmComparison';
import { CapturedComparisonFilesView } from '@/components/sessions/files/comparison/CapturedComparisonFilesView';
import { ScmComparisonBar } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { WorkspaceScmReviewBody } from '@/components/projects/scm/WorkspaceScmReviewBody';
import { listFilesComparisonScopeOptions, resolveFilesComparisonLabel } from '@/components/sessions/files/comparison/filesComparison';
import { useScmReviewActiveFileSelection, useSessionScmReviewTabState } from '@/components/sessions/files/comparison/useSessionScmReviewTabState';
import { SessionWalkthroughView } from '@/components/sessions/files/walkthrough/SessionWalkthroughView';
import { useScmWalkthroughState } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';
import { useCapturedComparisonEvidence } from '@/components/sessions/files/comparison/useCapturedComparisonEvidence';
import { useWalkthroughReading } from '@/components/sessions/files/walkthrough/useWalkthroughReading';
import { useScmReviewedMarks } from '@/components/sessions/files/comparison/useScmReviewedMarks';
import { createComparisonReviewExecutionRunDraftDetailsTab } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { useRunAnsweringEngine } from '@/components/sessions/runs/useRunAnsweringEngine';
import { selectScmDiffSummaryProducerModel } from '@/sync/domains/scm/diffSummary/state';
import { useReviewComposerHandoff } from '@/components/sessions/reviews/comments/useReviewComposerHandoff';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useSession } from '@/sync/domains/state/storage';
import { useScmReviewLimits } from '@/scm/review/useScmReviewLimits';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { t } from '@/text';
import { activeReviewFileKeyForSession } from '@/components/workspaces/scm/review/activeReviewFile';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createSessionPaneDetailsTab } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { fileChangesScopeOfComparison } from '@/components/workspaces/files/file/changes/fileChangesScope';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';

const NO_LOCAL_SCOPES = { showTurnViewToggle: false, showTurnAgentReportedViewToggle: false, showTurnCheckpointViewToggle: false, showSessionViewToggle: false };

/** Historical comparisons never mount the live checkout status, polling, selection or discard owners. */
export function SessionCapturedScmReviewDetailsView(props: SessionScmReviewDetailsViewProps & Readonly<{ comparison: SessionScmReviewComparison }>) {
    const session = useSession(props.sessionId);
    const workspaceScope = useWorkspaceScopeForSession(props.sessionId, props.serverId);
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations') === true;
    const latestTurnId = (!props.serverId || session?.serverId === props.serverId) ? session?.latestTurnId ?? null : null;
    const pane = useAppPaneScope(props.scopeId);
    const openDetailsTab = props.onOpenDetailsTab ?? pane.openDetailsTab;
    const goToComposer = useReviewComposerHandoff(props.scopeId);
    const { machineReachable } = useSessionMachineReachability(props.sessionId, props.serverId);
    const reviewDisabledReason = machineReachable ? null : t('walkthrough.notice.offlineA11y');
    const view = props.target?.view === 'walkthrough' ? 'walkthrough' : 'files';
    const { viewModel: walkthrough, ...restoration } = useScmWalkthroughState({ sessionId: props.sessionId }, props.comparison, 'walkthrough', props.serverId);
    const { engine: producerEngine } = useRunAnsweringEngine({ ...selectScmDiffSummaryProducerModel(walkthrough),
        sessionId: props.sessionId, serverId: props.serverId, presented: props.active !== false });
    const useSavedComparison = view === 'walkthrough' || Boolean(props.comparison.comparisonId);
    const [indexPageSize, setIndexPageSize] = React.useState<number | null>(null);
    const captured = useSessionCapturedScmComparison({ sessionId: props.sessionId, serverId: props.serverId,
        comparison: props.comparison,
        indexPageSize,
        // Restoration already reads the exact comparison with the saved result.
        active: props.active !== false && (!useSavedComparison || restoration.restoreState !== 'restoring'),
        knownComparison: useSavedComparison ? walkthrough?.comparison : null });
    const comparison = React.useMemo(() => captured.comparison
        ? { ...props.comparison, comparisonId: captured.comparison.id } : props.comparison, [props.comparison, captured.comparison?.id]);
    const accountBinding = useServerCredentialAccountScopeBinding(props.serverId).binding;
    const accountScope = accountBinding?.isCurrent() ? accountBinding.scope : null;
    const activeReviewFile = useScmReviewActiveFileSelection({ pane,
        hostKey: JSON.stringify([accountScope?.serverId, accountScope?.accountId, props.sessionId, captured.comparison?.repository.rootPath]),
        activeFileKey: activeReviewFileKeyForSession(props.sessionId, props.serverId), comparison, view, presented: props.active !== false && Boolean(accountScope),
        isCurrent: accountBinding?.isCurrent });
    const scopeLabel = resolveFilesComparisonLabel(comparison, null);
    const marks = useScmReviewedMarks({ comparison: view === 'files' ? captured.comparison : null, serverId: props.serverId ?? null,
        host: { sessionId: props.sessionId }, writeUnavailableReason: reviewDisabledReason });
    const marksAvailable = captured.comparison !== null && marks.record !== null && marks.unavailableReason === null;
    const evidence = useCapturedComparisonEvidence(walkthrough?.comparison?.id === comparison.comparisonId
        ? walkthrough?.comparison ?? null : null, { host: { sessionId: props.sessionId }, serverId: props.serverId });
    const reading = useWalkthroughReading(evidence.comparison && walkthrough?.outputs?.walkthrough?.value
        ? { comparison: evidence.comparison, walkthrough: walkthrough.outputs.walkthrough,
            analysis: walkthrough.analysis, reviewed: marks.record,
            provenance: walkthrough.savedResult?.walkthroughProvenance } : null);
    const { maxFiles, maxChangedLines } = useScmReviewLimits();
    const { mountedInitialReviewState, startedReviewRunIds, explain, setExplain,
        onCollapsedPathsChange, onScrollTopChange } = useSessionScmReviewTabState(props.sessionId, pane, props.target, openDetailsTab);
    const selectView = React.useCallback((next: SessionScmReviewView) => openDetailsTab(
        createSessionScmReviewDetailsTab({ ...props.target, comparison, view: next }), { intent: 'pinned' }), [openDetailsTab, props.target, comparison]);
    const openReview = React.useCallback(() => {
        if (!captured.comparison || !machineReachable) return;
        openDetailsTab(createComparisonReviewExecutionRunDraftDetailsTab({
            cwd: captured.comparison.repository.rootPath, comparison, scopeLabel, defaultWalkthrough: true,
            origin: { scopeId: props.scopeId, tab: createSessionScmReviewDetailsTab({ ...props.target, comparison }) },
        }), { intent: 'preview', start: true });
    }, [captured.comparison, machineReachable, comparison, scopeLabel, openDetailsTab, props.scopeId, props.target]);
    const fileCount = captured.page?.totalFiles ?? captured.comparison?.inventory.files.length ?? null;
    const scopeOptions = React.useMemo(() => listFilesComparisonScopeOptions(NO_LOCAL_SCOPES, latestTurnId, comparison,
        { currentFileCount: fileCount ?? undefined }), [comparison, fileCount, latestTurnId]);
    const selectComparison = React.useCallback((next: SessionScmReviewComparison) => openDetailsTab(
        createSessionScmReviewDetailsTab({ ...props.target, comparison: next, view }), { intent: 'pinned' }), [openDetailsTab, props.target, view]);
    const openFile = React.useCallback((path: string) => {
        if (!captured.comparison) return;
        const changes = fileChangesScopeOfComparison(comparison) ? comparison : null;
        const constructed = createSessionPaneDetailsTab({ kind: 'file', path, rootPath: captured.comparison.repository.rootPath,
            ...(changes ? { changes, view: 'changes' as const } : null) });
        if (!constructed) return;
        const { isPinned: _pinned, isPreview: _preview, ...tab } = constructed;
        deferOnWeb(() => openDetailsTab(tab));
    }, [captured.comparison, comparison, openDetailsTab]);
    return <WorkspaceScmReviewBody
        onVisibleFileRowCountChange={setIndexPageSize}
        activeReviewFile={activeReviewFile}
        comparison={comparison} view={view} scopeLabel={scopeLabel} scopeOptions={scopeOptions}
        onSelectComparison={selectComparison} onSelectView={selectView}
        fileCount={fileCount} rootPath={captured.comparison?.repository.rootPath}
        changeCount={captured.comparison?.inventory.files.reduce((sum, file) => sum + file.occurrences.length, 0)}
        reading={reading} explainEvidence={props.active !== false ? evidence : undefined} modelLabel={producerEngine?.label} marksAvailable={marksAvailable} marksPending={marks.pending}
        explain={explain} onExplainChange={setExplain}
        onStartReview={openReview} reviewDisabled={!captured.comparison || !machineReachable} reviewDisabledReason={reviewDisabledReason}
        renderWalkthrough={({ layout, renderBar, onShowFiles }) => <SessionWalkthroughView sessionId={props.sessionId} scopeId={props.scopeId}
            {...restoration}
            serverId={props.serverId} comparison={comparison} scopeLabel={scopeLabel} layout={layout} active={props.active !== false}
            startedReviewRunIds={startedReviewRunIds}
            renderBar={renderBar} onShowFiles={onShowFiles} onOpenFile={openFile} onOpenComposer={goToComposer} />}
        renderFiles={(chrome) => <>
            {captured.comparison ? <CapturedComparisonFilesView activeReviewFile={activeReviewFile} comparison={captured.comparison} sessionId={props.sessionId}
                error={captured.error}
                serverId={props.serverId} page={captured.page} onLoadMore={captured.loadMore} loadingMore={captured.loading}
                active={props.active !== false && view === 'files'}
                workspaceScope={workspaceScope} marks={marks} discardEnabled={scmWriteEnabled} onRefresh={captured.retry}
                comparisonChrome={chrome} initialCollapsedPaths={mountedInitialReviewState.collapsedPaths}
                onCollapsedPathsChange={onCollapsedPathsChange} initialScrollTop={mountedInitialReviewState.scrollTop}
                onScrollTopChange={onScrollTopChange} maxFiles={maxFiles}
                maxChangedLines={maxChangedLines} /> : <>
                {chrome.renderBar ? chrome.renderBar({ fileCount: fileCount ?? 0, added: 0, removed: 0, linesKnown: false }, null) : <ScmComparisonBar leading={chrome.renderBarLeading({ fileCount: fileCount ?? 0, added: 0, removed: 0, linesKnown: false })} trailing={chrome.barTrailing} />}
                <SurfaceStateCard testID="captured-comparison-loading" kind={captured.loading ? 'loading' : 'error'}
                    title={captured.loading ? t('common.loading') : scopeLabel}
                    reason={captured.error ?? t('scmComparison.scopePicker.unavailable')}
                    action={!captured.loading ? { label: t('common.retry'), onPress: captured.retry } : undefined} />
            </>}
        </>}
    />;
}
