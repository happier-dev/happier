import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { DiffPresentationStyleToggleButton } from '@/components/ui/code/diff/DiffPresentationStyleToggleButton';
import { buildDiffBlocks, buildDiffFileEntries } from '@/components/ui/code/model/diff/diffViewModel';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { useViewableItemIndices } from '@/components/ui/scroll/useViewableItemIndices';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { useScmReviewViewabilityConfig } from '@/scm/review/useScmReviewViewabilityConfig';
import { resolveScmStashEntries } from '@/scm/stash/useScmStashSummaryCount';
import { resolveScmStashIconName, resolveScmStashPrimaryLabel, resolveScmStashSecondaryLabel } from '@/scm/stash/stashPresentation';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { useScmDiffExpandedKeys } from '@/components/workspaces/scm/review/useScmDiffExpandedKeys';
import { type ScmStashDetailsAdapter } from './scmStashAdapter';
import {
    isManagedStashTransientErrorCode,
    resolveManagedStashRetryDelayMs,
    resolveManagedStashRetryMaxIntervalMs,
    shouldContinueManagedStashRetry,
} from './scmStashRetry';

import type { ScmStashEntry } from '@happier-dev/protocol';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';

type StashDiffState = Readonly<{
    stashRef: string | null;
    loading: boolean;
    diff: string;
    truncated: boolean;
    error: string | null;
}>;

export type ScmStashDetailsCoreProps = Readonly<{
    adapter: ScmStashDetailsAdapter;
    scopeResetKey: string;
    onAfterMutation?: (() => Promise<void> | void) | null;
    onOpenFile?: (filePath: string) => void;
    onOpenFilePinned?: (filePath: string) => void;
    rootTestId?: string;
    restoreButtonTestId?: string;
    discardButtonTestId?: string;
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

function resolveStashSelectorSubtitle(entry: ScmStashEntry): string | null {
    const secondary = resolveScmStashSecondaryLabel(entry);
    const timestamp = formatStashTimestamp(entry.createdAt);
    if (secondary && timestamp) {
        return `${secondary} • ${timestamp}`;
    }
    return secondary ?? timestamp;
}

export const ScmStashDetailsCore = React.memo((props: ScmStashDetailsCoreProps) => {
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
    const [stashes, setStashes] = React.useState<ScmStashEntry[]>([]);
    const [selectedStashRef, setSelectedStashRef] = React.useState<string | null>(null);
    const [stashSelectorOpen, setStashSelectorOpen] = React.useState(false);
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
            const response = await props.adapter.list();
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
                        setStashes([]);
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
                setStashes([]);
                setSelectedStashRef(null);
                setStashesError(response.error || t('files.stash.failedToLoad'));
                return;
            }

            stashListRetryAttemptRef.current = 0;
            stashListRetryStartedAtRef.current = null;
            const nextStashes = resolveScmStashEntries(response);
            setStashes(nextStashes);
            setSelectedStashRef((prev) => {
                if (prev && nextStashes.some((stash) => stash.stashRef === prev)) return prev;
                return nextStashes[0]?.stashRef ?? null;
            });
        } catch (error) {
            stashListRetryAttemptRef.current = 0;
            stashListRetryStartedAtRef.current = null;
            const message = error instanceof Error ? error.message : t('files.stash.failedToLoad');
            setStashes([]);
            setSelectedStashRef(null);
            setStashesError(message);
        } finally {
            if (!shouldKeepLoading) {
                setIsLoadingStashes(false);
            }
        }
    }, [clearStashListRetry, props.adapter, retryMaxIntervalMs]);

    React.useEffect(() => {
        void loadStashes();
    }, [loadStashes, props.scopeResetKey]);

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
                const response = await props.adapter.show(selectedStashRef);
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
            } catch (error) {
                if (!active) return;
                stashDiffRetryAttemptRef.current = 0;
                stashDiffRetryStartedAtRef.current = null;
                const message = error instanceof Error ? error.message : t('files.stash.failedToLoadDiff');
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
    }, [clearStashDiffRetry, props.adapter, retryMaxIntervalMs, selectedStashRef]);

    const diffBlocks = React.useMemo(() => buildDiffBlocks({ unified_diff: diffState.diff }), [diffState.diff]);
    const diffFiles = React.useMemo(() => buildDiffFileEntries(diffBlocks), [diffBlocks]);
    const maxFiles = typeof scmReviewMaxFilesSetting === 'number' && Number.isFinite(scmReviewMaxFilesSetting) ? scmReviewMaxFilesSetting : 25;
    const maxChangedLines = typeof scmReviewMaxChangedLinesSetting === 'number' && Number.isFinite(scmReviewMaxChangedLinesSetting) ? scmReviewMaxChangedLinesSetting : 2000;
    const totalChangedLines = React.useMemo(() => {
        let total = 0;
        for (const file of diffFiles) {
            const added = typeof file.added === 'number' ? file.added : 0;
            const removed = typeof file.removed === 'number' ? file.removed : 0;
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

    const allKeys = React.useMemo(() => diffFiles.map((file) => file.key), [diffFiles]);
    const { expandedKeys, toggleCollapsed } = useScmDiffExpandedKeys({
        allKeys,
        viewableIndices: viewability.viewableIndices,
        tooLarge,
        aheadCount: viewabilityConfig.aheadCount,
        behindCount: viewabilityConfig.behindCount,
        resetKey: `${props.scopeResetKey}:${selectedStashRef ?? ''}:${refreshTokenRef.current}`,
    });

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const selectedStash = React.useMemo(() => {
        if (!selectedStashRef) return null;
        return stashes.find((stash) => stash.stashRef === selectedStashRef) ?? null;
    }, [selectedStashRef, stashes]);
    const stashSelectorItems = React.useMemo<ReadonlyArray<DropdownMenuItem>>(() => {
        return stashes.map((stash) => ({
            id: stash.stashRef,
            title: resolveScmStashPrimaryLabel(stash),
            subtitle: resolveStashSelectorSubtitle(stash) ?? undefined,
            icon: (
                <Icon
                    name={resolveScmStashIconName(stash)}
                    size={16}
                    color={theme.colors.text.secondary}
                />
            ),
        }));
    }, [stashes, theme.colors.text.secondary]);

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
        const confirmed = await Modal.confirm(
            t('files.stash.restoreConfirm.title'),
            t('files.stash.restoreConfirm.body'),
            { confirmText: t('files.stash.restoreConfirm.confirm'), cancelText: t('common.cancel') },
        );
        if (!confirmed || !selectedStashRef) return;

        setOperationBusy('restore');
        try {
            const response = await props.adapter.pop(selectedStashRef);
            if (!response.success) {
                Modal.alert(t('common.error'), response.error || t('files.stash.restoreFailed'));
                return;
            }
            await props.onAfterMutation?.();
            refreshTokenRef.current += 1;
            await loadStashes();
        } catch (error) {
            const message = error instanceof Error ? error.message : t('files.stash.restoreFailed');
            Modal.alert(t('common.error'), message);
        } finally {
            setOperationBusy(null);
        }
    }, [ensureCanMutate, loadStashes, props.adapter, props.onAfterMutation, selectedStashRef]);

    const discardSelected = React.useCallback(async () => {
        if (!ensureCanMutate()) return;
        const confirmed = await Modal.confirm(
            t('files.stash.discardConfirm.title'),
            t('files.stash.discardConfirm.body'),
            { confirmText: t('files.stash.discardConfirm.confirm'), cancelText: t('common.cancel') },
        );
        if (!confirmed || !selectedStashRef) return;

        setOperationBusy('discard');
        try {
            const response = await props.adapter.drop(selectedStashRef);
            if (!response.success) {
                Modal.alert(t('common.error'), response.error || t('files.stash.discardFailed'));
                return;
            }
            await props.onAfterMutation?.();
            refreshTokenRef.current += 1;
            await loadStashes();
        } catch (error) {
            const message = error instanceof Error ? error.message : t('files.stash.discardFailed');
            Modal.alert(t('common.error'), message);
        } finally {
            setOperationBusy(null);
        }
    }, [ensureCanMutate, loadStashes, props.adapter, props.onAfterMutation, selectedStashRef]);

    const rootTestId = props.rootTestId;

    if (isLoadingStashes && stashes.length === 0) {
        return (
            <View testID={rootTestId} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 24 }}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                <Text style={{ marginTop: 12, fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (!isLoadingStashes && stashes.length === 0) {
        return (
            <View testID={rootTestId} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Text style={{ fontSize: 13, color: theme.colors.text.secondary, ...Typography.default(), textAlign: 'center' }}>
                    {stashesError ? stashesError : t('files.stash.empty')}
                </Text>
            </View>
        );
    }

    return (
        <View testID={rootTestId} style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
            <View
                style={{
                    paddingHorizontal: 16,
                    paddingTop: 14,
                    paddingBottom: 12,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.border.default,
                    backgroundColor: theme.colors.surface.inset,
                    gap: 10,
                }}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <DropdownMenu
                            open={stashSelectorOpen}
                            onOpenChange={setStashSelectorOpen}
                            selectedId={selectedStashRef}
                            items={stashSelectorItems}
                            onSelect={(itemId) => {
                                setSelectedStashRef(itemId);
                                setStashSelectorOpen(false);
                            }}
                            variant="selectable"
                            search={false}
                            showCategoryTitles={false}
                            rowKind="item"
                            itemRowProps={{ density: 'compact' }}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            itemTrigger={{
                                title: t('files.stash.detailsTitle'),
                                icon: (
                                    <Icon
                                        name={selectedStash ? resolveScmStashIconName(selectedStash) : 'archive'}
                                        size={16}
                                        color={theme.colors.text.secondary}
                                    />
                                ),
                                itemProps: { density: 'compact' },
                            }}
                        />
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Pressable
                            testID={props.restoreButtonTestId}
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
                                borderColor: theme.colors.border.default,
                                backgroundColor: theme.colors.surface.base,
                                opacity: pressed || operationBusy ? 0.78 : 1,
                            })}
                        >
                            <Icon name="upload" size={14} color={theme.colors.text.secondary} />
                            <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                                {t('files.stash.restore')}
                            </Text>
                        </Pressable>
                        <Pressable
                            testID={props.discardButtonTestId}
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
                                borderColor: theme.colors.border.default,
                                backgroundColor: theme.colors.surface.base,
                                opacity: pressed || operationBusy ? 0.78 : 1,
                            })}
                        >
                            <Icon name="trash" size={14} color={theme.colors.text.secondary} />
                            <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                                {t('files.stash.discard')}
                            </Text>
                        </Pressable>
                    </View>
                </View>

                {stashesError ? (
                    <Text style={{ fontSize: 12, color: theme.colors.state.neutral.foreground, ...Typography.default() }}>
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
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    <Text style={{ marginTop: 12, fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                        {t('common.loading')}
                    </Text>
                </View>
            ) : diffState.error ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                    <Text style={{ fontSize: 13, color: theme.colors.text.secondary, ...Typography.default(), textAlign: 'center' }}>
                        {diffState.error}
                    </Text>
                </View>
            ) : (
                <View style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                    <DiffFilesListView
                        files={diffFiles}
                        expandedKeys={expandedKeys}
                        onToggleExpanded={toggleCollapsed}
                        canRenderInlineDiffs
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
                                        <Text style={{ fontSize: 12, color: theme.colors.state.neutral.foreground, ...Typography.default('semiBold') }}>
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
            )}
        </View>
    );
});
