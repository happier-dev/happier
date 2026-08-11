import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeAgentActivityRowEntryFixture, renderScreen } from '@/dev/testkit';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';
import { AgentActivityList } from './AgentActivityList';
import { createListMotionQuiet } from './listMotionQuiet';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const reducedMotion = vi.hoisted(() => ({ enabled: false }));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotion.enabled,
}));

/**
 * The contract timings from the plan, written out rather than imported.
 *
 * A test that imported the constants would pass against any value they held, including a wrong
 * one — and these two numbers ARE the behaviour: 900 ms is how long a finished agent stays where
 * the reader watched it finish, 1200 ms is the longest a ready migration waits for stragglers so
 * that a burst of completions costs one reflow instead of six.
 */
const DWELL_MS = 900;
const BATCH_CEILING_MS = 1200;

const T0 = Date.parse('2026-05-12T00:00:00.000Z');

function entry(
    overrides: Partial<AgentActivityRowEntry> & Pick<AgentActivityRowEntry, 'id'>,
): AgentActivityRowEntry {
    return makeAgentActivityRowEntryFixture({ startedAtMs: T0, ...overrides });
}

function finished(source: AgentActivityRowEntry, atMs: number): AgentActivityRowEntry {
    return { ...source, status: 'succeeded', endedAtMs: atMs };
}

async function advance(ms: number): Promise<void> {
    await act(async () => {
        vi.advanceTimersByTime(ms);
    });
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/**
 * The rendered sequence of headers and rows, as one comparable string.
 *
 * This is the only thing "a reflow" means to a reader: the order they can see changed. Reading it
 * from the section and row testIDs keeps the assertion independent of how the list achieves the
 * order, so the same helper measures the unchoreographed list and the choreographed one.
 */
function layoutSignature(screen: Screen): string {
    const ids = screen.root
        .findAll((node) => /^roster:(section|row):[^:]+$/.test(String(node.props?.testID ?? '')))
        .map((node) => String(node.props.testID).replace('roster:', ''));
    return ids.filter((id, index) => id !== ids[index - 1]).join(' > ');
}

function dedupeConsecutive(values: readonly string[]): string[] {
    return values.filter((value, index) => value !== values[index - 1]);
}

function motionWrapper(screen: Screen, key: string) {
    return screen.findHostByTestId(`roster:motion:${key}`);
}

function elapsedText(screen: Screen, entryId: string): string {
    return String(screen.findHostByTestId(`roster:row:${entryId}:elapsed`)?.props.children ?? '');
}

describe('AgentActivityList migration choreography', () => {
    beforeEach(() => {
        reducedMotion.enabled = false;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T0 + 42_000));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('leaves a finishing agent where it finished for the dwell, then travels once', async () => {
        const alpha = entry({ id: 'alpha', title: 'Alpha', status: 'running' });
        const roster = [alpha, entry({ id: 'beta', status: 'running', startedAtMs: T0 + 1 })];
        const screen = await renderScreen(<AgentActivityList testID="roster" entries={roster} />);

        const working = layoutSignature(screen);
        expect(working).toBe('section:working > row:alpha > row:beta');

        await screen.update(
            <AgentActivityList testID="roster" entries={[finished(alpha, Date.now()), roster[1]!]} />,
        );
        // The settle happens in the status column; the row itself must not move on the same commit.
        expect(layoutSignature(screen)).toBe(working);

        await advance(DWELL_MS - 1);
        expect(layoutSignature(screen)).toBe(working);

        await advance(1);
        expect(layoutSignature(screen)).toBe(
            'section:working > row:beta > section:finished > row:alpha',
        );
        // It travelled; it did not arrive. An entrance here would read as the agent being replaced
        // by a different one at the moment it succeeded.
        expect(motionWrapper(screen, 'alpha')?.props.entering).toBeUndefined();
        // The section heading it travelled to IS new, and moves with the same reflow rather than
        // popping in ahead of the row that caused it.
        expect(motionWrapper(screen, 'section:finished')?.props.layout).toBeDefined();

        await screen.unmount();
    });

    it('turns six agents finishing across 400 ms into ONE reflow, not six', async () => {
        const keeper = entry({ id: 'keeper', status: 'running' });
        const finishing = Array.from({ length: 6 }, (_, index) => entry({
            id: `agent-${index}`,
            status: 'running',
            startedAtMs: T0 + index + 1,
        }));
        let roster: AgentActivityRowEntry[] = [keeper, ...finishing];

        const screen = await renderScreen(<AgentActivityList testID="roster" entries={roster} />);
        const signatures = [layoutSignature(screen)];

        for (const [index, agent] of finishing.entries()) {
            if (index > 0) {
                await advance(80);
                signatures.push(layoutSignature(screen));
            }
            roster = roster.map((row) => (row.id === agent.id ? finished(agent, Date.now()) : row));
            await screen.update(<AgentActivityList testID="roster" entries={roster} />);
            signatures.push(layoutSignature(screen));
        }

        // Well past the last dwell (400 + 900) and the batch ceiling (0 + 900 + 1200).
        for (let elapsed = 0; elapsed < 3_000; elapsed += 50) {
            await advance(50);
            signatures.push(layoutSignature(screen));
        }

        const reflows = dedupeConsecutive(signatures);
        expect(reflows).toHaveLength(2);
        expect(reflows[1]).toBe(
            'section:working > row:keeper > section:finished'
            + ' > row:agent-5 > row:agent-4 > row:agent-3'
            + ' > row:agent-2 > row:agent-1 > row:agent-0',
        );

        await screen.unmount();
    });

    it('defers the migration while the list is being scrolled, then commits once it settles', async () => {
        const quiet = createListMotionQuiet();
        const alpha = entry({ id: 'alpha', status: 'running' });
        const roster = [alpha, entry({ id: 'beta', status: 'running', startedAtMs: T0 + 1 })];
        const screen = await renderScreen(
            <AgentActivityList testID="roster" entries={roster} motionQuiet={quiet} />,
        );
        const working = layoutSignature(screen);

        await screen.update(
            <AgentActivityList
                testID="roster"
                entries={[finished(alpha, Date.now()), roster[1]!]}
                motionQuiet={quiet}
            />,
        );

        // A flick that outlasts the dwell and the batch ceiling several times over.
        for (let elapsed = 0; elapsed < DWELL_MS + BATCH_CEILING_MS + 1_000; elapsed += 100) {
            quiet.reportScrollActivity();
            await advance(100);
        }
        expect(layoutSignature(screen)).toBe(working);

        // The finger lifts. Nothing re-renders on its own, so the commit has to come from the
        // quiet window telling the batch it may go.
        await advance(1_000);
        expect(layoutSignature(screen)).toBe(
            'section:working > row:beta > section:finished > row:alpha',
        );

        await screen.unmount();
    });

    it('defers while a pointer rests on the list, and commits when it leaves', async () => {
        const alpha = entry({ id: 'alpha', status: 'running' });
        const roster = [alpha, entry({ id: 'beta', status: 'running', startedAtMs: T0 + 1 })];
        const screen = await renderScreen(<AgentActivityList testID="roster" entries={roster} />);
        const working = layoutSignature(screen);

        act(() => {
            screen.findHostByTestId('roster')?.props.onPointerEnter?.();
        });
        await screen.update(
            <AgentActivityList testID="roster" entries={[finished(alpha, Date.now()), roster[1]!]} />,
        );
        await advance(DWELL_MS + BATCH_CEILING_MS + 1_000);
        // Reflowing under a resting cursor turns the next click into a click on a different agent.
        expect(layoutSignature(screen)).toBe(working);

        await act(async () => {
            screen.findHostByTestId('roster')?.props.onPointerLeave?.();
        });
        expect(layoutSignature(screen)).toBe(
            'section:working > row:beta > section:finished > row:alpha',
        );

        await screen.unmount();
    });

    it('carries the reflow on the shared `reflow` spring, and drops it under reduced motion', async () => {
        const roster = [entry({ id: 'alpha', status: 'running' })];
        const screen = await renderScreen(<AgentActivityList testID="roster" entries={roster} />);

        const layout = motionWrapper(screen, 'alpha')?.props.layout;
        expect(layout).toBeDefined();
        // The physics come from `resolveMotionSpring('reflow')`; a second table here would be the
        // split-brain the role-named vocabulary exists to prevent. `type: 'spring'` matters as
        // much as the numbers: without `.springify()` the builder ignores all three.
        expect(layout).toMatchObject({
            presetName: 'LinearTransition',
            type: 'spring',
            stiffnessV: 256,
            dampingV: 32,
            massV: 1,
        });
        await screen.unmount();

        reducedMotion.enabled = true;
        const still = await renderScreen(<AgentActivityList testID="roster" entries={roster} />);
        expect(motionWrapper(still, 'alpha')?.props.layout).toBeUndefined();
        await still.unmount();
    });

    it('still holds the dwell and keeps the clock running under reduced motion', async () => {
        reducedMotion.enabled = true;
        const alpha = entry({ id: 'alpha', status: 'running' });
        const roster = [alpha, entry({ id: 'beta', status: 'running', startedAtMs: T0 + 1 })];
        const screen = await renderScreen(<AgentActivityList testID="roster" entries={roster} />);
        const working = layoutSignature(screen);
        expect(elapsedText(screen, 'beta')).toBe('0:41');

        await screen.update(
            <AgentActivityList testID="roster" entries={[finished(alpha, Date.now()), roster[1]!]} />,
        );
        // Reduced motion removes the travel, not the courtesy of finishing where you were watching.
        await advance(DWELL_MS - 1);
        expect(layoutSignature(screen)).toBe(working);

        await advance(1);
        expect(layoutSignature(screen)).toBe(
            'section:working > row:beta > section:finished > row:alpha',
        );

        // The still-running agent's clock never stopped — reduced motion drops it to the calmer
        // 60 s cadence rather than freezing it, which is what keeps the row from going quiet.
        await advance(60_000);
        expect(elapsedText(screen, 'beta')).toMatch(/^1:\d{2}$/);

        await screen.unmount();
    });

    it('repositions immediately and animates nothing when the pane is not being animated', async () => {
        const alpha = entry({ id: 'alpha', status: 'running' });
        const roster = [alpha, entry({ id: 'beta', status: 'running', startedAtMs: T0 + 1 })];
        const screen = await renderScreen(
            <AgentActivityList testID="roster" entries={roster} animationEnabled={false} />,
        );

        await screen.update(
            <AgentActivityList
                testID="roster"
                entries={[finished(alpha, Date.now()), roster[1]!]}
                animationEnabled={false}
            />,
        );
        // Nobody is watching an off-screen pane, so holding the row would only guarantee a reflow
        // the moment it comes back.
        expect(layoutSignature(screen)).toBe(
            'section:working > row:beta > section:finished > row:alpha',
        );
        expect(motionWrapper(screen, 'beta')?.props.layout).toBeUndefined();

        await screen.unmount();
    });

    it('animates in a genuinely new row, and never replays an entrance for one already rendered', async () => {
        const alpha = entry({ id: 'alpha', status: 'running' });
        const screen = await renderScreen(<AgentActivityList testID="roster" entries={[alpha]} />);

        // The roster a pane opens with is not "arriving"; fading forty rows in on open is the
        // wasted animation this gate exists to prevent.
        expect(motionWrapper(screen, 'alpha')?.props.entering).toBeUndefined();

        const beta = entry({ id: 'beta', status: 'running', startedAtMs: T0 + 1 });
        await screen.update(<AgentActivityList testID="roster" entries={[alpha, beta]} />);

        expect(motionWrapper(screen, 'beta')?.props.entering).toBeDefined();
        expect(motionWrapper(screen, 'alpha')?.props.entering).toBeUndefined();

        await screen.update(<AgentActivityList testID="roster" entries={[alpha, beta]} />);
        expect(motionWrapper(screen, 'beta')?.props.entering).toBeUndefined();

        await screen.unmount();
    });

    it('leaves an agent that stops on a permission prompt exactly where it is', async () => {
        const alpha = entry({ id: 'alpha', status: 'running' });
        const roster = [alpha, entry({ id: 'beta', status: 'running', startedAtMs: T0 + 1 })];
        const screen = await renderScreen(<AgentActivityList testID="roster" entries={roster} />);

        await screen.update(
            <AgentActivityList
                testID="roster"
                entries={[{ ...alpha, status: 'waiting' }, roster[1]!]}
            />,
        );

        // The dwell is a courtesy owed to work that is over, and `waiting` is not over: the row
        // stays in WORKING in its start order, so nothing moves under the reader at all. There is
        // no section for it to be pinned to any more.
        expect(layoutSignature(screen)).toBe(
            'section:working > row:alpha > row:beta',
        );

        await screen.unmount();
    });
});
