import { AGENT_ACTIVITY_STATUSES_V1 } from '@happier-dev/protocol';
import type { AgentActivityStatusV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';
import { AGENT_ACTIVITY_ROW_NO_ACTIONS } from '../agentActivityRowEntry';
import { resolveAgentActivityStatusWord } from './agentActivityToneStyle';
import { resolveAgentActivityMetaLine } from './resolveAgentActivityMetaLine';
import { resolveAgentActivityTitle } from './resolveAgentActivityTitle';

function entry(overrides: Partial<AgentActivityRowEntry> = {}): AgentActivityRowEntry {
    return {
        id: 'entry-1',
        status: 'running',
        title: 'Audit the reducer',
        actions: AGENT_ACTIVITY_ROW_NO_ACTIONS,
        ...overrides,
    };
}

/**
 * The row replaced seven identical fact pills with at most one meta line, so what that line says is
 * the whole information budget below the title. Two rules decide it:
 *
 * - An abnormal status always contributes its word (R-12: colour is never the only carrier).
 * - A normal status contributes nothing, so a healthy row does not narrate itself into two lines.
 */
describe('resolveAgentActivityMetaLine', () => {
    it('collapses the row to one line when a normal status has nothing to add', () => {
        expect(resolveAgentActivityMetaLine(entry({ status: 'running' }))).toBeNull();
        expect(resolveAgentActivityMetaLine(entry({ status: 'succeeded' }))).toBeNull();
        expect(resolveAgentActivityMetaLine(entry({ status: 'running', metaDetail: '   ' }))).toBeNull();
    });

    it('carries a word for every abnormal status, with or without a detail', () => {
        const silent: readonly AgentActivityStatusV1[] = ['running', 'succeeded'];
        for (const status of AGENT_ACTIVITY_STATUSES_V1) {
            const line = resolveAgentActivityMetaLine(entry({ status }));
            if (silent.includes(status)) {
                expect(line).toBeNull();
                continue;
            }
            expect(line).toBe(resolveAgentActivityStatusWord(status));
        }
    });

    it('leads with the status word and keeps the detail on the same single line', () => {
        const line = resolveAgentActivityMetaLine(entry({
            status: 'failed',
            metaDetail: 'exit code 2',
        }));

        expect(line).toBe(`${resolveAgentActivityStatusWord('failed')} · exit code 2`);
        expect(line).not.toContain('\n');
    });

    it('puts the silence note ahead of the detail it casts doubt on', () => {
        // The line is tail-truncated, so ordering is the whole decision: a reader who sees only its
        // first half must see the caveat rather than a preview that may be ten minutes old.
        expect(resolveAgentActivityMetaLine(entry({ status: 'running', metaDetail: 'Reading logs' }), 'quiet'))
            .toBe('No recent update · Reading logs');
        expect(resolveAgentActivityMetaLine(entry({ status: 'running', metaDetail: 'Reading logs' }), 'stale'))
            .toBe('No update in 10 min · Reading logs');
        // And it is the only thing staleness adds — the status word still leads.
        expect(resolveAgentActivityMetaLine(entry({ status: 'starting' }), 'stale'))
            .toBe(`${resolveAgentActivityStatusWord('starting')} · No update in 10 min`);
    });

    it('shows a running row its detail without a redundant "Running" prefix', () => {
        expect(resolveAgentActivityMetaLine(entry({ status: 'running', metaDetail: 'Reading logs' })))
            .toBe('Reading logs');
    });

    it('flattens a multi-line detail so a producer cannot grow the row', () => {
        expect(resolveAgentActivityMetaLine(entry({ status: 'running', metaDetail: 'first\nsecond' })))
            .toBe('first second');
    });
});

describe('resolveAgentActivityTitle', () => {
    it('uses the producer title, trimmed', () => {
        expect(resolveAgentActivityTitle(entry({ title: '  Audit the reducer  ' }))).toBe('Audit the reducer');
    });

    it('falls back to a translated name rather than rendering an empty row', () => {
        const fallback = resolveAgentActivityTitle(entry({ title: '   ' }));

        expect(fallback.trim().length).toBeGreaterThan(0);
        expect(fallback).toBe(resolveAgentActivityTitle(entry({ title: '' })));
    });

    it('collapses a multi-line title so it cannot break the one-line row', () => {
        expect(resolveAgentActivityTitle(entry({ title: 'Audit\nthe reducer' }))).toBe('Audit the reducer');
    });
});
