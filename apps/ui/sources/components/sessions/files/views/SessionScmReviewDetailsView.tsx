import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { Text } from '@/components/ui/text/Text';
import { ReviewCommentsSessionSurface } from '@/components/reviews/ReviewCommentsSessionSurface';
import { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import { ChangedFilesViewModeMenu } from '@/components/sessions/files/ChangedFilesViewModeMenu';
import { useChangedFilesData } from '@/hooks/session/files/useChangedFilesData';
import { useProjectForSession, useProjectSessions, useSessionMessages, useSessionProjectScmOperationLog, useSessionProjectScmSnapshot, useSessionProjectScmSnapshotError, useSessionProjectScmTouchedPaths, useSessionRealtimeScmTranscriptConsumer, useSessionWorkspacePath, useSetting, useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { ScmChangeDiscardButton } from '@/components/sessions/sourceControl/changes/ScmChangeDiscardButton';
import { SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import { useScmDiffCacheLimits } from '@/scm/diffCache/useScmDiffCacheLimits';
import { useScmAdaptivePolling } from '@/scm/refresh/useScmAdaptivePolling';
import { buildSnapshotSignature } from '@/scm/statusSync/projectState';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { NotSourceControlRepositoryState, SourceControlStaleSnapshotNotice, SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import { t } from '@/text';
import { useLastNonNullValue } from '@/hooks/ui/useLastNonNullValue';
import { useDerivedSessionChangeSet } from '@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import {
    getPreferredChangedFilesViewMode,
    resolveChangedFilesViewMode,
    type ChangedFilesViewMode,
} from '@/scm/scmAttribution';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { createPluginPermissionGrantActions } from '@/sync/domains/plugins/permissions/actions';
import { usePluginPermissionGrants } from '@/sync/domains/plugins/permissions/usePluginPermissionGrants';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import {
    selectPluginPermissionPendingRequests,
} from '@/sync/domains/plugins/permissions/store';
import {
    REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
    pluginPermissionGrantScopeKey,
    type PluginPermissionGrantListInput,
    type PluginPermissionGrantTargetScope,
} from '@/sync/domains/plugins/permissions/types';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export type SessionScmReviewDetailsViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
}>;

const REVIEW_SCROLL_TOP_PERSIST_DEBOUNCE_MS = 250;
const REVIEW_SCROLL_TOP_PERSIST_EPSILON_PX = 1;

function areReviewScrollTopValuesEqual(previous: unknown, next: unknown): boolean {
    if (Object.is(previous, next)) return true;
    if (typeof previous !== 'number' || typeof next !== 'number') return false;
    if (!Number.isFinite(previous) || !Number.isFinite(next)) return false;
    return Math.abs(previous - next) < REVIEW_SCROLL_TOP_PERSIST_EPSILON_PX;
}

function areReviewTabStateValuesEqual(key: string, previous: unknown, next: unknown): boolean {
    if (key === 'scrollTop') {
        return areReviewScrollTopValuesEqual(previous, next);
    }
    if (Object.is(previous, next)) return true;
    if (Array.isArray(previous) || Array.isArray(next)) {
        const previousArray = Array.isArray(previous) ? previous : [];
        const nextArray = Array.isArray(next) ? next : [];
        if (previousArray.length !== nextArray.length) return false;
        return previousArray.every((value, index) => Object.is(value, nextArray[index]));
    }
    return false;
}

function useMountedReviewInitialState(
    sessionId: string,
    scrollTop: number | null,
    collapsedPaths: string[] | null,
): Readonly<{ scrollTop: number | null; collapsedPaths: string[] | null }> {
    const initialStateRef = React.useRef<Readonly<{
        sessionId: string;
        scrollTop: number | null;
        collapsedPaths: string[] | null;
    }> | null>(null);

    if (!initialStateRef.current || initialStateRef.current.sessionId !== sessionId) {
        initialStateRef.current = {
            sessionId,
            scrollTop,
            collapsedPaths: collapsedPaths ? [...collapsedPaths] : null,
        };
    }

    return initialStateRef.current;
}

export const SessionScmReviewDetailsView = React.memo((props: SessionScmReviewDetailsViewProps) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const openDetailsTab = pane.openDetailsTab;
    const setDetailsTabState = pane.setDetailsTabState;
    const reviewTabKey = 'scmReview:working';
    const persistedReviewTabState = pane.scopeState?.details?.tabState?.[reviewTabKey] as any as
        | Readonly<{ collapsedPaths?: unknown; scrollTop?: unknown }>
        | null
        | undefined;
    const persistedCollapsedPaths = React.useMemo(() => {
        const raw = persistedReviewTabState?.collapsedPaths;
        return Array.isArray(raw) ? (raw.filter((p) => typeof p === 'string') as string[]) : null;
    }, [persistedReviewTabState?.collapsedPaths]);
    const persistedScrollTop = React.useMemo(() => {
        const raw = persistedReviewTabState?.scrollTop;
        return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    }, [persistedReviewTabState?.scrollTop]);
    const mountedInitialReviewState = useMountedReviewInitialState(props.sessionId, persistedScrollTop, persistedCollapsedPaths);
    const persistedReviewTabStateRef = React.useRef<Record<string, unknown>>({});
    React.useEffect(() => {
        persistedReviewTabStateRef.current =
            persistedReviewTabState && typeof persistedReviewTabState === 'object'
                ? (persistedReviewTabState as any as Record<string, unknown>)
                : {};
    }, [persistedReviewTabState]);
    const setPersistedReviewTabState = React.useCallback((patch: Record<string, unknown>) => {
        const prev = persistedReviewTabStateRef.current ?? {};
        let hasChange = false;
        for (const [key, value] of Object.entries(patch)) {
            if (!areReviewTabStateValuesEqual(key, prev[key], value)) {
                hasChange = true;
                break;
            }
        }
        if (!hasChange) return;
        const next = { ...prev, ...patch };
        persistedReviewTabStateRef.current = next;
        setDetailsTabState(reviewTabKey, next);
    }, [setDetailsTabState]);
    const onCollapsedPathsChange = React.useCallback((paths: string[]) => {
        setPersistedReviewTabState({ collapsedPaths: paths });
    }, [setPersistedReviewTabState]);
    const pendingScrollTopRef = React.useRef<number | null>(null);
    const scrollTopPersistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const flushPendingScrollTop = React.useCallback(() => {
        if (scrollTopPersistTimerRef.current) {
            clearTimeout(scrollTopPersistTimerRef.current);
            scrollTopPersistTimerRef.current = null;
        }
        const top = pendingScrollTopRef.current;
        pendingScrollTopRef.current = null;
        if (typeof top !== 'number' || !Number.isFinite(top)) return;
        setPersistedReviewTabState({ scrollTop: top });
    }, [setPersistedReviewTabState]);
    const onScrollTopChange = React.useCallback((top: number) => {
        if (!Number.isFinite(top)) return;
        if (areReviewScrollTopValuesEqual(pendingScrollTopRef.current, top)) return;
        if (pendingScrollTopRef.current === null && areReviewScrollTopValuesEqual(persistedReviewTabStateRef.current?.scrollTop, top)) return;
        pendingScrollTopRef.current = top;
        if (scrollTopPersistTimerRef.current) {
            clearTimeout(scrollTopPersistTimerRef.current);
        }
        scrollTopPersistTimerRef.current = setTimeout(
            flushPendingScrollTop,
            REVIEW_SCROLL_TOP_PERSIST_DEBOUNCE_MS,
        );
    }, [flushPendingScrollTop]);
    React.useEffect(() => flushPendingScrollTop, [flushPendingScrollTop]);
    const project = useProjectForSession(props.sessionId);
    const sessionPath = useSessionWorkspacePath(props.sessionId);
    const snapshot = useSessionProjectScmSnapshot(props.sessionId);
    const lastGoodSnapshot = useLastNonNullValue(snapshot, { resetKey: props.sessionId });
    const effectiveSnapshot = snapshot ?? lastGoodSnapshot;
    useSessionRealtimeScmTranscriptConsumer(props.sessionId, effectiveSnapshot);
    const snapshotError = useSessionProjectScmSnapshotError(props.sessionId);
    const touchedPaths = useSessionProjectScmTouchedPaths(props.sessionId);
    const operationLog = useSessionProjectScmOperationLog(props.sessionId);
    const projectSessionIds = useProjectSessions(project?.id ?? null);
    const scmReviewMaxFiles = useSetting('scmReviewMaxFiles');
    const scmReviewMaxChangedLines = useSetting('scmReviewMaxChangedLines');
    const scmCommitStrategySetting = useSetting('scmCommitStrategy');
    const scmCommitStrategy: ScmCommitStrategy = React.useMemo(() => {
        if (typeof scmCommitStrategySetting !== 'string') return 'atomic';
        return SCM_COMMIT_STRATEGIES.includes(scmCommitStrategySetting as ScmCommitStrategy)
            ? (scmCommitStrategySetting as ScmCommitStrategy)
            : 'atomic';
    }, [scmCommitStrategySetting]);
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const reviewScope = useWorkspaceScopeForSession(props.sessionId);
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments') === true && Boolean(reviewScope);
    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(reviewScope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(reviewScope);
    const frontDoorActionExecutor = React.useMemo(() => createFrontDoorUiActionExecutor(), []);
    const pluginPermissionGrantActions = React.useMemo(
        () => createPluginPermissionGrantActions({ execute: frontDoorActionExecutor }),
        [frontDoorActionExecutor],
    );
    const directWriteGrantScope = React.useMemo<PluginPermissionGrantTargetScope | null>(() => {
        if (!project?.id) return null;
        return {
            kind: 'project',
            projectId: project.id,
        };
    }, [project?.id]);
    const pluginPermissionGrantListInput = React.useMemo<PluginPermissionGrantListInput | null>(() => (
        directWriteGrantScope
            ? {
                  capability: REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
                  targetScope: directWriteGrantScope,
              }
            : null
    ), [directWriteGrantScope]);
    const pluginPermissionGrants = usePluginPermissionGrants({
        actions: pluginPermissionGrantActions,
        enabled: reviewCommentsEnabled && Boolean(pluginPermissionGrantListInput),
        listInput: pluginPermissionGrantListInput,
    });
    const directWriteGrants = pluginPermissionGrants.state.grantIds
        .map((id) => pluginPermissionGrants.state.grantsById[id])
        .filter((grant): grant is NonNullable<typeof grant> => (
            Boolean(grant)
            && grant?.capability === REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY
            && pluginPermissionGrantScopeKey(grant.targetScope) === pluginPermissionGrantScopeKey(directWriteGrantScope)
        ));
    const pendingDirectWriteGrantRequests = directWriteGrantScope
        ? selectPluginPermissionPendingRequests(pluginPermissionGrants.state, {
            capability: REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
            targetScope: directWriteGrantScope,
        })
        : [];
    const [diffRefreshToken, setDiffRefreshToken] = React.useState(0);

    useScmDiffCacheLimits(scmDiffCache);

    const autoRefreshIntervalSetting = useSetting('scmFilesAutoRefreshIntervalMs');
    const maxIntervalMs = React.useMemo(() => {
        const raw = typeof autoRefreshIntervalSetting === 'number' && Number.isFinite(autoRefreshIntervalSetting)
            ? autoRefreshIntervalSetting
            : 60_000;
        return Math.max(0, raw);
    }, [autoRefreshIntervalSetting]);
    const baseIntervalMs = React.useMemo(() => Math.max(0, Math.min(10_000, maxIntervalMs)), [maxIntervalMs]);

    const snapshotSignature = React.useMemo(() => {
        if (!effectiveSnapshot) return null;
        return buildSnapshotSignature(effectiveSnapshot);
    }, [effectiveSnapshot]);
    const getSnapshotSignature = React.useCallback(() => snapshotSignature, [snapshotSignature]);
    const {
        latestTurnChangeSet,
        latestTurnScopedChangeSet,
        latestTurnDiffByPath,
        latestTurnAgentReportedDiffByPath,
        latestTurnCheckpointDiffByPath,
        sessionChangeSet,
        providerDiffByPath,
    } = useDerivedSessionChangeSet(props.sessionId);
    const [requestedChangedFilesViewMode, setRequestedChangedFilesViewMode] = React.useState<ChangedFilesViewMode | null>(null);

    useScmAdaptivePolling({
        enabled: Boolean(props.sessionId) && effectiveSnapshot?.repo.isRepo === true,
        baseIntervalMs,
        stepIntervalMs: baseIntervalMs,
        maxIntervalMs,
        activityToken: diffRefreshToken,
        getSignature: getSnapshotSignature,
        invalidateAndAwait: React.useCallback(async () => {
            await scmStatusSync.invalidateFromAutoRefreshAndAwait(props.sessionId);
        }, [props.sessionId]),
    });

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const changed = useChangedFilesData({
        sessionId: props.sessionId,
        scmSnapshot: effectiveSnapshot ?? null,
        touchedPaths,
        operationLog,
        projectSessionIds,
        searchQuery: '',
        showAllRepositoryFiles: true,
        latestTurnChangeSet: latestTurnScopedChangeSet,
        latestTurnEvidence: latestTurnChangeSet,
        sessionChangeSet,
    });

    const changedFilesAvailability = React.useMemo(() => ({
        showTurnViewToggle: changed.showTurnViewToggle,
        showTurnAgentReportedViewToggle: changed.showTurnAgentReportedViewToggle,
        showTurnCheckpointViewToggle: changed.showTurnCheckpointViewToggle,
        showSessionViewToggle: changed.showSessionViewToggle,
    }), [
        changed.showSessionViewToggle,
        changed.showTurnAgentReportedViewToggle,
        changed.showTurnCheckpointViewToggle,
        changed.showTurnViewToggle,
    ]);

    const changedFilesViewMode = React.useMemo(() => {
        if (requestedChangedFilesViewMode) {
            return resolveChangedFilesViewMode({
                mode: requestedChangedFilesViewMode,
                ...changedFilesAvailability,
            });
        }
        return getPreferredChangedFilesViewMode(changedFilesAvailability);
    }, [
        changedFilesAvailability,
        requestedChangedFilesViewMode,
    ]);

    const reviewProviderDiffByPath = React.useMemo(() => {
        if (changedFilesViewMode === 'turn') return latestTurnDiffByPath;
        if (changedFilesViewMode === 'turn_agent_reported') return latestTurnAgentReportedDiffByPath;
        if (changedFilesViewMode === 'turn_checkpoint') return latestTurnCheckpointDiffByPath;
        if (changedFilesViewMode === 'session') return providerDiffByPath;
        return null;
    }, [
        changedFilesViewMode,
        latestTurnAgentReportedDiffByPath,
        latestTurnCheckpointDiffByPath,
        latestTurnDiffByPath,
        providerDiffByPath,
    ]);

    const maxFiles = typeof scmReviewMaxFiles === 'number' && Number.isFinite(scmReviewMaxFiles) ? scmReviewMaxFiles : 25;
    const maxChangedLines = typeof scmReviewMaxChangedLines === 'number' && Number.isFinite(scmReviewMaxChangedLines) ? scmReviewMaxChangedLines : 2000;

    const openFile = React.useCallback((fullPath: string, intent: 'default' | 'pinned' = 'default') => {
        const fileName = fullPath.split('/').pop() ?? fullPath;
        deferOnWeb(() => {
            pane.openDetailsTab(
                {
                    key: `file:${fullPath}`,
                    kind: 'file',
                    title: fileName,
                    resource: { kind: 'file', path: fullPath },
                },
                { intent },
            );
        });
    }, [openDetailsTab]);

    const openFileDefault = React.useCallback((file: { fullPath: string }) => {
        openFile(file.fullPath, 'default');
    }, [openFile]);

    const openFilePinned = React.useCallback((file: { fullPath: string }) => {
        openFile(file.fullPath, 'pinned');
    }, [openFile]);

    // Ensure the SCM snapshot is warm so large reviews can load diffs even if the user
    // opened the review tab before visiting Source control.
    React.useEffect(() => {
        scmStatusSync.invalidateFromAutoRefresh(props.sessionId);
    }, [props.sessionId]);

    const refreshAfterMutation = React.useCallback(async () => {
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
        setDiffRefreshToken((t) => t + 1);
    }, [props.sessionId]);

    const renderReviewFileTrailingActions = React.useMemo(() => {
        if (!scmWriteEnabled) return undefined;
        return (file: ScmFileStatus) => (
            <ScmChangeDiscardButton
                sessionId={props.sessionId}
                sessionPath={sessionPath}
                snapshot={effectiveSnapshot ?? null}
                scmWriteEnabled={scmWriteEnabled}
                commitStrategy={scmCommitStrategy}
                file={file}
                surface="files"
                onAfterDiscard={refreshAfterMutation}
            />
        );
    }, [
        effectiveSnapshot,
        props.sessionId,
        refreshAfterMutation,
        scmCommitStrategy,
        scmWriteEnabled,
        sessionPath,
    ]);

    if (!effectiveSnapshot && !snapshotError) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 24 }}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                <Text style={{ marginTop: 12, fontSize: 12, color: theme.colors.text.secondary }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    // `F-SCM-3`: the terminal `SourceControlUnavailableState` below was the only place this view
    // reported a snapshot error, and `scmStatusSync` stores an error WITHOUT clearing the snapshot —
    // so once a review had been cached, every later refresh failure was invisible and stale content
    // read as current. Worse here than on the git panes: the `isRepo === false` branch returns
    // BEFORE that guard, so a cached "not under source control" suppressed it twice over. From here
    // on the content is real but possibly stale, so the failure travels WITH it — including into
    // that branch. Mounted unconditionally: the notice owns the "is this stale?" decision and
    // renders nothing when there is no error.
    const staleSnapshotNotice = (
        <SourceControlStaleSnapshotNotice
            testID="session-scm-review-stale"
            error={snapshotError}
            onRetry={() => void scmStatusSync.invalidateFromUser(props.sessionId)}
        />
    );

    if (effectiveSnapshot && effectiveSnapshot.repo.isRepo === false) {
        return (
            <View style={{ flex: 1 }}>
                {staleSnapshotNotice}
                <NotSourceControlRepositoryState />
            </View>
        );
    }

    if (!effectiveSnapshot && snapshotError) {
        return (
            <SourceControlUnavailableState
                details={snapshotError.message}
                onRetry={() => void scmStatusSync.invalidateFromUser(props.sessionId)}
            />
        );
    }

    return (
        <View style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {staleSnapshotNotice}
            {changed.showTurnViewToggle
            || changed.showTurnAgentReportedViewToggle
            || changed.showTurnCheckpointViewToggle
            || changed.showSessionViewToggle ? (
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                        paddingHorizontal: 12,
                        paddingTop: 10,
                        paddingBottom: 8,
                        borderBottomWidth: 1,
                        borderBottomColor: theme.colors.border.default,
                        backgroundColor: theme.colors.surface.inset,
                    }}
                >
                    <ChangedFilesViewModeMenu
                        theme={theme}
                        changedFilesViewMode={changedFilesViewMode}
                        showTurnViewToggle={changed.showTurnViewToggle}
                        showTurnAgentReportedViewToggle={changed.showTurnAgentReportedViewToggle}
                        showTurnCheckpointViewToggle={changed.showTurnCheckpointViewToggle}
                        showSessionViewToggle={changed.showSessionViewToggle}
                        onChangedFilesViewMode={setRequestedChangedFilesViewMode}
                    />
                </View>
            ) : null}
            {reviewCommentsEnabled && project?.id ? (
                <ReviewCommentsSessionSurface
                    projectId={project.id}
                    sessionId={props.sessionId}
                    execute={frontDoorActionExecutor}
                    directWriteGrants={directWriteGrants}
                    pendingDirectWriteGrantRequests={pendingDirectWriteGrantRequests}
                    onGrantDirectWrite={pluginPermissionGrants.grant}
                    onCancelDirectWriteGrant={pluginPermissionGrants.dismissRequest}
                    onRevokeDirectWrite={pluginPermissionGrants.revoke}
                    permissionGrantStatus={pluginPermissionGrants.state.status}
                    permissionGrantError={pluginPermissionGrants.state.error}
                    onRefreshPermissionGrants={() => { void pluginPermissionGrants.refresh(); }}
                    defaultPanelOpen={false}
                    testID="review-comments-session"
                />
            ) : null}
            <ChangedFilesReview
                theme={theme}
                sessionId={props.sessionId}
                snapshot={effectiveSnapshot ?? null}
                changedFilesViewMode={changedFilesViewMode}
                attributionReliability={changed.attributionReliability}
                allRepositoryChangedFiles={changed.allRepositoryChangedFiles}
                turnAttributedFiles={changed.turnAttributedFiles}
                turnAgentReportedFiles={changed.turnAgentReportedFiles}
                turnCheckpointFiles={changed.turnCheckpointFiles}
                turnCheckpointMetadata={changed.turnCheckpointMetadata}
                turnRepositoryOnlyFiles={changed.turnRepositoryOnlyFiles}
                sessionAttributedFiles={changed.sessionAttributedFiles}
                repositoryOnlyFiles={changed.repositoryOnlyFiles}
                suppressedInferredCount={changed.suppressedInferredCount}
                maxFiles={maxFiles}
                maxChangedLines={maxChangedLines}
                onFilePress={openFileDefault}
                onFilePressPinned={openFilePinned}
                initialCollapsedPaths={mountedInitialReviewState.collapsedPaths}
                onCollapsedPathsChange={onCollapsedPathsChange}
                initialScrollTop={mountedInitialReviewState.scrollTop}
                onScrollTopChange={onScrollTopChange}
                renderFileTrailingActions={renderReviewFileTrailingActions}
                rowDensity="compact"
                diffRefreshToken={diffRefreshToken}
                providerDiffByPath={reviewProviderDiffByPath}
                reviewCommentsEnabled={reviewCommentsEnabled}
                reviewCommentDrafts={reviewCommentDrafts}
                onUpsertReviewCommentDraft={reviewDraftHandlers.onUpsertReviewCommentDraft}
                onDeleteReviewCommentDraft={reviewDraftHandlers.onDeleteReviewCommentDraft}
                onReviewCommentError={reviewDraftHandlers.onReviewCommentError}
                onLayout={scrollFades.onViewportLayout}
                onContentSizeChange={scrollFades.onContentSizeChange}
                onScroll={scrollFades.onScroll}
            />
            <ScrollEdgeFades
                color={theme.colors.surface.base}
                size={18}
                edges={scrollFades.visibility}
            />
            <ScrollEdgeIndicators
                edges={scrollFades.visibility}
                color={theme.colors.text.secondary}
                size={14}
                opacity={0.35}
            />
        </View>
    );
});
