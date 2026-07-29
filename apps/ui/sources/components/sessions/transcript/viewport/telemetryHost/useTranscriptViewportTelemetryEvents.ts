import * as React from 'react';
import { Platform } from 'react-native';
import { sync } from '@/sync/sync';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import {
    configureTranscriptViewportTelemetryFromTuning,
    recordTranscriptViewportTelemetryEvent,
    resolveTranscriptViewportTelemetryRendererFacts,
    resolveTranscriptViewportTelemetryPlatform,
    transcriptViewportTelemetry,
    type TranscriptViewportTelemetryBottomFollowMode,
    type TranscriptViewportTelemetryEvent,
    type TranscriptViewportTelemetryObservationReason,
    type TranscriptViewportTelemetryScrollReason,
    type TranscriptViewportTelemetryTransactionState,
    type TranscriptViewportTelemetryWebTrigger,
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
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

type MutableRef<T> = { current: T };

export type TranscriptViewportTelemetryEventsDeps = Readonly<{
    applyBlankRecoveryEffects(effects: readonly TranscriptBlankRecoveryEffect[]): void;
    bottomFollowModeStateRef: MutableRef<TranscriptBottomFollowModeState>;
    entryRestoreOwner: EntryRestoreOwner;
    getBottomFollowGestureActiveRef: MutableRef<() => boolean>;
    items: readonly ChatTranscriptListItem[];
    lastNativeVisibleRowsSnapshotRef: MutableRef<NativeVisibleWindowSnapshot | null>;
    listContentHeightRef: MutableRef<number>;
    listData: readonly ChatTranscriptListItem[];
    listLayoutHeightRef: MutableRef<number>;
    listRef: MutableRef<ScrollableChatListRef | null>;
    nativeMomentumScrollActiveRef: MutableRef<boolean>;
    nativePrependTelemetryStateRef: MutableRef<() => TranscriptViewportTelemetryTransactionState>;
    nativeVisibleWindowSnapshotRef: MutableRef<NativeVisibleWindowSnapshot | null>;
    /**
     * The session's ONE navigation-visibility publication owner (it resolves the
     * jump-landing retention immediately before it writes). Native viewability is
     * a trigger for it, never a second writer: publishing containment from here
     * would revert the rail to the pre-jump turn after every landing.
     */
    observeTranscriptNavigationVisibilityRef: MutableRef<() => void>;
    platformOS: typeof Platform.OS;
    readViewportVisibleSourceRange(): NativeVisibleSourceRange;
    resolveNativeObservedScrollOffset(
        rawOffsetY: number,
        override?: Readonly<{ contentHeight?: number; layoutHeight?: number }>,
    ): { canonicalOffsetY: number; distanceFromLiveTailPx: number } | null;
    resolveWebScrollMetrics(): WebTranscriptScrollMetrics | null;
    resolveWebViewportTelemetryDiagnostics(params: Readonly<{
        listContentHeight?: number;
        listLayoutHeight?: number;
        metrics?: WebTranscriptScrollMetrics | null;
        paginationPhase?: string;
        paginationSuspendedReasons?: readonly string[];
        programmaticWebWrite: boolean;
        scrollable?: boolean;
        trigger: TranscriptViewportTelemetryWebTrigger;
    }>): Record<string, unknown>;
    sessionId: string;
    wantsPinnedRef: MutableRef<boolean>;
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
    const telemetryRendererFacts = resolveTranscriptViewportTelemetryRendererFacts();

    const resolveEnabledViewportTelemetryTuning = React.useCallback(() => {
        const tuning = sync.getSyncTuning();
        configureTranscriptViewportTelemetryFromTuning(tuning);
        return transcriptViewportTelemetry.isEnabled() ? tuning : null;
    }, []);

    const resolveNativeVisibleWindowSnapshot = React.useCallback((): NativeVisibleWindowSnapshot => {
        const result = resolveNativeVisibleWindowSnapshotResult({
            computeVisibleIndices: () => deps.listRef.current?.computeVisibleIndices?.(),
            data: deps.listData,
            firstVisibleIndex: () => deps.listRef.current?.getFirstVisibleIndex?.(),
            lastNativeVisibleRowsSnapshot: deps.lastNativeVisibleRowsSnapshotRef.current,
            layoutHeight: deps.listLayoutHeightRef.current,
            nativeVisibleWindowSnapshot: deps.nativeVisibleWindowSnapshotRef.current,
        });
        deps.lastNativeVisibleRowsSnapshotRef.current = result.lastNativeVisibleRowsSnapshot;
        return result.snapshot;
    }, [
        deps.lastNativeVisibleRowsSnapshotRef,
        deps.listData,
        deps.listLayoutHeightRef,
        deps.listRef,
        deps.nativeVisibleWindowSnapshotRef,
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
            contentPresent: deps.listData.length > 0,
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
        deps.listData,
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
            contentHeight,
            entryRestoreState,
            eventContentHeight,
            eventLayoutHeight,
            fullItemCount: deps.items.length,
            layoutHeight,
            listDataLength: deps.listData.length,
            nativeMomentumActive: deps.nativeMomentumScrollActiveRef.current,
            orientation: telemetryRendererFacts.orientation,
            observedOffset,
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
        deps.items,
        deps.lastNativeVisibleRowsSnapshotRef,
        deps.listContentHeightRef,
        deps.listData,
        deps.listLayoutHeightRef,
        deps.listRef,
        deps.nativeMomentumScrollActiveRef,
        deps.nativePrependTelemetryStateRef,
        deps.nativeVisibleWindowSnapshotRef,
        deps.platformOS,
        deps.resolveNativeObservedScrollOffset,
        deps.sessionId,
        telemetryRendererFacts.orientation,
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
            listImplementation: telemetryRendererFacts.listImplementation,
            timestampMs: Date.now(),
        }, tuning);
    }, [
        deps.sessionId,
        resolveEnabledViewportTelemetryTuning,
        resolveNativeTelemetryDiagnostics,
        telemetryRendererFacts.listImplementation,
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
        // Viewability is a navigation-visibility TRIGGER: it fires on layout-only
        // changes that never emit a scroll event. It hands the frame to the
        // session's single publication owner, which re-derives from the renderer's
        // visible index window AND resolves the jump-landing retention; writing a
        // snapshot from here instead made viewability a competing owner that
        // reverted every landing.
        deps.observeTranscriptNavigationVisibilityRef.current();
        const result = resolveNativeViewabilityTelemetry({
            info,
            itemCount: deps.listData.length,
            layoutHeight: deps.listLayoutHeightRef.current,
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
        deps.listData,
        deps.listLayoutHeightRef,
        deps.nativeVisibleWindowSnapshotRef,
        deps.observeTranscriptNavigationVisibilityRef,
        deps.platformOS,
        observeNativeBlankRecovery,
        recordNativeVisibleWindowTelemetry,
    ]);

    const shouldAttachNativeViewability = deps.platformOS !== 'web';
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
