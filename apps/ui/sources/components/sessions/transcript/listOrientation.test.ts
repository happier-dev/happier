import { describe, expect, it } from 'vitest';

import {
    mapTranscriptListIndexBetweenOrders,
    orientTranscriptListItems,
    resolveOlderNeighborRenderedIndex,
    resolveOrientedListEdgeSlots,
    resolveTranscriptListPresentation,
    type TranscriptListOrientation,
} from './listOrientation';

describe('resolveTranscriptListPresentation', () => {
    it('uses standard presentation for web without exposing renderer implementation as a runtime axis', () => {
        const presentation = resolveTranscriptListPresentation({
            platformIsWeb: true,
        });

        expect(presentation).toEqual({
            orientation: 'standard',
        });
        expect(presentation).not.toHaveProperty('implementation');
    });

    it('uses standard presentation for web', () => {
        expect(resolveTranscriptListPresentation({
            platformIsWeb: true,
        })).toEqual({
            orientation: 'standard',
        });
    });

    it('uses inverted presentation for native', () => {
        expect(resolveTranscriptListPresentation({
            platformIsWeb: false,
        })).toEqual({
            orientation: 'inverted',
        });
    });
});

describe('orientTranscriptListItems', () => {
    it('returns the same item array for standard orientation', () => {
        const items = ['oldest', 'middle', 'newest'] as const;

        const oriented = orientTranscriptListItems(items, 'standard');

        expect(oriented).toBe(items);
        expect(oriented).toEqual(['oldest', 'middle', 'newest']);
    });

    it('returns a reversed copy for multi-item inverted orientation without mutating the source', () => {
        const items = ['oldest', 'middle', 'newest'];

        const oriented = orientTranscriptListItems(items, 'inverted');

        expect(oriented).not.toBe(items);
        expect(oriented).toEqual(['newest', 'middle', 'oldest']);
        expect(items).toEqual(['oldest', 'middle', 'newest']);
    });

    it('keeps empty and single-item inverted arrays by identity', () => {
        const empty: readonly string[] = [];
        const single = ['only'] as const;

        expect(orientTranscriptListItems(empty, 'inverted')).toBe(empty);
        expect(orientTranscriptListItems(single, 'inverted')).toBe(single);
    });
});

describe('mapTranscriptListIndexBetweenOrders', () => {
    it('keeps indexes by identity for standard orientation', () => {
        expect(mapTranscriptListIndexBetweenOrders(0, 4, 'standard')).toBe(0);
        expect(mapTranscriptListIndexBetweenOrders(2, 4, 'standard')).toBe(2);
        expect(mapTranscriptListIndexBetweenOrders(3, 4, 'standard')).toBe(3);
    });

    it('mirrors indexes for inverted orientation', () => {
        expect(mapTranscriptListIndexBetweenOrders(0, 4, 'inverted')).toBe(3);
        expect(mapTranscriptListIndexBetweenOrders(1, 4, 'inverted')).toBe(2);
        expect(mapTranscriptListIndexBetweenOrders(3, 4, 'inverted')).toBe(0);
    });

    it('round-trips source and rendered indexes because the mapping is involutive', () => {
        const orientations: readonly TranscriptListOrientation[] = ['standard', 'inverted'];

        for (const orientation of orientations) {
            for (let index = 0; index < 7; index += 1) {
                const mapped = mapTranscriptListIndexBetweenOrders(index, 7, orientation);

                expect(mapped).not.toBeNull();
                expect(mapTranscriptListIndexBetweenOrders(mapped as number, 7, orientation)).toBe(index);
            }
        }
    });

    it('returns null for non-integer or out-of-range indexes', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(mapTranscriptListIndexBetweenOrders(-1, 4, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(4, 4, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(1.5, 4, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(Number.NaN, 4, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(0, 0, orientation)).toBeNull();
        }
    });
});

describe('resolveOlderNeighborRenderedIndex', () => {
    it('resolves the older rendered neighbor by orientation', () => {
        expect(resolveOlderNeighborRenderedIndex(3, 5, 'standard')).toBe(2);
        expect(resolveOlderNeighborRenderedIndex(0, 5, 'standard')).toBeNull();

        expect(resolveOlderNeighborRenderedIndex(0, 5, 'inverted')).toBe(1);
        expect(resolveOlderNeighborRenderedIndex(4, 5, 'inverted')).toBeNull();
    });

    it('returns null for invalid rendered indexes', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(resolveOlderNeighborRenderedIndex(-1, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(5, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(2.5, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(Number.POSITIVE_INFINITY, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(0, 0, orientation)).toBeNull();
        }
    });
});

describe('resolveOrientedListEdgeSlots', () => {
    it('maps visual edge nodes to header and footer slots by orientation', () => {
        const visualTopNode = { edge: 'top' };
        const visualBottomNode = { edge: 'bottom' };

        expect(resolveOrientedListEdgeSlots({
            orientation: 'standard',
            visualBottomNode,
            visualTopNode,
        })).toEqual({
            listFooterNode: visualBottomNode,
            listHeaderNode: visualTopNode,
        });

        expect(resolveOrientedListEdgeSlots({
            orientation: 'inverted',
            visualBottomNode,
            visualTopNode,
        })).toEqual({
            listFooterNode: visualTopNode,
            listHeaderNode: visualBottomNode,
        });
    });
});
