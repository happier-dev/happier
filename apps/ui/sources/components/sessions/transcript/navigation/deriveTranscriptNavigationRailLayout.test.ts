import { describe, expect, it } from 'vitest';

import { deriveTranscriptNavigationRailLayout } from './deriveTranscriptNavigationRailLayout';

describe('deriveTranscriptNavigationRailLayout', () => {
    it('hides on native, below the safe width threshold, or with fewer than two entries', () => {
        expect(deriveTranscriptNavigationRailLayout({
            entryCount: 4,
            paneHeightPx: 800,
            paneWidthPx: 1000,
            platformOS: 'ios',
            transcriptContentWidthPx: 800,
        }).visible).toBe(false);
        expect(deriveTranscriptNavigationRailLayout({
            entryCount: 4,
            paneHeightPx: 800,
            paneWidthPx: 860,
            platformOS: 'web',
            transcriptContentWidthPx: 800,
        }).visible).toBe(false);
        expect(deriveTranscriptNavigationRailLayout({
            entryCount: 1,
            paneHeightPx: 800,
            paneWidthPx: 1000,
            platformOS: 'web',
            transcriptContentWidthPx: 800,
        }).visible).toBe(false);
    });

    it('hides when the transcript gutter cannot safely fit the rail', () => {
        expect(deriveTranscriptNavigationRailLayout({
            entryCount: 4,
            paneHeightPx: 800,
            paneWidthPx: 1000,
            platformOS: 'web',
            transcriptContentWidthPx: 980,
        })).toMatchObject({
            visible: false,
            hiddenReason: 'insufficient-gutter',
        });
    });

    it('caps the rail viewport to 80 percent of the transcript pane and centers it', () => {
        expect(deriveTranscriptNavigationRailLayout({
            entryCount: 200,
            paneHeightPx: 1000,
            paneWidthPx: 1000,
            platformOS: 'web',
            transcriptContentWidthPx: 800,
        })).toMatchObject({
            visible: true,
            viewportMaxHeightPx: 800,
            viewportOffsetTopPx: 100,
            overflow: true,
        });
    });

    it('shows fades only for hidden scrollable marker content at the current scroll position', () => {
        const base = {
            entryCount: 200,
            paneHeightPx: 1000,
            paneWidthPx: 1000,
            platformOS: 'web' as const,
            transcriptContentWidthPx: 800,
        };

        expect(deriveTranscriptNavigationRailLayout({
            ...base,
            scrollTopPx: 0,
        })).toMatchObject({
            showTopFade: false,
            showBottomFade: true,
        });
        expect(deriveTranscriptNavigationRailLayout({
            ...base,
            scrollTopPx: 300,
        })).toMatchObject({
            showTopFade: true,
            showBottomFade: true,
        });
        const bottom = deriveTranscriptNavigationRailLayout(base);
        expect(deriveTranscriptNavigationRailLayout({
            ...base,
            scrollTopPx: bottom.contentHeightPx - bottom.viewportMaxHeightPx,
        })).toMatchObject({
            showTopFade: true,
            showBottomFade: false,
        });
    });

    it('keeps tick content geometry count-driven rather than viewport-measurement-driven', () => {
        const shortPane = deriveTranscriptNavigationRailLayout({
            entryCount: 40,
            paneHeightPx: 500,
            paneWidthPx: 1000,
            platformOS: 'web',
            transcriptContentWidthPx: 800,
        });
        const tallPane = deriveTranscriptNavigationRailLayout({
            entryCount: 40,
            paneHeightPx: 1200,
            paneWidthPx: 1000,
            platformOS: 'web',
            transcriptContentWidthPx: 800,
        });

        expect(shortPane.contentHeightPx).toBe(tallPane.contentHeightPx);
        expect(shortPane.markerSpacingPx).toBe(tallPane.markerSpacingPx);
    });
});
