import { describe, expect, it } from 'vitest';

import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptAtVisualBottom,
    resolveWebTranscriptMaxScrollTop,
} from './webTranscriptScrollMetrics';

function metrics(params: Readonly<{
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
}>) {
    return {
        element: {} as HTMLElement,
        clientHeight: params.clientHeight,
        scrollHeight: params.scrollHeight,
        scrollTop: params.scrollTop,
    };
}

describe('webTranscriptScrollMetrics', () => {
    it('preserves fractional distance from the visual bottom', () => {
        expect(getWebTranscriptDistanceFromBottom(metrics({
            clientHeight: 500.25,
            scrollHeight: 1000.75,
            scrollTop: 400.25,
        }))).toBeCloseTo(100.25);
    });

    it('resolves and clamps max scroll top', () => {
        expect(resolveWebTranscriptMaxScrollTop(metrics({
            clientHeight: 500,
            scrollHeight: 1000,
            scrollTop: 0,
        }))).toBe(500);
        expect(resolveWebTranscriptMaxScrollTop(metrics({
            clientHeight: 800,
            scrollHeight: 500,
            scrollTop: 0,
        }))).toBe(0);
    });

    it('uses tolerance when deciding whether the viewport is visually at bottom', () => {
        expect(isWebTranscriptAtVisualBottom(metrics({
            clientHeight: 500,
            scrollHeight: 1000,
            scrollTop: 499.6,
        }), 1)).toBe(true);
        expect(isWebTranscriptAtVisualBottom(metrics({
            clientHeight: 500,
            scrollHeight: 1000,
            scrollTop: 498,
        }), 1)).toBe(false);
    });
});
