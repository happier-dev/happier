import * as React from 'react';
import { Platform } from 'react-native';
import { sync } from '@/sync/sync';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import {
    configureTranscriptViewportTelemetryFromTuning,
    recordTranscriptViewportTelemetryEvent,
    resolveTranscriptViewportTelemetryPlatform,
    transcriptViewportTelemetry,
    type TranscriptViewportTelemetryBottomFollowMode,
    type TranscriptViewportTelemetryEvent,
    type TranscriptViewportTelemetryMvcpPolicy,
    type TranscriptViewportTelemetryObservationReason,
    type TranscriptViewportTelemetryScrollReason,
    type TranscriptViewportTelemetryTransactionState,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptBottomFollowModeState } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type { TranscriptViewportMode } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import { readNativeAbsoluteScrollOffset } from '@/components/sessions/transcript/viewport/driver/readNativeAbsoluteScrollOffset';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type { EntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import {
    EMPTY_NATIVE_VISIBLE_WINDOW_SNAPSHOT,
    resolveNativeVisibleWindowSnapshot as resolveNativeVisibleWindowSnapshotResult,
    type NativeVisibleWindowSnapshot,
} from '@/components/sessions/transcript/viewport/telemetryHost/nativeVisibleWindow';
import { resolveNativeTelemetryDiagnostics as resolveNativeTelemetryDiagnosticsRecord } from '@/components/sessions/transcript/viewport/telemetryHost/nativeDiagnostics';
import {
    resolveNativeViewabilityTelemetry,
    type NativeViewableTranscriptItem,
} from '@/components/sessions/transcript/viewport/telemetryHost/nativeViewability';
import { readFiniteTelemetryNumber } from '@/components/sessions/transcript/viewport/telemetryHost/readTelemetryPrimitive';
import {
    buildRestoreDecisionTelemetryEvent,
    buildScrollObservedTelemetryEvent,
    resolveNativeVisibleWindowTelemetryEvent,
    type NativeVisibleSourceRange,
    type NativeVisibleWindowTelemetryParams,
    type RestoreDecisionTelemetryParams,
    type ScrollObservedTelemetryParams,
} from '@/components/sessions/transcript/viewport/telemetryHost/viewportEvents';
import {
    createTranscriptBlankRecoveryState,
    planTranscriptBlankRecoveryObservation,
    type TranscriptBlankRecoveryEffect,
} from '@/components/sessions/transcript/viewport/visibility/blankRecoveryOwner';
import { getTranscriptNavigationVisibilityStore } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';
import type { TranscriptNavigationRuntimeAnchor } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';
import type { TranscriptListOrientation } from '@/components/sessions/transcript/listOrientation';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { WebPrependTelemetryFacts, WebPrependTelemetryFactsInput } from '@/components/sessions/transcript/viewport/prepend/webPrependOwner';

type MutableRef<T> = { current: T };

type TranscriptHotColdSegments = Readonly<{
    coldCount: number;
    hotCount: number;
}>;

type NativeHotEdgeVisibleRows = {
    firstItemId: string | null;
    firstSourceIndex: number | null;
    lastItemId: string | null;
    lastSourceIndex: number | null;
} | null;

export type TranscriptViewportTelemetryEventsDeps = Readonly<{
    applyBlankRecoveryEffects(effects: readonly TranscriptBlankRecoveryEffect[]): void;
    bottomFollowModeStateRef: MutableRef<TranscriptBottomFollowModeState>;
    entryRestoreOwner: EntryRestoreOwner;
    getBottomFollowGestureActiveRef: MutableRef<() => boolean>;
    itemsRef: MutableRef<readonly ChatTranscriptListItem[]>;
    lastNativeVisibleRowsSnapshotRef: MutableRef<NativeVisibleWindowSnapshot | null>;
    listContentHeightRef: MutableRef<number>;
    listDataRef: MutableRef<readonly ChatTranscriptListItem[]>;
    listLayoutHeightRef: MutableRef<number>;
    listOrientation: TranscriptListOrientation;
    listRef: MutableRef<ScrollableChatListRef | null>;
    nativeFlashListMvcpPolicyRef: MutableRef<TranscriptViewportTelemetryMvcpPolicy>;
    nativeFlashListPauseOffsetCorrectionRef: MutableRef<boolean>;
    nativeHotEdgeVisibleRowsRef: MutableRef<NativeHotEdgeVisibleRows>;
    nativeMomentumScrollActiveRef: MutableRef<boolean>;
    nativePrependTelemetryStateRef: MutableRef<() => TranscriptViewportTelemetryTransactionState>;
    nativeVisibleWindowSnapshotRef: MutableRef<NativeVisibleWindowSnapshot | null>;
    pinThresholdPxRef: MutableRef<number>;
    platformOS: typeof Platform.OS;
    readCurrentNativeDistanceFromBottom(params?: Readonly<{ contentHeight?: number; layoutHeight?: number }>): number | null;
    readViewportVisibleSourceRange(): NativeVisibleSourceRange;
    resolveNativeObservedScrollOffset(
        rawOffsetY: number,
        override?: Readonly<{ contentHeight?: number; layoutHeight?: number }>,
    ): { canonicalOffsetY: number; distanceFromLiveTailPx: number } | null;
    resolveWebPrependTelemetryFactsRef: MutableRef<(params: WebPrependTelemetryFactsInput) => WebPrependTelemetryFacts>;
    resolveWebScrollMetrics(): WebTranscriptScrollMetrics | null;
    resolveWebViewportTelemetryDiagnostics(params: Readonly<{
        flashListContentHeight?: number;
        flashListLayoutHeight?: number;
        metrics?: WebTranscriptScrollMetrics | null;
        paginationPhase?: string;
        paginationSuspendedReasons?: readonly string[];
        programmaticWebWrite: boolean;
        scrollable?: boolean;
        trigger: 'scroll' | 'edge-reached' | 'restore' | 'prepend-restore' | 'jump';
    }>): Record<string, unknown>;
    runtimeAnchorsRef: MutableRef<readonly TranscriptNavigationRuntimeAnchor[]>;
    sessionId: string;
    shouldUseNativeHotColdSplit: boolean;
    transcriptHotColdSegments: TranscriptHotColdSegments;
    usesNativeFlashListBottomMaintenance: boolean;
    wantsPinnedRef: MutableRef<boolean>;
    webHotColdCountsRef: MutableRef<{ coldCount: number; hotCount: number }>;
}>;

export type TranscriptViewportTelemetryEvents = Readonly<{
    handleNativeViewableItemsChanged(info: Readonly<{ viewableItems?: readonly NativeViewableTranscriptItem[] }>): void;
    nativeViewabilityConfig: { itemVisiblePercentThreshold: number } | undefined;
    observeNativeBlankRecovery(
        observationReason?: TranscriptViewportTelemetryObservationReason,
        source?: Readonly<{
            canonicalOffsetY?: number;
            contentHeight?: number;
            distanceFromBottom?: number;
            emptyVisibleWindowObserved?: boolean;
            layoutHeight?: number;
            rawOffsetY?: number;
            viewportOutsideContentObserved?: boolean;
        }>,
    ): void;
    recordNativeVisibleWindowTelemetry(
        reason?: TranscriptViewportTelemetryObservationReason,
        params?: NativeVisibleWindowTelemetryParams,
    ): void;
    recordRestoreDecisionTelemetry(
        reason: TranscriptViewportTelemetryObservationReason,
        params?: RestoreDecisionTelemetryParams,
    ): void;
    recordScrollObservedTelemetry(params: ScrollObservedTelemetryParams): void;
    recordViewportTelemetryEvent(
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
        options?: Readonly<{ sessionId?: string }>,
    ): void;
    resolveNativeTelemetryDiagnostics(source: Readonly<Record<string, unknown>>): Record<string, unknown>;
    resolveNativeVisibleWindowSnapshot(): NativeVisibleWindowSnapshot;
    resolveViewportTelemetryMode(mode?: TranscriptViewportMode): TranscriptViewportMode;
    shouldAttachNativeViewability: boolean;
    telemetryPlatform: ReturnType<typeof resolveTranscriptViewportTelemetryPlatform>;
}>;

export function useTranscriptViewportTelemetryEvents(
    deps: TranscriptViewportTelemetryEventsDeps,
): TranscriptViewportTelemetryEvents {
    const blankRecoveryStateRef = React.useRef(createTranscriptBlankRecoveryState());
    const telemetryPlatform = resolveTranscriptViewportTelemetryPlatform(deps.platformOS);

    const resolveEnabledViewportTelemetryTuning = React.useCallback(() => {
        const tuning = sync.getSyncTuning();
        configureTranscriptViewportTelemetryFromTuning(tuning);
        return transcriptViewportTelemetry.isEnabled() ? tuning : null;
    }, []);

    const resolveNativeVisibleWindowSnapshot = React.useCallback((): NativeVisibleWindowSnapshot => {
        const result = resolveNativeVisibleWindowSnapshotResult({
            computeVisibleIndices: () => deps.listRef.current?.computeVisibleIndices?.(),
            data: deps.listDataRef.current,
            distanceFromBottom: deps.readCurrentNativeDistanceFromBottom(),
            firstVisibleIndex: () => deps.listRef.current?.getFirstVisibleIndex?.(),
            lastNativeVisibleRowsSnapshot: deps.lastNativeVisibleRowsSnapshotRef.current,
            layoutHeight: deps.listLayoutHeightRef.current,
            nativeHotEdgeVisibleRows: deps.nativeHotEdgeVisibleRowsRef.current,
            nativeVisibleWindowSnapshot: deps.nativeVisibleWindowSnapshotRef.current,
            pinThresholdPx: deps.pinThresholdPxRef.current,
            rawOffsetY: readNativeAbsoluteScrollOffset(deps.listRef.current),
        });
        deps.lastNativeVisibleRowsSnapshotRef.current = result.lastNativeVisibleRowsSnapshot;
        return result.snapshot;
    }, [
        deps.lastNativeVisibleRowsSnapshotRef,
        deps.listDataRef,
        deps.listLayoutHeightRef,
        deps.listRef,
        deps.nativeHotEdgeVisibleRowsRef,
        deps.nativeVisibleWindowSnapshotRef,
        deps.pinThresholdPxRef,
        deps.readCurrentNativeDistanceFromBottom,
    ]);

    const observeNativeBlankRecovery = React.useCallback((
        observationReason: TranscriptViewportTelemetryObservationReason = 'observed',
        source: Readonly<{
            canonicalOffsetY?: number;
            contentHeight?: number;
            distanceFromBottom?: number;
            emptyVisibleWindowObserved?: boolean;
            layoutHeight?: number;
            rawOffsetY?: number;
            viewportOutsideContentObserved?: boolean;
        }> = {},
    ): void => {
        if (deps.platformOS === 'web') return;
        const invalidNativeOffset = observationReason === 'invalid-native-offset';
        const viewportOutsideContent = source.viewportOutsideContentObserved === true;
        if (!invalidNativeOffset && source.emptyVisibleWindowObserved !== true && !viewportOutsideContent) return;
        const rawOffsetY = source.rawOffsetY ?? (
            invalidNativeOffset ? readNativeAbsoluteScrollOffset(deps.listRef.current) ?? undefined : undefined
        );
        const bottomFollowState = deps.bottomFollowModeStateRef.current;
        const bottomFollowMode: TranscriptViewportTelemetryBottomFollowMode =
            bottomFollowState.mode === 'escaping' || bottomFollowState.mode === 'released'
                ? bottomFollowState.mode
                : 'following';
        const entryRestoreState: TranscriptViewportTelemetryTransactionState =
            deps.entryRestoreOwner.telemetryState(deps.sessionId);
        const prependState: TranscriptViewportTelemetryTransactionState =
            deps.nativePrependTelemetryStateRef.current();
        const recoveryPlan = planTranscriptBlankRecoveryObservation(blankRecoveryStateRef.current, {
            bottomFollowMode,
            contentPresent: deps.listDataRef.current.length > 0,
            entryRestoreOpen: entryRestoreState === 'open',
            gestureActive:
                deps.getBottomFollowGestureActiveRef.current() ||
                deps.nativeMomentumScrollActiveRef.current ||
                bottomFollowState.dragSession !== null,
            hasVisibleRows: source.emptyVisibleWindowObserved === true ? false : true,
            nowMs: Date.now(),
            observationReason: invalidNativeOffset ? 'invalid-native-offset' : undefined,
            prependOpen: prependState === 'open',
            rawOffsetY,
            sessionId: deps.sessionId,
            viewportOutsideContent,
        });
        blankRecoveryStateRef.current = recoveryPlan.state;
        deps.applyBlankRecoveryEffects(recoveryPlan.effects);
    }, [
        deps.applyBlankRecoveryEffects,
        deps.bottomFollowModeStateRef,
        deps.entryRestoreOwner,
        deps.getBottomFollowGestureActiveRef,
        deps.listDataRef,
        deps.listRef,
        deps.nativeMomentumScrollActiveRef,
        deps.nativePrependTelemetryStateRef,
        deps.platformOS,
        deps.sessionId,
    ]);

    const resolveNativeTelemetryDiagnostics = React.useCallback((
        source: Readonly<Record<string, unknown>>,
    ): Record<string, unknown> => {
        if (deps.platformOS === 'web') return {};
        const rawOffsetFromSource = readFiniteTelemetryNumber(source.rawOffsetY);
        const rawOffsetFromList = readNativeAbsoluteScrollOffset(deps.listRef.current) ?? undefined;
        const rawOffsetY = rawOffsetFromSource ?? rawOffsetFromList;
        const eventLayoutHeight = readFiniteTelemetryNumber(source.layoutHeight);
        const eventContentHeight = readFiniteTelemetryNumber(source.contentHeight);
        const refLayoutHeight = readFiniteTelemetryNumber(deps.listLayoutHeightRef.current);
        const refContentHeight = readFiniteTelemetryNumber(deps.listContentHeightRef.current);
        const layoutHeight = eventLayoutHeight ?? refLayoutHeight;
        const contentHeight = eventContentHeight ?? refContentHeight;
        const observedOffset =
            rawOffsetY !== undefined &&
            layoutHeight !== undefined &&
            contentHeight !== undefined
                ? deps.resolveNativeObservedScrollOffset(rawOffsetY, { contentHeight, layoutHeight })
                : null;
        const shouldResolveVisibleSnapshot =
            source.emptyVisibleWindowObserved === true ||
            source.reason === 'invalid-native-offset' ||
            source.type === 'visible-window-observed';
        const visibleSnapshot = shouldResolveVisibleSnapshot
            ? resolveNativeVisibleWindowSnapshot()
            : deps.nativeVisibleWindowSnapshotRef.current ?? deps.lastNativeVisibleRowsSnapshotRef.current ?? EMPTY_NATIVE_VISIBLE_WINDOW_SNAPSHOT;
        const bottomFollowState = deps.bottomFollowModeStateRef.current;
        const bottomFollowMode: TranscriptViewportTelemetryBottomFollowMode =
            bottomFollowState.mode === 'escaping' || bottomFollowState.mode === 'released'
                ? bottomFollowState.mode
                : 'following';
        const entryRestoreState: TranscriptViewportTelemetryTransactionState =
            deps.entryRestoreOwner.telemetryState(deps.sessionId);
        const prependState: TranscriptViewportTelemetryTransactionState =
            deps.nativePrependTelemetryStateRef.current();
        return resolveNativeTelemetryDiagnosticsRecord({
            bottomFollowMode,
            dragSessionTrusted: bottomFollowState.dragSession?.trusted === true,
            carveTelemetry: {
                active: deps.shouldUseNativeHotColdSplit,
                coldCount: deps.transcriptHotColdSegments.coldCount,
                hotCount: deps.transcriptHotColdSegments.hotCount,
            },
            contentHeight,
            entryRestoreState,
            eventContentHeight,
            eventLayoutHeight,
            fullItemCount: deps.itemsRef.current.length,
            layoutHeight,
            listDataLength: deps.listDataRef.current.length,
            nativeMomentumActive: deps.nativeMomentumScrollActiveRef.current,
            mvcpPolicy: deps.nativeFlashListMvcpPolicyRef.current,
            observedOffset,
            pauseOffsetCorrection: deps.nativeFlashListPauseOffsetCorrectionRef.current,
            prependState,
            rawOffsetY,
            refContentHeight,
            refLayoutHeight,
            source,
            visibleSnapshot,
        });
    }, [
        deps.bottomFollowModeStateRef,
        deps.entryRestoreOwner,
        deps.itemsRef,
        deps.lastNativeVisibleRowsSnapshotRef,
        deps.listContentHeightRef,
        deps.listDataRef,
        deps.listLayoutHeightRef,
        deps.listRef,
        deps.nativeFlashListMvcpPolicyRef,
        deps.nativeFlashListPauseOffsetCorrectionRef,
        deps.nativeMomentumScrollActiveRef,
        deps.nativePrependTelemetryStateRef,
        deps.nativeVisibleWindowSnapshotRef,
        deps.platformOS,
        deps.resolveNativeObservedScrollOffset,
        deps.sessionId,
        deps.shouldUseNativeHotColdSplit,
        deps.transcriptHotColdSegments,
        resolveNativeVisibleWindowSnapshot,
    ]);

    const resolveViewportTelemetryMode = React.useCallback((mode?: TranscriptViewportMode): TranscriptViewportMode => {
        return mode ?? (deps.wantsPinnedRef.current ? 'follow-bottom' : 'user-unpinned');
    }, [deps.wantsPinnedRef]);

    const recordViewportTelemetryEvent = React.useCallback((
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
        options?: Readonly<{ sessionId?: string }>,
    ) => {
        const tuning = resolveEnabledViewportTelemetryTuning();
        if (!tuning) return;
        const nativeDiagnostics = resolveNativeTelemetryDiagnostics(event);
        recordTranscriptViewportTelemetryEvent({
            ...event,
            ...nativeDiagnostics,
            sessionId: options?.sessionId ?? deps.sessionId,
            platform: telemetryPlatform,
            listImplementation: 'flash_v2',
            timestampMs: Date.now(),
        }, tuning);
    }, [
        deps.sessionId,
        resolveEnabledViewportTelemetryTuning,
        resolveNativeTelemetryDiagnostics,
        telemetryPlatform,
    ]);

    const recordRestoreDecisionTelemetry = React.useCallback((
        reason: TranscriptViewportTelemetryObservationReason,
        params: RestoreDecisionTelemetryParams = {},
    ) => {
        const webMetrics = deps.platformOS === 'web' ? deps.resolveWebScrollMetrics() : null;
        recordViewportTelemetryEvent(buildRestoreDecisionTelemetryEvent({
            mode: resolveViewportTelemetryMode(params.mode ?? 'restore-distance'),
            reason,
            restore: params,
            webMetrics,
            resolveWebDiagnostics: deps.resolveWebViewportTelemetryDiagnostics,
        }));
    }, [
        deps.platformOS,
        deps.resolveWebScrollMetrics,
        deps.resolveWebViewportTelemetryDiagnostics,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
    ]);

    const recordScrollObservedTelemetry = React.useCallback((
        params: ScrollObservedTelemetryParams,
    ) => {
        recordViewportTelemetryEvent(buildScrollObservedTelemetryEvent({
            mode: resolveViewportTelemetryMode(),
            scroll: params,
        }));
    }, [recordViewportTelemetryEvent, resolveViewportTelemetryMode]);

    const recordNativeVisibleWindowTelemetry = React.useCallback((
        reason: TranscriptViewportTelemetryObservationReason = 'observed',
        params: NativeVisibleWindowTelemetryParams = {},
    ) => {
        if (!resolveEnabledViewportTelemetryTuning()) return;
        const layoutHeight = params.layoutHeight ?? deps.listLayoutHeightRef.current;
        const contentHeight = params.contentHeight ?? deps.listContentHeightRef.current;
        const rawOffsetY = params.rawOffsetY ?? readNativeAbsoluteScrollOffset(deps.listRef.current) ?? undefined;
        const event = resolveNativeVisibleWindowTelemetryEvent({
            contentHeight,
            distanceFromBottom: params.distanceFromBottom,
            layoutHeight,
            mode: resolveViewportTelemetryMode(),
            observedOffset: rawOffsetY !== undefined
                ? deps.resolveNativeObservedScrollOffset(rawOffsetY, { contentHeight, layoutHeight })
                : null,
            readRawOffsetY: () => readNativeAbsoluteScrollOffset(deps.listRef.current),
            reason,
            source: params,
            visibleSourceRange: deps.wantsPinnedRef.current ? deps.readViewportVisibleSourceRange() : null,
        });
        if (event) recordViewportTelemetryEvent(event);
    }, [
        deps.listContentHeightRef,
        deps.listLayoutHeightRef,
        deps.listRef,
        deps.readViewportVisibleSourceRange,
        deps.resolveNativeObservedScrollOffset,
        deps.wantsPinnedRef,
        recordViewportTelemetryEvent,
        resolveEnabledViewportTelemetryTuning,
        resolveViewportTelemetryMode,
    ]);

    const handleNativeViewableItemsChanged = React.useCallback((info: Readonly<{
        viewableItems?: readonly NativeViewableTranscriptItem[];
    }>) => {
        if (deps.platformOS === 'web') return;
        const result = resolveNativeViewabilityTelemetry({
            info,
            itemCount: deps.listDataRef.current.length,
            layoutHeight: deps.listLayoutHeightRef.current,
            listOrientation: deps.listOrientation,
            runtimeAnchors: deps.runtimeAnchorsRef.current,
            sessionId: deps.sessionId,
            syncTuning: sync.getSyncTuning(),
        });
        if (!result) return;
        deps.nativeVisibleWindowSnapshotRef.current = result.snapshot;
        if (deps.nativeVisibleWindowSnapshotRef.current.hasVisibleRows) {
            deps.lastNativeVisibleRowsSnapshotRef.current = deps.nativeVisibleWindowSnapshotRef.current;
        }
        if (result.observeBlankRecovery) {
            observeNativeBlankRecovery('observed', {
                emptyVisibleWindowObserved: true,
            });
        }
        recordNativeVisibleWindowTelemetry('observed');
    }, [
        deps.lastNativeVisibleRowsSnapshotRef,
        deps.listDataRef,
        deps.listLayoutHeightRef,
        deps.listOrientation,
        deps.nativeVisibleWindowSnapshotRef,
        deps.platformOS,
        deps.runtimeAnchorsRef,
        deps.sessionId,
        observeNativeBlankRecovery,
        recordNativeVisibleWindowTelemetry,
    ]);

    const shouldAttachNativeViewabilityTelemetry =
        deps.platformOS !== 'web' &&
        sync.getSyncTuning().transcriptViewportTelemetryEnabled === true;
    const shouldAttachNativeViewability =
        deps.platformOS !== 'web' &&
        (!deps.usesNativeFlashListBottomMaintenance || shouldAttachNativeViewabilityTelemetry || (
            deps.runtimeAnchorsRef.current.length > 0 &&
            getTranscriptNavigationVisibilityStore(deps.sessionId).hasSubscribers()
        ));
    const nativeViewabilityConfig = React.useMemo(() => (
        shouldAttachNativeViewability
            ? { itemVisiblePercentThreshold: 1 }
            : undefined
    ), [shouldAttachNativeViewability]);

    return {
        handleNativeViewableItemsChanged,
        nativeViewabilityConfig,
        observeNativeBlankRecovery,
        recordNativeVisibleWindowTelemetry,
        recordRestoreDecisionTelemetry,
        recordScrollObservedTelemetry,
        recordViewportTelemetryEvent,
        resolveNativeTelemetryDiagnostics,
        resolveNativeVisibleWindowSnapshot,
        resolveViewportTelemetryMode,
        shouldAttachNativeViewability,
        telemetryPlatform,
    };
}
