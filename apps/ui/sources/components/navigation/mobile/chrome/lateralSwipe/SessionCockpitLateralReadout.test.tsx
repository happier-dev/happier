import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { buildSessionNavigationCursor } from '@/sync/domains/session/navigation/sessionNavigationCursor';
import {
    publishSessionNavigationCursor,
    resetSessionNavigationCursorForTests,
} from '@/sync/domains/session/navigation/sessionNavigationCursorStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionNamesState = vi.hoisted(() => ({
    bySessionId: {} as Record<string, string>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: ({ children, ...props }: any) => React.createElement('View', props, children),
    });
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    getCurrentAuth: () => null,
}));

vi.mock('expo-router', () => createExpoRouterMock({}).module);

// The neighbour hook reads metadata imperatively (it runs in a host mounted on every route,
// so it must not hold a subscription per render). Seed the store the same way production reads it.
vi.mock('@/sync/domains/state/storage', () => createStorageModuleStub({
    storage: {
        getState: () => ({
            sessions: Object.fromEntries(
                Object.entries(sessionNamesState.bySessionId).map(([sessionId, name]) => [
                    sessionId,
                    { metadata: { name } },
                ]),
            ),
        }),
    },
}));

function publishVisibleSessionOrder(sessionIds: readonly string[]): void {
    const cursor = buildSessionNavigationCursor({
        identity: { origin: 'session-list', sourceScopeKey: 'all', storageKind: 'all' },
        items: sessionIds.map((sessionId) => ({ type: 'session', session: { id: sessionId } })),
        nowMs: 1_000,
    });
    if (!cursor) throw new Error('test setup: cursor needs at least two sessions');
    publishSessionNavigationCursor(cursor);
}

type Harness = {
    progress?: { value: number };
    picker?: {
        direction: { value: 'previous' | 'next' | null };
        browseProgress: { value: number };
        rowOffset: { value: number };
        index: { value: number };
    };
    rerender?: () => void;
};

/**
 * Puts the shared values where a real gesture would. The capsule names what the gesture
 * has SELECTED, and the gesture always publishes the locked direction and the selected
 * index alongside the travel — so driving `progress` on its own would describe a state
 * production never produces.
 */
function steerTo(harness: Harness, direction: 'previous' | 'next', progress: number, index = 1): void {
    harness.progress!.value = progress;
    harness.picker!.direction.value = direction;
    harness.picker!.index.value = index;
    harness.rerender!();
}

async function renderReadout(sessionId: string) {
    const harness: Harness = {};
    const { SessionCockpitLateralReadout } = await import('./SessionCockpitLateralReadout');
    const { SessionCockpitChromeRegistryProvider, useSessionLateralSwipe } = await import(
        '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry'
    );

    function ReadoutHarness() {
        const swipe = useSessionLateralSwipe();
        // Remount on demand: the readout is memoised and reads progress from a shared
        // value, so a node test has to re-run its reaction explicitly.
        const [tick, force] = React.useReducer((current: number) => current + 1, 0);
        harness.progress = swipe.progress;
        harness.picker = swipe.picker as Harness['picker'];
        harness.rerender = force;
        return <SessionCockpitLateralReadout key={tick} sessionId={sessionId} />;
    }

    const screen = await renderScreen(
        <SessionCockpitChromeRegistryProvider>
            <ReadoutHarness />
        </SessionCockpitChromeRegistryProvider>,
    );
    return { harness, screen };
}

describe('SessionCockpitLateralReadout', () => {
    afterEach(() => {
        standardCleanup();
        resetSessionNavigationCursorForTests();
        sessionNamesState.bySessionId = {};
    });

    it('adds no resting pixels to the capsule', async () => {
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
        const { screen } = await renderReadout('session-1');

        expect(screen.findAllHostsByTestId('session-cockpit-lateral-readout')).toHaveLength(0);
    });

    it('names the destination and its place in the captured order while the finger travels', async () => {
        sessionNamesState.bySessionId = { 'session-2': 'Refactor the parser' };
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
        const { harness, screen } = await renderReadout('session-1');

        act(() => {
            // Negative progress travels toward the NEXT session.
            steerTo(harness, 'next', -0.6);
        });

        expect(screen.findByTestId('session-cockpit-lateral-readout-title')?.props.children)
            .toBe('Refactor the parser');
        expect(screen.getTextContent()).toContain('3 of 3');
    });

    it('names the previous session when the finger travels the other way', async () => {
        sessionNamesState.bySessionId = { 'session-0': 'Fix the flaky test' };
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
        const { harness, screen } = await renderReadout('session-1');

        act(() => {
            steerTo(harness, 'previous', 0.6);
        });

        expect(screen.findByTestId('session-cockpit-lateral-readout-title')?.props.children)
            .toBe('Fix the flaky test');
        expect(screen.getTextContent()).toContain('1 of 3');
    });

    it('overlays the tab row absolutely so the capsule cannot resize mid-gesture', async () => {
        sessionNamesState.bySessionId = { 'session-2': 'Refactor the parser' };
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
        const { harness, screen } = await renderReadout('session-1');

        act(() => {
            steerTo(harness, 'next', -0.6);
        });

        const readout = screen.findHostByTestId('session-cockpit-lateral-readout');
        const styles = (Array.isArray(readout?.props.style) ? readout?.props.style : [readout?.props.style])
            .filter((style): style is Record<string, unknown> => Boolean(style) && typeof style === 'object');
        expect(styles.some((style) => style.position === 'absolute')).toBe(true);
        expect(readout?.props.pointerEvents).toBe('none');
    });

    it('promises nothing while rubber-banding against an end of the order', async () => {
        publishVisibleSessionOrder(['session-0', 'session-1']);
        const { harness, screen } = await renderReadout('session-1');

        act(() => {
            // At the last entry a further left-drag has no destination to name, so the
            // gesture locks the direction with nothing selected.
            steerTo(harness, 'next', -0.12, 0);
        });

        expect(screen.findAllHostsByTestId('session-cockpit-lateral-readout')).toHaveLength(0);
    });

    it('names the scrubbed row, not the immediate neighbour, once the picker is open', async () => {
        sessionNamesState.bySessionId = {
            'session-2': 'Refactor the parser',
            'session-3': 'Ship the release notes',
        };
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3']);
        const { harness, screen } = await renderReadout('session-1');

        act(() => {
            // Two rows into the picker: the capsule IS the picker's selection window, so
            // it must name the row that has descended into it.
            harness.picker!.browseProgress.value = 1;
            harness.picker!.rowOffset.value = 1;
            steerTo(harness, 'next', -0.2, 2);
        });

        expect(screen.findByTestId('session-cockpit-lateral-readout-title')?.props.children)
            .toBe('Ship the release notes');
        expect(screen.getTextContent()).toContain('4 of 4');
    });
});
