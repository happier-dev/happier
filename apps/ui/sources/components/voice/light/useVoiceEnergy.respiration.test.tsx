import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    readReanimatedFrameCallbacks,
    resetReanimatedFrameCallbacks,
    type ReanimatedFrameCallbackRecord,
} from '@/dev/testkit/mocks/reanimated';

import { ARRIVAL_SECONDS } from './arrivalGesture';
import {
    VoiceEnergyProvider,
    useVoiceEnergy,
    useVoiceEnergyPresence,
    type VoiceEnergy,
    type VoiceEnergyState,
} from './useVoiceEnergy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => motion.reduced,
}));

const LIVE: VoiceEnergyState = { luminosity: 0.62, energized: false, direction: 'none' };

const FRAME_MS = 1000 / 60;

let energy: VoiceEnergy | null = null;

function EnergyProbe(): null {
    energy = useVoiceEnergy();
    const presence = useVoiceEnergyPresence();
    React.useEffect(() => {
        presence.acquire();
        return () => presence.release();
    }, [presence]);
    return null;
}

/**
 * §2.4a, at the bus.
 *
 * The rendered contract is pinned by `voiceLightRespiration.test.tsx`; this
 * pins the two terms behind it over *time*, which a frozen frame cannot show:
 * that respiration eases rather than cuts, that the arrival gesture is spent on
 * the same clock every other term runs on (so it can never be burned off
 * screen), and that reduced motion stops respiration outright.
 */
describe('VoiceEnergyProvider respiration and arrival', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    let elapsedMs = 0;

    beforeEach(() => {
        resetReanimatedFrameCallbacks();
        motion.reduced = false;
        energy = null;
        elapsedMs = 0;
    });

    afterEach(() => {
        act(() => {
            tree?.unmount();
        });
        tree = null;
    });

    function scene(
        fields: Readonly<{ attemptActive: boolean; micCaptureActive: boolean }>,
    ): React.ReactElement {
        return (
            <VoiceEnergyProvider state={LIVE} activation={{ providerReady: true, ...fields }}>
                <EnergyProbe />
            </VoiceEnergyProvider>
        );
    }

    function render(fields: Readonly<{ attemptActive: boolean; micCaptureActive: boolean }>): void {
        act(() => {
            tree = renderer.create(scene(fields));
        });
    }

    function update(fields: Readonly<{ attemptActive: boolean; micCaptureActive: boolean }>): void {
        act(() => {
            tree!.update(scene(fields));
        });
    }

    function frameRecord(): ReanimatedFrameCallbackRecord {
        const records = readReanimatedFrameCallbacks();
        expect(records).toHaveLength(1);
        return records[0]!;
    }

    function runFrames(count: number): void {
        const record = frameRecord();
        for (let i = 0; i < count; i += 1) {
            elapsedMs += FRAME_MS;
            record.run({
                timestamp: elapsedMs,
                timeSincePreviousFrame: FRAME_MS,
                timeSinceFirstFrame: elapsedMs,
            });
        }
    }

    it('holds respiration at zero while the attempt is still acquiring the microphone', () => {
        render({ attemptActive: true, micCaptureActive: false });
        runFrames(120);

        expect(energy!.respiration.get()).toBe(0);
    });

    it('eases respiration in when capture goes live, rather than cutting it on', () => {
        render({ attemptActive: true, micCaptureActive: false });
        runFrames(30);
        update({ attemptActive: true, micCaptureActive: true });

        runFrames(3);
        const early = energy!.respiration.get();
        expect(early).toBeGreaterThan(0);
        // A hard cut would already be at 1 three frames in.
        expect(early).toBeLessThan(0.5);

        runFrames(120);
        expect(energy!.respiration.get()).toBeGreaterThan(0.95);
    });

    it('spends the arrival gesture on the clock, once, and then stays still', () => {
        render({ attemptActive: true, micCaptureActive: false });

        // Into the swell.
        runFrames(Math.round((ARRIVAL_SECONDS * 0.32 * 1000) / FRAME_MS));
        expect(energy!.arrival.get()).toBeGreaterThan(0.9);

        // Past the end of the gesture — a slow connect must not keep moving.
        runFrames(Math.round((ARRIVAL_SECONDS * 1000) / FRAME_MS) + 60);
        expect(energy!.arrival.get()).toBe(0);

        // And it does not restart while the same attempt keeps connecting.
        runFrames(300);
        expect(energy!.arrival.get()).toBe(0);
    });

    it('yields the arrival gesture to respiration when the microphone opens', () => {
        render({ attemptActive: true, micCaptureActive: false });
        runFrames(Math.round((ARRIVAL_SECONDS * 0.32 * 1000) / FRAME_MS));
        expect(energy!.arrival.get()).toBeGreaterThan(0.9);

        update({ attemptActive: true, micCaptureActive: true });
        runFrames(3);
        // Eased, not cut: three frames later it is on its way down, not gone.
        const easing = energy!.arrival.get();
        expect(easing).toBeGreaterThan(0);
        expect(easing).toBeLessThan(0.95);

        runFrames(120);
        expect(energy!.arrival.get()).toBe(0);
        expect(energy!.respiration.get()).toBeGreaterThan(0.95);
    });

    it('does not replay the arrival gesture when capture drops mid-conversation', () => {
        render({ attemptActive: true, micCaptureActive: true });
        runFrames(120);

        // Muting closes the capture source; the planet stops breathing, but the
        // conversation did not just start, so nothing "arrives" again.
        update({ attemptActive: true, micCaptureActive: false });
        runFrames(60);

        expect(energy!.arrival.get()).toBe(0);
        expect(energy!.respiration.get()).toBeLessThan(0.2);
    });

    it('settles respiration and the gesture to still when the attempt ends', () => {
        render({ attemptActive: true, micCaptureActive: true });
        runFrames(120);
        expect(energy!.respiration.get()).toBeGreaterThan(0.95);

        update({ attemptActive: false, micCaptureActive: false });

        // The clock stops here, so the settle cannot be a worklet term: the
        // shape would freeze mid-inhale for as long as the surface is on screen.
        expect(frameRecord().handle.isActive).toBe(false);
        expect(energy!.respiration.get()).toBe(0);
        expect(energy!.arrival.get()).toBe(0);
    });

    it('stops respiration outright under reduced motion', () => {
        // §9.2 — the accessibility floor, and the one gate that is a hard
        // requirement rather than an efficiency measure.
        motion.reduced = true;
        render({ attemptActive: true, micCaptureActive: true });

        expect(frameRecord().handle.isActive).toBe(false);
        expect(energy!.respiration.get()).toBe(0);
        expect(energy!.arrival.get()).toBe(0);
    });
});
