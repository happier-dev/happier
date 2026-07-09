import { describe, expect, it } from 'vitest';

import {
    resolveWebDomOlderLoadObservation,
    resolveWebDomOlderLoadObservationTrigger,
} from './webDomOlderLoadObservation';

function scroller(params: Readonly<{
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
}>): HTMLElement {
    return {
        clientHeight: params.clientHeight,
        scrollHeight: params.scrollHeight,
        scrollTop: params.scrollTop,
    } as HTMLElement;
}

describe('resolveWebDomOlderLoadObservation', () => {
    it('resolves genuine top frames to edge-reached while preserving caller triggers outside the top band', () => {
        expect(resolveWebDomOlderLoadObservationTrigger({
            requestedTrigger: 'scroll',
            scrollTop: 0,
        })).toBe('edge-reached');
        expect(resolveWebDomOlderLoadObservationTrigger({
            requestedTrigger: 'scroll',
            scrollTop: 1,
        })).toBe('edge-reached');
        expect(resolveWebDomOlderLoadObservationTrigger({
            requestedTrigger: 'scroll',
            scrollTop: 2,
        })).toBe('scroll');
        expect(resolveWebDomOlderLoadObservationTrigger({
            requestedTrigger: 'edge-reached',
            scrollTop: 2,
        })).toBe('edge-reached');
        expect(resolveWebDomOlderLoadObservationTrigger({
            scrollTop: 2,
        })).toBe('scroll');
    });

    it('classifies exact and epsilon top frames as edge-reached without widening the band', () => {
        expect(resolveWebDomOlderLoadObservation({
            target: scroller({ clientHeight: 500, scrollHeight: 2000, scrollTop: 0 }),
            requestedTrigger: 'scroll',
            viewportGuardThresholdPx: 400,
        })).toMatchObject({
            contentHeight: 2000,
            distanceFromBottom: 1500,
            layoutHeight: 500,
            offsetY: 0,
            scrollable: true,
            trigger: 'edge-reached',
        });

        expect(resolveWebDomOlderLoadObservation({
            target: scroller({ clientHeight: 500, scrollHeight: 2000, scrollTop: 1 }),
            requestedTrigger: 'scroll',
            viewportGuardThresholdPx: 400,
        })?.trigger).toBe('edge-reached');

        expect(resolveWebDomOlderLoadObservation({
            target: scroller({ clientHeight: 500, scrollHeight: 2000, scrollTop: 2 }),
            requestedTrigger: 'scroll',
            viewportGuardThresholdPx: 400,
        })?.trigger).toBe('scroll');
    });

    it('keeps short content and bottom-guarded viewports non-scrollable for older loading', () => {
        expect(resolveWebDomOlderLoadObservation({
            target: scroller({ clientHeight: 500, scrollHeight: 500, scrollTop: 0 }),
            requestedTrigger: 'edge-reached',
            viewportGuardThresholdPx: 400,
        })).toMatchObject({
            contentHeight: 500,
            distanceFromBottom: 0,
            layoutHeight: 500,
            offsetY: 0,
            scrollable: false,
            trigger: 'edge-reached',
        });

        expect(resolveWebDomOlderLoadObservation({
            target: scroller({ clientHeight: 500, scrollHeight: 2000, scrollTop: 1200 }),
            requestedTrigger: 'edge-reached',
            viewportGuardThresholdPx: 400,
        })).toMatchObject({
            distanceFromBottom: 300,
            scrollable: false,
            trigger: 'edge-reached',
        });
    });

    it('returns null for non-web scroll targets', () => {
        expect(resolveWebDomOlderLoadObservation({
            target: { scrollTop: 0 },
            requestedTrigger: 'scroll',
            viewportGuardThresholdPx: 400,
        })).toBeNull();
    });
});
