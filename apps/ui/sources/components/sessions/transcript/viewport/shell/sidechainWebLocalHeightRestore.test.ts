import { describe, expect, it } from 'vitest';

import {
    createWebDomScrollObservation,
} from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import type { SidechainWebLocalHeightChangeAnchor } from './sidechainWebAnchorCapture';
import {
    applySidechainWebLocalHeightRestore,
    buildSidechainWebLocalHeightRestoreTelemetryEvent,
} from './sidechainWebLocalHeightRestore';

function buildAnchor(overrides: Partial<SidechainWebLocalHeightChangeAnchor> = {}): SidechainWebLocalHeightChangeAnchor {
    const element = {
        clientHeight: 300,
        scrollHeight: 1320,
        scrollTop: 360,
    } as HTMLElement;
    return {
        metrics: {
            clientHeight: 300,
            element,
            scrollHeight: 1200,
            scrollTop: 240,
        },
        mode: 'preserve-position',
        sessionId: 'session-1',
        ...overrides,
    };
}

describe('sidechain web local-height restore', () => {
    it('builds telemetry from live post-restore DOM metrics', () => {
        const anchor = buildAnchor();

        expect(buildSidechainWebLocalHeightRestoreTelemetryEvent({
            anchor,
            flashListContentHeightPx: 1400,
            flashListLayoutHeightPx: 500,
            itemCount: 7,
            paginationSnapshot: {
                hasMore: true,
                insideThreshold: false,
                phase: 'armed',
                suspendedReasons: ['negative-offset'],
            },
            platformOS: 'web',
            result: {
                distanceFromBottom: 660,
                landedScrollTop: 360,
                ok: true,
                previousScrollTop: 240,
                targetScrollTop: 360,
            },
            timestampMs: 123,
        })).toEqual({
            coldCount: 7,
            contentHeight: 1320,
            distanceFromBottom: 660,
            domClientHeight: 300,
            domScrollHeight: 1320,
            domScrollTop: 360,
            flashListContentHeight: 1400,
            flashListLayoutHeight: 500,
            hotCount: 0,
            layoutHeight: 300,
            listImplementation: 'flash_v2',
            mode: 'restore-anchor',
            paginationPhase: 'armed',
            paginationSuspendedReasons: ['negative-offset'],
            pendingWebPrependAnchorKind: 'none',
            platform: 'web',
            previousOffsetY: 240,
            programmaticWebWrite: true,
            reason: 'content-size-change',
            scrollable: true,
            sessionId: 'session-1',
            targetOffsetY: 360,
            timestampMs: 123,
            trigger: 'restore',
            type: 'scroll-write',
            writer: 'web-dom-restore',
        });
    });

    it('applies a preserve-position restore and records exactly one telemetry event', () => {
        const element = {
            clientHeight: 300,
            scrollHeight: 1320,
            scrollTop: 240,
        } as HTMLElement;
        const events: unknown[] = [];

        const result = applySidechainWebLocalHeightRestore({
            anchor: buildAnchor({
                metrics: {
                    clientHeight: 300,
                    element,
                    scrollHeight: 1200,
                    scrollTop: 240,
                },
            }),
            flashListContentHeightPx: 1400,
            flashListLayoutHeightPx: 500,
            itemCount: 7,
            paginationSnapshot: {
                hasMore: true,
                insideThreshold: false,
                phase: 'armed',
                suspendedReasons: ['negative-offset'],
            },
            platformOS: 'web',
            recordTelemetry: (event) => events.push(event),
            timestampMs: 123,
            webDomObservation: createWebDomScrollObservation(),
        });

        expect(result).toBe(true);
        expect(element.scrollTop).toBe(360);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            mode: 'restore-anchor',
            previousOffsetY: 240,
            targetOffsetY: 360,
            type: 'scroll-write',
            writer: 'web-dom-restore',
        });
    });

    it('applies a follow-bottom restore with follow-bottom telemetry mode', () => {
        const element = {
            clientHeight: 300,
            scrollHeight: 1320,
            scrollTop: 900,
        } as HTMLElement;
        const events: unknown[] = [];

        expect(applySidechainWebLocalHeightRestore({
            anchor: buildAnchor({
                metrics: {
                    clientHeight: 300,
                    element,
                    scrollHeight: 1200,
                    scrollTop: 900,
                },
                mode: 'follow-bottom',
            }),
            flashListContentHeightPx: 1320,
            flashListLayoutHeightPx: 300,
            itemCount: 4,
            paginationSnapshot: {
                hasMore: true,
                insideThreshold: true,
                phase: 'idle',
                suspendedReasons: [],
            },
            platformOS: 'web',
            recordTelemetry: (event) => events.push(event),
            timestampMs: 456,
            webDomObservation: createWebDomScrollObservation(),
        })).toBe(true);

        expect(element.scrollTop).toBe(1020);
        expect(events[0]).toMatchObject({
            distanceFromBottom: 0,
            mode: 'follow-bottom',
            targetOffsetY: 1020,
        });
    });

    it('does not record telemetry when no write occurs', () => {
        const events: unknown[] = [];

        const result = applySidechainWebLocalHeightRestore({
            anchor: buildAnchor(),
            flashListContentHeightPx: 1200,
            flashListLayoutHeightPx: 500,
            itemCount: 7,
            paginationSnapshot: {
                hasMore: true,
                insideThreshold: false,
                phase: 'armed',
                suspendedReasons: [],
            },
            platformOS: 'web',
            recordTelemetry: (event) => events.push(event),
            timestampMs: 123,
            webDomObservation: createWebDomScrollObservation(),
        });

        expect(result).toBe(false);
        expect(events).toEqual([]);
    });
});
