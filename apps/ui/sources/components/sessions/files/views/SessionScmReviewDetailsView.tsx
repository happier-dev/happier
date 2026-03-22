import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { Text } from '@/components/ui/text/Text';
import { ChangedFilesReview } from '@/components/sessions/files/content/ChangedFilesReview';
import { useChangedFilesData } from '@/hooks/session/files/useChangedFilesData';
import { useProjectForSession, useProjectSessions, useSession, useSessionMessages, useSessionProjectScmOperationLog, useSessionProjectScmSnapshot, useSessionProjectScmSnapshotError, useSessionProjectScmTouchedPaths, useSetting } from '@/sync/domains/state/storage';
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
import { NotSourceControlRepositoryState, SourceControlUnavailableState } from '@/components/sessions/sourceControl/states';
import { t } from '@/text';
import { useLastNonNullValue } from '@/hooks/ui/useLastNonNullValue';
import { resolveSessionWorkspacePath } from '@/sync/domains/session/resolveSessionWorkspacePath';
import { useDerivedSessionChangeSet } from '@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet';
import { getDefaultChangedFilesViewMode, type ChangedFilesViewMode } from '@/scm/scmAttribution';

export type SessionScmReviewDetailsViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
}>;

export const SessionScmReviewDetailsView = React.memo((props: SessionScmReviewDetailsViewProps) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
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
            if (prev[key] !== value) {
                hasChange = true;
                break;
            }
        }
        if (!hasChange) return;
        setDetailsTabState(reviewTabKey, { ...prev, ...patch });
    }, [setDetailsTabState]);
    const onCollapsedPathsChange = React.useCallback((paths: string[]) => {
        setPersistedReviewTabState({ collapsedPaths: paths });
    }, [setPersistedReviewTabState]);
    const onScrollTopChange = React.useCallback((top: number) => {
        setPersistedReviewTabState({ scrollTop: top });
    }, [setPersistedReviewTabState]);
    const session = useSession(props.sessionId);
    const project = useProjectForSession(props.sessionId);
    const sessionPath = resolveSessionWorkspacePath({
        sessionPath: session?.metadata?.path ?? null,
        projectPath: project?.key?.path ?? null,
    });
    const snapshot = useSessionProjectScmSnapshot(props.sessionId);
    const lastGoodSnapshot = useLastNonNullValue(snapshot, { resetKey: props.sessionId });
    const effectiveSnapshot = snapshot ?? lastGoodSnapshot;
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
    const { latestTurnScopedChangeSet, latestTurnDiffByPath, sessionChangeSet, providerDiffByPath } = useDerivedSessionChangeSet(props.sessionId);
    const [changedFilesViewMode, setChangedFilesViewMode] = React.useState<ChangedFilesViewMode>(() => {
        if (latestTurnScopedChangeSet) return 'turn';
        if (sessionChangeSet) return 'session';
        return getDefaultChangedFilesViewMode();
    });

    React.useEffect(() => {
        if (changedFilesViewMode === 'turn' && latestTurnScopedChangeSet) return;
        if (changedFilesViewMode === 'session' && sessionChangeSet) return;
        if (latestTurnScopedChangeSet) {
            setChangedFilesViewMode('turn');
            return;
        }
        if (sessionChangeSet) {
            setChangedFilesViewMode('session');
            return;
        }
        if (changedFilesViewMode !== 'repository') {
            setChangedFilesViewMode(getDefaultChangedFilesViewMode());
        }
    }, [changedFilesViewMode, latestTurnScopedChangeSet, sessionChangeSet]);

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
        sessionChangeSet,
    });

    const reviewProviderDiffByPath = React.useMemo(() => {
        if (changedFilesViewMode === 'turn') return latestTurnDiffByPath;
        if (changedFilesViewMode === 'session') return providerDiffByPath;
        return null;
    }, [changedFilesViewMode, latestTurnDiffByPath, providerDiffByPath]);

    const viewModeOptions = React.useMemo(() => {
        return [
            { mode: 'repository' as const, label: t('files.toolbar.repositoryView'), icon: 'list-unordered' as const },
            ...(changed.showTurnViewToggle
                ? [{ mode: 'turn' as const, label: t('files.toolbar.turnView'), icon: 'clock' as const }]
                : []),
            ...(changed.showSessionViewToggle
                ? [{ mode: 'session' as const, label: t('files.toolbar.sessionView'), icon: 'history' as const }]
                : []),
        ];
    }, [changed.showSessionViewToggle, changed.showTurnViewToggle]);

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
    }, [pane]);

    // Ensure the SCM snapshot is warm so large reviews can load diffs even if the user
    // opened the review tab before visiting Source control.
    React.useEffect(() => {
        scmStatusSync.invalidateFromUser(props.sessionId);
    }, [props.sessionId]);

    const refreshAfterMutation = React.useCallback(async () => {
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
        setDiffRefreshToken((t) => t + 1);
    }, [props.sessionId]);

    if (!effectiveSnapshot && !snapshotError) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 24 }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={{ marginTop: 12, fontSize: 12, color: theme.colors.textSecondary }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (effectiveSnapshot && effectiveSnapshot.repo.isRepo === false) {
        return <NotSourceControlRepositoryState />;
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
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surfaceHigh,
                }}
            >
                {viewModeOptions.map((option) => {
                    const active = changedFilesViewMode === option.mode;
                    return (
                        <Pressable
                            key={option.mode}
                            accessibilityRole="button"
                            onPress={() => setChangedFilesViewMode(option.mode)}
                            style={({ pressed }) => ({
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: 6,
                                height: 28,
                                paddingHorizontal: 10,
                                borderRadius: 10,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                backgroundColor: active ? theme.colors.surface : theme.colors.surfaceHigh,
                                opacity: pressed ? 0.78 : 1,
                            })}
                        >
                            <Octicons name={option.icon} size={13} color={theme.colors.textSecondary} />
                            <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>
                                {option.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
            <ChangedFilesReview
                theme={theme}
                sessionId={props.sessionId}
                snapshot={effectiveSnapshot ?? null}
                changedFilesViewMode={changedFilesViewMode}
                attributionReliability={changed.attributionReliability}
                allRepositoryChangedFiles={changed.allRepositoryChangedFiles}
                turnAttributedFiles={changed.turnAttributedFiles}
                turnRepositoryOnlyFiles={changed.turnRepositoryOnlyFiles}
                sessionAttributedFiles={changed.sessionAttributedFiles}
                repositoryOnlyFiles={changed.repositoryOnlyFiles}
                suppressedInferredCount={changed.suppressedInferredCount}
                maxFiles={maxFiles}
                maxChangedLines={maxChangedLines}
                onFilePress={(file) => openFile(file.fullPath, 'default')}
                onFilePressPinned={(file) => openFile(file.fullPath, 'pinned')}
                initialCollapsedPaths={persistedCollapsedPaths}
                onCollapsedPathsChange={onCollapsedPathsChange}
                initialScrollTop={persistedScrollTop}
                onScrollTopChange={onScrollTopChange}
                renderFileTrailingActions={
                    scmWriteEnabled
                        ? (file) => (
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
                        )
                        : undefined
                }
                rowDensity="compact"
                diffRefreshToken={diffRefreshToken}
                providerDiffByPath={reviewProviderDiffByPath}
                onLayout={scrollFades.onViewportLayout}
                onContentSizeChange={scrollFades.onContentSizeChange}
                onScroll={scrollFades.onScroll}
            />
            <ScrollEdgeFades
                color={theme.colors.surface}
                size={18}
                edges={scrollFades.visibility}
            />
            <ScrollEdgeIndicators
                edges={scrollFades.visibility}
                color={theme.colors.textSecondary}
                size={14}
                opacity={0.35}
            />
        </View>
    );
});
