import { describe, expect, it, vi } from 'vitest';

import type { TranscriptExitSnapshotSelection } from './transcriptSameSessionHandoff';
import { selectTranscriptExitSnapshot } from './selectTranscriptExitSnapshot';

const jumpSelection: TranscriptExitSnapshotSelection = {
    source: 'jump-promotion',
    viewport: {
        anchor: null,
        capturedAtMs: 20,
        isPinned: true,
        offsetY: 0,
        shouldRestoreViewport: false,
    },
};

const physicalSelection: TranscriptExitSnapshotSelection = {
    source: 'physical-exit',
    viewport: {
        anchor: {
            kind: 'message',
            messageId: 'm2',
            itemId: 'm2',
            itemOffsetPx: 55,
            capturedAtMs: 20,
        },
        capturedAtMs: 20,
        isPinned: false,
        offsetY: 500,
        shouldRestoreViewport: true,
    },
};

describe('selectTranscriptExitSnapshot', () => {
    it('returns exactly the selected jump snapshot and never lets generic capture overwrite it', () => {
        const flushJumpPromotion = vi.fn(() => jumpSelection);
        const capturePhysicalExit = vi.fn(() => physicalSelection);

        expect(selectTranscriptExitSnapshot({
            capturePhysicalExit,
            flushJumpPromotion,
        })).toBe(jumpSelection);
        expect(flushJumpPromotion).toHaveBeenCalledTimes(1);
        expect(capturePhysicalExit).not.toHaveBeenCalled();
    });

    it('uses the one physical capture only when no jump promotion owns exit', () => {
        const flushJumpPromotion = vi.fn(() => null);
        const capturePhysicalExit = vi.fn(() => physicalSelection);

        expect(selectTranscriptExitSnapshot({
            capturePhysicalExit,
            flushJumpPromotion,
        })).toBe(physicalSelection);
        expect(flushJumpPromotion).toHaveBeenCalledTimes(1);
        expect(capturePhysicalExit).toHaveBeenCalledTimes(1);
    });
});
