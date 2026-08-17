import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { Bloom, PlanetLimb, PlanetOrb, VoiceWaveform } from '@/components/voice/light/VoiceLight';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { VOICE_LAB_STATE_BY_ID } from './voiceLabModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

/**
 * M9 — the extraction fidelity gate.
 *
 * The shared light material is about to move out of the lab and into
 * `components/voice/light/**`. "It still looks the same" is not something a
 * reviewer can check by eye across a file move, and this repo has **no
 * visual-regression capability at all** — no `toHaveScreenshot`, no
 * `jest-image-snapshot`, no `pixelmatch`, and `argent run screenshot-diff`
 * requires a device. So the gate is numeric instead of pixel-based.
 *
 * At a frozen `previewTimeMs` the energy provider resolves every SharedValue
 * deterministically, and the testkit's reanimated mock *evaluates* animated-style
 * worklets (`useAnimatedStyle: (factory) => factory()`). `VoiceLight` contains
 * zero `interpolate(` calls and computes opacity and transforms by direct
 * arithmetic, so the resolved styles below are the real output of the real
 * worklets — not stub values. That is what makes this discriminating rather than
 * decorative.
 *
 * **After the move, change only the two import paths above.** Every number in
 * the snapshot must stay identical. A diff here is a fidelity regression, and
 * the only acceptable responses are to fix it or to amend the design on purpose.
 */

/**
 * Deterministic instant — chosen, not arbitrary.
 *
 * `breathe()` holds at full inhale between phase 0.34 and 0.42. While Voice is
 * live the period is ~2.9s, so that window is ~0.99s–1.22s. Freezing at 1100ms
 * lands inside it, where the respiration term is at its **maximum**.
 *
 * This matters: an earlier draft froze at 2400ms, where the breath sits near
 * rest and every scale resolved to ~1.000. A broken breath would have passed
 * that gate unnoticed. Pin the motion where it is loudest.
 */
const FROZEN_MS = 1_100;

type StyleBag = Record<string, unknown>;

function flattenStyle(style: unknown, into: StyleBag): StyleBag {
    if (Array.isArray(style)) {
        for (const entry of style) flattenStyle(entry, into);
        return into;
    }
    if (style && typeof style === 'object') Object.assign(into, style);
    return into;
}

/** Round hard, so floating-point noise never fails a fidelity check spuriously. */
function round(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

/**
 * The visual facts worth pinning: what the eye actually reads. Layout constants
 * are already fixed by the source; these are the *computed* ones.
 */
function visualFacts(node: unknown, path: string, out: string[]): void {
    if (!node || typeof node !== 'object') return;
    const element = node as { type?: string; props?: StyleBag; children?: unknown[] };
    const props = element.props ?? {};
    const flat = flattenStyle(props.style, {});

    const parts: string[] = [];
    if (typeof flat.opacity === 'number') parts.push(`opacity=${round(flat.opacity)}`);
    if (typeof flat.height === 'number') parts.push(`height=${round(flat.height)}`);
    if (Array.isArray(flat.transform)) {
        for (const t of flat.transform as StyleBag[]) {
            for (const [key, value] of Object.entries(t)) {
                if (typeof value === 'number') parts.push(`${key}=${round(value)}`);
            }
        }
    }
    if (typeof props.stopOpacity === 'number') parts.push(`stopOpacity=${round(props.stopOpacity)}`);
    if (typeof props.offset === 'string') parts.push(`offset=${props.offset}`);

    if (parts.length > 0) out.push(`${path}<${element.type ?? '?'}> ${parts.join(' ')}`);

    const children = Array.isArray(element.children) ? element.children : [];
    children.forEach((child, index) => visualFacts(child, `${path}${index}.`, out));
}

function capture(node: React.ReactElement): string[] {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
        tree = renderer.create(
            <VoiceEnergyProvider state={VOICE_LAB_STATE_BY_ID.listening} previewTimeMs={FROZEN_MS}>
                {node}
            </VoiceEnergyProvider>,
        );
    });
    // The provider writes preview values in an effect, so the FIRST render still
    // holds initial SharedValues. Reading here would pin zeros and pass forever.
    act(() => {
        tree!.update(
            <VoiceEnergyProvider state={VOICE_LAB_STATE_BY_ID.listening} previewTimeMs={FROZEN_MS}>
                {node}
            </VoiceEnergyProvider>,
        );
    });
    const out: string[] = [];
    visualFacts(tree!.toJSON(), '', out);
    return out;
}

describe('voice light golden frame (M9)', () => {
    it('resolves the planet body deterministically at a frozen instant', () => {
        expect(capture(<PlanetOrb size={34} tint="warm" tintAmount={0.11} />)).toMatchSnapshot();
    });

    it('resolves the bloom gradient deterministically at a frozen instant', () => {
        expect(capture(<Bloom size={380} blur={82} stop="warm" alpha={0.42} polarity={1} reactivity={1} />))
            .toMatchSnapshot();
    });

    it('resolves the meter deterministically at a frozen instant', () => {
        expect(capture(<VoiceWaveform stop="warm" height={20} />)).toMatchSnapshot();
    });

    it('resolves the planet limb deterministically at a frozen instant', () => {
        expect(capture(<PlanetLimb width={272} height={90} stop="warm" stopSecondary="cool" crownRatio={0.3} />))
            .toMatchSnapshot();
    });

    it('produces non-trivial values — proving the worklets actually ran', () => {
        const facts = capture(<PlanetOrb size={34} tint="warm" tintAmount={0.11} />);
        const numbers = facts
            .flatMap((line) => line.match(/=(-?\d+(?:\.\d+)?)/g) ?? [])
            .map((token) => Number(token.slice(1)));

        // A stubbed-out reanimated mock would leave every animated value at its
        // initial 0/1. If this ever passes trivially the gate above is worthless.
        expect(numbers.length).toBeGreaterThan(0);
        expect(numbers.some((value) => value !== 0 && value !== 1)).toBe(true);
    });

    it('pins the breath itself, not just values that happen to vary', () => {
        // The guard above is not enough on its own: the orb's rings carry static
        // scales (1.26, 1.52…), so it passed even when every *time-dependent*
        // value was frozen at clock=0 and the body's breath scale resolved to
        // exactly 1. That is a gate blind to the one motion it exists to protect.
        //
        // The body is the layer whose opacity is `0.42 + luminosity * 0.58`.
        // At the frozen instant the breath is at full inhale, so its scale must
        // be meaningfully above 1.
        const body = capture(<PlanetOrb size={34} tint="warm" tintAmount={0.11} />)
            .find((line) => line.includes('opacity=0.739'));

        expect(body).toBeDefined();
        const scale = Number(/scale=(-?\d+(?:\.\d+)?)/.exec(body!)?.[1]);
        expect(scale).toBeGreaterThan(1.05);
    });
});
