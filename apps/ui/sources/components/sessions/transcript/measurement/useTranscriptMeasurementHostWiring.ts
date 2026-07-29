import * as React from 'react';
import { useTranscriptRowEvidenceTelemetry } from '@/components/sessions/transcript/viewport/telemetryHost/rowEvidenceTelemetry';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';

type MutableRef<T> = { current: T };
type RowEvidenceTelemetryParams = Parameters<typeof useTranscriptRowEvidenceTelemetry>[0];

export function useTranscriptMeasurementHostWiring(params: Readonly<{
    getItemType: (item: ChatTranscriptListItem) => string;
    listData: readonly ChatTranscriptListItem[];
    listDataRef: MutableRef<readonly ChatTranscriptListItem[]>;
    listLayoutHeightRef: MutableRef<number>;
    listRef: MutableRef<ScrollableChatListRef | null>;
    recordViewportTelemetryEvent: RowEvidenceTelemetryParams['recordViewportTelemetryEvent'];
    resolveViewportTelemetryMode: RowEvidenceTelemetryParams['resolveViewportTelemetryMode'];
    sessionId: string;
}>) {
    const {
        getItemType,
        listData,
        listDataRef,
        listLayoutHeightRef,
        listRef,
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
        recordRowContentMutations,
    } = rowEvidenceTelemetry;

    React.useEffect(() => {
        recordRowContentMutations(listData, getItemType);
    }, [getItemType, listData, recordRowContentMutations]);

    return {
        handleRowShellMeasured,
    };
}
