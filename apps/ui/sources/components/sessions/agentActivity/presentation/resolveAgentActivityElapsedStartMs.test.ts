import { AGENT_ACTIVITY_STATUSES_V1, isInProgressAgentActivityStatus } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    AGENT_ACTIVITY_ROW_NO_ACTIONS,
    type AgentActivityRowEntry,
} from '../agentActivityRowEntry';
import { resolveAgentActivityElapsedStartMs } from './resolveAgentActivityElapsedStartMs';

const STARTED_AT = Date.parse('2026-05-12T00:00:00.000Z');

function makeEntry(overrides: Partial<AgentActivityRowEntry> = {}): AgentActivityRowEntry {
    return {
        id: 'entry-1',
        status: 'running',
        title: 'Audit the reducer',
        startedAtMs: STARTED_AT,
        actions: AGENT_ACTIVITY_ROW_NO_ACTIONS,
        ...overrides,
    };
}

describe('resolveAgentActivityElapsedStartMs (D-8)', () => {
    it.each([...AGENT_ACTIVITY_STATUSES_V1])(
        'counts from the start for %s while there is no finish, only if the work is still going',
        (status) => {
            const resolved = resolveAgentActivityElapsedStartMs(makeEntry({ status }));
            expect(resolved).toBe(isInProgressAgentActivityStatus(status) ? STARTED_AT : null);
        },
    );

    it.each([...AGENT_ACTIVITY_STATUSES_V1])(
        'counts from the start for %s once a genuine finish exists',
        (status) => {
            const resolved = resolveAgentActivityElapsedStartMs(
                makeEntry({ status, endedAtMs: STARTED_AT + 16_000 }),
            );
            expect(resolved).toBe(STARTED_AT);
        },
    );

    it('claims nothing without a start, whatever the finish says', () => {
        expect(resolveAgentActivityElapsedStartMs(makeEntry({
            status: 'succeeded',
            startedAtMs: null,
            endedAtMs: STARTED_AT + 16_000,
        }))).toBeNull();
    });

    it('keeps a waiting agent counting — how long it has waited for you is the point', () => {
        expect(resolveAgentActivityElapsedStartMs(makeEntry({ status: 'waiting' }))).toBe(STARTED_AT);
    });

    it('does not second-guess a genuinely sub-second run', () => {
        // A start equal to its finish is only a lie when it was fabricated, and that is the
        // derivations' problem. Suppressing it here would hide real fast runs instead.
        expect(resolveAgentActivityElapsedStartMs(makeEntry({
            status: 'succeeded',
            endedAtMs: STARTED_AT,
        }))).toBe(STARTED_AT);
    });

    it('ignores a non-finite instant rather than counting from NaN', () => {
        expect(resolveAgentActivityElapsedStartMs(makeEntry({
            status: 'succeeded',
            startedAtMs: Number.NaN,
            endedAtMs: STARTED_AT,
        }))).toBeNull();
    });
});
