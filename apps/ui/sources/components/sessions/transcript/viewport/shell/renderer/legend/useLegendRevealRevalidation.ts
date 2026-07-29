import * as React from 'react';
import type { LegendListRef } from '@legendapp/list/react-native';

import type { TranscriptViewportMutationCause } from '../types';
import { settleLegendScroll } from './heldIntent';

type MutableRef<T> = { current: T };

/**
 * S-E route-pop desync (live native capture 2026-07-11): a scroll write issued while the
 * transcript screen was covered by a pushed route can fail to become native truth, and no
 * scroll event arrives on reveal — Legend keeps computing its mounted window for the
 * believed offset while the native view displays another, leaving a persistent blank
 * region that only the user's first swipe (the first real native event) healed. On
 * reveal, compare the transformed page positions of Legend's content and its Fabric scroll
 * host. Unlike measureLayout, `measure` includes the ScrollView content transform, so
 * hostPageY - contentPageY is the natively displayed offset. When it disagrees with Legend
 * state, replay it through Legend's own scroll command: the native write is a no-op (the
 * view is already there) and Legend re-runs its window calculation for the offset the user
 * is actually looking at.
 */
export function useLegendRevealRevalidation(params: Readonly<{
    isWebFrame: boolean;
    legendListRef: MutableRef<LegendListRef | null>;
    pendingViewportCauseRef: MutableRef<TranscriptViewportMutationCause>;
    requestHeldIntentSettle: () => void;
}>): () => void {
    const { isWebFrame, legendListRef, pendingViewportCauseRef, requestHeldIntentSettle } = params;
    const measurementGenerationRef = React.useRef<object | null>(null);
    return React.useCallback(() => {
        if (isWebFrame) return;
        const legendRef = legendListRef.current;
        if (!legendRef) return;
        const scroller = legendRef.getNativeScrollRef?.() as unknown as Readonly<{
            getInnerViewRef?: () => unknown;
            getNativeScrollRef?: () => unknown;
        }> | null | undefined;
        const innerRef = scroller?.getInnerViewRef?.() as Readonly<{
            measure?: (
                onSuccess: (
                    x: number,
                    y: number,
                    width: number,
                    height: number,
                    pageX: number,
                    pageY: number,
                ) => void,
            ) => void;
        }> | null | undefined;
        const scrollHost = scroller?.getNativeScrollRef?.() as Readonly<{
            measure?: (
                onSuccess: (
                    x: number,
                    y: number,
                    width: number,
                    height: number,
                    pageX: number,
                    pageY: number,
                ) => void,
            ) => void;
        }> | null | undefined;
        if (
            typeof innerRef?.measure !== 'function'
            || typeof scrollHost?.measure !== 'function'
        ) {
            return;
        }
        const generation = {};
        measurementGenerationRef.current = generation;
        let contentPageY: number | null = null;
        let hostPageY: number | null = null;
        const finishMeasurement = (): void => {
            const currentScroller = legendListRef.current?.getNativeScrollRef?.() as unknown as Readonly<{
                getInnerViewRef?: () => unknown;
                getNativeScrollRef?: () => unknown;
            }> | null | undefined;
            if (
                measurementGenerationRef.current !== generation
                || legendListRef.current !== legendRef
                || currentScroller?.getInnerViewRef?.() !== innerRef
                || currentScroller?.getNativeScrollRef?.() !== scrollHost
                || contentPageY == null
                || hostPageY == null
            ) {
                return;
            }
            measurementGenerationRef.current = null;
            const displayedOffset = hostPageY - contentPageY;
            if (!Number.isFinite(displayedOffset)) return;
            const state = legendListRef.current?.getState();
            const believedOffset = state?.scroll;
            if (typeof believedOffset !== 'number' || !Number.isFinite(believedOffset)) return;
            if (Math.abs(displayedOffset - believedOffset) < 1) return;
            pendingViewportCauseRef.current = 'layout';
            settleLegendScroll(legendListRef.current?.scrollToOffset({
                animated: false,
                offset: Math.max(0, displayedOffset),
            }));
            // A live held intent re-verifies against the re-observed geometry instead of
            // treating the replayed offset as an external rollback.
            requestHeldIntentSettle();
        };
        innerRef.measure((_x, _y, _width, _height, _pageX, pageY) => {
            contentPageY = pageY;
            finishMeasurement();
        });
        scrollHost.measure((_x, _y, _width, _height, _pageX, pageY) => {
            hostPageY = pageY;
            finishMeasurement();
        });
    }, [isWebFrame, legendListRef, measurementGenerationRef, pendingViewportCauseRef, requestHeldIntentSettle]);
}
