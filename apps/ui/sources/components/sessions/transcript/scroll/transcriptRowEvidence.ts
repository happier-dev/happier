/**
 * N1 evidence helpers (dev-gated telemetry only — no product behavior):
 * pure calculators behind the `row-measured` / `row-mutated` transcript viewport
 * telemetry events. Geometry inputs come from the FlashList imperative API
 * (`getLayout`, `getAbsoluteLastScrollOffset`) and the observed list layout height;
 * content counts come from the transcript row items themselves.
 */

import type { TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';

import type { TranscriptViewportTelemetryRowViewportRelation } from './transcriptViewportTelemetry';

function isUsableNumber(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Classifies where a row sits relative to the viewport at measure time.
 * Boundaries are exclusive: a row ending exactly at the viewport top is `above`,
 * a row starting exactly at the viewport bottom is `below`.
 */
export function resolveTranscriptRowViewportRelation(params: Readonly<{
    rowTopY: number | undefined;
    rowHeightPx: number | undefined;
    scrollOffsetY: number | undefined;
    viewportHeightPx: number | undefined;
}>): TranscriptViewportTelemetryRowViewportRelation {
    const { rowTopY, rowHeightPx, scrollOffsetY, viewportHeightPx } = params;
    if (
        !isUsableNumber(rowTopY) ||
        !isUsableNumber(rowHeightPx) ||
        !isUsableNumber(scrollOffsetY) ||
        !isUsableNumber(viewportHeightPx) ||
        viewportHeightPx <= 0
    ) {
        return 'unknown';
    }
    if (rowTopY + rowHeightPx <= scrollOffsetY) return 'above';
    if (rowTopY >= scrollOffsetY + viewportHeightPx) return 'below';
    return 'inside';
}

/**
 * Number of content entries rendered inside one virtualized row (N1.3 / D6):
 * post-mount growth of this count is an intra-row mutation no list-level
 * position maintenance can compensate for.
 */
export function resolveTranscriptRowContentCount(item: TranscriptRowShellItem): number | undefined {
    if (item.kind === 'message') return 1;
    if (item.kind === 'pending-user-action') return 1;
    // N2c stable virtualization units: each unit row renders exactly one content entry,
    // so tool-group growth becomes between-row insertion and row-mutated events ~ 0.
    if (
        item.kind === 'tool-group-header' ||
        item.kind === 'tool-group-expand' ||
        item.kind === 'tool-group-tool' ||
        item.kind === 'tool-group-footer'
    ) {
        return 1;
    }
    if (item.kind === 'tool-calls-group') return item.toolMessageIds.length;
    if (item.kind === 'turn') {
        let count = item.turn.userMessageId ? 1 : 0;
        for (const content of item.turn.content) {
            count += content.kind === 'message' ? 1 : content.toolMessageIds.length;
        }
        return count;
    }
    return undefined;
}
