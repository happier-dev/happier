import * as React from 'react';
import { useTranscriptRowEvidenceTelemetry } from '@/components/sessions/transcript/viewport/telemetryHost/rowEvidenceTelemetry';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type {
    TranscriptMeasurementHost,
    TranscriptMeasurementHostEffect,
} from '@/components/sessions/transcript/measurement/transcriptMeasurementHost';
import type { TranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';

type MutableRef<T> = { current: T };
type RowEvidenceTelemetryParams = Parameters<typeof useTranscriptRowEvidenceTelemetry>[0];

export function useTranscriptMeasurementHostWiring(params: Readonly<{
    getItemType: (item: ChatTranscriptListItem) => string;
    hasOpenEntryRestoreTransactionForSession: () => boolean;
    hasOpenNativePrependTransactionForSession: () => boolean;
    listData: readonly ChatTranscriptListItem[];
    listDataRef: MutableRef<readonly ChatTranscriptListItem[]>;
    listLayoutHeightRef: MutableRef<number>;
    listRef: MutableRef<ScrollableChatListRef | null>;
    measurementHost: TranscriptMeasurementHost;
    recordViewportTelemetryEvent: RowEvidenceTelemetryParams['recordViewportTelemetryEvent'];
    resolveViewportTelemetryMode: RowEvidenceTelemetryParams['resolveViewportTelemetryMode'];
    sessionId: string;
}>) {
    const {
        getItemType,
        hasOpenEntryRestoreTransactionForSession,
        hasOpenNativePrependTransactionForSession,
        listData,
        listDataRef,
        listLayoutHeightRef,
        listRef,
        measurementHost,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        sessionId,
    } = params;
    const rowEvidenceTelemetry = useTranscriptRowEvidenceTelemetry({
        listDataRef,
        listLayoutHeightRef,
        listRef,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        sessionId,
    });
    const {
        handleRowShellMeasured,
        recordOffsetCorrectionTelemetry,
        recordRowContentMutations,
    } = rowEvidenceTelemetry;

    React.useEffect(() => {
        recordRowContentMutations(listData, getItemType);
    }, [getItemType, listData, recordRowContentMutations]);

    React.useEffect(() => {
        measurementHost.advanceLayoutInvalidationCommitToken();
    });

    const applyTranscriptMeasurementHostEffects = React.useCallback((
        effects: readonly TranscriptMeasurementHostEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.type === 'clear-layout-cache') {
                const list = listRef.current;
                list?.clearLayoutCacheOnUpdate?.();
            }
        }
    }, [listRef]);

    const handleRowLayoutMutation = React.useCallback((rowMutation: Readonly<{
        itemId: string;
        mutation: TranscriptRowLayoutMutation;
        rowKind: string;
    }>) => {
        const result = measurementHost.observeRowLayoutMutation({
            mutation: rowMutation.mutation,
            viewportTransactionOpen:
                hasOpenNativePrependTransactionForSession() || hasOpenEntryRestoreTransactionForSession(),
        });
        applyTranscriptMeasurementHostEffects(result.effects);
    }, [
        applyTranscriptMeasurementHostEffects,
        hasOpenEntryRestoreTransactionForSession,
        hasOpenNativePrependTransactionForSession,
        measurementHost,
    ]);

    return {
        handleRowLayoutMutation,
        handleRowShellMeasured,
        recordOffsetCorrectionTelemetry,
    };
}
