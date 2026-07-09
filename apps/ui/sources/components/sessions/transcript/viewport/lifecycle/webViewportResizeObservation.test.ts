import { describe, expect, it } from 'vitest';

import {
    resolveWebViewportResizeObservation,
} from './webViewportResizeObservation';
import type { WebTranscriptScrollMetrics } from '../../webTranscriptScrollMetrics';

function metrics(overrides: Partial<WebTranscriptScrollMetrics> = {}): WebTranscriptScrollMetrics {
    return {
        clientHeight: 300,
        element: {} as HTMLElement,
        scrollHeight: 900,
        scrollTop: 600,
        ...overrides,
    };
}

describe('web viewport resize observation', () => {
    it('ignores the first resize sample because there is no prior viewport basis', () => {
        expect(resolveWebViewportResizeObservation({
            nextMetrics: metrics(),
            previousMetrics: null,
        })).toBeNull();
    });

    it('returns a viewport-resized observation when the same viewport changes size', () => {
        const element = {} as HTMLElement;
        const previousMetrics = metrics({ clientHeight: 420, element, scrollTop: 480 });
        const nextMetrics = metrics({ clientHeight: 300, element, scrollTop: 480 });

        expect(resolveWebViewportResizeObservation({
            nextMetrics,
            previousMetrics,
        })).toEqual({
            nextWebMetrics: nextMetrics,
            previousWebMetrics: previousMetrics,
            reason: 'viewport-resized',
        });
    });

    it('ignores unchanged same-element metrics', () => {
        const element = {} as HTMLElement;
        const previousMetrics = metrics({ element });
        const nextMetrics = metrics({ element });

        expect(resolveWebViewportResizeObservation({
            nextMetrics,
            previousMetrics,
        })).toBeNull();
    });
});
