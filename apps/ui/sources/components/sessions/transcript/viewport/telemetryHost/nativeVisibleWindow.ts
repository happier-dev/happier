import type {
    TranscriptViewportTelemetryBlankAreaSource,
    TranscriptViewportTelemetryVisibleRangeReadStatus,
    TranscriptViewportTelemetryVisibleWindowSource,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';

export type NativeVisibleWindowSnapshot = Readonly<{
    blankAreaPx: number;
    blankAreaSource: TranscriptViewportTelemetryBlankAreaSource;
    firstVisibleItemId?: string;
    hasVisibleRows: boolean;
    lastVisibleItemId?: string;
    lastKnownFirstVisibleItemId?: string;
    lastKnownLastVisibleItemId?: string;
    visibleWindowStale?: boolean;
    visibleWindowSource: TranscriptViewportTelemetryVisibleWindowSource;
    visibleRangeReadStatus?: TranscriptViewportTelemetryVisibleRangeReadStatus;
    visibleRenderedStartIndex?: number;
    visibleRenderedEndIndex?: number;
    firstVisibleRenderedIndex?: number;
}>;

export type NativeTelemetryVisibleWindowResult = Readonly<{
    snapshot: NativeVisibleWindowSnapshot;
    lastNativeVisibleRowsSnapshot: NativeVisibleWindowSnapshot | null;
}>;

export const EMPTY_NATIVE_VISIBLE_WINDOW_SNAPSHOT: NativeVisibleWindowSnapshot = {
    blankAreaPx: 0,
    blankAreaSource: 'none',
    hasVisibleRows: true,
    visibleWindowSource: 'none',
};

export function resolveNativeVisibleWindowSnapshot(params: Readonly<{
    computeVisibleIndices: (() => { startIndex: number; endIndex: number } | null | undefined) | undefined;
    data: readonly { id: string }[];
    firstVisibleIndex: (() => number | null | undefined) | undefined;
    lastNativeVisibleRowsSnapshot: NativeVisibleWindowSnapshot | null;
    layoutHeight: number;
    nativeVisibleWindowSnapshot: NativeVisibleWindowSnapshot | null;
}>): NativeTelemetryVisibleWindowResult {
    const data = params.data;
    const blankAreaPx = data.length > 0 && Number.isFinite(params.layoutHeight) && params.layoutHeight > 0
        ? Math.max(0, Math.trunc(params.layoutHeight))
        : 0;
    let visibleRangeReadStatus: TranscriptViewportTelemetryVisibleRangeReadStatus = 'null';
    let lastNativeVisibleRowsSnapshot = params.lastNativeVisibleRowsSnapshot;

    const resolveLastKnownVisibleRowsSnapshot = (): NativeVisibleWindowSnapshot | null => {
        const snapshot = lastNativeVisibleRowsSnapshot;
        if (!snapshot?.hasVisibleRows) return null;
        const rowIds = new Set(data.map((item) => item.id));
        if (
            (snapshot.firstVisibleItemId && !rowIds.has(snapshot.firstVisibleItemId)) ||
            (snapshot.lastVisibleItemId && !rowIds.has(snapshot.lastVisibleItemId))
        ) {
            return null;
        }
        return snapshot;
    };

    const buildBlankSnapshot = (
        visibleWindowSource: TranscriptViewportTelemetryVisibleWindowSource,
        rangeFacts: Readonly<{
            firstVisibleRenderedIndex?: number;
            visibleRangeReadStatus?: TranscriptViewportTelemetryVisibleRangeReadStatus;
            visibleRenderedEndIndex?: number;
            visibleRenderedStartIndex?: number;
        }> = {},
    ): NativeVisibleWindowSnapshot => {
        const lastKnownSnapshot = resolveLastKnownVisibleRowsSnapshot();
        if (lastKnownSnapshot) {
            return {
                blankAreaPx,
                blankAreaSource: 'index-estimate',
                hasVisibleRows: false,
                ...(rangeFacts.firstVisibleRenderedIndex !== undefined
                    ? { firstVisibleRenderedIndex: rangeFacts.firstVisibleRenderedIndex }
                    : {}),
                lastKnownFirstVisibleItemId: lastKnownSnapshot.firstVisibleItemId,
                lastKnownLastVisibleItemId: lastKnownSnapshot.lastVisibleItemId,
                ...(rangeFacts.visibleRangeReadStatus ? { visibleRangeReadStatus: rangeFacts.visibleRangeReadStatus } : {}),
                ...(rangeFacts.visibleRenderedEndIndex !== undefined
                    ? { visibleRenderedEndIndex: rangeFacts.visibleRenderedEndIndex }
                    : {}),
                ...(rangeFacts.visibleRenderedStartIndex !== undefined
                    ? { visibleRenderedStartIndex: rangeFacts.visibleRenderedStartIndex }
                    : {}),
                visibleWindowSource,
                visibleWindowStale: true,
            };
        }
        return {
            blankAreaPx,
            blankAreaSource: 'index-estimate',
            ...(rangeFacts.firstVisibleRenderedIndex !== undefined
                ? { firstVisibleRenderedIndex: rangeFacts.firstVisibleRenderedIndex }
                : {}),
            hasVisibleRows: false,
            ...(rangeFacts.visibleRangeReadStatus ? { visibleRangeReadStatus: rangeFacts.visibleRangeReadStatus } : {}),
            ...(rangeFacts.visibleRenderedEndIndex !== undefined
                ? { visibleRenderedEndIndex: rangeFacts.visibleRenderedEndIndex }
                : {}),
            ...(rangeFacts.visibleRenderedStartIndex !== undefined
                ? { visibleRenderedStartIndex: rangeFacts.visibleRenderedStartIndex }
                : {}),
            visibleWindowSource,
        };
    };

    const buildSnapshotFromRange = (
        startIndex: number,
        endIndex: number,
        visibleWindowSource: TranscriptViewportTelemetryVisibleWindowSource,
    ): NativeVisibleWindowSnapshot | null => {
        if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return null;
        if (data.length === 0) {
            return {
                blankAreaPx: 0,
                blankAreaSource: 'none',
                hasVisibleRows: false,
                visibleRangeReadStatus: 'null',
                visibleWindowSource,
            };
        }
        const normalizedStart = Math.trunc(startIndex);
        const normalizedEnd = Math.trunc(endIndex);
        const rangeFacts = {
            visibleRenderedEndIndex: normalizedEnd,
            visibleRenderedStartIndex: normalizedStart,
        };
        if (normalizedStart > normalizedEnd) {
            return buildBlankSnapshot(visibleWindowSource, {
                ...rangeFacts,
                firstVisibleRenderedIndex: normalizedStart,
                visibleRangeReadStatus: 'reversed',
            });
        }
        const rangeOutOfBounds =
            normalizedStart < 0 ||
            normalizedEnd < 0 ||
            normalizedStart >= data.length ||
            normalizedEnd >= data.length;
        const clampedStart = Math.max(0, Math.min(data.length - 1, normalizedStart));
        const clampedEnd = Math.max(0, Math.min(data.length - 1, normalizedEnd));
        if (clampedStart > clampedEnd) {
            return buildBlankSnapshot(visibleWindowSource, {
                ...rangeFacts,
                firstVisibleRenderedIndex: normalizedStart,
                visibleRangeReadStatus: 'out-of-range',
            });
        }
        const firstVisibleItemId = data[clampedStart]?.id;
        const lastVisibleItemId = data[clampedEnd]?.id;
        if (!firstVisibleItemId && !lastVisibleItemId) {
            return buildBlankSnapshot(visibleWindowSource, {
                ...rangeFacts,
                firstVisibleRenderedIndex: normalizedStart,
                visibleRangeReadStatus: rangeOutOfBounds ? 'out-of-range' : 'ok',
            });
        }
        const snapshot: NativeVisibleWindowSnapshot = {
            blankAreaPx: 0,
            blankAreaSource: 'none',
            firstVisibleRenderedIndex: normalizedStart,
            firstVisibleItemId,
            hasVisibleRows: true,
            lastVisibleItemId,
            visibleRangeReadStatus: rangeOutOfBounds ? 'out-of-range' : 'ok',
            visibleRenderedEndIndex: normalizedEnd,
            visibleRenderedStartIndex: normalizedStart,
            visibleWindowSource,
        };
        lastNativeVisibleRowsSnapshot = snapshot;
        return snapshot;
    };

    try {
        const visibleIndices = params.computeVisibleIndices?.();
        const snapshot = visibleIndices
            ? buildSnapshotFromRange(visibleIndices.startIndex, visibleIndices.endIndex, 'ref-compute')
            : null;
        if (snapshot) return { snapshot, lastNativeVisibleRowsSnapshot };
    } catch {
        visibleRangeReadStatus = 'threw';
    }

    try {
        const firstVisibleIndex = params.firstVisibleIndex?.();
        if (typeof firstVisibleIndex === 'number' && Number.isFinite(firstVisibleIndex)) {
            const snapshot = buildSnapshotFromRange(firstVisibleIndex, firstVisibleIndex, 'ref-first-index');
            if (snapshot) return { snapshot, lastNativeVisibleRowsSnapshot };
        }
    } catch {
    }

    return {
        snapshot: params.nativeVisibleWindowSnapshot ?? {
            blankAreaPx,
            blankAreaSource: blankAreaPx > 0 ? 'index-estimate' : 'none',
            hasVisibleRows: false,
            visibleRangeReadStatus,
            visibleWindowSource: 'none',
        },
        lastNativeVisibleRowsSnapshot,
    };
}
