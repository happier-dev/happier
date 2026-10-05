import * as React from 'react';
import { View, Platform } from 'react-native';
import {
    sessionScmCommitBackout,
    sessionScmDiffCommit,
    sessionScmRepositoryRemoveIndexLock,
} from '@/sync/ops';
import {
    storage,
    useSessions,
    useSessionProjectScmInFlightOperation,
    useSessionProjectScmSnapshot,
    useSessionRpcAvailabilityState,
    useSessionWorkspacePath,
    useWorkspaceReviewCommentsDrafts,
    useSetting,
} from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { canRevertFromSnapshot } from '@/scm/operations/safety';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { runScmOperationWithGitIndexLockRecovery } from '@/scm/operations/gitIndexLockRecovery';
import { buildRevertConfirmBody } from '@/scm/operations/revertFeedback';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tracking } from '@/track';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { buildDiffBlocks, buildDiffFileEntries } from '@/components/ui/code/model/diff/diffViewModel';
import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { DiffPresentationStyleToggleButton } from '@/components/ui/code/diff/DiffPresentationStyleToggleButton';
import { WrapLinesToggleButton } from '@/components/ui/code/WrapLinesToggleButton';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import { useInlineUnifiedDiffReviewCommentsRenderer } from '@/components/ui/code/diff/reviewComments/useInlineUnifiedDiffReviewCommentsRenderer';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useScmReviewViewabilityConfig } from '@/scm/review/useScmReviewViewabilityConfig';
import { useViewableItemIndices } from '@/components/ui/scroll/useViewableItemIndices';
import { useScmDiffExpandedKeys } from '@/components/workspaces/scm/review/useScmDiffExpandedKeys';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';
import { DetailsDiffSummaryRow } from '@/components/appShell/panes/details/header/DetailsDiffSummaryRow';
import { ScmCommitDetailsHeader } from '@/components/workspaces/scm/history/ScmCommitDetailsHeader';
import { useScmCommitLogEntry } from '@/scm/history/useScmCommitLogEntry';

export type SessionCommitDetailsViewProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    sha: string;
    onBack?: () => void;
    onOpenFile?: (filePath: string) => void;
    onOpenFilePinned?: (filePath: string) => void;
}>;

export function SessionCommitDetailsView(props: SessionCommitDetailsViewProps) {
    const { theme } = useUnistyles();
    const onBack = props.onBack ?? (() => {});
    const sessionId = props.sessionId;
    const sha = props.sha;

    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const reviewScope = useWorkspaceScopeForSession(sessionId, props.serverId);
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments') === true && Boolean(reviewScope);
    const scmSnapshot = useSessionProjectScmSnapshot(sessionId, props.serverId);
    // The commit's identity (subject, author, time, message) for the header; the diff never waits on it.
    const commitEntry = useScmCommitLogEntry(reviewScope, sha);
    const inFlightScmOperation = useSessionProjectScmInFlightOperation(sessionId, props.serverId);
    const canRevert = canRevertFromSnapshot(scmSnapshot);

    const [isLoading, setIsLoading] = React.useState(true);
    const [isReverting, setIsReverting] = React.useState(false);
    const [diff, setDiff] = React.useState<string>('');
    const [error, setError] = React.useState<string | null>(null);
    const hasLoadedDiffRef = React.useRef(false);
    const loadedKeyRef = React.useRef<string | null>(null);

    const wrapLines = useSetting('wrapLinesInDiffs');
    const showLineNumbers = useSetting('showLineNumbers');
    const scmReviewMaxFilesSetting = useSetting('scmReviewMaxFiles');
    const scmReviewMaxChangedLinesSetting = useSetting('scmReviewMaxChangedLines');

    const diffBlocks = React.useMemo(() => buildDiffBlocks({ unified_diff: diff }), [diff]);
    const diffFiles = React.useMemo(() => buildDiffFileEntries(diffBlocks), [diffBlocks]);
    const maxFiles = typeof scmReviewMaxFilesSetting === 'number' && Number.isFinite(scmReviewMaxFilesSetting) ? scmReviewMaxFilesSetting : 25;
    const maxChangedLines = typeof scmReviewMaxChangedLinesSetting === 'number' && Number.isFinite(scmReviewMaxChangedLinesSetting) ? scmReviewMaxChangedLinesSetting : 2000;
    const totalChangedLines = React.useMemo(() => {
        let total = 0;
        for (const file of diffFiles) {
            const added = typeof (file as any).added === 'number' ? (file as any).added : 0;
            const removed = typeof (file as any).removed === 'number' ? (file as any).removed : 0;
            total += Math.max(0, added) + Math.max(0, removed);
        }
        return total;
    }, [diffFiles]);
    const tooLarge = diffFiles.length > maxFiles || totalChangedLines > maxChangedLines;
    const { totalAdded, totalRemoved } = React.useMemo(() => {
        let added = 0;
        let removed = 0;
        for (const file of diffFiles) {
            added += Math.max(0, typeof file.added === 'number' ? file.added : 0);
            removed += Math.max(0, typeof file.removed === 'number' ? file.removed : 0);
        }
        return { totalAdded: added, totalRemoved: removed };
    }, [diffFiles]);

    const viewabilityConfig = useScmReviewViewabilityConfig();
    const viewability = useViewableItemIndices({
        enabled: viewabilityConfig.enabled && diffFiles.length > 0,
        debounceMs: viewabilityConfig.debounceMs,
    });

    const allKeys = React.useMemo(() => diffFiles.map((f) => f.key), [diffFiles]);
    const { expandedKeys, toggleCollapsed } = useScmDiffExpandedKeys({
        allKeys,
        viewableIndices: viewability.viewableIndices,
        tooLarge,
        aheadCount: viewabilityConfig.aheadCount,
        behindCount: viewabilityConfig.behindCount,
        resetKey: `${sessionId}:${sha}`,
    });

    const sessions = useSessions();
    const isStorageReady = sessions !== null;
    const { sessionExists } = useSessionRpcAvailabilityState(sessionId, props.serverId);
    const sessionPath = useSessionWorkspacePath(sessionId, props.serverId);

    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(reviewScope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(reviewScope);

    const renderInlineUnifiedDiff = useInlineUnifiedDiffReviewCommentsRenderer({
        enabled: reviewCommentsEnabled,
        reviewCommentDrafts,
        onUpsertReviewCommentDraft: reviewDraftHandlers.onUpsertReviewCommentDraft,
        onDeleteReviewCommentDraft: reviewDraftHandlers.onDeleteReviewCommentDraft,
        onReviewCommentError: reviewDraftHandlers.onReviewCommentError,
    });

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const loadCommit = React.useCallback(async () => {
        const requestKey = `${sessionId}:${sha}`;

        if (!sessionId || !sha) {
            setError(t('files.commitDetails.missingContext'));
            setIsLoading(false);
            return;
        }

        // Commit diffs are immutable: once we have loaded a diff for this commit, do not
        // refetch it again due to transient store hydration churn (prevents flicker).
        if (hasLoadedDiffRef.current && loadedKeyRef.current === requestKey) {
            return;
        }

        // Deep-links can happen before storage is ready. Keep the loading state until storage
        // hydrates at least once, but do not regress already-loaded diffs if hydration is flaky.
        if (!isStorageReady) {
            if (hasLoadedDiffRef.current) return;
            setIsLoading(true);
            setError(null);
            return;
        }

        if (!sessionExists) {
            setError(t('files.commitDetails.missingContext'));
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        setError(null);
        try {
            const response = await sessionScmDiffCommit(sessionId, {
                commit: sha,
            }, props.serverId);

            if (!response.success) {
                setError(response.error || t('files.commitDetails.failedToLoadDiff'));
                setDiff('');
                return;
            }

            const nextDiff = response.diff ?? '';
            hasLoadedDiffRef.current = true;
            loadedKeyRef.current = requestKey;
            setDiff(nextDiff);
        } catch (err) {
            const message = err instanceof Error ? err.message : t('files.commitDetails.failedToLoadDiff');
            setError(message);
            setDiff('');
        } finally {
            setIsLoading(false);
        }
    }, [isStorageReady, props.serverId, sessionExists, sessionId, sha]);

    React.useEffect(() => {
        loadCommit();
    }, [loadCommit]);

    const revertCommit = React.useCallback(async () => {
        const preflight = evaluateScmOperationPreflight({
            intent: 'revert',
            scmWriteEnabled,
            sessionPath,
            snapshot: scmSnapshot,
        });
        if (!preflight.allowed) {
            trackBlockedScmOperation({
                operation: 'revert',
                reason: 'preflight',
                message: preflight.message,
                surface: 'commit',
                tracking,
            });
            Modal.alert(t('common.error'), preflight.message);
            return;
        }
        const cwd = sessionPath;
        if (!cwd) return;

        const confirmed = await Modal.confirm(
            t('files.commitDetails.revert.title'),
            buildRevertConfirmBody({
                commit: sha,
                branch: scmSnapshot?.branch.head ?? null,
                detached: scmSnapshot?.branch.detached ?? false,
                detachedLabel: t('files.detachedHead'),
            }),
            { confirmText: t('files.commitDetails.revert.confirm'), cancelText: t('common.cancel') }
        );
        if (!confirmed) return;
        const lockResult = await withSessionProjectScmOperationLock({
            state: storage.getState(),
            sessionId,
            ...(props.serverId ? { serverId: props.serverId } : {}),
            operation: 'revert',
            run: async () => {
                setIsReverting(true);
                try {
                    const runBackout = async () => await sessionScmCommitBackout(sessionId, {
                        commit: sha,
                    }, props.serverId);
                    let response = await runBackout();

                    if (!response.success) {
                        response = await runScmOperationWithGitIndexLockRecovery({
                            cwd,
                            failedResponse: response,
                            removeIndexLock: (request) => sessionScmRepositoryRemoveIndexLock(sessionId, request, props.serverId),
                            retryOriginalOperation: runBackout,
                        });
                    }

                    if (!response.success) {
                        const errorMessage = getScmUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || t('files.commitDetails.revert.failed'),
                        });
                        reportSessionScmOperation({
                            state: storage.getState(),
                            sessionId,
                            ...(props.serverId ? { serverId: props.serverId } : {}),
                            operation: 'revert',
                            status: 'failed',
                            detail: errorMessage,
                            errorCode: response.errorCode,
                            surface: 'commit',
                            tracking,
                        });
                        Modal.alert(t('common.error'), errorMessage);
                        return;
                    }

                    reportSessionScmOperation({
                        state: storage.getState(),
                        sessionId,
                        ...(props.serverId ? { serverId: props.serverId } : {}),
                        operation: 'revert',
                        status: 'success',
                        detail: sha,
                        surface: 'commit',
                        tracking,
                    });
                    await scmStatusSync.invalidateFromMutationAndAwait(sessionId, props.serverId);
                    Modal.alert(t('common.success'), t('files.commitDetails.revert.success'));
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : t('files.commitDetails.revert.failed');
                    reportSessionScmOperation({
                        state: storage.getState(),
                        sessionId,
                        ...(props.serverId ? { serverId: props.serverId } : {}),
                        operation: 'revert',
                        status: 'failed',
                        detail: errorMessage,
                        surface: 'commit',
                        tracking,
                    });
                    Modal.alert(t('common.error'), errorMessage);
                } finally {
                    setIsReverting(false);
                }
            },
        });
        if (!lockResult.started) {
            trackBlockedScmOperation({
                operation: 'revert',
                reason: 'lock',
                message: lockResult.message,
                surface: 'commit',
                tracking,
            });
            Modal.alert(t('common.error'), lockResult.message);
        }
    }, [props.serverId, scmSnapshot, scmWriteEnabled, sessionId, sessionPath, sha]);

    if (isLoading) {
        return <SurfaceStateCard testID="scm-commit-details-loading" kind="loading" title={t('surfaceState.opening', { name: sha.slice(0, 7) })} />;
    }

    if (error) {
        // Pane-states lab 0 "X": what failed in words and one recovery. The failure text comes from the
        // transport, so it is the diagnostic behind the collapsed Details, never the headline.
        return (
            <SurfaceStateCard
                testID="scm-commit-details-error"
                kind="error"
                iconName="git-commit"
                title={t('files.commitDetails.couldNotOpenTitle', { sha: sha.slice(0, 7) })}
                reason={t('files.commitDetails.couldNotOpenReason')}
                diagnosticCode={error}
                action={{ label: t('surfaceState.tryAgain'), onPress: () => loadCommit() }}
                secondaryAction={{ label: t('common.back'), onPress: onBack }}
            />
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface.base, position: 'relative' }]}>
            <ScmCommitDetailsHeader
                sha={sha}
                commit={commitEntry}
                runningOperation={inFlightScmOperation?.operation ?? null}
                actions={(
                    <>
                        {Platform.OS === 'web' ? <DiffPresentationStyleToggleButton presentation="segmented" /> : null}
                        <WrapLinesToggleButton />
                    </>
                )}
            />
            <DetailsDiffSummaryRow
                testID="scm-commit-details-summary"
                label={t('detailsSurface.history.filesChanged', { count: diffFiles.length })}
                added={totalAdded}
                removed={totalRemoved}
                trailing={scmWriteEnabled ? (
                    <ToolbarButton
                        testID="scm-commit-details-revert"
                        label={t('detailsSurface.history.revertEllipsis')}
                        accessibilityLabel={canRevert ? t('files.commitDetails.revert.button') : t('files.commitRevertUnavailable')}
                        icon={<Icon name="arrow-arc-left" size={14} color={theme.colors.text.secondary} />}
                        disabled={isReverting || !canRevert || Boolean(inFlightScmOperation)}
                        busy={isReverting}
                        onPress={revertCommit}
                        style={{ borderWidth: 0, backgroundColor: 'transparent' }}
                    />
                ) : null}
            />

            <DiffFilesListView
                files={diffFiles}
                expandedKeys={expandedKeys}
                onToggleExpanded={toggleCollapsed}
                canRenderInlineDiffs={true}
                wrapLines={wrapLines}
                showLineNumbers={showLineNumbers}
                showPrefix={showLineNumbers}
                virtualizeFileList
                renderInlineUnifiedDiff={renderInlineUnifiedDiff}
                onOpenFile={props.onOpenFile}
                onOpenFilePinned={props.onOpenFilePinned}
                onLayout={scrollFades.onViewportLayout}
                onContentSizeChange={scrollFades.onContentSizeChange}
                onScroll={scrollFades.onScroll}
                onViewableItemsChanged={viewability.onViewableItemsChanged}
                scrollEventThrottle={16}
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
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
}));
