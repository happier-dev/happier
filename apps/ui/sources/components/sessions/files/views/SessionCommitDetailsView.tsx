import * as React from 'react';
import { View, ActivityIndicator, Platform, Pressable } from 'react-native';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { sessionScmCommitBackout, sessionScmDiffCommit } from '@/sync/ops';
import {
    storage,
    useSession,
    useProjectForSession,
    useSessions,
    useSessionProjectScmInFlightOperation,
    useSessionProjectScmSnapshot,
    useSessionReviewCommentsDrafts,
    useSetting,
} from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { canRevertFromSnapshot } from '@/scm/operations/safety';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { buildRevertConfirmBody } from '@/scm/operations/revertFeedback';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tracking } from '@/track';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { buildDiffBlocks, buildDiffFileEntries } from '@/components/ui/code/model/diff/diffViewModel';
import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { DiffPresentationStyleToggleButton } from '@/components/ui/code/diff/DiffPresentationStyleToggleButton';
import { useSessionReviewCommentDraftHandlers } from '@/components/sessions/reviews/comments/useSessionReviewCommentDraftHandlers';
import { useInlineUnifiedDiffReviewCommentsRenderer } from '@/components/ui/code/diff/reviewComments/useInlineUnifiedDiffReviewCommentsRenderer';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useScmReviewViewabilityConfig } from '@/scm/review/useScmReviewViewabilityConfig';
import { useViewableItemIndices } from '@/components/ui/scroll/useViewableItemIndices';
import { resolveSessionWorkspacePath } from '@/sync/domains/session/resolveSessionWorkspacePath';
import { useScmDiffExpandedKeys } from '@/components/sessions/files/content/review/useScmDiffExpandedKeys';

export type SessionCommitDetailsViewProps = Readonly<{
    sessionId: string;
    sha: string;
    onBack?: () => void;
    presentation?: 'screen' | 'panel';
    onOpenFile?: (filePath: string) => void;
    onOpenFilePinned?: (filePath: string) => void;
}>;

export function SessionCommitDetailsView(props: SessionCommitDetailsViewProps) {
    const { theme } = useUnistyles();
    const onBack = props.onBack ?? (() => {});
    const sessionId = props.sessionId;
    const sha = props.sha;
    const presentation = props.presentation ?? 'screen';
    const constrainWidth = presentation === 'screen';

    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments') === true;
    const scmSnapshot = useSessionProjectScmSnapshot(sessionId);
    const inFlightScmOperation = useSessionProjectScmInFlightOperation(sessionId);
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

    const sessionsData = useSessions();
    const isStorageReady = sessionsData !== null;
    const session = useSession(sessionId);
    const project = useProjectForSession(sessionId);
    const sessionPath = resolveSessionWorkspacePath({
        sessionPath: session?.metadata?.path ?? null,
        projectPath: project?.key?.path ?? null,
    });

    const reviewCommentDrafts = useSessionReviewCommentsDrafts(sessionId);
    const reviewDraftHandlers = useSessionReviewCommentDraftHandlers(sessionId);

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

        if (!session) {
            setError(t('files.commitDetails.missingContext'));
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        setError(null);
        try {
            const response = await sessionScmDiffCommit(sessionId, {
                commit: sha,
            });

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
    }, [isStorageReady, sessionId, sha]);

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
            operation: 'revert',
            run: async () => {
                setIsReverting(true);
                try {
                    const response = await sessionScmCommitBackout(sessionId, {
                        commit: sha,
                    });

                    if (!response.success) {
                        const errorMessage = getScmUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || t('files.commitDetails.revert.failed'),
                        });
                        reportSessionScmOperation({
                            state: storage.getState(),
                            sessionId,
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
                        operation: 'revert',
                        status: 'success',
                        detail: sha,
                        surface: 'commit',
                        tracking,
                    });
                    await scmStatusSync.invalidateFromMutationAndAwait(sessionId);
                    Modal.alert(t('common.success'), t('files.commitDetails.revert.success'));
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : t('files.commitDetails.revert.failed');
                    reportSessionScmOperation({
                        state: storage.getState(),
                        sessionId,
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
    }, [scmSnapshot, scmWriteEnabled, sessionId, sessionPath, sha]);

    if (isLoading) {
        return (
            <View
                style={[
                    styles.centered,
                    constrainWidth ? { maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' } : null,
                ]}
            >
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (error) {
        return (
            <View
                style={[
                    styles.centered,
                    constrainWidth ? { maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' } : null,
                ]}
            >
                <View style={{ width: '100%', ...(constrainWidth ? { maxWidth: layout.maxWidth } : null), paddingHorizontal: 16 }}>
                    <Text style={{ color: theme.colors.text, fontSize: 16, ...Typography.default('semiBold') }}>
                        {t('files.commitDetails.diffUnavailableTitle')}
                    </Text>
                    <Text style={{ marginTop: 6, color: theme.colors.textDestructive, ...Typography.default('semiBold') }}>
                        {error}
                    </Text>
                    <Text style={{ marginTop: 10, color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                        {t('files.commitDetails.diffUnavailableHint')}
                    </Text>
                    <Pressable
                        onPress={onBack}
                        style={{
                            marginTop: 14,
                            alignSelf: 'flex-start',
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            borderRadius: 10,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            backgroundColor: theme.colors.surfaceHigh ?? theme.colors.surface,
                        }}
                    >
                        <Text style={{ color: theme.colors.text, fontSize: 12, ...Typography.default('semiBold') }}>
                            {t('common.back')}
                        </Text>
                    </Pressable>
                </View>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface, position: 'relative' }]}>
            <View
                style={{
                    padding: 16,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surfaceHigh,
                }}
            >
                <Text style={{ color: theme.colors.textSecondary, fontSize: 12, ...Typography.default('semiBold') }}>
                    {t('files.commitDetails.commitLabel')}
                </Text>
                <Text style={{ color: theme.colors.text, fontSize: 14, ...Typography.mono() }}>{sha}</Text>
                {inFlightScmOperation && (
                    <Text style={{ marginTop: 6, color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                        {t('files.commitDetails.running', { operation: inFlightScmOperation.operation })}
                    </Text>
                )}

                {scmWriteEnabled && (
                    <>
                        <Pressable
                            disabled={isReverting || !canRevert || Boolean(inFlightScmOperation)}
                            onPress={revertCommit}
                            testID="scm-commit-details-revert"
                            style={{
                                marginTop: 10,
                                alignSelf: 'flex-start',
                                paddingHorizontal: 12,
                                paddingVertical: 7,
                                borderRadius: 8,
                                backgroundColor: theme.colors.warning,
                                opacity: isReverting || !canRevert || Boolean(inFlightScmOperation) ? 0.6 : 1,
                            }}
                        >
                            <Text style={{ color: 'white', fontSize: 12, ...Typography.default('semiBold') }}>{t('files.commitDetails.revert.button')}</Text>
                        </Pressable>
                        {!canRevert && (
                            <Text style={{ marginTop: 6, color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                                {t('files.commitRevertUnavailable')}
                            </Text>
                        )}
                    </>
                )}
            </View>

            {Platform.OS === 'web' ? (
                <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, alignItems: 'flex-start' }}>
                    <DiffPresentationStyleToggleButton />
                </View>
            ) : null}

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
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
}));
