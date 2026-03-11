import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { DiffPresentationStyleToggleButton } from '@/components/ui/code/diff/DiffPresentationStyleToggleButton';
import { buildDiffBlocks, buildDiffFileEntries } from '@/components/ui/code/model/diff/diffViewModel';
import { useScmDiffExpandedKeys } from '@/components/sessions/files/content/review/useScmDiffExpandedKeys';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useViewableItemIndices } from '@/components/ui/scroll/useViewableItemIndices';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { useSetting } from '@/sync/domains/state/storage';
import { sessionScmStashDrop, sessionScmStashList, sessionScmStashPop, sessionScmStashShow } from '@/sync/ops';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { useScmReviewViewabilityConfig } from '@/scm/review/useScmReviewViewabilityConfig';

import type { ScmStashEntry } from '@happier-dev/protocol';
import {
    isManagedStashTransientErrorCode,
    resolveManagedStashRetryDelayMs,
    resolveManagedStashRetryMaxIntervalMs,
    shouldContinueManagedStashRetry,
} from './scmStashRetry';

export type SessionScmStashDetailsViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
    onOpenFile?: (filePath: string) => void;
    onOpenFilePinned?: (filePath: string) => void;
}>;

type StashDiffState = Readonly<{
    stashRef: string | null;
    loading: boolean;
    diff: string;
    truncated: boolean;
    error: string | null;
}>;

function formatStashTimestamp(value: number | null | undefined): string | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    try {
        return new Date(value).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return null;
    }
}

export const SessionScmStashDetailsView = React.memo((props: SessionScmStashDetailsViewProps) => {
    const { theme } = useUnistyles();
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations') === true;

    const wrapLines = useSetting('wrapLinesInDiffs') === true;
    const showLineNumbers = useSetting('showLineNumbers') === true;
    const autoRefreshIntervalSetting = useSetting('scmFilesAutoRefreshIntervalMs');
    const scmReviewMaxFilesSetting = useSetting('scmReviewMaxFiles');
    const scmReviewMaxChangedLinesSetting = useSetting('scmReviewMaxChangedLines');
    const retryMaxIntervalMs = React.useMemo(
        () => resolveManagedStashRetryMaxIntervalMs(autoRefreshIntervalSetting),
        [autoRefreshIntervalSetting],
    );

    const [isLoadingStashes, setIsLoadingStashes] = React.useState(true);
    const [stashesError, setStashesError] = React.useState<string | null>(null);
    const [managedStashes, setManagedStashes] = React.useState<ScmStashEntry[]>([]);
    const [selectedStashRef, setSelectedStashRef] = React.useState<string | null>(null);
    const [diffState, setDiffState] = React.useState<StashDiffState>(() => ({
        stashRef: null,
        loading: false,
        diff: '',
        truncated: false,
        error: null,
    }));
    const [operationBusy, setOperationBusy] = React.useState<null | 'restore' | 'discard'>(null);
    const refreshTokenRef = React.useRef(0);
    const stashListRetryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const stashListRetryAttemptRef = React.useRef(0);
    const stashListRetryStartedAtRef = React.useRef<number | null>(null);
    const stashDiffRetryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const stashDiffRetryAttemptRef = React.useRef(0);
    const stashDiffRetryStartedAtRef = React.useRef<number | null>(null);

    const clearStashListRetry = React.useCallback(() => {
        if (stashListRetryTimerRef.current) {
            clearTimeout(stashListRetryTimerRef.current);
            stashListRetryTimerRef.current = null;
        }
    }, []);

    const clearStashDiffRetry = React.useCallback(() => {
        if (stashDiffRetryTimerRef.current) {
            clearTimeout(stashDiffRetryTimerRef.current);
            stashDiffRetryTimerRef.current = null;
        }
    }, []);

    React.useEffect(() => {
        return () => {
            clearStashListRetry();
            clearStashDiffRetry();
        };
    }, [clearStashDiffRetry, clearStashListRetry]);

    const loadStashes = React.useCallback(async () => {
        clearStashListRetry();
        setIsLoadingStashes(true);
        setStashesError(null);
        let shouldKeepLoading = false;
        try {
            const response = await sessionScmStashList(props.sessionId, {});
            if (!response.success) {
                if (isManagedStashTransientErrorCode(response.errorCode)) {
                    shouldKeepLoading = true;
                    const nowMs = Date.now();
                    const startedAtMs = stashListRetryStartedAtRef.current ?? nowMs;
                    stashListRetryStartedAtRef.current = startedAtMs;
                    const delayMs = resolveManagedStashRetryDelayMs(
                        stashListRetryAttemptRef.current,
                        retryMaxIntervalMs,
                    );
                    if (!shouldContinueManagedStashRetry({ startedAtMs, nextDelayMs: delayMs, maxIntervalMs: retryMaxIntervalMs, nowMs })) {
                        shouldKeepLoading = false;
                        stashListRetryAttemptRef.current = 0;
                        stashListRetryStartedAtRef.current = null;
                        setManagedStashes([]);
                        setSelectedStashRef(null);
                        setStashesError(response.error || t('files.stash.failedToLoad'));
                        return;
                    }
                    stashListRetryAttemptRef.current += 1;
                    stashListRetryTimerRef.current = setTimeout(() => {
                        void loadStashes();
                    }, delayMs);
                    return;
                }
                stashListRetryAttemptRef.current = 0;
                stashListRetryStartedAtRef.current = null;
                setManagedStashes([]);
                setSelectedStashRef(null);
                setStashesError(response.error || t('files.stash.failedToLoad'));
                return;
            }
            stashListRetryAttemptRef.current = 0;
            stashListRetryStartedAtRef.current = null;
            const nextStashes = Array.isArray(response.managedStashes) ? response.managedStashes : [];
            setManagedStashes(nextStashes);

            setSelectedStashRef((prev) => {
                if (prev && nextStashes.some((s) => s.stashRef === prev)) return prev;
                return nextStashes[0]?.stashRef ?? null;
            });
        } catch (err) {
            stashListRetryAttemptRef.current = 0;
            stashListRetryStartedAtRef.current = null;
            const message = err instanceof Error ? err.message : t('files.stash.failedToLoad');
            setManagedStashes([]);
            setSelectedStashRef(null);
            setStashesError(message);
        } finally {
            if (!shouldKeepLoading) {
                setIsLoadingStashes(false);
            }
        }
    }, [clearStashListRetry, props.sessionId, retryMaxIntervalMs]);

    React.useEffect(() => {
        void loadStashes();
    }, [loadStashes, props.sessionId]);

    React.useEffect(() => {
        let active = true;
        clearStashDiffRetry();
        stashDiffRetryAttemptRef.current = 0;
        stashDiffRetryStartedAtRef.current = null;
        if (!selectedStashRef) {
            setDiffState({
                stashRef: null,
                loading: false,
                diff: '',
                truncated: false,
                error: null,
            });
            return () => {
                active = false;
                clearStashDiffRetry();
            };
        }

        const loadSelectedDiff = async () => {
            clearStashDiffRetry();
            setDiffState({
                stashRef: selectedStashRef,
                loading: true,
                diff: '',
                truncated: false,
                error: null,
            });
            try {
                const response = await sessionScmStashShow(props.sessionId, { stashRef: selectedStashRef });
                if (!active) return;
                if (!response.success) {
                    if (isManagedStashTransientErrorCode(response.errorCode)) {
                        const nowMs = Date.now();
                        const startedAtMs = stashDiffRetryStartedAtRef.current ?? nowMs;
                        stashDiffRetryStartedAtRef.current = startedAtMs;
                        const delayMs = resolveManagedStashRetryDelayMs(
                            stashDiffRetryAttemptRef.current,
                            retryMaxIntervalMs,
                        );
                        if (!shouldContinueManagedStashRetry({ startedAtMs, nextDelayMs: delayMs, maxIntervalMs: retryMaxIntervalMs, nowMs })) {
                            stashDiffRetryAttemptRef.current = 0;
                            stashDiffRetryStartedAtRef.current = null;
                            setDiffState({
                                stashRef: selectedStashRef,
                                loading: false,
                                diff: '',
                                truncated: false,
                                error: response.error || t('files.stash.failedToLoadDiff'),
                            });
                            return;
                        }
                        stashDiffRetryAttemptRef.current += 1;
                        stashDiffRetryTimerRef.current = setTimeout(() => {
                            if (active) {
                                void loadSelectedDiff();
                            }
                        }, delayMs);
                        return;
                    }
                    stashDiffRetryAttemptRef.current = 0;
                    stashDiffRetryStartedAtRef.current = null;
                    setDiffState({
                        stashRef: selectedStashRef,
                        loading: false,
                        diff: '',
                        truncated: false,
                        error: response.error || t('files.stash.failedToLoadDiff'),
                    });
                    return;
                }
                stashDiffRetryAttemptRef.current = 0;
                stashDiffRetryStartedAtRef.current = null;
                setDiffState({
                    stashRef: selectedStashRef,
                    loading: false,
                    diff: response.diff ?? '',
                    truncated: response.truncated === true,
                    error: null,
                });
            } catch (err) {
                if (!active) return;
                stashDiffRetryAttemptRef.current = 0;
                stashDiffRetryStartedAtRef.current = null;
                const message = err instanceof Error ? err.message : t('files.stash.failedToLoadDiff');
                setDiffState({
                    stashRef: selectedStashRef,
                    loading: false,
                    diff: '',
                    truncated: false,
                    error: message,
                });
            }
        };

        void loadSelectedDiff();

        return () => {
            active = false;
            clearStashDiffRetry();
        };
    }, [clearStashDiffRetry, props.sessionId, retryMaxIntervalMs, selectedStashRef]);

    const diffBlocks = React.useMemo(() => buildDiffBlocks({ unified_diff: diffState.diff }), [diffState.diff]);
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
        resetKey: `${props.sessionId}:${selectedStashRef ?? ''}:${refreshTokenRef.current}`,
    });

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const selectedStash = React.useMemo(() => {
        if (!selectedStashRef) return null;
        return managedStashes.find((stash) => stash.stashRef === selectedStashRef) ?? null;
    }, [managedStashes, selectedStashRef]);

    const ensureCanMutate = React.useCallback(() => {
        if (!scmWriteEnabled) {
            Modal.alert(t('common.error'), t('files.stash.writeDisabled'));
            return false;
        }
        if (!selectedStashRef) {
            Modal.alert(t('common.error'), t('files.stash.noSelection'));
            return false;
        }
        if (operationBusy) return false;
        return true;
    }, [operationBusy, scmWriteEnabled, selectedStashRef]);

    const restoreSelected = React.useCallback(async () => {
        if (!ensureCanMutate()) return;
        const stashRef = selectedStashRef as string;

        const confirmed = await Modal.confirm(
            t('files.stash.restoreConfirm.title'),
            t('files.stash.restoreConfirm.body'),
            { confirmText: t('files.stash.restoreConfirm.confirm'), cancelText: t('common.cancel') },
        );
        if (!confirmed) return;

        setOperationBusy('restore');
        try {
            const response = await sessionScmStashPop(props.sessionId, { stashRef });
            if (!response.success) {
                Modal.alert(t('common.error'), response.error || t('files.stash.restoreFailed'));
                return;
            }
            await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
            refreshTokenRef.current += 1;
            await loadStashes();
        } catch (err) {
            const message = err instanceof Error ? err.message : t('files.stash.restoreFailed');
            Modal.alert(t('common.error'), message);
        } finally {
            setOperationBusy(null);
        }
    }, [ensureCanMutate, loadStashes, props.sessionId, selectedStashRef]);

    const discardSelected = React.useCallback(async () => {
        if (!ensureCanMutate()) return;
        const stashRef = selectedStashRef as string;

        const confirmed = await Modal.confirm(
            t('files.stash.discardConfirm.title'),
            t('files.stash.discardConfirm.body'),
            { confirmText: t('files.stash.discardConfirm.confirm'), cancelText: t('common.cancel') },
        );
        if (!confirmed) return;

        setOperationBusy('discard');
        try {
            const response = await sessionScmStashDrop(props.sessionId, { stashRef });
            if (!response.success) {
                Modal.alert(t('common.error'), response.error || t('files.stash.discardFailed'));
                return;
            }
            await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
            refreshTokenRef.current += 1;
            await loadStashes();
        } catch (err) {
            const message = err instanceof Error ? err.message : t('files.stash.discardFailed');
            Modal.alert(t('common.error'), message);
        } finally {
            setOperationBusy(null);
        }
    }, [ensureCanMutate, loadStashes, props.sessionId, selectedStashRef]);

    if (isLoadingStashes && managedStashes.length === 0) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 24 }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={{ marginTop: 12, fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }
    if (!isLoadingStashes && managedStashes.length === 0) {
        return (
            <View
                testID="scm-stash-details-root"
                style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}
            >
                <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default(), textAlign: 'center' }}>
                    {stashesError ? stashesError : t('files.stash.empty')}
                </Text>
            </View>
        );
    }

    return (
        <View testID="scm-stash-details-root" style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
            <View
                style={{
                    paddingHorizontal: 16,
                    paddingTop: 14,
                    paddingBottom: 12,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surfaceHigh,
                    gap: 10,
                }}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                            {t('files.stash.detailsTitle')}
                        </Text>
                        {selectedStash ? (
                            <Text style={{ marginTop: 4, fontSize: 12, color: theme.colors.text, ...Typography.mono('semiBold') }}>
                                {selectedStash.branch ? `${selectedStash.branch} · ${selectedStash.stashRef}` : selectedStash.stashRef}
                            </Text>
                        ) : null}
                        {selectedStash?.createdAt ? (
                            <Text style={{ marginTop: 4, fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                                {formatStashTimestamp(selectedStash.createdAt) ?? ''}
                            </Text>
                        ) : null}
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Pressable
                            testID="scm-stash-restore-button"
                            accessibilityRole="button"
                            accessibilityLabel={t('files.stash.restore')}
                            onPress={() => {
                                void restoreSelected();
                            }}
                            style={({ pressed }) => ({
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 6,
                                paddingHorizontal: 10,
                                height: 32,
                                borderRadius: 10,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                backgroundColor: theme.colors.surface,
                                opacity: pressed || operationBusy ? 0.78 : 1,
                            })}
                        >
                            <Octicons name="upload" size={14} color={theme.colors.textSecondary} />
                            <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                                {t('files.stash.restore')}
                            </Text>
                        </Pressable>
                        <Pressable
                            testID="scm-stash-discard-button"
                            accessibilityRole="button"
                            accessibilityLabel={t('files.stash.discard')}
                            onPress={() => {
                                void discardSelected();
                            }}
                            style={({ pressed }) => ({
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 6,
                                paddingHorizontal: 10,
                                height: 32,
                                borderRadius: 10,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                backgroundColor: theme.colors.surface,
                                opacity: pressed || operationBusy ? 0.78 : 1,
                            })}
                        >
                            <Octicons name="trash" size={14} color={theme.colors.textSecondary} />
                            <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                                {t('files.stash.discard')}
                            </Text>
                        </Pressable>
                    </View>
                </View>

                {managedStashes.length > 1 ? (
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ paddingVertical: 2, gap: 8 }}
                        style={{ flexGrow: 0 }}
                    >
                        {managedStashes.map((stash) => {
                            const isSelected = stash.stashRef === selectedStashRef;
                            const safeId = toTestIdSafeValue(stash.stashRef);
                            return (
                                <Pressable
                                    key={stash.stashRef}
                                    testID={`scm-stash-pill-${safeId}`}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('files.stash.selectA11y', { stash: stash.stashRef })}
                                    onPress={() => setSelectedStashRef(stash.stashRef)}
                                    style={({ pressed }) => ({
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 6,
                                        paddingHorizontal: 10,
                                        height: 28,
                                        borderRadius: 999,
                                        borderWidth: 1,
                                        borderColor: isSelected ? theme.colors.textLink : theme.colors.divider,
                                        backgroundColor: isSelected ? theme.colors.surfaceHighest ?? theme.colors.surfaceHigh : theme.colors.surface,
                                        opacity: pressed ? 0.85 : 1,
                                    })}
                                >
                                    <Octicons
                                        name={stash.kind === 'transient' ? 'zap' : 'archive'}
                                        size={13}
                                        color={theme.colors.textSecondary}
                                    />
                                    <Text
                                        numberOfLines={1}
                                        style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.mono('semiBold') }}
                                    >
                                        {stash.branch ?? stash.stashRef}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </ScrollView>
                ) : null}

                {stashesError ? (
                    <Text style={{ fontSize: 12, color: theme.colors.warning, ...Typography.default() }}>
                        {stashesError}
                    </Text>
                ) : null}
            </View>

            {Platform.OS === 'web' ? (
                <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, alignItems: 'flex-start' }}>
                    <DiffPresentationStyleToggleButton />
                </View>
            ) : null}

            {diffState.loading ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 24 }}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    <Text style={{ marginTop: 12, fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                        {t('common.loading')}
                    </Text>
                </View>
            ) : diffState.error ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                    <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default(), textAlign: 'center' }}>
                        {diffState.error}
                    </Text>
                </View>
            ) : (
                <View style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                    <DiffFilesListView
                        files={diffFiles}
                        expandedKeys={expandedKeys}
                        onToggleExpanded={toggleCollapsed}
                        canRenderInlineDiffs={true}
                        wrapLines={wrapLines}
                        showLineNumbers={showLineNumbers}
                        showPrefix={showLineNumbers}
                        virtualizeFileList
                        onOpenFile={props.onOpenFile}
                        onOpenFilePinned={props.onOpenFilePinned}
                        ListHeaderComponent={
                            diffState.truncated
                                ? () => (
                                    <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 }}>
                                        <Text style={{ fontSize: 12, color: theme.colors.warning, ...Typography.default('semiBold') }}>
                                            {t('files.stash.diffTruncated')}
                                        </Text>
                                    </View>
                                )
                                : null
                        }
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
            )}
        </View>
    );
});
