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
import { useSessionScmWalkthrough } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';
import { buildWalkthroughReading } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { useWalkthroughReviewedMarks } from '@/components/sessions/files/walkthrough/useWalkthroughReviewedMarks';
import { presentStartReviewDialog } from '@/components/sessions/reviews/walkthrough/StartReviewDialog';
import { useReviewComposerHandoff } from '@/components/sessions/reviews/comments/useReviewComposerHandoff';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { WalkthroughNotice } from '@/components/sessions/files/walkthrough/WalkthroughLifecycle';
import { useSession, useSetting } from '@/sync/domains/state/storage';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { t } from '@/text';
import { activeReviewFileKeyForSession } from '@/components/workspaces/scm/review/activeReviewFile';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

const NO_LOCAL_SCOPES = { showTurnViewToggle: false, showTurnAgentReportedViewToggle: false, showTurnCheckpointViewToggle: false, showSessionViewToggle: false };

/** Historical comparisons never mount the live checkout status, polling, selection or discard owners. */
export function SessionCapturedScmReviewDetailsView(props: SessionScmReviewDetailsViewProps & Readonly<{ comparison: SessionScmReviewComparison }>) {
    const activeReviewFile = React.useMemo(() => ({ key: activeReviewFileKeyForSession(props.sessionId, props.serverId),
        presented: props.active !== false, externalLifecycle: true }), [props.sessionId, props.serverId, props.active]);
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
    const accountBinding = useServerCredentialAccountScopeBinding(props.serverId).binding;
    const accountScope = accountBinding?.isCurrent() ? accountBinding.scope : null;
    useScmReviewActiveFileSelection({ pane,
        hostKey: JSON.stringify([accountScope?.serverId, accountScope?.accountId, props.sessionId, captured.comparison?.repository.rootPath]),
        activeFileKey: activeReviewFile.key, comparison, view, presented: props.active !== false && Boolean(accountScope),
        isCurrent: accountBinding?.isCurrent });
    const scopeLabel = resolveFilesComparisonLabel(comparison, null);
    const marks = useWalkthroughReviewedMarks({ comparison: view === 'files' ? captured.comparison : null, serverId: props.serverId ?? null,
        host: { sessionId: props.sessionId } });
    const marksAvailable = marks.record?.comparisonId === captured.comparison?.id && marks.record !== null && marks.unavailableReason === null;
    const reading = React.useMemo(() => walkthrough?.comparison && walkthrough.comparison.id === comparison.comparisonId && walkthrough.outputs?.walkthrough?.value
        ? buildWalkthroughReading({ comparison: walkthrough.comparison, walkthrough: walkthrough.outputs.walkthrough,
            analysis: walkthrough.analysis, reviewed: marksAvailable ? marks.record : null,
            provenance: walkthrough.savedResult?.walkthroughProvenance }) : null, [walkthrough, comparison.comparisonId, marksAvailable, marks.record]);
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
    return <WorkspaceScmReviewBody
        activeReviewFile={activeReviewFile}
        comparison={comparison} view={view} scopeLabel={scopeLabel} scopeOptions={scopeOptions}
        onSelectComparison={selectComparison} onSelectView={selectView} onClose={pane.closeDetails}
        fileCount={fileCount} rootPath={captured.comparison?.repository.rootPath}
        changeCount={captured.comparison?.inventory.files.reduce((sum, file) => sum + file.occurrences.length, 0)}
        reading={reading} modelLabel={walkthrough?.producer?.modelId} marksAvailable={marksAvailable}
        explain={explain} onExplainChange={setExplain}
        onStartReview={openReview} reviewDisabled={!captured.comparison || !machineReachable} reviewDisabledReason={reviewDisabledReason}
        renderWalkthrough={({ layout, renderBar, onShowFiles }) => <SessionWalkthroughView sessionId={props.sessionId}
            serverId={props.serverId} comparison={comparison} scopeLabel={scopeLabel} layout={layout} active={props.active !== false}
            renderBar={renderBar} onShowFiles={onShowFiles} onOpenFile={onShowFiles} onOpenComposer={goToComposer} />}
        renderFiles={(chrome) => <>
            {captured.error ? <WalkthroughNotice testID="captured-comparison-error" tone="warning" icon="warning" message={captured.error} /> : null}
            {captured.comparison ? <CapturedComparisonFilesView activeReviewFile={activeReviewFile} comparison={captured.comparison} sessionId={props.sessionId}
                comparisonChrome={chrome} initialCollapsedPaths={mountedInitialReviewState.collapsedPaths}
                onCollapsedPathsChange={onCollapsedPathsChange} initialScrollTop={mountedInitialReviewState.scrollTop}
                onScrollTopChange={onScrollTopChange} maxFiles={typeof maxFilesSetting === 'number' ? maxFilesSetting : 25}
                maxChangedLines={typeof maxLinesSetting === 'number' ? maxLinesSetting : 2000} /> : <>
                {chrome.renderBar ? chrome.renderBar({ fileCount: fileCount ?? 0, added: 0, removed: 0, linesKnown: false }, null) : <ScmComparisonBar leading={chrome.renderBarLeading({ fileCount: fileCount ?? 0, added: 0, removed: 0, linesKnown: false })} trailing={chrome.barTrailing} />}
                <SurfaceStateCard testID="captured-comparison-loading" kind={captured.loading ? 'loading' : 'error'}
                    title={captured.loading ? t('common.loading') : scopeLabel}
                    reason={captured.error ?? t('scmComparison.scopePicker.unavailable')}
                    action={!captured.loading ? { label: t('common.retry'), onPress: captured.retry } : undefined} />
            </>}
        </>}
    />;
}
