import { describe, expect, it } from 'vitest';

import type { TranscriptViewportTelemetryEvent } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';

import {
    assertNoSilentBails,
    assertOneOwnerPerPhase,
    assertScenario,
    assertWebWregDiagnostics,
    assertWriteBudget,
} from './viewportTelemetryAssertions';

type ScrollWriteOverrides = Partial<Omit<Extract<TranscriptViewportTelemetryEvent, { type: 'scroll-write' }>, 'type'>>;
type ObservationEvent = Exclude<TranscriptViewportTelemetryEvent, { type: 'scroll-write' | 'scroll-write-rejected' }>;
type ObservationOverrides = Partial<Omit<ObservationEvent, 'type'>>;

function scrollWrite(overrides: ScrollWriteOverrides = {}): TranscriptViewportTelemetryEvent {
    return {
        type: 'scroll-write',
        writer: 'native-scroll-to-offset',
        reason: 'entry-restore',
        sessionId: 'session:1',
        platform: 'ios',
        listImplementation: 'legend',
        mode: 'restore-distance',
        targetOffsetY: 100,
        timestampMs: 0,
        ...overrides,
    };
}

function observed(overrides: ObservationOverrides = {}): TranscriptViewportTelemetryEvent {
    return {
        type: 'scroll-observed',
        sessionId: 'session:1',
        platform: 'ios',
        listImplementation: 'legend',
        mode: 'follow-bottom',
        offsetY: 100,
        reason: 'observed',
        timestampMs: 0,
        ...overrides,
    };
}

function decision(overrides: ObservationOverrides = {}): TranscriptViewportTelemetryEvent {
    return {
        type: 'restore-decision',
        sessionId: 'session:1',
        platform: 'ios',
        listImplementation: 'legend',
        mode: 'restore-anchor',
        reason: 'pending',
        timestampMs: 0,
        ...overrides,
    };
}

describe('assertOneOwnerPerPhase', () => {
    it('passes when every write inside a phase window belongs to the declared owner', () => {
        const events = [
            scrollWrite({ reason: 'entry-restore', timestampMs: 10 }),
            scrollWrite({ reason: 'stream-append', mode: 'follow-bottom', timestampMs: 120 }),
        ];

        expect(() => assertOneOwnerPerPhase(events, [
            { owner: 'entry', startMs: 0, endMs: 100 },
            { owner: 'follow', startMs: 100, endMs: 200 },
        ])).not.toThrow();
    });

    it('fails with the offending events when a second owner writes inside a phase window (E2)', () => {
        const events = [
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 2123, timestampMs: 50 }),
            scrollWrite({ reason: 'prepend-restore', mode: 'restore-anchor', targetOffsetY: 1586, timestampMs: 50 }),
        ];

        expect(() => assertOneOwnerPerPhase(events, [
            { owner: 'entry', startMs: 0, endMs: 100, label: 'entry-window' },
        ])).toThrow(/entry-window[\s\S]*prepend-restore[\s\S]*1586/);
    });

    it('fails on writes that cannot be attributed to any owner', () => {
        const events = [
            scrollWrite({ reason: 'passive-drift', timestampMs: 10 }),
        ];

        expect(() => assertOneOwnerPerPhase(events, [
            { owner: 'follow', startMs: 0, endMs: 100 },
        ])).toThrow(/passive-drift/);
    });

    it('ignores rejected writes', () => {
        const rejectedWrite: TranscriptViewportTelemetryEvent = {
            type: 'scroll-write-rejected',
            writer: 'native-scroll-to-offset',
            reason: 'prepend-restore',
            rejectedOwner: 'prepend',
            activeOwner: 'entry',
            sessionId: 'session:1',
            platform: 'ios',
            listImplementation: 'legend',
            mode: 'restore-anchor',
            targetOffsetY: 1586,
            timestampMs: 20,
        };
        const events: TranscriptViewportTelemetryEvent[] = [
            scrollWrite({ reason: 'entry-restore', timestampMs: 10 }),
            rejectedWrite,
        ];

        expect(() => assertOneOwnerPerPhase(events, [
            { owner: 'entry', startMs: 0, endMs: 100 },
        ])).not.toThrow();
    });
});

describe('assertWriteBudget', () => {
    it('fails the E1 regression fixture: one owner writing 5 distinct targets in one phase', () => {
        const targets = [588, 149, 276, 276, 1586, 2123];
        const events = targets.map((targetOffsetY, index) => scrollWrite({
            reason: 'entry-restore',
            targetOffsetY,
            timestampMs: 10 + index * 100,
        }));

        expect(() => assertWriteBudget(events, {
            phase: { owner: 'entry', startMs: 0, endMs: 1_000 },
            maxWrites: 2,
            maxDistinctTargets: 2,
        })).toThrow(/distinct targets[\s\S]*5/);
    });

    it('fails when total writes exceed the budget even with few distinct targets', () => {
        const events = [
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 100, timestampMs: 10 }),
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 100, timestampMs: 20 }),
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 100, timestampMs: 30 }),
        ];

        expect(() => assertWriteBudget(events, {
            phase: { owner: 'entry', startMs: 0, endMs: 100 },
            maxWrites: 2,
            maxDistinctTargets: 2,
        })).toThrow(/writes[\s\S]*3/);
    });

    it('passes within budget and ignores writes outside the phase window', () => {
        const events = [
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 100, timestampMs: 10 }),
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 140, timestampMs: 20 }),
            scrollWrite({ reason: 'stream-append', mode: 'follow-bottom', targetOffsetY: 900, timestampMs: 500 }),
        ];

        expect(() => assertWriteBudget(events, {
            phase: { owner: 'entry', startMs: 0, endMs: 100 },
            maxWrites: 2,
            maxDistinctTargets: 2,
        })).not.toThrow();
    });
});

describe('assertNoSilentBails', () => {
    it('passes when every pending decision closes with a terminal outcome', () => {
        const events = [
            decision({ reason: 'pending', timestampMs: 10 }),
            decision({ reason: 'fallback-restored', timestampMs: 50 }),
            decision({ reason: 'pending', sessionId: 'session:2', timestampMs: 60 }),
            decision({ reason: 'abandoned-layout-timeout', sessionId: 'session:2', timestampMs: 90 }),
        ];

        expect(() => assertNoSilentBails(events)).not.toThrow();
    });

    it('passes when a web pending decision closes as observed', () => {
        const events = [
            decision({ reason: 'pending', platform: 'web', listImplementation: 'legend', timestampMs: 10 }),
            decision({ reason: 'observed', platform: 'web', listImplementation: 'legend', timestampMs: 50 }),
        ];

        expect(() => assertNoSilentBails(events)).not.toThrow();
    });

    it('passes when a web pending decision closes as not-ready', () => {
        const events = [
            decision({ reason: 'pending', platform: 'web', listImplementation: 'legend', timestampMs: 10 }),
            decision({ reason: 'not-ready', platform: 'web', listImplementation: 'legend', timestampMs: 50 }),
        ];

        expect(() => assertNoSilentBails(events)).not.toThrow();
    });

    it('fails when a pending decision never reaches a terminal outcome (E5)', () => {
        const events = [
            decision({ reason: 'pending', timestampMs: 10 }),
            observed({ timestampMs: 50 }),
        ];

        expect(() => assertNoSilentBails(events)).toThrow(/pending[\s\S]*session:1/);
    });

    it('scopes pending/outcome matching per session', () => {
        const events = [
            decision({ reason: 'pending', sessionId: 'session:1', timestampMs: 10 }),
            decision({ reason: 'mvcp-preserved', sessionId: 'session:2', timestampMs: 50 }),
        ];

        expect(() => assertNoSilentBails(events)).toThrow(/session:1/);
    });
});

describe('assertScenario cold-open (invariant A)', () => {
    it('passes a clean cold open: ≤2 writes, allowed reasons, confirmed at bottom', () => {
        const events = [
            scrollWrite({ reason: 'initial-open', mode: 'follow-bottom', targetOffsetY: 900, timestampMs: 10 }),
            scrollWrite({ reason: 'mount-settle', mode: 'follow-bottom', targetOffsetY: 905, timestampMs: 40 }),
            observed({ offsetY: 905, distanceFromBottom: 0, timestampMs: 90 }),
        ];

        expect(() => assertScenario(events, 'cold-open', { pinThresholdPx: 72 })).not.toThrow();
    });

    it('fails when cold open uses a disallowed write reason', () => {
        const events = [
            scrollWrite({ reason: 'entry-restore', timestampMs: 10 }),
            observed({ distanceFromBottom: 0, timestampMs: 90 }),
        ];

        expect(() => assertScenario(events, 'cold-open')).toThrow(/entry-restore/);
    });

    it('fails when cold open issues more than 2 writes', () => {
        const events = [
            scrollWrite({ reason: 'initial-open', mode: 'follow-bottom', timestampMs: 10 }),
            scrollWrite({ reason: 'mount-settle', mode: 'follow-bottom', timestampMs: 20 }),
            scrollWrite({ reason: 'mount-settle', mode: 'follow-bottom', timestampMs: 30 }),
            observed({ distanceFromBottom: 0, timestampMs: 90 }),
        ];

        expect(() => assertScenario(events, 'cold-open')).toThrow(/3/);
    });

    it('fails when the final observation is not at the bottom', () => {
        const events = [
            scrollWrite({ reason: 'initial-open', mode: 'follow-bottom', timestampMs: 10 }),
            observed({ distanceFromBottom: 480, timestampMs: 90 }),
        ];

        expect(() => assertScenario(events, 'cold-open', { pinThresholdPx: 72 })).toThrow(/480/);
    });

    it('fails when the final write is never confirmed by an observation (E3)', () => {
        const events = [
            observed({ distanceFromBottom: 0, timestampMs: 5 }),
            scrollWrite({ reason: 'initial-open', mode: 'follow-bottom', timestampMs: 10 }),
        ];

        expect(() => assertScenario(events, 'cold-open')).toThrow(/confirm/i);
    });
});

describe('assertScenario warm-reopen (invariant B)', () => {
    it('passes one entry write plus one confirmed correction', () => {
        const events = [
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 2100, timestampMs: 10 }),
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 2123, timestampMs: 60 }),
            observed({ offsetY: 2123, timestampMs: 120 }),
        ];

        expect(() => assertScenario(events, 'warm-reopen')).not.toThrow();
    });

    it('fails the E1 fixture: entry re-issuing on every content-height change', () => {
        const targets = [588, 149, 276, 276, 1586, 2123];
        const events = [
            ...targets.map((targetOffsetY, index) => scrollWrite({
                reason: 'entry-restore',
                targetOffsetY,
                timestampMs: 10 + index * 150,
            })),
            observed({ offsetY: 2123, timestampMs: 1_200 }),
        ];

        expect(() => assertScenario(events, 'warm-reopen')).toThrow(/entry/);
    });

    it('fails when a prepend write competes during entry (E2)', () => {
        const events = [
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 2123, timestampMs: 50 }),
            scrollWrite({ reason: 'prepend-restore', mode: 'restore-anchor', targetOffsetY: 1586, timestampMs: 50 }),
            observed({ offsetY: 2123, timestampMs: 120 }),
        ];

        expect(() => assertScenario(events, 'warm-reopen')).toThrow(/prepend/);
    });

    it('fails when the final entry write lands unconfirmed (E3)', () => {
        const events = [
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 2123, timestampMs: 50 }),
        ];

        expect(() => assertScenario(events, 'warm-reopen')).toThrow(/confirm/i);
    });
});

describe('assertScenario prepend (invariant D)', () => {
    it('passes mvcp-preserved with zero prepend writes', () => {
        const events = [
            decision({ reason: 'pending', timestampMs: 10 }),
            decision({ reason: 'mvcp-preserved', timestampMs: 80 }),
        ];

        expect(() => assertScenario(events, 'prepend')).not.toThrow();
    });

    it('passes fallback-restored with exactly one prepend write', () => {
        const events = [
            decision({ reason: 'pending', timestampMs: 10 }),
            decision({ reason: 'fallback-restored', timestampMs: 80 }),
            scrollWrite({ reason: 'prepend-restore', mode: 'restore-anchor', targetOffsetY: 1400, timestampMs: 90 }),
            observed({ offsetY: 1400, timestampMs: 140 }),
        ];

        expect(() => assertScenario(events, 'prepend')).not.toThrow();
    });

    it('fails when the transcript silently ends without any transaction outcome (E5)', () => {
        const events = [
            observed({ offsetY: 0, timestampMs: 10 }),
        ];

        expect(() => assertScenario(events, 'prepend')).toThrow(/outcome/i);
    });

    it('fails when more than one transaction outcome is emitted', () => {
        const events = [
            decision({ reason: 'mvcp-preserved', timestampMs: 10 }),
            decision({ reason: 'fallback-restored', timestampMs: 80 }),
        ];

        expect(() => assertScenario(events, 'prepend')).toThrow(/2/);
    });

    it('fails when mvcp-preserved still issues a prepend write', () => {
        const events = [
            decision({ reason: 'mvcp-preserved', timestampMs: 10 }),
            scrollWrite({ reason: 'prepend-restore', mode: 'restore-anchor', timestampMs: 20 }),
        ];

        expect(() => assertScenario(events, 'prepend')).toThrow(/mvcp-preserved/);
    });

    it('accepts an abandoned outcome because it carries its reason', () => {
        const events = [
            decision({ reason: 'pending', timestampMs: 10 }),
            decision({ reason: 'abandoned-user-scroll', timestampMs: 80 }),
        ];

        expect(() => assertScenario(events, 'prepend')).not.toThrow();
    });

    it('accepts abandoned-layout-timeout as a closing transaction outcome', () => {
        const events = [
            decision({ reason: 'pending', timestampMs: 10 }),
            decision({ reason: 'abandoned-layout-timeout', timestampMs: 80 }),
        ];

        expect(() => assertScenario(events, 'prepend')).not.toThrow();
        expect(() => assertNoSilentBails(events)).not.toThrow();
    });
});

describe('assertScenario manual-scroll (invariant E)', () => {
    it('passes when a manual scroll session contains zero writes', () => {
        const events = [
            observed({ offsetY: 400, timestampMs: 10 }),
            observed({ offsetY: 900, timestampMs: 60 }),
        ];

        expect(() => assertScenario(events, 'manual-scroll')).not.toThrow();
    });

    it('fails on any write during manual scroll', () => {
        const events = [
            observed({ offsetY: 400, timestampMs: 10 }),
            scrollWrite({ reason: 'mount-settle', mode: 'follow-bottom', timestampMs: 20 }),
        ];

        expect(() => assertScenario(events, 'manual-scroll')).toThrow(/mount-settle/);
    });
});

describe('assertScenario streaming-pinned (invariant F)', () => {
    it('passes stream writes each attributable to a new content version', () => {
        const events = [
            scrollWrite({ reason: 'stream-append', mode: 'follow-bottom', contentHeight: 1_000, targetOffsetY: 500, timestampMs: 10 }),
            scrollWrite({ reason: 'stream-append', mode: 'follow-bottom', contentHeight: 1_200, targetOffsetY: 700, timestampMs: 60 }),
        ];

        expect(() => assertScenario(events, 'streaming-pinned')).not.toThrow();
    });

    it('fails two writes for the same content version', () => {
        const events = [
            scrollWrite({ reason: 'stream-append', mode: 'follow-bottom', contentHeight: 1_000, timestampMs: 10 }),
            scrollWrite({ reason: 'stream-append', mode: 'follow-bottom', contentHeight: 1_000, timestampMs: 30 }),
        ];

        expect(() => assertScenario(events, 'streaming-pinned')).toThrow(/1000/);
    });

    it('fails writes while the user is unpinned (no pull-back)', () => {
        const events = [
            scrollWrite({ reason: 'stream-append', mode: 'user-unpinned', contentHeight: 1_000, timestampMs: 10 }),
        ];

        expect(() => assertScenario(events, 'streaming-pinned')).toThrow(/user-unpinned/);
    });
});

describe('assertScenario owner write-target spread (invariant G)', () => {
    it('fails streaming-pinned when a non-follow owner writes in steady state', () => {
        const events = [
            scrollWrite({ reason: 'stream-append', mode: 'follow-bottom', contentHeight: 1_000, targetOffsetY: 100, timestampMs: 10 }),
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 200, timestampMs: 20 }),
        ];

        expect(() => assertScenario(events, 'streaming-pinned')).toThrow(/entry/);
    });

    it('fails any scenario where the entry owner spreads writes over more than 2 distinct targets', () => {
        const events = [
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 588, timestampMs: 10 }),
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 149, timestampMs: 20 }),
            scrollWrite({ reason: 'entry-restore', targetOffsetY: 1586, timestampMs: 30 }),
            observed({ offsetY: 1586, timestampMs: 90 }),
        ];

        expect(() => assertScenario(events, 'warm-reopen')).toThrow(/distinct targets=3/);
    });
});

describe('assertWebWregDiagnostics', () => {
    it('fails when a web pagination trace omits required WREG diagnostics', () => {
        const events: TranscriptViewportTelemetryEvent[] = [
            observed({
                platform: 'web',
                listImplementation: 'legend',
                mode: 'user-unpinned',
                reason: 'observed',
                trigger: 'edge-reached',
                domScrollTop: 0,
                domScrollHeight: 1200,
                // Missing domClientHeight, FlashList metrics, scrollability,
                // pagination diagnostics, hot/cold counts, pending anchor,
                // and programmatic-write evidence must block WREG.7.
                timestampMs: 10,
            }),
        ];

        expect(() => assertWebWregDiagnostics(events)).toThrow(/domClientHeight[\s\S]*paginationPhase[\s\S]*programmaticWebWrite/);
    });

    it('passes when web pagination and restore events carry the complete WREG diagnostic set', () => {
        const events: TranscriptViewportTelemetryEvent[] = [
            observed({
                platform: 'web',
                listImplementation: 'legend',
                mode: 'user-unpinned',
                reason: 'observed',
                offsetY: 0,
                layoutHeight: 600,
                contentHeight: 1200,
                distanceFromBottom: 600,
                trigger: 'edge-reached',
                domScrollTop: 0,
                domScrollHeight: 1200,
                domClientHeight: 600,
                listContentHeight: 1180,
                listLayoutHeight: 580,
                scrollable: true,
                paginationPhase: 'armed',
                paginationSuspendedReasons: [],
                firstVisibleAnchorTestId: 'transcript-item-turn-1',
                programmaticWebWrite: false,
                timestampMs: 10,
            }),
            decision({
                platform: 'web',
                listImplementation: 'legend',
                mode: 'restore-anchor',
                reason: 'restored',
                trigger: 'prepend-restore',
                offsetY: 180,
                layoutHeight: 600,
                contentHeight: 1600,
                distanceFromBottom: 820,
                domScrollTop: 180,
                domScrollHeight: 1600,
                domClientHeight: 600,
                listContentHeight: 1580,
                listLayoutHeight: 580,
                scrollable: true,
                paginationPhase: 'idle',
                paginationSuspendedReasons: [],
                firstVisibleAnchorTestId: 'transcript-item-turn-1',
                programmaticWebWrite: true,
                timestampMs: 40,
            }),
        ];

        expect(() => assertWebWregDiagnostics(events)).not.toThrow();
    });

    it('does not require a DOM anchor id on owner decisions that did not observe the DOM', () => {
        const events: TranscriptViewportTelemetryEvent[] = [
            decision({
                platform: 'web',
                listImplementation: 'legend',
                mode: 'restore-distance',
                reason: 'restored',
                trigger: 'prepend-restore',
                offsetY: 180,
                layoutHeight: 600,
                contentHeight: 1600,
                distanceFromBottom: 820,
                domScrollTop: 180,
                domScrollHeight: 1600,
                domClientHeight: 600,
                listContentHeight: 1580,
                listLayoutHeight: 580,
                scrollable: true,
                paginationPhase: 'idle',
                paginationSuspendedReasons: [],
                programmaticWebWrite: true,
                timestampMs: 40,
            }),
        ];

        expect(() => assertWebWregDiagnostics(events)).not.toThrow();
    });
});
