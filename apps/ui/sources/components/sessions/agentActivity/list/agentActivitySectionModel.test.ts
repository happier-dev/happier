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
    waiting: 'working',
    blocked: 'working',
    succeeded: 'finished',
    failed: 'finished',
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

    it('escalates nothing: the roster has two sections and neither is an attention claim', () => {
        // r4.0. The roster reports a WORK STATE. `waiting` is an agent stopped on a permission
        // prompt — still open work, so it sits under WORKING with its own glyph and status word.
        // `failed` is terminal, so it sits under FINISHED. Neither gets a section of its own: a
        // header that says NEEDS YOU spends the roster's one loud device on something the main
        // agent already handles, and a header that cries wolf stops being read.
        expect([...AGENT_ACTIVITY_SECTION_IDS]).toEqual(['working', 'finished']);
        const inProgress = AGENT_ACTIVITY_STATUSES_V1
            .filter((status) => resolveAgentActivitySectionId(status) === 'working');
        expect([...inProgress].sort())
            .toEqual(['blocked', 'queued', 'running', 'starting', 'waiting']);
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

    it('orders the two sections working, finished whatever order the input arrives in', () => {
        const model = buildAgentActivitySectionModel({
            entries: [
                entry({ id: 'done', status: 'succeeded', startedAtMs: T0, endedAtMs: T0 + 10 }),
                entry({ id: 'live', status: 'running', startedAtMs: T0 }),
                entry({ id: 'blocked-on-me', status: 'waiting', startedAtMs: T0 - 10 }),
            ],
        });
        expect(model.sections.map((section) => section.id)).toEqual([
            ...AGENT_ACTIVITY_SECTION_IDS,
        ]);
        expect(idsOf(model.sections[0]!.entries)).toEqual(['blocked-on-me', 'live']);
        expect(idsOf(model.sections[1]!.entries)).toEqual(['done']);
    });

    /**
     * The deciding guard for the r4.0 deletion: a permission-blocked agent must not vanish when its
     * section does. It joins WORKING, ordered by start like every other in-flight row — no tier
     * floating it to the top, which would be the attention claim re-entering through the sort.
     */
    it('keeps a permission-blocked agent in WORKING, ordered by start and never floated', () => {
        const model = buildAgentActivitySectionModel({
            entries: [
                entry({ id: 'failed-old', status: 'failed', startedAtMs: T0, endedAtMs: T0 + 10 }),
                entry({ id: 'waiting-new', status: 'waiting', startedAtMs: T0 + 60_000 }),
                entry({ id: 'running-old', status: 'running', startedAtMs: T0 }),
            ],
        });
        expect(idsOf(sectionById(model, 'working')!.entries))
            .toEqual(['running-old', 'waiting-new']);
        expect(idsOf(sectionById(model, 'finished')!.entries)).toEqual(['failed-old']);
        expect(sectionById(model, 'needsYou' as never)).toBeNull();
    });

    /**
     * The sort is the second half of the decision. Routing a failure to FINISHED and then floating
     * it above the successes would smuggle the attention claim straight back in through the
     * ordering — and it would be a lie about what the section is sorted by. Recency, like every
     * other terminal state.
     */
    it('sorts a failure in FINISHED by recency, with no priority tier above the successes', () => {
        const model = buildAgentActivitySectionModel({
            entries: [
                entry({ id: 'failed-oldest', status: 'failed', startedAtMs: T0, endedAtMs: T0 + 1_000 }),
                entry({ id: 'succeeded-newest', status: 'succeeded', startedAtMs: T0, endedAtMs: T0 + 3_000 }),
                entry({ id: 'failed-middle', status: 'failed', startedAtMs: T0, endedAtMs: T0 + 2_000 }),
            ],
        });

        expect(idsOf(sectionById(model, 'finished')!.entries))
            .toEqual(['succeeded-newest', 'failed-middle', 'failed-oldest']);
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

    /**
     * A headline-only entry carries no terminal instant by design (D-8 forbids inventing one) and
     * the count-only workflow headline carries no start either — all it has is `updatedAt`, the
     * instant of the most recent EVIDENCE. Without reading it a just-failed workflow run sorts
     * below every success from an hour ago, which is the opposite of what FINISHED is sorted by.
     */
    it('orders a terminal entry that has only an evidence instant by that instant', () => {
        const model = buildAgentActivitySectionModel({
            entries: [
                entry({ id: 'older', status: 'succeeded', startedAtMs: T0, endedAtMs: T0 + 1_000 }),
                entry({ id: 'run-just-failed', status: 'failed', updatedAtMs: T0 + 9_000 }),
                entry({ id: 'oldest', status: 'succeeded', startedAtMs: T0, endedAtMs: T0 + 500 }),
            ],
        });

        expect(idsOf(sectionById(model, 'finished')!.entries))
            .toEqual(['run-just-failed', 'older', 'oldest']);
    });

    /**
     * FIX-4: the WORKING header and every count surface must state the same number.
     *
     * A host that draws a live run as its own panel takes that run's members out of the list, so
     * the rows under WORKING are fewer than the live units the badge above the pane counts. The
     * header states the section's population, not its row count — the same relationship the
     * FINISHED cap already has — so the reader is never left to compute the difference.
     */
    it('adds the units a host folded into its own panels to the WORKING total', () => {
        const model = buildAgentActivitySectionModel({
            entries: [
                entry({ id: 'loose-1', status: 'running', startedAtMs: T0 }),
                entry({ id: 'loose-2', status: 'running', startedAtMs: T0 + 1 }),
                entry({ id: 'done', status: 'succeeded', startedAtMs: T0, endedAtMs: T0 + 1 }),
            ],
            foldedWorkingCount: 2,
        });
        const working = sectionById(model, 'working')!;

        expect(idsOf(working.entries)).toEqual(['loose-1', 'loose-2']);
        expect(working.totalCount).toBe(4);
        // Folding is a WORKING-only relationship: only live runs are drawn as panels.
        expect(sectionById(model, 'finished')!.totalCount).toBe(1);
    });

    it('leaves the WORKING total alone when the host folded nothing', () => {
        const model = buildAgentActivitySectionModel({
            entries: [entry({ id: 'loose-1', status: 'running', startedAtMs: T0 })],
            foldedWorkingCount: 0,
        });

        expect(sectionById(model, 'working')!.totalCount).toBe(1);
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
                'header:section:working',
                'row:live',
                'row:needs',
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
