import * as React from 'react';
import { sync } from '@/sync/sync';
import {
    configureTranscriptViewportTelemetryFromTuning,
    transcriptViewportTelemetry,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    resolveTranscriptRowContentCount,
    resolveTranscriptRowViewportRelation,
} from '@/components/sessions/transcript/scroll/transcriptRowEvidence';
import { readNativeAbsoluteScrollOffset } from '@/components/sessions/transcript/viewport/driver/readNativeAbsoluteScrollOffset';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type { TranscriptViewportMode } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { TranscriptViewportTelemetryEvent } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';

type ReadRef<T> = Readonly<{ current: T }>;

export function useTranscriptRowEvidenceTelemetry(params: Readonly<{
    listDataRef: ReadRef<readonly ChatTranscriptListItem[]>;
    listLayoutHeightRef: ReadRef<number>;
    listRef: ReadRef<ScrollableChatListRef | null>;
    recordViewportTelemetryEvent: (
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
    ) => void;
    resolveViewportTelemetryMode: (mode?: TranscriptViewportMode) => TranscriptViewportMode;
    sessionId: string;
}>) {
    const {
        listDataRef,
        listLayoutHeightRef,
        listRef,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        sessionId,
    } = params;
    const rowEvidenceHeightsRef = React.useRef(new Map<string, number>());
    const rowEvidenceContentCountsRef = React.useRef(new Map<string, number>());
    const rowEvidenceIndexLookupRef = React.useRef<{
        data: readonly ChatTranscriptListItem[];
        indexById: Map<string, number>;
    } | null>(null);

    React.useEffect(() => {
        rowEvidenceHeightsRef.current.clear();
        rowEvidenceContentCountsRef.current.clear();
        rowEvidenceIndexLookupRef.current = null;
    }, [sessionId]);

    const isViewportEvidenceTelemetryEnabled = React.useCallback((): boolean => {
        configureTranscriptViewportTelemetryFromTuning(sync.getSyncTuning());
        return transcriptViewportTelemetry.isEnabled();
    }, []);

    const resolveRowEvidenceViewportRelation = React.useCallback((itemId: string) => {
        const data = listDataRef.current;
        let lookup = rowEvidenceIndexLookupRef.current;
        if (!lookup || lookup.data !== data) {
            const indexById = new Map<string, number>();
            for (let i = 0; i < data.length; i += 1) {
                const item = data[i];
                if (item) indexById.set(item.id, i);
            }
            lookup = { data, indexById };
            rowEvidenceIndexLookupRef.current = lookup;
        }
        const index = lookup.indexById.get(itemId);
        const layout = index === undefined ? undefined : listRef.current?.getLayout?.(index);
        return resolveTranscriptRowViewportRelation({
            rowTopY: layout?.y,
            rowHeightPx: layout?.height,
            scrollOffsetY: readNativeAbsoluteScrollOffset(listRef.current) ?? undefined,
            viewportHeightPx: listLayoutHeightRef.current,
        });
    }, [listDataRef, listLayoutHeightRef, listRef]);

    const handleRowShellMeasured = React.useCallback((row: Readonly<{
        itemId: string;
        rowKind: string;
        heightPx: number;
    }>) => {
        if (!isViewportEvidenceTelemetryEnabled()) return;
        const previousHeightPx = rowEvidenceHeightsRef.current.get(row.itemId);
        rowEvidenceHeightsRef.current.set(row.itemId, row.heightPx);
        if (previousHeightPx === row.heightPx) return;
        recordViewportTelemetryEvent({
            type: 'row-measured',
            mode: resolveViewportTelemetryMode(),
            rowId: row.itemId,
            rowKind: row.rowKind,
            rowHeightPx: row.heightPx,
            rowPreviousHeightPx: previousHeightPx,
            rowDeltaPx: previousHeightPx === undefined ? undefined : row.heightPx - previousHeightPx,
            rowMeasurePhase: previousHeightPx === undefined ? 'first' : 'remeasure',
            rowViewportRelation: resolveRowEvidenceViewportRelation(row.itemId),
        });
    }, [
        isViewportEvidenceTelemetryEnabled,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        resolveRowEvidenceViewportRelation,
    ]);

    const recordRowContentMutations = React.useCallback((
        items: readonly ChatTranscriptListItem[],
        getItemType: (item: ChatTranscriptListItem) => string,
    ) => {
        if (!isViewportEvidenceTelemetryEnabled()) return;
        const previousCounts = rowEvidenceContentCountsRef.current;
        const nextCounts = new Map<string, number>();
        for (const item of items) {
            const count = resolveTranscriptRowContentCount(item);
            if (count === undefined) continue;
            nextCounts.set(item.id, count);
            const previousCount = previousCounts.get(item.id);
            if (previousCount !== undefined && previousCount !== count) {
                recordViewportTelemetryEvent({
                    type: 'row-mutated',
                    mode: resolveViewportTelemetryMode(),
                    rowId: item.id,
                    rowKind: getItemType(item),
                    rowContentCount: count,
                    rowPreviousContentCount: previousCount,
                    rowViewportRelation: resolveRowEvidenceViewportRelation(item.id),
                });
            }
        }
        rowEvidenceContentCountsRef.current = nextCounts;
    }, [
        isViewportEvidenceTelemetryEnabled,
        recordViewportTelemetryEvent,
        resolveRowEvidenceViewportRelation,
        resolveViewportTelemetryMode,
    ]);

    const recordOffsetCorrectionTelemetry = React.useCallback((event: Readonly<{
        diffPx?: number;
        source?: string;
        type: string;
    }>) => {
        if (!isViewportEvidenceTelemetryEnabled()) return;
        recordViewportTelemetryEvent({
            type: 'offset-correction',
            mode: resolveViewportTelemetryMode(),
            correctionAction: event.type,
            correctionSource: event.source,
            correctionDiffPx: event.diffPx,
        });
    }, [
        isViewportEvidenceTelemetryEnabled,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
    ]);

    return React.useMemo(() => ({
        handleRowShellMeasured,
        recordRowContentMutations,
        recordOffsetCorrectionTelemetry,
    }), [
        handleRowShellMeasured,
        recordRowContentMutations,
        recordOffsetCorrectionTelemetry,
    ]);
}
