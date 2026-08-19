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

import { SESSION_LATERAL_PICKER_ROW_PITCH_PX, resolveSessionLateralPickerFrame } from './sessionLateralPickerState';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionNamesState = vi.hoisted(() => ({
    bySessionId: {} as Record<string, string>,
}));
const reducedMotionState = vi.hoisted(() => ({
    value: false,
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

// The scrim is a shared primitive with its own suite; here it only has to prove that the
// picker hands it the browse progress and never grows it by animating its bounds.
vi.mock('@/components/ui/overlays/OverlayScrim', () => ({
    OverlayScrim: (props: Record<string, unknown>) => React.createElement('OverlayScrim', props),
    OVERLAY_SCRIM_RAMP_HEIGHT: 88,
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.value,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    getCurrentAuth: () => null,
}));

vi.mock('expo-router', () => createExpoRouterMock({}).module);

// The picker resolves session metadata imperatively, once per direction lock, because it
// lives in chrome mounted on every route. Seed the store the way production reads it.
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
    picker?: {
        direction: { value: 'previous' | 'next' | null };
        browseProgress: { value: number };
        rowOffset: { value: number };
        index: { value: number };
    };
    rerender?: () => void;
};

async function renderPicker(sessionId: string) {
    const harness: Harness = {};
    const { SessionCockpitLateralPicker } = await import('./SessionCockpitLateralPicker');
    const { SessionCockpitChromeRegistryProvider, useSessionLateralSwipe } = await import(
        '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry'
    );

    function PickerHarness() {
        const swipe = useSessionLateralSwipe();
        // The rows read their position from shared values, which a node test cannot make
        // tick on their own, so the harness re-runs the styles explicitly.
        const [tick, force] = React.useReducer((current: number) => current + 1, 0);
        harness.picker = swipe.picker as Harness['picker'];
        harness.rerender = force;
        return <SessionCockpitLateralPicker key={tick} sessionId={sessionId} />;
    }

    const screen = await renderScreen(
        <SessionCockpitChromeRegistryProvider>
            <PickerHarness />
        </SessionCockpitChromeRegistryProvider>,
    );
    return { harness, screen };
}

/**
 * Opens the picker the way the GESTURE does — from a raw horizontal sign — instead of by
 * writing the locked direction in by hand.
 *
 * `openPicker` below sets `direction` directly, and the host suite mocks this component out
 * entirely, so between them nothing exercised "real translationX sign -> real rows". That gap
 * is exactly where a sign inversion hides.
 */
function openPickerByGesture(
    harness: Harness,
    params: Readonly<{ translationX: number; translationY: number; available: number }>,
): void {
    const frame = resolveSessionLateralPickerFrame({
        translationX: params.translationX,
        translationY: params.translationY,
        availablePrevious: params.available,
        availableNext: params.available,
        lockedDirection: harness.picker!.direction.value,
    });
    harness.picker!.direction.value = frame.direction;
    harness.picker!.browseProgress.value = frame.browseProgress;
    harness.picker!.rowOffset.value = frame.rowOffset;
    harness.picker!.index.value = frame.index;
    harness.rerender!();
}

function openPicker(harness: Harness, direction: 'previous' | 'next', rowOffset: number): void {
    harness.picker!.direction.value = direction;
    harness.picker!.browseProgress.value = 1;
    harness.picker!.rowOffset.value = rowOffset;
    harness.picker!.index.value = 1 + Math.floor(rowOffset);
    harness.rerender!();
}

/** The flattened animated style a row ended up with. */
function readRowStyle(node: { props: { style?: unknown } } | undefined): Record<string, any> {
    const styles = (Array.isArray(node?.props.style) ? node?.props.style : [node?.props.style])
        .filter((style): style is Record<string, unknown> => Boolean(style) && typeof style === 'object');
    return Object.assign({}, ...styles);
}

function readRowTranslateY(node: { props: { style?: unknown } } | undefined): number {
    const transform = readRowStyle(node).transform as Array<{ translateY?: number }> | undefined;
    return transform?.find((entry) => typeof entry.translateY === 'number')?.translateY ?? Number.NaN;
}

describe('SessionCockpitLateralPicker', () => {
    afterEach(() => {
        standardCleanup();
        resetSessionNavigationCursorForTests();
        sessionNamesState.bySessionId = {};
        reducedMotionState.value = false;
    });

    it('adds no resting pixels above the band', async () => {
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3']);
        const { screen } = await renderPicker('session-1');

        // The overlay is always mounted, the way `TreeDropOverlay` is, and paints nothing
        // until the gesture opens it.
        expect(screen.findAllHostsByTestId('session-cockpit-lateral-picker')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('session-cockpit-lateral-picker-row')).toHaveLength(0);
        const root = screen.findHostByTestId('session-cockpit-lateral-picker');
        expect(root?.props.pointerEvents).toBe('none');
        // It exists only under a finger, so its rows must never become focus stops. The
        // non-gesture equivalent rides the cockpit tabs and is unaffected.
        expect(root?.props.accessibilityElementsHidden).toBe(true);
        expect(root?.props.importantForAccessibility).toBe('no-hide-descendants');
    });

    it('lists the sessions FURTHER in the locked direction, never the one already in the capsule', async () => {
        sessionNamesState.bySessionId = {
            'session-2': 'In the capsule',
            'session-3': 'One further',
            'session-4': 'Two further',
        };
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3', 'session-4']);
        const { harness, screen } = await renderPicker('session-1');

        act(() => {
            openPicker(harness, 'next', 0);
        });

        const text = screen.getTextContent();
        expect(text).toContain('One further');
        expect(text).toContain('Two further');
        // The immediate neighbour is what the capsule readout is already naming; a copy
        // of it above the bar would be the same session drawn twice.
        expect(text).not.toContain('In the capsule');
    });


    it('lists the sessions AFTER the anchor when the finger actually swiped right-to-left', async () => {
        // Driven from a raw negative translationX rather than a hand-set direction: right-to-left
        // is "next", so the column must name the sessions further DOWN the captured order.
        sessionNamesState.bySessionId = {
            'session-0': 'Two back',
            'session-1': 'One back',
            'session-2': 'Anchor',
            'session-3': 'In the capsule',
            'session-4': 'One further',
            'session-5': 'Two further',
        };
        publishVisibleSessionOrder([
            'session-0', 'session-1', 'session-2', 'session-3', 'session-4', 'session-5',
        ]);
        const { harness, screen } = await renderPicker('session-2');

        act(() => {
            openPickerByGesture(harness, { translationX: -80, translationY: -60, available: 3 });
        });

        const text = screen.getTextContent();
        expect(text).toContain('One further');
        expect(text).not.toContain('One back');
        expect(text).not.toContain('Two back');
    });

    it('lists the other direction when that is the one the finger locked', async () => {
        sessionNamesState.bySessionId = {
            'session-0': 'Two back',
            'session-1': 'One back',
            'session-4': 'Ahead',
        };
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3', 'session-4']);
        const { harness, screen } = await renderPicker('session-3');

        act(() => {
            openPicker(harness, 'previous', 0);
        });

        expect(screen.getTextContent()).toContain('Two back');
        expect(screen.getTextContent()).not.toContain('Ahead');
    });

    it('descends the selected row into the capsule and shifts the list down behind it', async () => {
        sessionNamesState.bySessionId = {
            'session-3': 'One further',
            'session-4': 'Two further',
        };
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3', 'session-4']);
        const { harness, screen } = await renderPicker('session-1');

        act(() => {
            openPicker(harness, 'next', 0);
        });
        const [restingFirst, restingSecond] = screen.findAllHostsByTestId('session-cockpit-lateral-picker-row');
        expect(readRowTranslateY(restingFirst)).toBe(-SESSION_LATERAL_PICKER_ROW_PITCH_PX);
        expect(readRowTranslateY(restingSecond)).toBe(-2 * SESSION_LATERAL_PICKER_ROW_PITCH_PX);
        expect(readRowStyle(restingFirst).opacity).toBe(1);

        act(() => {
            openPicker(harness, 'next', 1);
        });
        const [arrivedFirst, arrivedSecond] = screen.findAllHostsByTestId('session-cockpit-lateral-picker-row');
        // The row the selection reached now sits exactly where the capsule is, dissolved
        // into it, and its neighbour has taken the slot it left.
        expect(readRowTranslateY(arrivedFirst)).toBe(0);
        expect(readRowStyle(arrivedFirst).opacity).toBe(0);
        expect(readRowTranslateY(arrivedSecond)).toBe(-SESSION_LATERAL_PICKER_ROW_PITCH_PX);
    });

    it('drives the scrim by opacity alone, never by growing it', async () => {
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3']);
        const { harness, screen } = await renderPicker('session-1');

        const scrim = screen.tree.findByType('OverlayScrim' as never);
        // The scrim is laid out once at full size and only faded: `expo-blur` allocates a
        // fresh animator per intensity write and `MaskedView` re-rasterises per mask
        // invalidation, so an overlay that grew under a finger would re-rasterise per frame.
        expect(scrim.props.progress).toBe(harness.picker!.browseProgress);
        expect(scrim.props.style).toBeUndefined();
    });

    it('still lists and still selects under reduced motion, without the opening travel', async () => {
        reducedMotionState.value = true;
        sessionNamesState.bySessionId = { 'session-3': 'One further' };
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3', 'session-4']);
        const { harness, screen } = await renderPicker('session-1');

        act(() => {
            harness.picker!.direction.value = 'next';
            harness.picker!.browseProgress.value = 0.5;
            harness.picker!.rowOffset.value = 0;
            harness.picker!.index.value = 1;
            harness.rerender!();
        });

        const [row] = screen.findAllHostsByTestId('session-cockpit-lateral-picker-row');
        expect(screen.getTextContent()).toContain('One further');
        // Half-open, so the row is half-present — but it is already at its settled place
        // rather than rising into it. Reduced motion removes travel, never the capability.
        expect(readRowTranslateY(row)).toBe(-SESSION_LATERAL_PICKER_ROW_PITCH_PX);
        expect(readRowStyle(row).opacity).toBeCloseTo(0.5, 5);
    });

    it('has nothing to list when the captured order has no further sessions that way', async () => {
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
        const { harness, screen } = await renderPicker('session-1');

        act(() => {
            openPicker(harness, 'next', 0);
        });

        expect(screen.findAllHostsByTestId('session-cockpit-lateral-picker-row')).toHaveLength(0);
    });
});
