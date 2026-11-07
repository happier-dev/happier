import { describe, expect, it } from 'vitest';

import type { SessionBackgroundTaskRecordV1 } from '@happier-dev/protocol';

import { deriveAgentActivityCounts } from '../deriveAgentActivityCounts';
import {
    deriveAgentActivityEntries,
    toAgentActivityCountable,
} from '../deriveAgentActivityEntries';
import {
    buildBackgroundTaskEntryId,
    deriveBackgroundTaskActivityEntries,
    readBackgroundTaskEntryTaskId,
} from './fromBackgroundTasks';

const FALLBACK_TITLE = 'Background command';

function record(overrides: Partial<SessionBackgroundTaskRecordV1> = {}): SessionBackgroundTaskRecordV1 {
    return {
        v: 1,
        taskId: 'task_1',
        kind: 'command',
        status: 'running',
        updatedAt: 1_700_000_010_000,
        ...overrides,
    } as SessionBackgroundTaskRecordV1;
}

describe('deriveBackgroundTaskActivityEntries', () => {
    it('names the row with the redacted label the CLI persisted', () => {
        const [entry] = deriveBackgroundTaskActivityEntries({
            records: [record({ label: 'curl [REDACTED] https://example.test' })],
            fallbackTitle: FALLBACK_TITLE,
        });

        expect(entry?.title).toBe('curl [REDACTED] https://example.test');
        expect(entry?.kind).toBe('background_task');
        expect(entry?.id).toBe('background_task:task_1');
    });

    it('calls an unlabelled command a command, never an unnamed agent', () => {
        // A task first observed at its terminal event carries no description. Falling through to
        // the roster's agent fallback would state the one thing this kind exists to deny.
        const [entry] = deriveBackgroundTaskActivityEntries({
            records: [record({ label: undefined })],
            fallbackTitle: FALLBACK_TITLE,
        });

        expect(entry?.title).toBe(FALLBACK_TITLE);
    });

    it('never fabricates a start from the end instant', () => {
        // D-8: `startedAt ?? endedAt` made a 16-second run report 0:00. A terminal record without a
        // recorded start must claim no start at all.
        const [entry] = deriveBackgroundTaskActivityEntries({
            records: [record({ status: 'succeeded', endedAt: 1_700_000_016_000, startedAt: undefined })],
            fallbackTitle: FALLBACK_TITLE,
        });

        expect(entry?.startedAtMs).toBeNull();
        expect(entry?.endedAtMs).toBe(1_700_000_016_000);
    });

    it('carries the provider summary as the row one extra fact', () => {
        const [entry] = deriveBackgroundTaskActivityEntries({
            records: [record({ summary: 'Reading logs' })],
            fallbackTitle: FALLBACK_TITLE,
        });

        expect(entry?.metaDetail).toBe('Reading logs');
    });

    it('cannot be joined onto a headline entry', () => {
        // No CLI publishes background tasks into a headline, so the entry offers no handle and the
        // merge must render it as a local-only row rather than pairing it with somebody else.
        const [entry] = deriveBackgroundTaskActivityEntries({
            records: [record()],
            fallbackTitle: FALLBACK_TITLE,
        });
        expect(entry?.handle).toBeNull();

        const merged = deriveAgentActivityEntries({ headline: null, local: [entry!] });
        expect(merged.entries).toHaveLength(1);
        expect(merged.entries[0]?.provenance).toBe('local');
        expect(merged.entries[0]?.kind).toBe('background_task');
    });

    it('counts as a background command, not as a subagent', () => {
        // "3 subagents working" over two agents and a shell loop is the mislabel this mapping stops.
        // The kind is spelled `backgroundTask` and not `task` because the composer row it feeds
        // already contains a work-state plan item, which the product calls a task.
        const [entry] = deriveBackgroundTaskActivityEntries({
            records: [record()],
            fallbackTitle: FALLBACK_TITLE,
        });
        const merged = deriveAgentActivityEntries({ headline: null, local: [entry!] });

        expect(toAgentActivityCountable(merged.entries[0]!).kind).toBe('backgroundTask');
    });

    it('round-trips its entry id', () => {
        expect(readBackgroundTaskEntryTaskId(buildBackgroundTaskEntryId('task_9'))).toBe('task_9');
        expect(readBackgroundTaskEntryTaskId('workflow_agent:wf_1:a1')).toBeNull();
    });
});

describe('deriveBackgroundTaskActivityEntries (acknowledged stale reports)', () => {
    function derive(
        records: readonly SessionBackgroundTaskRecordV1[],
        acknowledgedUpdatedAtByTaskId: Readonly<Record<string, number>>,
    ) {
        const entries = deriveBackgroundTaskActivityEntries({
            records,
            fallbackTitle: FALLBACK_TITLE,
            acknowledgedUpdatedAtByTaskId,
        });
        const merged = deriveAgentActivityEntries({ headline: null, local: entries });
        return { entries, counts: deriveAgentActivityCounts(merged.entries.map(toAgentActivityCountable)) };
    }

    it('stops counting an acknowledged running report as live, without calling it an outcome', () => {
        const { entries, counts } = derive([record()], { task_1: 1_700_000_010_000 });

        expect(entries[0]?.status).toBe('unknown');
        expect(counts.liveBackgroundTasks).toBe(0);
        expect(counts.live).toBe(0);
    });

    it('shows the report as running again once newer evidence arrives', () => {
        const { entries, counts } = derive(
            [record({ updatedAt: 1_700_000_020_000 })],
            { task_1: 1_700_000_010_000 },
        );

        expect(entries[0]?.status).toBe('running');
        expect(counts.liveBackgroundTasks).toBe(1);
    });

    it('does not let an acknowledgement for one task hide another', () => {
        const { counts } = derive([record({ taskId: 'task_2' })], { task_1: 1_700_000_010_000 });

        expect(counts.liveBackgroundTasks).toBe(1);
    });

    it('keeps a real terminal outcome even when its earlier report was acknowledged', () => {
        const { entries } = derive(
            [record({ status: 'succeeded', updatedAt: 1_700_000_010_000 })],
            { task_1: 1_700_000_010_000 },
        );

        expect(entries[0]?.status).toBe('succeeded');
    });
});
