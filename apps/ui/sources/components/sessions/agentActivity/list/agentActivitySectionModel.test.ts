import { AGENT_ACTIVITY_STATUSES_V1, type AgentActivityStatusV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    makeAgentActivityRosterFixture,
    makeAgentActivityRowEntryFixture,
} from '@/dev/testkit';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';
import {
    AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT,
    AGENT_ACTIVITY_SECTION_IDS,
    buildAgentActivitySectionModel,
    flattenAgentActivitySectionModel,
    resolveAgentActivitySectionId,
    type AgentActivitySectionId,
} from './agentActivitySectionModel';

const T0 = Date.parse('2026-05-12T00:00:00.000Z');

const entry = makeAgentActivityRowEntryFixture;

function idsOf(entries: readonly AgentActivityRowEntry[]): readonly string[] {
    return entries.map((item) => item.id);
}

function sectionById(
    model: ReturnType<typeof buildAgentActivitySectionModel>,
    id: AgentActivitySectionId,
) {
    return model.sections.find((section) => section.id === id) ?? null;
}

/**
 * The hand-written expectation for where every status lives.
 *
 * Written out longhand rather than derived, so a new protocol status has to be placed
 * deliberately: the coverage assertion below fails before any behaviour is checked.
 */
const EXPECTED_SECTION_BY_STATUS: Record<AgentActivityStatusV1, AgentActivitySectionId> = {
    queued: 'working',
    starting: 'working',
    running: 'working',
    waiting: 'needsYou',
    blocked: 'working',
    succeeded: 'finished',
    failed: 'needsYou',
    timedOut: 'finished',
    cancelled: 'finished',
    unknown: 'finished',
};

describe('resolveAgentActivitySectionId', () => {
    it('places every protocol status in exactly one section', () => {
        // Lock 1: the expected table and the protocol vocabulary are the same set, so a new status
        // cannot be silently absorbed by whichever section the implementation defaults to.
        expect(Object.keys(EXPECTED_SECTION_BY_STATUS).sort())
            .toEqual([...AGENT_ACTIVITY_STATUSES_V1].sort());

        for (const status of AGENT_ACTIVITY_STATUSES_V1) {
            expect(resolveAgentActivitySectionId(status)).toBe(EXPECTED_SECTION_BY_STATUS[status]);
        }
    });

    it('escalates only the two statuses a person can act on', () => {
        const escalating = AGENT_ACTIVITY_STATUSES_V1
            .filter((status) => resolveAgentActivitySectionId(status) === 'needsYou');
        // `timedOut` is a danger tone but needs no person until they read it; `blocked` waits on a
        // sibling, not a human. Pinning either would make the section stop meaning anything.
        expect([...escalating].sort()).toEqual(['failed', 'waiting']);
    });
});

describe('buildAgentActivitySectionModel', () => {
    it('returns nothing at all for an empty roster', () => {
        const model = buildAgentActivitySectionModel({ entries: [] });
        expect(model.sections).toEqual([]);
        expect(model.totalCount).toBe(0);
    });

    it('renders a single section for a single entry, and no empty ones', () => {
        const model = buildAgentActivitySectionModel({
            entries: [entry({ id: 'a', status: 'running', startedAtMs: T0 })],
        });
        expect(model.sections.map((section) => section.id)).toEqual(['working']);
        expect(model.totalCount).toBe(1);
    });

    it('orders the three sections needsYou, working, finished whatever order the input arrives in', () => {
        const model = buildAgentActivitySectionModel({
            entries: [
                entry({ id: 'done', status: 'succeeded', startedAtMs: T0, endedAtMs: T0 + 10 }),
                entry({ id: 'live', status: 'running', startedAtMs: T0 }),
                entry({ id: 'blocked-on-me', status: 'waiting', startedAtMs: T0 }),
            ],
        });
        expect(model.sections.map((section) => section.id)).toEqual([
            ...AGENT_ACTIVITY_SECTION_IDS,
        ]);
        expect(idsOf(model.sections[0]!.entries)).toEqual(['blocked-on-me']);
        expect(idsOf(model.sections[1]!.entries)).toEqual(['live']);
        expect(idsOf(model.sections[2]!.entries)).toEqual(['done']);
    });

    it('puts waiting above failed inside NEEDS YOU, then the longest wait first', () => {
        const model = buildAgentActivitySectionModel({
            entries: [
                entry({ id: 'failed-old', status: 'failed', startedAtMs: T0 }),
                entry({ id: 'waiting-new', status: 'waiting', startedAtMs: T0 + 60_000 }),
                entry({ id: 'failed-new', status: 'failed', startedAtMs: T0 + 90_000 }),
                entry({ id: 'waiting-old', status: 'waiting', startedAtMs: T0 }),
            ],
        });
        // A person can unblock `waiting` right now; `failed` is already over. Within a status the
        // one that has been waiting longest is the one that most needs a person.
        expect(idsOf(sectionById(model, 'needsYou')!.entries))
            .toEqual(['waiting-old', 'waiting-new', 'failed-old', 'failed-new']);
    });

    it('sorts WORKING by start time only, so a status change never moves a row under the reader', () => {
        // Status and start time deliberately disagree: a status-ranked section would read
        // running, queued, blocked — the assertion below is the one that tells the two apart.
        const entries = [
            entry({ id: 'queued-oldest', status: 'queued', startedAtMs: T0 }),
            entry({ id: 'running-middle', status: 'running', startedAtMs: T0 + 1_000 }),
            entry({ id: 'blocked-newest', status: 'blocked', startedAtMs: T0 + 2_000 }),
        ];
        const before = buildAgentActivitySectionModel({ entries });
        expect(idsOf(sectionById(before, 'working')!.entries))
            .toEqual(['queued-oldest', 'running-middle', 'blocked-newest']);

        // `blocked-newest` unblocks and starts running. Nothing about where the reader was looking
        // has changed, so nothing about the order may change either.
        const after = buildAgentActivitySectionModel({
            entries: [
                entries[0]!,
                entries[1]!,
                entry({ id: 'blocked-newest', status: 'running', startedAtMs: T0 + 2_000 }),
            ],
        });
        expect(idsOf(sectionById(after, 'working')!.entries))
            .toEqual(['queued-oldest', 'running-middle', 'blocked-newest']);
    });

    it('sorts FINISHED newest-first and sinks entries whose end time is unknown', () => {
        const model = buildAgentActivitySectionModel({
            entries: [
                entry({ id: 'older', status: 'succeeded', startedAtMs: T0, endedAtMs: T0 + 1_000 }),
                entry({ id: 'no-end', status: 'cancelled', startedAtMs: T0 }),
                entry({ id: 'newest', status: 'timedOut', startedAtMs: T0, endedAtMs: T0 + 9_000 }),
            ],
        });
        expect(idsOf(sectionById(model, 'finished')!.entries)).toEqual(['newest', 'older', 'no-end']);
    });

    it('keeps the newest 24 finished rows in the pane and reports what it hid', () => {
        const entries = Array.from({ length: 40 }, (_, index) => entry({
            id: `done-${index}`,
            status: 'succeeded',
            startedAtMs: T0,
            endedAtMs: T0 + index,
        }));
        const model = buildAgentActivitySectionModel({
            entries,
            finishedLimit: AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT,
        });
        const finished = sectionById(model, 'finished')!;

        expect(finished.entries).toHaveLength(AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT);
        expect(finished.totalCount).toBe(40);
        expect(finished.hiddenCount).toBe(16);
        // The cap must drop the oldest, never the just-finished ones the reader is watching for.
        expect(finished.entries[0]!.id).toBe('done-39');
        expect(finished.entries.at(-1)!.id).toBe('done-16');
        expect(model.totalCount).toBe(40);
    });

    it('shows every finished row when the host has nowhere to send a "show all"', () => {
        const entries = Array.from({ length: 40 }, (_, index) => entry({
            id: `done-${index}`,
            status: 'succeeded',
            startedAtMs: T0,
            endedAtMs: T0 + index,
        }));
        const model = buildAgentActivitySectionModel({ entries, finishedLimit: null });
        const finished = sectionById(model, 'finished')!;

        // A cap without an escape route is a dead end: rows would exist with no way to reach them.
        expect(finished.entries).toHaveLength(40);
        expect(finished.hiddenCount).toBe(0);
    });

    it('is deterministic and preserves input order for entries that tie on every key', () => {
        const entries = ['e', 'd', 'c', 'b', 'a'].map((id) => entry({
            id,
            status: 'running',
            startedAtMs: T0,
        }));
        const first = buildAgentActivitySectionModel({ entries });
        const second = buildAgentActivitySectionModel({ entries });

        expect(idsOf(sectionById(first, 'working')!.entries)).toEqual(['e', 'd', 'c', 'b', 'a']);
        expect(idsOf(sectionById(second, 'working')!.entries))
            .toEqual(idsOf(sectionById(first, 'working')!.entries));
    });

    it('hands back the very same entry objects, so a memoized row stays memoized (INV-4)', () => {
        const live = entry({ id: 'live', status: 'running', startedAtMs: T0 });
        const model = buildAgentActivitySectionModel({ entries: [live] });
        expect(sectionById(model, 'working')!.entries[0]).toBe(live);
    });

    it('handles a 40-entry mixed roster without losing or duplicating a row', () => {
        const entries = makeAgentActivityRosterFixture({
            count: 40,
            statuses: AGENT_ACTIVITY_STATUSES_V1,
            startedAtMs: T0,
        });
        const model = buildAgentActivitySectionModel({
            entries,
            finishedLimit: AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT,
        });

        const rendered = model.sections.flatMap((section) => idsOf(section.entries));
        expect(new Set(rendered).size).toBe(rendered.length);
        expect(model.totalCount).toBe(40);
        const placed = model.sections.reduce((sum, section) => sum + section.totalCount, 0);
        expect(placed).toBe(40);
    });
});

describe('flattenAgentActivitySectionModel', () => {
    it('emits one flat sequence of headers and rows, so a row that changes section keeps its place', () => {
        const model = buildAgentActivitySectionModel({
            entries: [
                entry({ id: 'live', status: 'running', startedAtMs: T0 }),
                entry({ id: 'needs', status: 'waiting', startedAtMs: T0 }),
                entry({ id: 'done', status: 'succeeded', startedAtMs: T0, endedAtMs: T0 + 1 }),
            ],
        });

        expect(flattenAgentActivitySectionModel(model).map((item) => `${item.kind}:${item.key}`))
            .toEqual([
                'header:section:needsYou',
                'row:needs',
                'header:section:working',
                'row:live',
                'header:section:finished',
                'row:done',
            ]);
    });

    it('marks only the last row of each section, so dividers stop at the section edge', () => {
        const model = buildAgentActivitySectionModel({
            entries: [
                entry({ id: 'live-a', status: 'running', startedAtMs: T0 }),
                entry({ id: 'live-b', status: 'running', startedAtMs: T0 + 1 }),
                entry({ id: 'done', status: 'succeeded', startedAtMs: T0, endedAtMs: T0 + 1 }),
            ],
        });

        const lastFlags = flattenAgentActivitySectionModel(model)
            .filter((item) => item.kind === 'row')
            .map((item) => (item.kind === 'row' ? [item.entry.id, item.isLastInSection] : null));
        expect(lastFlags).toEqual([['live-a', false], ['live-b', true], ['done', true]]);
    });

    it('emits the show-all item only when the cap actually hid something', () => {
        const entries = Array.from({ length: 26 }, (_, index) => entry({
            id: `done-${index}`,
            status: 'succeeded',
            startedAtMs: T0,
            endedAtMs: T0 + index,
        }));

        const capped = flattenAgentActivitySectionModel(buildAgentActivitySectionModel({
            entries,
            finishedLimit: AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT,
        }));
        const showAll = capped.filter((item) => item.kind === 'showAll');
        expect(showAll).toHaveLength(1);
        expect(showAll[0]).toMatchObject({ kind: 'showAll', totalCount: 26 });
        expect(capped.at(-1)).toBe(showAll[0]);

        const uncapped = flattenAgentActivitySectionModel(buildAgentActivitySectionModel({
            entries,
            finishedLimit: null,
        }));
        expect(uncapped.some((item) => item.kind === 'showAll')).toBe(false);
    });

    it('draws a row where the migration placed it, keeping the count and the row it counts together', () => {
        const entries = [
            entry({ id: 'live-a', status: 'running', startedAtMs: T0 }),
            entry({ id: 'just-done', status: 'succeeded', startedAtMs: T0 + 1, endedAtMs: T0 + 900 }),
            entry({ id: 'live-b', status: 'running', startedAtMs: T0 + 2 }),
        ];

        const model = buildAgentActivitySectionModel({
            entries,
            // The dwell: the agent has finished, but it is still drawn where it was watched.
            placementById: new Map([['just-done', 'working' as const]]),
        });

        // In its held section it keeps its place by start time — a dwelling row must not move
        // WITHIN the section either, or the dwell would just relocate the jump.
        expect(idsOf(sectionById(model, 'working')!.entries)).toEqual(['live-a', 'just-done', 'live-b']);
        // A section header that said "2" over three rows would be the list contradicting itself.
        expect(sectionById(model, 'working')!.totalCount).toBe(3);
        expect(sectionById(model, 'finished')).toBeNull();
    });

    it('leaves placement to the status for every entry the migration did not name', () => {
        const entries = [
            entry({ id: 'held', status: 'succeeded', startedAtMs: T0, endedAtMs: T0 + 10 }),
            entry({ id: 'free', status: 'succeeded', startedAtMs: T0 + 1, endedAtMs: T0 + 20 }),
        ];

        const model = buildAgentActivitySectionModel({
            entries,
            placementById: new Map([['held', 'working' as const]]),
        });

        expect(idsOf(sectionById(model, 'working')!.entries)).toEqual(['held']);
        expect(idsOf(sectionById(model, 'finished')!.entries)).toEqual(['free']);
    });
});
