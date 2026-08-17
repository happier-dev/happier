import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    readReanimatedFrameCallbacks,
    resetReanimatedFrameCallbacks,
    type ReanimatedFrameCallbackRecord,
} from '@/dev/testkit/mocks/reanimated';
import {
    voiceRuntimeLevelStore,
    type VoiceRuntimeLevelWriter,
} from '@/voice/runtime/levels/voiceRuntimeLevelStore';

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
const ENDED: VoiceEnergyState = { luminosity: 0.18, energized: false, direction: 'none' };

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

function frameRecord(): ReanimatedFrameCallbackRecord {
    const records = readReanimatedFrameCallbacks();
    expect(records).toHaveLength(1);
    return records[0]!;
}

/** Feeds the store until its own ATTACK/RELEASE envelope has settled on `sample`. */
function drive(writer: VoiceRuntimeLevelWriter, sample: number, times = 24): void {
    // Opening or closing a source moves React state in the provider.
    act(() => {
        for (let i = 0; i < times; i += 1) writer.write(sample);
    });
}

describe('VoiceEnergyProvider audio bridge', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    let elapsedMs = 0;
    const writers: VoiceRuntimeLevelWriter[] = [];

    beforeEach(() => {
        resetReanimatedFrameCallbacks();
        energy = null;
        elapsedMs = 0;
    });

    afterEach(() => {
        act(() => {
            for (const writer of writers.splice(0)) writer.close();
            tree?.unmount();
        });
        tree = null;
    });

    function openWriter(channel: 'input' | 'output'): VoiceRuntimeLevelWriter {
        const writer = voiceRuntimeLevelStore.open({ channel, sourceId: `test-${channel}` });
        writers.push(writer);
        return writer;
    }

    function scene(attemptActive: boolean): React.ReactElement {
        return (
            <VoiceEnergyProvider
                state={attemptActive ? LISTENING : ENDED}
                activation={{ providerReady: true, attemptActive, micCaptureActive: attemptActive }}
                sourceActivity={voiceRuntimeLevelStore.getSourceActivitySnapshot()}
            >
                <EnergyProbe />
            </VoiceEnergyProvider>
        );
    }

    function mount(): void {
        act(() => {
            tree = renderer.create(scene(true));
        });
    }

    function endAttempt(): void {
        act(() => {
            tree!.update(scene(false));
        });
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

    it('drives the envelope from the real microphone channel, not a synthetic source', () => {
        const input = openWriter('input');
        mount();
        drive(input, 1);
        runFrames(90);

        // The store's own smoothed level is the only honest target. A synthesized
        // envelope lands somewhere else entirely and never reaches the ceiling.
        expect(voiceRuntimeLevelStore.getSnapshot().inputLevel).toBeGreaterThan(0.99);
        expect(energy!.level.get()).toBeGreaterThan(0.95);
        expect(energy!.flow.get()).toBeLessThan(-0.9);
    });

    it('falls silent when the microphone does', () => {
        const input = openWriter('input');
        mount();
        drive(input, 1);
        runFrames(90);

        act(() => {
            input.reset();
        });
        // Long enough for the τ_release envelope to reach the epsilon floor: the
        // meter must reach a true zero, not hover at a visible sliver forever.
        runFrames(180);

        expect(energy!.level.get()).toBe(0);
    });

    it('does not commit a React update per audio write', () => {
        // The provider is mounted around the whole app, so a re-render per
        // published sample would be 30 Hz of React work app-wide. The store
        // publishes on every write; only *opening or closing* a source may
        // reach React. Writes are split across separate `act()` calls because a
        // single batch collapses to one commit and proves nothing (§16.1).
        const input = openWriter('input');
        let commits = 0;
        act(() => {
            tree = renderer.create(
                <React.Profiler id="voice-energy" onRender={() => { commits += 1; }}>
                    <VoiceEnergyProvider
                        state={LISTENING}
                        activation={{ providerReady: true, attemptActive: true, micCaptureActive: true }}
                        sourceActivity={voiceRuntimeLevelStore.getSourceActivitySnapshot()}
                    >
                        <EnergyProbe />
                    </VoiceEnergyProvider>
                </React.Profiler>,
            );
        });

        const baseline = commits;
        expect(baseline).toBeGreaterThan(0);
        for (let i = 0; i < 100; i += 1) {
            act(() => {
                input.write((i % 50) / 50);
            });
        }

        // At most one, and it is React's own: a state setter that returns the
        // previous value bails out, but React may still re-render that one
        // component once before it does. Observed exactly once, on the first
        // write that moved the level. A provider actually subscribed to the
        // amplitude would land ~99 here.
        expect(commits - baseline).toBeLessThanOrEqual(1);
    });

    it('settles back to still when the attempt ends', () => {
        // §2.4a: "Attempt ends → settles back to still." Stopping the clock is
        // not the same as being still: `level` and `flow` are written only by
        // the worklet, so a shape that was mid-syllable when the last channel
        // closed stays frozen at that amplitude — a planet stuck half-inflated,
        // pointing inward, for as long as the surface is on screen.
        const input = openWriter('input');
        mount();
        drive(input, 1);
        runFrames(90);
        expect(energy!.level.get()).toBeGreaterThan(0.9);
        expect(energy!.flow.get()).toBeLessThan(-0.9);

        act(() => {
            input.close();
        });
        endAttempt();

        expect(frameRecord().handle.isActive).toBe(false);
        expect(energy!.level.get()).toBe(0);
        expect(energy!.flow.get()).toBe(0);
        expect(energy!.sourceActive.get()).toBe(0);
        expect(energy!.history.get().every((slot) => slot === 0)).toBe(true);
    });

    it('travels outward while only the playback channel is open', () => {
        const output = openWriter('output');
        mount();
        drive(output, 1);
        runFrames(120);

        expect(energy!.level.get()).toBeGreaterThan(0.95);
        expect(energy!.flow.get()).toBeGreaterThan(0.9);
    });

    it('keeps the user\'s own energy during barge-in instead of hiding it', () => {
        // The moment the user speaks over the assistant is when inward motion
        // carries the most meaning, so a plain "output wins" rule is wrong.
        const output = openWriter('output');
        const input = openWriter('input');
        mount();
        drive(output, 1);
        drive(input, 1);
        runFrames(120);

        expect(energy!.flow.get()).toBeLessThan(-0.9);
    });

    it('holds the inward selection through a dip, instead of flickering channel', () => {
        const output = openWriter('output');
        const input = openWriter('input');
        mount();
        drive(output, 1);
        drive(input, 0.4);
        runFrames(60);
        expect(energy!.flow.get()).toBeLessThan(-0.5);

        // A quiet syllable boundary: below the level that *engages* the input
        // channel, above the level that releases it. Without hysteresis a duplex
        // passage flips channel frame to frame and the meter jumps to the loud
        // playback amplitude.
        drive(input, 0.05, 40);
        runFrames(60);

        expect(energy!.level.get()).toBeLessThan(0.2);
        expect(energy!.flow.get()).toBeLessThan(-0.5);
    });
});
