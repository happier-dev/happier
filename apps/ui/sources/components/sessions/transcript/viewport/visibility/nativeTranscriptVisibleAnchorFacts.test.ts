import { describe, expect, it } from 'vitest';

import {
    deriveNativeTranscriptVisibleAnchorFacts,
    translateNativeViewableItemsToVisibleSourceRange,
} from './nativeTranscriptVisibleAnchorFacts';

const anchors = [
    { id: 'turn-1', kind: 'user-turn', sourceIndex: 0 },
    { id: 'turn-2', kind: 'user-turn', sourceIndex: 1 },
    { id: 'turn-3', kind: 'user-turn', sourceIndex: 2 },
    { id: 'turn-4', kind: 'user-turn', sourceIndex: 3 },
] as const;

describe('native transcript visible anchor facts', () => {
    it('translates standard rendered viewability into canonical source range facts', () => {
        expect(translateNativeViewableItemsToVisibleSourceRange({
            itemCount: 4,
            orientation: 'standard',
            viewableItems: [
                { index: 1, isViewable: true },
                { index: 2, isViewable: true },
            ],
        })).toEqual({
            firstSourceIndex: 1,
            lastSourceIndex: 2,
        });
    });

    it('translates native inverted rendered indices through the list orientation owner', () => {
        expect(translateNativeViewableItemsToVisibleSourceRange({
            itemCount: 4,
            orientation: 'inverted',
            viewableItems: [
                { index: 0, isViewable: true },
                { index: 1, isViewable: true },
            ],
        })).toEqual({
            firstSourceIndex: 2,
            lastSourceIndex: 3,
        });
    });

    it('derives current and visible anchors without telemetry-gated inputs', () => {
        expect(deriveNativeTranscriptVisibleAnchorFacts({
            anchors,
            itemCount: 4,
            orientation: 'inverted',
            viewableItems: [
                { index: 0, isViewable: true },
                { index: 1, isViewable: true },
            ],
        })).toEqual({
            currentAnchorId: 'turn-3',
            visibleAnchorIds: ['turn-3', 'turn-4'],
        });
    });

    it('returns an empty snapshot for invalid native viewability ranges', () => {
        expect(deriveNativeTranscriptVisibleAnchorFacts({
            anchors,
            itemCount: 4,
            orientation: 'standard',
            viewableItems: [
                { index: null, isViewable: true },
                { index: 8, isViewable: true },
                { index: 1, isViewable: false },
            ],
        })).toEqual({
            currentAnchorId: null,
            visibleAnchorIds: [],
        });
    });
});
