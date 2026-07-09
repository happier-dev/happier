import { describe, expect, it } from 'vitest';

import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';

import { applySidechainWebPrependGrowthRestore } from './sidechainWebPrependGrowthRestore';

class FakeElement {
    public clientHeight: number;
    public scrollHeight: number;
    private scrollTopValue: number;

    public constructor(params: Readonly<{
        clientHeight: number;
        scrollHeight: number;
        scrollTop: number;
    }>) {
        this.clientHeight = params.clientHeight;
        this.scrollHeight = params.scrollHeight;
        this.scrollTopValue = params.scrollTop;
    }

    public get scrollTop(): number {
        return this.scrollTopValue;
    }

    public set scrollTop(value: number) {
        const max = Math.max(0, this.scrollHeight - this.clientHeight);
        this.scrollTopValue = Math.max(0, Math.min(value, max));
    }
}

function createMetrics(params: Readonly<{
    clientHeight?: number;
    scrollHeight?: number;
    scrollTop?: number;
}> = {}) {
    const element = new FakeElement({
        clientHeight: params.clientHeight ?? 500,
        scrollHeight: params.scrollHeight ?? 1000,
        scrollTop: params.scrollTop ?? 100,
    });
    return {
        element,
        metrics: {
            clientHeight: element.clientHeight,
            element: element as unknown as HTMLElement,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
        },
    };
}

describe('applySidechainWebPrependGrowthRestore', () => {
    it('preserves sidechain web older-prepend growth through the shell owner', () => {
        const { element, metrics } = createMetrics();
        const observation = createWebDomScrollObservation();
        element.scrollHeight = 1300;

        const result = applySidechainWebPrependGrowthRestore({
            capturedMetrics: metrics,
            webDomObservation: observation,
        });

        expect(result).toEqual({
            ok: true,
            distanceFromBottom: 400,
            growthPx: 300,
            landedScrollTop: 400,
            previousScrollTop: 100,
            targetScrollTop: 400,
        });
        expect(element.scrollTop).toBe(400);
        expect(observation.getState()).toMatchObject({
            observedScrollHeight: 1300,
            observedScrollTop: 400,
        });
    });

    it('does not write when sidechain web older-prepend height did not grow', () => {
        const { element, metrics } = createMetrics();
        const observation = createWebDomScrollObservation();

        const result = applySidechainWebPrependGrowthRestore({
            capturedMetrics: metrics,
            webDomObservation: observation,
        });

        expect(result).toEqual({
            ok: false,
            previousScrollTop: 100,
            reason: 'no_growth',
        });
        expect(element.scrollTop).toBe(100);
        expect(observation.getState()).toMatchObject({
            observedScrollHeight: null,
            observedScrollTop: null,
        });
    });
});
