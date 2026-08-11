import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeAgentActivityRowEntryFixture, renderScreen } from '@/dev/testkit';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';
import { AgentActivityList } from './AgentActivityList';

/**
 * Quiet at 90 s, stale at 10 minutes — and never, at any point, a terminal status.
 *
 * This runs through the real chain (list -> staleness resolver -> row -> meta line -> time slot)
 * rather than testing the resolver twice, because the two things 4.10 actually promises are
 * observable only when they are composed: the note appears while the clock is still counting, and
 * later the clock stops while the status stays exactly what it was.
 */

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

const T0 = Date.parse('2026-05-12T00:00:00.000Z');
const MOUNTED_AT_OFFSET_MS = 42_000;

let clockOffsetMs = MOUNTED_AT_OFFSET_MS;

/**
 * Move the shared clock to `offsetMs` after the agent started.
 *
 * Advancing the timers is what moves `Date.now` under fake timers, so the intervals and the instant
 * they read stay consistent — setting the system time separately would let the 1 s elapsed clock
 * and the 30 s note clock disagree about what "now" is.
 */
async function advanceTo(offsetMs: number) {
    const deltaMs = offsetMs - clockOffsetMs;
    clockOffsetMs = offsetMs;
    await act(async () => {
        vi.advanceTimersByTime(deltaMs);
    });
}

function findRowProps(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> {
    const matches = screen.tree.root.findAll((node) => {
        const props = node.props as Record<string, unknown> | undefined;
        return props != null
            && 'showChevron' in props
            && 'iconBoxSize' in props
            && 'subtitleLines' in props;
    });
    expect(matches).toHaveLength(1);
    return matches[0].props as Record<string, unknown>;
}

/**
 * Whether the running spinner is still turning.
 *
 * Matched on `animationEnabled` + `color` + `size`, which is `ActivitySpinner`'s own signature —
 * the row and the status slot both forward an `animationEnabled` prop, so matching on that alone
 * finds the top of the chain rather than the thing that actually spins.
 */
function spinnerAnimating(screen: Awaited<ReturnType<typeof renderScreen>>): boolean | null {
    const matches = screen.tree.root.findAll((node) => {
        const props = node.props as Record<string, unknown> | undefined;
        return props != null
            && 'animationEnabled' in props
            && 'color' in props
            && 'size' in props;
    });
    if (matches.length === 0) return null;
    return (matches[0].props as { animationEnabled?: boolean }).animationEnabled !== false;
}

function liveEntry(overrides: Partial<AgentActivityRowEntry> = {}): AgentActivityRowEntry {
    return makeAgentActivityRowEntryFixture({
        id: 'agent-1',
        title: 'Audit the reducer',
        status: 'running',
        startedAtMs: T0,
        updatedAtMs: T0,
        ...overrides,
    });
}

describe('AgentActivityList (quiet and stale rows)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T0 + MOUNTED_AT_OFFSET_MS));
        clockOffsetMs = MOUNTED_AT_OFFSET_MS;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('says nothing about a briefly quiet agent', async () => {
        const screen = await renderScreen(<AgentActivityList entries={[liveEntry()]} />);

        expect(findRowProps(screen).subtitle).toBeNull();
        expect(screen.getTextContent()).toContain('0:42');

        await screen.unmount();
    });

    it('notes the silence at 90 s and keeps counting, because the agent has not stopped', async () => {
        const entries = [liveEntry()] as const;
        const screen = await renderScreen(<AgentActivityList entries={entries} />);

        await advanceTo(120_000);

        expect(String(findRowProps(screen).subtitle)).toContain('No recent update');
        expect(screen.getTextContent()).toContain('2:00');

        // Quiet is a note, not a stop: the clock is the remaining evidence that this is still live.
        await advanceTo(123_000);
        expect(screen.getTextContent()).toContain('2:03');

        await screen.unmount();
    });

    it('freezes the clock at 10 minutes so the row stops claiming liveness', async () => {
        const entries = [liveEntry()] as const;
        const screen = await renderScreen(<AgentActivityList entries={entries} />);

        await advanceTo(630_000);

        expect(String(findRowProps(screen).subtitle)).toContain('No update for over 10 min');
        // Frozen exactly on the threshold, not at the current 10:30 — and it does not jump
        // backwards to get there, because the clock clamps itself rather than waiting for the note.
        expect(screen.getTextContent()).toContain('10:00');
        expect(screen.getTextContent()).not.toContain('10:30');

        await advanceTo(900_000);
        expect(screen.getTextContent()).toContain('10:00');
        expect(screen.getTextContent()).not.toContain('15:00');

        // Nothing is left claiming that work is happening right now.
        expect(spinnerAnimating(screen)).toBe(false);

        await screen.unmount();
    });

    it('never lets silence become an outcome', async () => {
        const entries = [liveEntry()] as const;
        const screen = await renderScreen(<AgentActivityList entries={entries} />);

        await advanceTo(86_400_000);

        const row = findRowProps(screen);
        // 4.9.3: a stale entry keeps its last known non-terminal status. If a day of silence could
        // produce `Succeeded` or `Failed` here, this pane would be inventing outcomes.
        expect(String(row.accessibilityLabel)).toContain('Running');
        expect(String(row.accessibilityLabel)).not.toContain('Succeeded');
        expect(String(row.accessibilityLabel)).not.toContain('Failed');
        expect(String(row.accessibilityLabel)).not.toContain('Timed out');
        expect(row.accessibilityState).toMatchObject({ busy: true });

        await screen.unmount();
    });

    it('makes no claim about an agent whose activity we have never observed', async () => {
        // No `updatedAtMs`: the roster has not hydrated this agent's sidechain, so it knows only
        // that it has not looked. A note here would describe our hydration, not the agent.
        const entries = [liveEntry({ updatedAtMs: null })] as const;
        const screen = await renderScreen(<AgentActivityList entries={entries} />);

        await advanceTo(86_400_000);

        expect(findRowProps(screen).subtitle).toBeNull();
        expect(screen.getTextContent()).toContain('24h 00m');
        expect(spinnerAnimating(screen)).toBe(true);

        await screen.unmount();
    });

    it('leaves an agent that is waiting on a person alone, clock included', async () => {
        // 4.7: how long it has been waiting for YOU is the datum that makes a person act, so it is
        // never frozen and never described as an absence of updates.
        const entries = [liveEntry({ status: 'waiting' })] as const;
        const screen = await renderScreen(<AgentActivityList entries={entries} />);

        await advanceTo(630_000);

        expect(String(findRowProps(screen).subtitle)).not.toContain('No update');
        expect(screen.getTextContent()).toContain('10:30');

        await screen.unmount();
    });
});
