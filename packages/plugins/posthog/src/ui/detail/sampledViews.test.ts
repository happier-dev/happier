import { describe, expect, it } from 'vitest';

import eventsPage from '../../api/__fixtures__/queryIssueEventsPage.json' with { type: 'json' };
import { parsePosthogIssueEventsEnvelope } from '../../api/types/events.js';
import {
    POSTHOG_SAMPLED_EVENT_BOUNDS_V1,
    projectPosthogIssueEvents,
    type PosthogProjectedIssueEvent,
} from './issueEventProjection.js';
import {
    posthogAffectedSessionRows,
    posthogOccurrenceRows,
    posthogStackTrace,
} from './sampledViews.js';

function sample(): readonly PosthogProjectedIssueEvent[] {
    const envelope = parsePosthogIssueEventsEnvelope(eventsPage);
    if (envelope === null) throw new Error('recorded issue-events fixture must parse');
    return projectPosthogIssueEvents(envelope.rawEvents, POSTHOG_SAMPLED_EVENT_BOUNDS_V1);
}

describe('posthogOccurrenceRows', () => {
    it('names each sampled row by its exception and keeps the provider row order', () => {
        const rows = posthogOccurrenceRows(sample());

        expect(rows.map((row) => row.uuid)).toEqual([
            '00000000-0000-4000-8000-0000000000f1',
            '00000000-0000-4000-8000-0000000000f2',
            '00000000-0000-4000-8000-0000000000f3',
        ]);
        expect(rows[0]?.headline).toBe(
            "TypeError: Cannot read properties of undefined (reading 'id')",
        );
        expect(rows[0]?.detail).toBe('https://shop.example/checkout/summary');
        expect(rows[0]?.atMs).toBe(Date.parse('2026-08-14T06:41:55.902000Z'));
        // The third fixture row carries neither URL nor session id.
        expect(rows[2]?.detail).toBeNull();
    });

    it('still lists a row whose exception carried no readable text', () => {
        const rows = posthogOccurrenceRows([{ uuid: 'e-bare', exceptions: [] }]);

        expect(rows).toHaveLength(1);
        // A row with nothing to say is still a sampled occurrence a reader can select.
        expect(rows[0]?.headline.length).toBeGreaterThan(0);
    });
});

describe('posthogStackTrace', () => {
    it('flattens the selected occurrence frames and counts app against other frames', () => {
        const trace = posthogStackTrace(sample()[0]);

        expect(trace.frames.map((frame) => frame.label))
            .toEqual(['renderSummary', 'commitWork']);
        expect(trace.frames[0]?.location).toBe('app/checkout/summary.tsx:128:17');
        expect(trace.frames[0]?.inApp).toBe(true);
        expect(trace.appFrameCount).toBe(1);
        expect(trace.otherFrameCount).toBe(1);
        expect(trace.frames.map((frame) => frame.id)).toEqual(['0:0', '0:1']);
    });

    it('reports an unselected or frameless occurrence without inventing a stack', () => {
        expect(posthogStackTrace(undefined).frames).toEqual([]);
        const frameless = posthogStackTrace(sample()[1]);
        expect(frameless.frames).toEqual([]);
        expect(frameless.exceptionLabel).toBe(
            "TypeError: Cannot read properties of undefined (reading 'id')",
        );
    });

    it('says the stack was shortened when the boundary projector bounded it', () => {
        const trace = posthogStackTrace({
            uuid: 'e1',
            exceptions: [{ type: 'TypeError', frames: [] }],
            truncated: true,
        });

        expect(trace.truncated).toBe(true);
    });
});

describe('posthogAffectedSessionRows', () => {
    it('derives one row per session and counts the occurrences that named it', () => {
        const rows = posthogAffectedSessionRows([
            ...sample(),
            { uuid: 'e-again', sessionId: '00000000-0000-4000-8000-0000000000c1', exceptions: [] },
        ]);

        expect(rows.map((row) => row.sessionId)).toEqual([
            '00000000-0000-4000-8000-0000000000c1',
            '00000000-0000-4000-8000-0000000000c2',
        ]);
        expect(rows[0]?.occurrenceCount).toBe(2);
        // The event with no session id contributes no row: a session this sample never
        // named is not an affected session.
        expect(rows).toHaveLength(2);
    });

    it('projects affected sessions without a dormant replay claim', () => {
        const rows = posthogAffectedSessionRows(sample());

        expect(rows[0]).toMatchObject({ sessionId: expect.any(String), occurrenceCount: 1 });
        expect(JSON.stringify(rows)).not.toContain('replay');
    });
});
