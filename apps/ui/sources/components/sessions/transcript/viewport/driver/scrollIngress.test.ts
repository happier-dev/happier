import { describe, expect, it } from 'vitest';

import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { normalizeTranscriptScrollIngress } from './scrollIngress';

function webMetrics(params: Readonly<{
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
}>): WebTranscriptScrollMetrics {
    return {
        clientHeight: params.clientHeight,
        element: {} as HTMLElement,
        scrollHeight: params.scrollHeight,
        scrollTop: params.scrollTop,
    };
}

describe('normalizeTranscriptScrollIngress', () => {
    it('uses live DOM metrics as the single web distance source when ref geometry is stale', () => {
        const observation = normalizeTranscriptScrollIngress({
            eventNativeEvent: {
                contentOffset: { y: 0 },
                contentSize: { height: 0 },
                layoutMeasurement: { height: 0 },
                isTrusted: true,
            },
            measuredContentHeight: 0,
            measuredLayoutHeight: 0,
            platform: 'web',
            webMetrics: webMetrics({ clientHeight: 500, scrollHeight: 2000, scrollTop: 700 }),
        });

        expect(observation).toMatchObject({
            contentHeightPx: 0,
            distanceFromLiveTailPx: 800,
            hasLiveWebMetrics: true,
            isTrusted: true,
            layoutHeightPx: 0,
            platform: 'web',
            rawOffsetY: 700,
            scrollOffsetPx: 700,
            visualBottomScrollOffsetPx: 1500,
        });
    });

    it('keeps web measured ref geometry distinct from live DOM geometry for diagnostics', () => {
        const observation = normalizeTranscriptScrollIngress({
            eventNativeEvent: {
                contentOffset: { y: 700 },
                contentSize: { height: 1800 },
                layoutMeasurement: { height: 450 },
            },
            measuredContentHeight: 1200,
            measuredLayoutHeight: 400,
            platform: 'web',
            webMetrics: webMetrics({ clientHeight: 500, scrollHeight: 2000, scrollTop: 700 }),
        });

        expect(observation).toMatchObject({
            contentHeightPx: 1200,
            distanceFromLiveTailPx: 800,
            hasLiveWebMetrics: true,
            layoutHeightPx: 400,
            rawOffsetY: 700,
            scrollOffsetPx: 700,
            visualBottomScrollOffsetPx: 1500,
        });
        expect(observation?.webMetrics).toMatchObject({
            clientHeight: 500,
            scrollHeight: 2000,
            scrollTop: 700,
        });
    });

    it('normalizes native inverted raw offsets through the native driver fact source', () => {
        const observation = normalizeTranscriptScrollIngress({
            eventNativeEvent: {
                contentOffset: { y: 300 },
                contentSize: { height: 2000 },
                layoutMeasurement: { height: 500 },
                isTrusted: false,
            },
            measuredContentHeight: 0,
            measuredLayoutHeight: 0,
            platform: 'native',
        });

        expect(observation).toMatchObject({
            contentHeightPx: 2000,
            distanceFromLiveTailPx: 300,
            distanceFromLiveTailForReleasePx: 300,
            hasLiveWebMetrics: false,
            isTrusted: false,
            layoutHeightPx: 500,
            platform: 'native',
            rawOffsetY: 300,
            scrollOffsetPx: 1200,
            visualBottomScrollOffsetPx: 1500,
        });
    });

    it('normalizes native standard raw offsets without inverted mirroring', () => {
        const observation = normalizeTranscriptScrollIngress({
            eventNativeEvent: {
                contentOffset: { y: 1500 },
                contentSize: { height: 2000 },
                layoutMeasurement: { height: 500 },
                isTrusted: false,
            },
            measuredContentHeight: 0,
            measuredLayoutHeight: 0,
            nativeCommandSpace: 'standard',
            platform: 'native',
        });

        expect(observation).toMatchObject({
            contentHeightPx: 2000,
            distanceFromLiveTailPx: 0,
            distanceFromLiveTailForReleasePx: 0,
            hasLiveWebMetrics: false,
            isTrusted: false,
            layoutHeightPx: 500,
            platform: 'native',
            rawOffsetY: 1500,
            scrollOffsetPx: 1500,
            viewportOutsideContent: false,
            visualBottomScrollOffsetPx: 1500,
        });
    });

    it('marks native standard observations beyond the measured content range as outside content', () => {
        const observation = normalizeTranscriptScrollIngress({
            eventNativeEvent: {
                contentOffset: { y: 1600 },
                contentSize: { height: 2000 },
                layoutMeasurement: { height: 500 },
            },
            measuredContentHeight: 0,
            measuredLayoutHeight: 0,
            nativeCommandSpace: 'standard',
            platform: 'native',
        });

        expect(observation).toMatchObject({
            distanceFromLiveTailPx: 0,
            rawOffsetY: 1600,
            scrollOffsetPx: 1600,
            viewportOutsideContent: true,
            visualBottomScrollOffsetPx: 1500,
        });
    });

    it('returns null for missing native geometry and clamps negative native live-tail distance', () => {
        expect(normalizeTranscriptScrollIngress({
            eventNativeEvent: {
                contentOffset: { y: 12 },
                contentSize: { height: 2000 },
                layoutMeasurement: { height: 0 },
            },
            measuredContentHeight: 0,
            measuredLayoutHeight: 0,
            platform: 'native',
        })).toBeNull();

        expect(normalizeTranscriptScrollIngress({
            eventNativeEvent: {
                contentOffset: { y: -40 },
                contentSize: { height: 2000 },
                layoutMeasurement: { height: 500 },
            },
            measuredContentHeight: 0,
            measuredLayoutHeight: 0,
            platform: 'native',
        })?.distanceFromLiveTailPx).toBe(0);
    });

    it('falls back to the synthetic web event only when live DOM metrics are unavailable', () => {
        const observation = normalizeTranscriptScrollIngress({
            eventNativeEvent: {
                contentOffset: { y: 440 },
                contentSize: { height: 1600 },
                layoutMeasurement: { height: 600 },
            },
            measuredContentHeight: 0,
            measuredLayoutHeight: 0,
            platform: 'web',
            webMetrics: null,
        });

        expect(observation).toMatchObject({
            contentHeightPx: 1600,
            distanceFromLiveTailPx: 560,
            hasLiveWebMetrics: false,
            layoutHeightPx: 600,
            platform: 'web',
            rawOffsetY: 440,
            scrollOffsetPx: 440,
        });
    });
});
