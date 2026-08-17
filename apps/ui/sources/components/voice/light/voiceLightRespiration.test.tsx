import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { PlanetOrb } from './VoiceLight';
import {
    VoiceEnergyProvider,
    type VoiceEnergyRuntimeActivation,
    type VoiceEnergyState,
} from './useVoiceEnergy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

/**
 * §2.4a — the planet must not lie about the microphone.
 *
 * Respiration means *listening*. The runtime has a distinct `acquiring_mic`
 * phase between `connected` and `listening`, and the canonical capture fact is
 * `resolveVoiceMicCaptureActive` (`status === 'connected' && inputSourceActive`).
 * A planet that breathes on `connecting` tells the user the microphone is open
 * while it is still being acquired — the one thing this animation exists to
 * say, said falsely.
 *
 * The assertion is the **drawn body**, not a bus value: what the eye reads is
 * the body's scale, and a gate that is computed and then ignored is exactly the
 * drift this test exists to catch. The M9 golden-frame methodology is reused —
 * at a frozen `previewTimeMs` the provider resolves every SharedValue during
 * render and the testkit evaluates the real animated-style worklets, so the
 * numbers below are the real output of the real motion code.
 */

/**
 * Frozen at the loudest instant of the breath.
 *
 * `breathe()` holds at full inhale between phase 0.34 and 0.42; at
 * `luminosity: 0.62` the period is ~2.91s, so that window is ~0.99s–1.22s.
 * 1100ms lands inside it. Freezing anywhere else would let a broken gate pass.
 */
const FROZEN_MS = 1_100;

/** Silent: no amplitude at all, so the body's scale is the respiration term alone. */
const SILENT: VoiceEnergyState = { luminosity: 0.62, energized: false, direction: 'none' };
/** The assistant has the floor: real amplitude, travelling outward. */
const PLAYBACK: VoiceEnergyState = { luminosity: 0.62, energized: true, direction: 'outward' };

type StyleBag = Record<string, unknown>;

function flatten(style: unknown, into: StyleBag): StyleBag {
    if (Array.isArray(style)) {
        for (const entry of style) flatten(entry, into);
        return into;
    }
    if (style && typeof style === 'object') Object.assign(into, style);
    return into;
}

/**
 * The scale of the planet's body.
 *
 * `atmosphere={false}` removes the blooms and rings, so the single remaining
 * animated node is the body itself — no ambiguity about which transform is
 * being read.
 */
function bodyScale(
    state: VoiceEnergyState,
    activation: VoiceEnergyRuntimeActivation | null,
): number {
    let tree: renderer.ReactTestRenderer | null = null;
    const scene = (
        <VoiceEnergyProvider state={state} activation={activation} previewTimeMs={FROZEN_MS}>
            <PlanetOrb size={34} atmosphere={false} />
        </VoiceEnergyProvider>
    );
    act(() => {
        tree = renderer.create(scene);
    });
    const scales: number[] = [];
    const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const element = node as { props?: StyleBag; children?: unknown[] };
        const flat = flatten(element.props?.style, {});
        if (Array.isArray(flat.transform)) {
            for (const entry of flat.transform as StyleBag[]) {
                if (typeof entry.scale === 'number') scales.push(entry.scale);
            }
        }
        for (const child of Array.isArray(element.children) ? element.children : []) walk(child);
    };
    walk(tree!.toJSON());
    act(() => {
        tree!.unmount();
    });
    expect(scales).toHaveLength(1);
    return scales[0]!;
}

function allPlanetScales(previewTimeMs: number): readonly number[] {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
        tree = renderer.create(
            <VoiceEnergyProvider
                state={SILENT}
                activation={runtime({ attemptActive: true, micCaptureActive: false })}
                previewTimeMs={previewTimeMs}
            >
                <PlanetOrb size={34} />
            </VoiceEnergyProvider>,
        );
    });
    const scales: number[] = [];
    const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const element = node as { props?: StyleBag; children?: unknown[] };
        const flat = flatten(element.props?.style, {});
        if (Array.isArray(flat.transform)) {
            for (const entry of flat.transform as StyleBag[]) {
                if (typeof entry.scale === 'number') scales.push(entry.scale);
            }
        }
        for (const child of Array.isArray(element.children) ? element.children : []) walk(child);
    };
    walk(tree!.toJSON());
    act(() => {
        tree!.unmount();
    });
    return scales;
}

function runtime(
    fields: Readonly<{ attemptActive: boolean; micCaptureActive: boolean }>,
): VoiceEnergyRuntimeActivation {
    return { providerReady: true, ...fields };
}

describe('the planet breathes only while the microphone is capturing (§2.4a)', () => {
    it('is still when Voice is enabled but no attempt is running', () => {
        expect(bodyScale(SILENT, runtime({ attemptActive: false, micCaptureActive: false })))
            .toBe(1);
    });

    it('does not breathe while connecting, before the microphone is acquired', () => {
        // The defect this test exists for: `connecting`/`acquiring_mic` used to
        // start the clock and the body breathed unconditionally, claiming an
        // open microphone the runtime had not acquired yet.
        expect(bodyScale(SILENT, runtime({ attemptActive: true, micCaptureActive: false })))
            .toBe(1);
    });

    it('keeps the complete atmospheric planet still after the bounded connection arrival', () => {
        const first = allPlanetScales(2_000);
        const later = allPlanetScales(9_000);

        expect(first.length).toBeGreaterThan(1);
        expect(later).toEqual(first);
    });

    it('breathes once the microphone is genuinely capturing', () => {
        // Full inhale at the frozen instant: 1 + (0.085 + live * 0.035).
        expect(bodyScale(SILENT, runtime({ attemptActive: true, micCaptureActive: true })))
            .toBeGreaterThan(1.05);
    });

    it('answers the assistant with amplitude, not with the listening breath', () => {
        // Output-only — the assistant is speaking and the microphone is closed.
        // The body still moves, because it is answering real playback amplitude,
        // but the respiration term stays off: this is a different behaviour, not
        // a quieter version of listening.
        const outputOnly = bodyScale(PLAYBACK, runtime({ attemptActive: true, micCaptureActive: false }));
        const listening = bodyScale(PLAYBACK, runtime({ attemptActive: true, micCaptureActive: true }));

        expect(outputOnly).toBeGreaterThan(1);
        // The whole respiration term separates the two, at identical amplitude.
        expect(listening - outputOnly).toBeGreaterThan(0.11);
    });

    it('keeps the lab and any frozen preview breathing when no runtime is attached', () => {
        // The design lab and the M9 golden frame pass no activation at all:
        // there is no attempt to track, so the runtime inputs stay neutral and
        // the reference material is unchanged.
        expect(bodyScale(SILENT, null)).toBeGreaterThan(1.05);
    });
});
