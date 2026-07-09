import { describe, expect, it } from 'vitest';

import {
    applySidechainOlderLoadObservation,
    buildSidechainOlderLoadScrollObservedTelemetryEvent,
    resolveSidechainOlderLoadEdgeReachedObservation,
    resolveSidechainOlderLoadObservation,
    resolveSidechainOlderLoadScrollEventObservation,
} from './sidechainOlderLoadObservation';

const webMetrics = {
    clientHeight: 400,
    scrollHeight: 1200,
    scrollTop: 80,
} as const;

describe('resolveSidechainOlderLoadObservation', () => {
    it('resolves web scroll-event ingress from the event target', () => {
        const target = {
            clientHeight: 400,
            scrollHeight: 1200,
            scrollTop: 80,
        };

        expect(resolveSidechainOlderLoadScrollEventObservation({
            event: { nativeEvent: { target } },
            viewportGuardThresholdPx: 80,
        })).toMatchObject({
            ok: true,
            observation: {
                offsetY: 80,
                webObservation: {
                    distanceFromBottom: 720,
                    offsetY: 80,
                    scrollable: true,
                    trigger: 'scroll',
                },
            },
            webElement: target,
        });
    });

    it('falls scroll-event ingress back to native content offset facts', () => {
        expect(resolveSidechainOlderLoadScrollEventObservation({
            event: { nativeEvent: { contentOffset: { y: 320 } } },
            viewportGuardThresholdPx: 80,
        })).toEqual({
            ok: true,
            observation: {
                offsetY: 320,
                trigger: 'scroll',
            },
            webElement: null,
        });
    });

    it('falls scroll-event ingress back to target scrollTop when content offset is missing', () => {
        expect(resolveSidechainOlderLoadScrollEventObservation({
            event: { nativeEvent: { target: { scrollTop: 42 } } },
            viewportGuardThresholdPx: 80,
        })).toEqual({
            ok: true,
            observation: {
                offsetY: 42,
                trigger: 'scroll',
            },
            webElement: null,
        });
    });

    it('falls scroll-event ingress back to top-level target scrollTop when the native target has no offset', () => {
        expect(resolveSidechainOlderLoadScrollEventObservation({
            event: {
                nativeEvent: { target: { nodeType: 1 } },
                target: { scrollTop: 64 },
            },
            viewportGuardThresholdPx: 80,
        })).toEqual({
            ok: true,
            observation: {
                offsetY: 64,
                trigger: 'scroll',
            },
            webElement: null,
        });
    });

    it('ignores scroll-event ingress without finite offset facts', () => {
        expect(resolveSidechainOlderLoadScrollEventObservation({
            event: { nativeEvent: { contentOffset: { y: Number.NaN } } },
            viewportGuardThresholdPx: 80,
        })).toEqual({ ok: false, reason: 'missing_offset' });
    });

    it('resolves edge-reached ingress from the cached web element first', () => {
        const webElement = {
            clientHeight: 400,
            scrollHeight: 1200,
            scrollTop: 0,
        };

        expect(resolveSidechainOlderLoadEdgeReachedObservation({
            nativeObservedOffset: {
                canonicalOffsetY: 999,
                distanceFromLiveTailPx: 201,
                isAtRawLiveTail: false,
                rawOffsetY: 201,
            },
            viewportGuardThresholdPx: 80,
            webElement,
        })).toMatchObject({
            ok: true,
            observation: {
                offsetY: 0,
                webObservation: {
                    trigger: 'edge-reached',
                },
            },
            webElement,
        });
    });

    it('falls edge-reached ingress back to semantic native observed-offset facts', () => {
        expect(resolveSidechainOlderLoadEdgeReachedObservation({
            nativeObservedOffset: {
                canonicalOffsetY: 128,
                distanceFromLiveTailPx: 1072,
                isAtRawLiveTail: false,
                rawOffsetY: 1072,
            },
            viewportGuardThresholdPx: 80,
            webElement: null,
        })).toEqual({
            ok: true,
            observation: {
                nativeObservedOffset: {
                    canonicalOffsetY: 128,
                    distanceFromLiveTailPx: 1072,
                    isAtRawLiveTail: false,
                    rawOffsetY: 1072,
                },
                offsetY: 128,
                trigger: 'edge-reached',
            },
            webElement: null,
        });
    });

    it('ignores edge-reached ingress when native edge reads fail', () => {
        expect(resolveSidechainOlderLoadEdgeReachedObservation({
            viewportGuardThresholdPx: 80,
            webElement: null,
        })).toEqual({ ok: false, reason: 'missing_offset' });
    });

    it('ignores invalid offsets before reaching the pagination machine', () => {
        expect(resolveSidechainOlderLoadObservation({
            contentHeightPx: 1200,
            dataOrder: 'oldest-first',
            itemCount: 20,
            layoutHeightPx: 400,
            observation: { offsetY: Number.NaN, trigger: 'scroll' },
            platformOS: 'ios',
            viewportGuardThresholdPx: 80,
        })).toEqual({ ok: false, reason: 'invalid_offset' });
    });

    it('normalizes unmeasured and unscrollable content as non-scrollable pagination facts', () => {
        expect(resolveSidechainOlderLoadObservation({
            contentHeightPx: 300,
            dataOrder: 'oldest-first',
            itemCount: 3,
            layoutHeightPx: 400,
            observation: { offsetY: 0, trigger: 'edge-reached' },
            platformOS: 'ios',
            viewportGuardThresholdPx: 80,
        })).toEqual({
            ok: true,
            pagination: {
                offsetY: 0,
                scrollable: false,
                trigger: 'edge-reached',
            },
            telemetry: {
                contentHeightPx: 300,
                distanceFromBottomPx: 0,
                itemCount: 3,
                layoutHeightPx: 400,
                offsetY: 0,
                scrollable: false,
                trigger: 'edge-reached',
                webMetrics: null,
            },
        });
    });

    it('computes native distance and scrollability from measured content and layout facts', () => {
        expect(resolveSidechainOlderLoadObservation({
            contentHeightPx: 1600,
            dataOrder: 'oldest-first',
            itemCount: 20,
            layoutHeightPx: 400,
            observation: { offsetY: 200, trigger: 'scroll' },
            platformOS: 'ios',
            viewportGuardThresholdPx: 80,
        })).toMatchObject({
            ok: true,
            pagination: {
                offsetY: 200,
                scrollable: true,
                trigger: 'scroll',
            },
            telemetry: {
                contentHeightPx: 1600,
                distanceFromBottomPx: 1000,
                itemCount: 20,
                layoutHeightPx: 400,
                offsetY: 200,
                scrollable: true,
                trigger: 'scroll',
                webMetrics: null,
            },
        });
    });

    it('maps native newest-first raw offsets into canonical older-edge pagination offsets', () => {
        expect(resolveSidechainOlderLoadObservation({
            contentHeightPx: 1600,
            dataOrder: 'newest-first',
            itemCount: 20,
            layoutHeightPx: 400,
            observation: {
                nativeObservedOffset: {
                    canonicalOffsetY: 50,
                    distanceFromLiveTailPx: 1150,
                    isAtRawLiveTail: false,
                    rawOffsetY: 1150,
                },
                trigger: 'edge-reached',
            },
            platformOS: 'ios',
            viewportGuardThresholdPx: 80,
        })).toMatchObject({
            ok: true,
            pagination: {
                offsetY: 50,
                scrollable: true,
                trigger: 'edge-reached',
            },
            telemetry: {
                distanceFromBottomPx: 1150,
                offsetY: 50,
                scrollable: true,
            },
        });
    });

    it('trusts native observed-offset facts instead of recomputing inverted offsets in the shell', () => {
        expect(resolveSidechainOlderLoadObservation({
            contentHeightPx: 1600,
            dataOrder: 'newest-first',
            itemCount: 20,
            layoutHeightPx: 400,
            observation: {
                nativeObservedOffset: {
                    canonicalOffsetY: 50,
                    distanceFromLiveTailPx: 1150,
                    isAtRawLiveTail: false,
                    rawOffsetY: 777,
                },
                trigger: 'edge-reached',
            },
            platformOS: 'ios',
            viewportGuardThresholdPx: 80,
        })).toMatchObject({
            ok: true,
            pagination: {
                offsetY: 50,
                scrollable: true,
                trigger: 'edge-reached',
            },
            telemetry: {
                contentHeightPx: 1600,
                distanceFromBottomPx: 1150,
                layoutHeightPx: 400,
                offsetY: 50,
                scrollable: true,
            },
        });
    });

    it('rejects native newest-first observations that do not carry semantic observed-offset facts', () => {
        expect(resolveSidechainOlderLoadObservation({
            contentHeightPx: 1600,
            dataOrder: 'newest-first',
            itemCount: 20,
            layoutHeightPx: 400,
            observation: { offsetY: 1150, trigger: 'edge-reached' },
            platformOS: 'ios',
            viewportGuardThresholdPx: 80,
        })).toEqual({ ok: false, reason: 'invalid_offset' });
    });

    it('does not treat the native inverted visual bottom as the older edge', () => {
        expect(resolveSidechainOlderLoadObservation({
            contentHeightPx: 1600,
            dataOrder: 'newest-first',
            itemCount: 20,
            layoutHeightPx: 400,
            observation: {
                nativeObservedOffset: {
                    canonicalOffsetY: 1200,
                    distanceFromLiveTailPx: 0,
                    isAtRawLiveTail: true,
                    rawOffsetY: 0,
                },
                trigger: 'edge-reached',
            },
            platformOS: 'ios',
            viewportGuardThresholdPx: 80,
        })).toMatchObject({
            ok: true,
            pagination: {
                offsetY: 1200,
                scrollable: false,
                trigger: 'edge-reached',
            },
            telemetry: {
                distanceFromBottomPx: 0,
                offsetY: 1200,
                scrollable: false,
            },
        });
    });

    it('uses the bottom guard to suppress native older loading near the live tail', () => {
        expect(resolveSidechainOlderLoadObservation({
            contentHeightPx: 1000,
            dataOrder: 'oldest-first',
            itemCount: 12,
            layoutHeightPx: 400,
            observation: { offsetY: 560, trigger: 'scroll' },
            platformOS: 'ios',
            viewportGuardThresholdPx: 80,
        })).toMatchObject({
            ok: true,
            pagination: {
                offsetY: 560,
                scrollable: false,
                trigger: 'scroll',
            },
            telemetry: {
                distanceFromBottomPx: 40,
                scrollable: false,
            },
        });
    });

    it('trusts web driver observations instead of recomputing offset, trigger, distance, and scrollability in the host', () => {
        expect(resolveSidechainOlderLoadObservation({
            contentHeightPx: 9999,
            dataOrder: 'oldest-first',
            itemCount: 15,
            layoutHeightPx: 9999,
            observation: {
                webObservation: {
                    contentHeight: 1200,
                    distanceFromBottom: 720,
                    layoutHeight: 400,
                    metrics: webMetrics,
                    offsetY: 80,
                    scrollable: true,
                    trigger: 'edge-reached',
                },
            },
            platformOS: 'web',
            viewportGuardThresholdPx: 80,
        })).toEqual({
            ok: true,
            pagination: {
                offsetY: 80,
                scrollable: true,
                trigger: 'edge-reached',
            },
            telemetry: {
                contentHeightPx: 1200,
                distanceFromBottomPx: 720,
                itemCount: 15,
                layoutHeightPx: 400,
                offsetY: 80,
                scrollable: true,
                trigger: 'edge-reached',
                webMetrics,
            },
        });
    });

    it('builds web scroll-observed telemetry from normalized sidechain older-load facts', () => {
        expect(buildSidechainOlderLoadScrollObservedTelemetryEvent({
            flashListContentHeightPx: 1400,
            flashListLayoutHeightPx: 500,
            paginationSnapshot: {
                hasMore: true,
                insideThreshold: true,
                phase: 'armed',
                suspendedReasons: ['negative-offset'],
            },
            platformOS: 'web',
            sessionId: 'session-1',
            telemetry: {
                contentHeightPx: 1200,
                distanceFromBottomPx: 720,
                itemCount: 15,
                layoutHeightPx: 400,
                offsetY: 80,
                scrollable: true,
                trigger: 'edge-reached',
                webMetrics,
            },
            timestampMs: 123,
        })).toEqual({
            coldCount: 15,
            contentHeight: 1200,
            distanceFromBottom: 720,
            domClientHeight: 400,
            domScrollHeight: 1200,
            domScrollTop: 80,
            flashListContentHeight: 1400,
            flashListLayoutHeight: 500,
            hotCount: 0,
            layoutHeight: 400,
            listImplementation: 'flash_v2',
            mode: 'user-unpinned',
            offsetY: 80,
            paginationPhase: 'armed',
            paginationSuspendedReasons: ['negative-offset'],
            pendingWebPrependAnchorKind: 'none',
            platform: 'web',
            programmaticWebWrite: false,
            reason: 'observed',
            scrollable: true,
            sessionId: 'session-1',
            timestampMs: 123,
            trigger: 'edge-reached',
            type: 'scroll-observed',
        });
    });

    it('applies native sidechain older-load observations without recording web telemetry', () => {
        const dispatches: unknown[] = [];
        const records: unknown[] = [];

        const applied = applySidechainOlderLoadObservation({
            contentHeightPx: 1600,
            dataOrder: 'oldest-first',
            flashListContentHeightPx: 1600,
            flashListLayoutHeightPx: 400,
            getPaginationSnapshot: () => {
                throw new Error('native should not snapshot for web telemetry');
            },
            itemCount: 20,
            layoutHeightPx: 400,
            observation: { offsetY: 200, trigger: 'scroll' },
            onScrollObservation: (metrics) => {
                dispatches.push(metrics);
            },
            platformOS: 'ios',
            recordTelemetry: (event) => {
                records.push(event);
            },
            sessionId: 'session-1',
            timestampMs: 123,
            viewportGuardThresholdPx: 80,
        });

        expect(applied).toBe(true);
        expect(dispatches).toEqual([{
            offsetY: 200,
            scrollable: true,
            trigger: 'scroll',
        }]);
        expect(records).toEqual([]);
    });

    it('applies web sidechain older-load observations and records telemetry after pagination dispatch', () => {
        const order: string[] = [];
        const records: unknown[] = [];

        const applied = applySidechainOlderLoadObservation({
            contentHeightPx: 9999,
            dataOrder: 'oldest-first',
            flashListContentHeightPx: 1400,
            flashListLayoutHeightPx: 500,
            getPaginationSnapshot: () => {
                order.push('snapshot');
                return {
                    hasMore: true,
                    insideThreshold: true,
                    phase: 'cooldown',
                    suspendedReasons: ['transaction-open'],
                };
            },
            itemCount: 15,
            layoutHeightPx: 9999,
            observation: {
                webObservation: {
                    contentHeight: 1200,
                    distanceFromBottom: 720,
                    layoutHeight: 400,
                    metrics: webMetrics,
                    offsetY: 80,
                    scrollable: true,
                    trigger: 'edge-reached',
                },
            },
            onScrollObservation: (metrics) => {
                order.push('dispatch');
                expect(metrics).toEqual({
                    offsetY: 80,
                    scrollable: true,
                    trigger: 'edge-reached',
                });
            },
            platformOS: 'web',
            recordTelemetry: (event) => {
                order.push('record');
                records.push(event);
            },
            sessionId: 'session-1',
            timestampMs: 123,
            viewportGuardThresholdPx: 80,
        });

        expect(applied).toBe(true);
        expect(order).toEqual(['dispatch', 'snapshot', 'record']);
        expect(records).toEqual([{
            coldCount: 15,
            contentHeight: 1200,
            distanceFromBottom: 720,
            domClientHeight: 400,
            domScrollHeight: 1200,
            domScrollTop: 80,
            flashListContentHeight: 1400,
            flashListLayoutHeight: 500,
            hotCount: 0,
            layoutHeight: 400,
            listImplementation: 'flash_v2',
            mode: 'user-unpinned',
            offsetY: 80,
            paginationPhase: 'cooldown',
            paginationSuspendedReasons: ['transaction-open'],
            pendingWebPrependAnchorKind: 'none',
            platform: 'web',
            programmaticWebWrite: false,
            reason: 'observed',
            scrollable: true,
            sessionId: 'session-1',
            timestampMs: 123,
            trigger: 'edge-reached',
            type: 'scroll-observed',
        }]);
    });

    it('does not dispatch or record telemetry for invalid sidechain older-load observations', () => {
        const dispatches: unknown[] = [];
        const records: unknown[] = [];

        const applied = applySidechainOlderLoadObservation({
            contentHeightPx: 1200,
            dataOrder: 'oldest-first',
            flashListContentHeightPx: 1200,
            flashListLayoutHeightPx: 400,
            getPaginationSnapshot: () => ({
                hasMore: true,
                insideThreshold: false,
                phase: 'armed',
                suspendedReasons: [],
            }),
            itemCount: 12,
            layoutHeightPx: 400,
            observation: { offsetY: Number.NaN, trigger: 'scroll' },
            onScrollObservation: (metrics) => {
                dispatches.push(metrics);
            },
            platformOS: 'web',
            recordTelemetry: (event) => {
                records.push(event);
            },
            sessionId: 'session-1',
            timestampMs: 123,
            viewportGuardThresholdPx: 80,
        });

        expect(applied).toBe(false);
        expect(dispatches).toEqual([]);
        expect(records).toEqual([]);
    });
});
