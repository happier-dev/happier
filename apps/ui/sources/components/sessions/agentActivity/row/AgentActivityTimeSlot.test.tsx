import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const preferenceRef = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => preferenceRef.reducedMotion,
}));

const START_MS = Date.parse('2026-05-12T00:00:00.000Z');

async function advance(ms: number) {
    await act(async () => {
        vi.advanceTimersByTime(ms);
    });
}

/**
 * The elapsed column is the datum that makes a person act — how long an agent has been running, and
 * how long one has been waiting for them. Two properties decide whether it is trustworthy: it must
 * move while the work is live, and it must stop the moment the work is not.
 */
describe('AgentActivityTimeSlot', () => {
    beforeEach(() => {
        preferenceRef.reducedMotion = false;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(START_MS + 42_000));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('ticks a live entry on the shared clock', async () => {
        const { AgentActivityTimeSlot } = await import('./AgentActivityTimeSlot');
        const screen = await renderScreen(
            <AgentActivityTimeSlot startedAtMs={START_MS} testID="time" />,
        );

        expect(screen.getTextContent()).toContain('0:42');
        await advance(3_000);
        expect(screen.getTextContent()).toContain('0:45');

        await screen.unmount();
    });

    it('freezes a finished entry at its total instead of counting past it', async () => {
        const { AgentActivityTimeSlot } = await import('./AgentActivityTimeSlot');
        const screen = await renderScreen(
            <AgentActivityTimeSlot startedAtMs={START_MS} endedAtMs={START_MS + 12_000} testID="time" />,
        );

        expect(screen.getTextContent()).toContain('0:12');
        await advance(30_000);
        // A succeeded agent whose clock keeps running is a lie about liveness, and 24 of them on a
        // FINISHED section would each wake the JS thread once a second to tell it.
        expect(screen.getTextContent()).toContain('0:12');

        await screen.unmount();
    });

    it('renders nothing when no start is known, rather than a fake 0:00', async () => {
        const { AgentActivityTimeSlot } = await import('./AgentActivityTimeSlot');
        const screen = await renderScreen(<AgentActivityTimeSlot testID="time" />);

        // Nothing at all — not an empty text node holding a column open.
        expect(screen.tree.toJSON()).toBeNull();

        await screen.unmount();
    });

    it('drops to a calm cadence under reduced motion instead of ticking every second', async () => {
        preferenceRef.reducedMotion = true;
        const { AgentActivityTimeSlot } = await import('./AgentActivityTimeSlot');
        const screen = await renderScreen(
            <AgentActivityTimeSlot startedAtMs={START_MS} testID="time" />,
        );

        expect(screen.getTextContent()).toContain('0:42');
        // Three seconds in, a one-second consumer would already read 0:45.
        await advance(3_000);
        expect(screen.getTextContent()).toContain('0:42');
        // The minute bucket fires at t=60s, so the value jumps a whole minute at once.
        await advance(57_000);
        expect(screen.getTextContent()).toContain('1:42');

        await screen.unmount();
    });

    it('carries its own accessible name so the row label never has to interpolate the clock', async () => {
        const { AgentActivityTimeSlot } = await import('./AgentActivityTimeSlot');
        const live = await renderScreen(<AgentActivityTimeSlot startedAtMs={START_MS} testID="time" />);

        const label = String(live.findByTestId('time')?.props.accessibilityLabel ?? '');
        expect(label).toContain('0:42');
        // A label that re-announces on every tick is worse than no label; the slot is not a live
        // region, and `WorkflowRunHeader` already sets this precedent for the same reason.
        expect(live.findByTestId('time')?.props.accessibilityLiveRegion).toBe('none');
        await live.unmount();

        const done = await renderScreen(
            <AgentActivityTimeSlot startedAtMs={START_MS} endedAtMs={START_MS + 12_000} testID="time" />,
        );
        const doneLabel = String(done.findByTestId('time')?.props.accessibilityLabel ?? '');
        expect(doneLabel).toContain('0:12');
        expect(doneLabel).not.toBe(label);
        await done.unmount();
    });

    it('reserves a fixed width so a ticking value cannot shift the row', async () => {
        const { AGENT_TIME_SLOT_MIN_PX } = await import('./agentRowMetrics');
        const { AgentActivityTimeSlot } = await import('./AgentActivityTimeSlot');
        const screen = await renderScreen(
            <AgentActivityTimeSlot startedAtMs={START_MS} testID="time" />,
        );

        const style = Object.assign({}, ...[screen.findByTestId('time')?.props.style].flat().filter(Boolean));
        expect(style.minWidth).toBe(AGENT_TIME_SLOT_MIN_PX);
        expect(style.fontVariant).toEqual(['tabular-nums']);

        await screen.unmount();
    });
});
