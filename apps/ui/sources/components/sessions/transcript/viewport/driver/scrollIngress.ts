import {
    getWebTranscriptDistanceFromBottom,
    resolveWebTranscriptMaxScrollTop,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { toNativeInvertedCanonicalOffset } from './nativeInvertedRawScroll';

export type TranscriptScrollIngressPlatform = 'native' | 'web';
export type TranscriptScrollIngressNativeCommandSpace = 'inverted' | 'standard';
const NATIVE_VIEWPORT_OUTSIDE_CONTENT_TOLERANCE_PX = 64;

export type TranscriptScrollIngressNativeEvent = Readonly<{
    contentOffset?: Readonly<{ y?: unknown }> | null;
    contentSize?: Readonly<{ height?: unknown }> | null;
    isTrusted?: unknown;
    layoutMeasurement?: Readonly<{ height?: unknown }> | null;
}>;

export type TranscriptScrollIngressObservation = Readonly<{
    contentHeightPx: number;
    distanceFromLiveTailForReleasePx: number;
    distanceFromLiveTailPx: number;
    hasLiveWebMetrics: boolean;
    isTrusted: boolean;
    layoutHeightPx: number;
    platform: TranscriptScrollIngressPlatform;
    rawOffsetY: number;
    scrollOffsetPx: number;
    viewportOutsideContent: boolean;
    visualBottomScrollOffsetPx: number | null;
    webMetrics: WebTranscriptScrollMetrics | null;
}>;

export function normalizeTranscriptScrollIngress(input: Readonly<{
    eventNativeEvent: TranscriptScrollIngressNativeEvent | null | undefined;
    measuredContentHeight: number;
    measuredLayoutHeight: number;
    nativeCommandSpace?: TranscriptScrollIngressNativeCommandSpace;
    platform: TranscriptScrollIngressPlatform;
    webMetrics?: WebTranscriptScrollMetrics | null;
}>): TranscriptScrollIngressObservation | null {
    const isTrusted = input.eventNativeEvent?.isTrusted === true;
    if (input.platform === 'web') {
        return normalizeWebScrollIngress({
            eventNativeEvent: input.eventNativeEvent,
            isTrusted,
            measuredContentHeight: input.measuredContentHeight,
            measuredLayoutHeight: input.measuredLayoutHeight,
            webMetrics: input.webMetrics ?? null,
        });
    }
    return normalizeNativeScrollIngress({
        eventNativeEvent: input.eventNativeEvent,
        isTrusted,
        measuredContentHeight: input.measuredContentHeight,
        measuredLayoutHeight: input.measuredLayoutHeight,
        nativeCommandSpace: input.nativeCommandSpace ?? 'inverted',
    });
}

function normalizeWebScrollIngress(input: Readonly<{
    eventNativeEvent: TranscriptScrollIngressNativeEvent | null | undefined;
    isTrusted: boolean;
    measuredContentHeight: number;
    measuredLayoutHeight: number;
    webMetrics: WebTranscriptScrollMetrics | null;
}>): TranscriptScrollIngressObservation | null {
    const metrics = input.webMetrics;
    const rawOffsetY = metrics?.scrollTop ?? resolveFiniteMetric(input.eventNativeEvent?.contentOffset?.y);
    if (rawOffsetY === null) return null;

    const layoutHeight = metrics?.clientHeight
        ?? resolveFiniteMetric(input.eventNativeEvent?.layoutMeasurement?.height)
        ?? input.measuredLayoutHeight;
    const contentHeight = metrics?.scrollHeight
        ?? resolveFiniteMetric(input.eventNativeEvent?.contentSize?.height)
        ?? input.measuredContentHeight;
    if (!Number.isFinite(layoutHeight) || !Number.isFinite(contentHeight)) return null;
    const measuredLayoutHeight = metrics
        ? (
            resolveFiniteMetric(input.measuredLayoutHeight)
            ?? resolveFiniteMetric(input.eventNativeEvent?.layoutMeasurement?.height)
            ?? layoutHeight
        )
        : layoutHeight;
    const measuredContentHeight = metrics
        ? (
            resolveFiniteMetric(input.measuredContentHeight)
            ?? resolveFiniteMetric(input.eventNativeEvent?.contentSize?.height)
            ?? contentHeight
        )
        : contentHeight;

    const distanceFromLiveTailPx = metrics
        ? getWebTranscriptDistanceFromBottom(metrics)
        : deriveStandardDistanceFromLiveTail({
            contentHeight,
            layoutHeight,
            scrollOffset: rawOffsetY,
        });
    const visualBottomScrollOffsetPx = metrics
        ? resolveWebTranscriptMaxScrollTop(metrics)
        : deriveVisualBottomScrollOffset({ contentHeight, layoutHeight });

    return {
        contentHeightPx: Math.max(0, measuredContentHeight),
        distanceFromLiveTailForReleasePx: distanceFromLiveTailPx,
        distanceFromLiveTailPx,
        hasLiveWebMetrics: metrics !== null,
        isTrusted: input.isTrusted,
        layoutHeightPx: Math.max(0, measuredLayoutHeight),
        platform: 'web',
        rawOffsetY,
        scrollOffsetPx: rawOffsetY,
        viewportOutsideContent: false,
        visualBottomScrollOffsetPx,
        webMetrics: metrics,
    };
}

function normalizeNativeScrollIngress(input: Readonly<{
    eventNativeEvent: TranscriptScrollIngressNativeEvent | null | undefined;
    isTrusted: boolean;
    measuredContentHeight: number;
    measuredLayoutHeight: number;
    nativeCommandSpace: TranscriptScrollIngressNativeCommandSpace;
}>): TranscriptScrollIngressObservation | null {
    const rawOffsetY = resolveFiniteMetric(input.eventNativeEvent?.contentOffset?.y);
    if (rawOffsetY === null) return null;

    const layoutHeight = resolveFiniteMetric(input.eventNativeEvent?.layoutMeasurement?.height)
        ?? input.measuredLayoutHeight;
    const contentHeight = resolveFiniteMetric(input.eventNativeEvent?.contentSize?.height)
        ?? input.measuredContentHeight;
    if (!Number.isFinite(contentHeight) || !Number.isFinite(layoutHeight) || layoutHeight <= 0) {
        return null;
    }

    const canonicalOffsetY = input.nativeCommandSpace === 'standard'
        ? Math.max(0, Math.trunc(rawOffsetY))
        : toNativeInvertedCanonicalOffset({
            contentHeight,
            layoutHeight,
            rawOffsetY,
        });
    const distanceFromLiveTailPx = input.nativeCommandSpace === 'standard'
        ? deriveStandardDistanceFromLiveTail({
            contentHeight,
            layoutHeight,
            scrollOffset: rawOffsetY,
        })
        : Math.max(
            0,
            Math.trunc(contentHeight - layoutHeight - canonicalOffsetY),
        );
    const visualBottomScrollOffsetPx = deriveVisualBottomScrollOffset({ contentHeight, layoutHeight });
    const viewportOutsideContent = visualBottomScrollOffsetPx !== null && (
        rawOffsetY < -NATIVE_VIEWPORT_OUTSIDE_CONTENT_TOLERANCE_PX ||
        rawOffsetY > visualBottomScrollOffsetPx + NATIVE_VIEWPORT_OUTSIDE_CONTENT_TOLERANCE_PX
    );

    return {
        contentHeightPx: Math.max(0, contentHeight),
        distanceFromLiveTailForReleasePx: distanceFromLiveTailPx,
        distanceFromLiveTailPx,
        hasLiveWebMetrics: false,
        isTrusted: input.isTrusted,
        layoutHeightPx: Math.max(0, layoutHeight),
        platform: 'native',
        rawOffsetY,
        scrollOffsetPx: canonicalOffsetY,
        viewportOutsideContent,
        visualBottomScrollOffsetPx,
        webMetrics: null,
    };
}

function deriveStandardDistanceFromLiveTail(input: Readonly<{
    contentHeight: number;
    layoutHeight: number;
    scrollOffset: number;
}>): number {
    if (input.layoutHeight <= 0 || input.contentHeight < input.layoutHeight) return 0;
    return Math.max(0, Math.trunc(input.contentHeight - input.layoutHeight - input.scrollOffset));
}

function deriveVisualBottomScrollOffset(input: Readonly<{
    contentHeight: number;
    layoutHeight: number;
}>): number | null {
    if (input.layoutHeight <= 0 || input.contentHeight < input.layoutHeight) return null;
    return Math.max(0, Math.trunc(input.contentHeight - input.layoutHeight));
}

function resolveFiniteMetric(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
