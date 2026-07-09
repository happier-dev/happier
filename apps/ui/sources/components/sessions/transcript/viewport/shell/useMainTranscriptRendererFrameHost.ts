import * as React from 'react';
import type { TranscriptBottomFollowModeState } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type { TranscriptViewportTelemetryMvcpPolicy } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    resolveMainTranscriptRendererFrameHost,
} from '@/components/sessions/transcript/viewport/shell/mainTranscriptRendererFrameHost';

type MutableRef<T> = { current: T };

export function useMainTranscriptRendererFrameHost(params: Readonly<{
    autoFollowWhenPinned: boolean;
    bottomFollowModeRevision: number;
    bottomFollowModeStateRef: MutableRef<TranscriptBottomFollowModeState>;
    chatListNativeId: string;
    configuredFlashListDrawDistance: unknown;
    hasOpenEntryRestoreTransactionForSession: () => boolean;
    hasOpenNativePrependTransactionForSession: () => boolean;
    layoutHeight: number;
    nativeEntryShouldUseBottomMaintenance: boolean;
    nativeFlashListMvcpPolicyRef: MutableRef<TranscriptViewportTelemetryMvcpPolicy>;
    nativeFlashListPauseOffsetCorrectionRef: MutableRef<boolean>;
    nativeInitialViewportPendingObservation: boolean;
    nativePrependTransactionRevision: number;
    pinEnabled: boolean;
    pinThresholdPx: number;
    platformOS: string;
    shouldUseNativeHotColdSplit: boolean;
    targetWindowActive: boolean;
}>) {
    const {
        autoFollowWhenPinned,
        bottomFollowModeRevision,
        bottomFollowModeStateRef,
        chatListNativeId,
        configuredFlashListDrawDistance,
        hasOpenEntryRestoreTransactionForSession,
        hasOpenNativePrependTransactionForSession,
        layoutHeight,
        nativeEntryShouldUseBottomMaintenance,
        nativeFlashListMvcpPolicyRef,
        nativeFlashListPauseOffsetCorrectionRef,
        nativeInitialViewportPendingObservation,
        nativePrependTransactionRevision,
        pinEnabled,
        pinThresholdPx,
        platformOS,
        shouldUseNativeHotColdSplit,
        targetWindowActive,
    } = params;
    const mainTranscriptRendererFrameHost = React.useMemo(() => {
        const bottomFollowModeState = bottomFollowModeStateRef.current;
        return resolveMainTranscriptRendererFrameHost({
            autoFollowWhenPinned,
            bottomFollowMode: bottomFollowModeState.mode,
            configuredDrawDistance: configuredFlashListDrawDistance,
            hasOpenViewportTransaction:
                hasOpenEntryRestoreTransactionForSession() || hasOpenNativePrependTransactionForSession(),
            layoutHeight,
            liveRegionActive: shouldUseNativeHotColdSplit,
            nativeEntryShouldUseBottomMaintenance,
            nativeID: chatListNativeId,
            pinEnabled,
            pinThresholdPx,
            platformOS,
            targetWindowActive,
        });
    }, [
        autoFollowWhenPinned,
        bottomFollowModeRevision,
        bottomFollowModeStateRef,
        chatListNativeId,
        configuredFlashListDrawDistance,
        hasOpenEntryRestoreTransactionForSession,
        hasOpenNativePrependTransactionForSession,
        layoutHeight,
        nativeEntryShouldUseBottomMaintenance,
        nativeInitialViewportPendingObservation,
        nativePrependTransactionRevision,
        pinEnabled,
        pinThresholdPx,
        platformOS,
        shouldUseNativeHotColdSplit,
        targetWindowActive,
    ]);
    nativeFlashListMvcpPolicyRef.current = mainTranscriptRendererFrameHost.telemetryMvcpPolicy;
    nativeFlashListPauseOffsetCorrectionRef.current = mainTranscriptRendererFrameHost.pauseOffsetCorrection;

    return mainTranscriptRendererFrameHost.frame;
}
