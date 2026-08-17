import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    readReanimatedFrameCallbacks,
    resetReanimatedFrameCallbacks,
} from '@/dev/testkit/mocks/reanimated';

import {
    VoiceEnergyProvider,
    useVoiceEnergy,
    useVoiceEnergyPresence,
    type VoiceEnergy,
    type VoiceEnergyState,
} from './useVoiceEnergy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

const LISTENING: VoiceEnergyState = { luminosity: 0.62, energized: true, direction: 'inward' };
const ERROR: VoiceEnergyState = { luminosity: 0.3, energized: false, direction: 'none' };

const probe = { renders: 0 };

/**
 * Memoized on purpose: a consumer of the presence context must re-render only
 * when that context's value changes. Publishing the consumer *count* instead of
 * a boolean would re-render every Voice surface on any mount, which is the
 * failure this probe exists to catch.
 */
const PresenceProbe = React.memo(function PresenceProbe(): null {
    useVoiceEnergyPresence();
    probe.renders += 1;
    return null;
});

/** A Voice surface: present while mounted, gone when it unmounts. */
function VisibleConsumer(): null {
    const presence = useVoiceEnergyPresence();
    React.useEffect(() => {
        presence.acquire();
        return () => presence.release();
    }, [presence]);
    return null;
}

let extraPresence: { acquire: () => void; release: () => void } | null = null;

function PresenceHandle(): null {
    extraPresence = useVoiceEnergyPresence();
    return null;
}

function frameActivations(): readonly boolean[] {
    const records = readReanimatedFrameCallbacks();
    expect(records).toHaveLength(1);
    return records[0]!.setActiveCalls;
}

describe('VoiceEnergyProvider activation', () => {
    let tree: renderer.ReactTestRenderer | null = null;

    beforeEach(() => {
        resetReanimatedFrameCallbacks();
        probe.renders = 0;
        extraPresence = null;
    });

    afterEach(() => {
        act(() => {
            tree?.unmount();
        });
        tree = null;
    });

    function render(node: React.ReactElement): void {
        act(() => {
            tree = renderer.create(node);
        });
    }

    function update(node: React.ReactElement): void {
        act(() => {
            tree!.update(node);
        });
    }

    function scene(consumers: number, attemptActive = true): React.ReactElement {
        return (
            <VoiceEnergyProvider
                state={LISTENING}
                activation={{ providerReady: true, attemptActive, micCaptureActive: attemptActive }}
            >
                <PresenceProbe />
                <PresenceHandle />
                {Array.from({ length: consumers }, (_, index) => <VisibleConsumer key={index} />)}
            </VoiceEnergyProvider>
        );
    }

    it('stays still while a visible surface has nothing to animate about', () => {
        // §2.4a: enabled but idle is *motionless*. Without the liveness clause a
        // mounted, visible, motion-allowed surface would drive a 60 Hz loop all
        // day, and no screenshot would ever show it.
        render(scene(1, false));
        expect(frameActivations()).toEqual([false]);
    });

    it('runs the clock only while at least one surface is mounted', () => {
        render(scene(0));
        expect(frameActivations()).toEqual([false]);

        update(scene(1));
        expect(frameActivations()).toEqual([false, true]);

        // A second surface must not retrigger activation, and must not re-render
        // the surfaces that were already mounted.
        const rendersAfterFirst = probe.renders;
        update(scene(2));
        expect(frameActivations()).toEqual([false, true]);
        expect(probe.renders).toBe(rendersAfterFirst);

        // Losing one of two keeps the conversation on screen.
        update(scene(1));
        expect(frameActivations()).toEqual([false, true]);

        update(scene(0));
        expect(frameActivations()).toEqual([false, true, false]);

        // A surface that mounts again reactivates it.
        update(scene(1));
        expect(frameActivations()).toEqual([false, true, false, true]);
    });

    it('cannot underflow on a duplicate or unbalanced release', () => {
        render(scene(1));
        expect(frameActivations()).toEqual([false, true]);

        act(() => {
            extraPresence!.release();
            extraPresence!.release();
        });
        expect(frameActivations()).toEqual([false, true, false]);

        // The mounted consumer's own release lands on an already-empty count. A
        // count that went negative here would never reach 1 again, and the next
        // surface would mount into a dead clock.
        update(scene(0));
        expect(frameActivations()).toEqual([false, true, false]);

        update(scene(1));
        expect(frameActivations()).toEqual([false, true, false, true]);
    });

    it('stays still while the Voice provider is off', () => {
        render(
            <VoiceEnergyProvider
                state={LISTENING}
                activation={{ providerReady: false, attemptActive: true, micCaptureActive: true }}
            >
                <VisibleConsumer />
            </VoiceEnergyProvider>,
        );
        expect(frameActivations()).toEqual([false]);
    });

    it('stays still while a frozen preview is pinned', () => {
        render(
            <VoiceEnergyProvider
                state={LISTENING}
                activation={{ providerReady: true, attemptActive: true, micCaptureActive: true }}
                previewTimeMs={1_100}
            >
                <VisibleConsumer />
            </VoiceEnergyProvider>,
        );
        expect(frameActivations()).toEqual([false]);
    });

    it('leaves a pinned preview pose alone instead of settling it to zero', () => {
        // A stopped clock settles the amplitude terms to still (§2.4a), and a
        // frozen preview also has a stopped clock — but its pose is resolved
        // during render and must survive. Without the exclusion the settle
        // lands on the same commit and zeroes it, which would quietly turn the
        // golden fidelity frame into a snapshot of nothing happening.
        let observed: VoiceEnergy | null = null;
        function EnergyProbe(): null {
            observed = useVoiceEnergy();
            return null;
        }
        render(
            <VoiceEnergyProvider
                state={LISTENING}
                activation={{ providerReady: true, attemptActive: true, micCaptureActive: true }}
                previewTimeMs={1_100}
            >
                <EnergyProbe />
            </VoiceEnergyProvider>,
        );
        expect(observed!.level.get()).toBeGreaterThan(0);
        expect(observed!.flow.get()).toBe(-1);
        expect(observed!.clock.get()).toBeCloseTo(1.1);
    });

    it('reaches the resting luminosity of a terminal state after the frame clock stops', () => {
        let observed: VoiceEnergy | null = null;
        function EnergyProbe(): null {
            observed = useVoiceEnergy();
            return null;
        }
        function terminalScene(state: VoiceEnergyState, attemptActive: boolean): React.ReactElement {
            return (
                <VoiceEnergyProvider
                    state={state}
                    activation={{ providerReady: true, attemptActive, micCaptureActive: false }}
                >
                    <EnergyProbe />
                    <VisibleConsumer />
                </VoiceEnergyProvider>
            );
        }

        render(terminalScene(LISTENING, true));
        expect(observed!.luminosity.get()).toBe(LISTENING.luminosity);

        update(terminalScene(ERROR, false));
        expect(frameActivations().at(-1)).toBe(false);
        // Stopping the single frame callback must not freeze the last live
        // state's brightness over a visible error/idle presence.
        expect(observed!.luminosity.get()).toBe(ERROR.luminosity);
    });
});
