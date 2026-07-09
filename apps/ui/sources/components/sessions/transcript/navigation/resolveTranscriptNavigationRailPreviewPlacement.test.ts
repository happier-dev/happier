import { describe, expect, it } from 'vitest';

import { resolveTranscriptNavigationRailPreviewPlacement } from './resolveTranscriptNavigationRailPreviewPlacement';

const BASE = {
    markerTopPx: 100,
    railWidthPx: 24,
    paneHeightPx: 800,
    paneWidthPx: 1000,
    viewportOffsetTopPx: 80,
    previewHeightPx: 72,
} as const;

describe('resolveTranscriptNavigationRailPreviewPlacement', () => {
    it('places the preview beside the rail with an 8px gutter derived from rail layout facts', () => {
        expect(resolveTranscriptNavigationRailPreviewPlacement(BASE).leftPx).toBe(32);
        expect(resolveTranscriptNavigationRailPreviewPlacement({ ...BASE, railWidthPx: 40 }).leftPx).toBe(48);
    });

    it('anchors the preview near the focused marker inside the pane bounds', () => {
        expect(resolveTranscriptNavigationRailPreviewPlacement(BASE).topPx).toBe(76);
    });

    it('clamps the preview to the pane top edge', () => {
        const placement = resolveTranscriptNavigationRailPreviewPlacement({ ...BASE, markerTopPx: -400 });
        // 8px margin from the pane top, expressed in rail-container coordinates.
        expect(placement.topPx).toBe(8 - BASE.viewportOffsetTopPx);
    });

    it('clamps the preview to the pane bottom edge using the measured preview height', () => {
        const placement = resolveTranscriptNavigationRailPreviewPlacement({
            ...BASE,
            paneHeightPx: 240,
            viewportOffsetTopPx: 24,
            markerTopPx: 1400,
            previewHeightPx: 120,
        });
        expect(placement.topPx).toBe(240 - 24 - 120 - 8);
    });

    it('falls back to a height estimate before the preview reports its layout', () => {
        const measured = resolveTranscriptNavigationRailPreviewPlacement({
            ...BASE,
            paneHeightPx: 240,
            viewportOffsetTopPx: 24,
            markerTopPx: 1400,
            previewHeightPx: null,
        });
        expect(measured.topPx).toBe(240 - 24 - 72 - 8);
    });

    it('constrains the preview width to the pane', () => {
        expect(resolveTranscriptNavigationRailPreviewPlacement(BASE).maxWidthPx).toBe(320);
        expect(resolveTranscriptNavigationRailPreviewPlacement({ ...BASE, paneWidthPx: 200 }).maxWidthPx).toBe(160);
        expect(resolveTranscriptNavigationRailPreviewPlacement({ ...BASE, paneWidthPx: 100 }).maxWidthPx).toBe(120);
    });
});
