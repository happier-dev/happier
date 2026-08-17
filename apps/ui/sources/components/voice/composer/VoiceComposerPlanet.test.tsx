import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    readReanimatedFrameCallbacks,
    resetReanimatedFrameCallbacks,
} from '@/dev/testkit/mocks/reanimated';
import { VoiceEnergyProvider, type VoiceEnergyState } from '@/components/voice/light/useVoiceEnergy';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

import { VOICE_COMPOSER_PLANET_SLOT, VoiceComposerPlanet } from './VoiceComposerPlanet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

const LISTENING: VoiceEnergyState = { luminosity: 0.62, energized: true, direction: 'inward' };

const TEST_ID = 'session-composer-voice';

/** Module-level so a parent re-render passes the *same* handler identity. */
const onPress = vi.fn();

type StyleBag = Record<string, unknown>;

function flattenStyle(style: unknown, into: StyleBag = {}): StyleBag {
    if (Array.isArray(style)) {
        for (const entry of style) flattenStyle(entry, into);
        return into;
    }
    if (style && typeof style === 'object') Object.assign(into, style);
    return into;
}

/**
 * The box a pointer can actually hit.
 *
 * Deliberately does **not** count `hitSlop`: react-native-web 0.21 implements it
 * only in the legacy `Touchable` export — `Pressable` and `View` never read it —
 * and the desktop app is the web bundle. Summing it here is what let a 32pt
 * control be reported as a 48pt target for two lanes running.
 */
function readPressBox(node: ReactTestInstance): Readonly<{ width: number; height: number }> {
    const style = flattenStyle(node.props.style);
    return { width: Number(style.width), height: Number(style.height) };
}

describe('VoiceComposerPlanet', () => {
    let tree: renderer.ReactTestRenderer | null = null;

    beforeEach(() => {
        resetReanimatedFrameCallbacks();
        onPress.mockClear();
    });

    afterEach(() => {
        act(() => {
            tree?.unmount();
        });
        tree = null;
    });

    function scene(
        overrides: Partial<React.ComponentProps<typeof VoiceComposerPlanet>> = {},
        options: Readonly<{ mounted?: boolean }> = {},
    ): React.ReactElement {
        const { mounted = true } = options;
        return (
            <VoiceEnergyProvider
                state={LISTENING}
                activation={{ providerReady: true, attemptActive: true, micCaptureActive: true }}
            >
                {mounted ? (
                    <VoiceComposerPlanet
                        live
                        muted={false}
                        stop="cool"
                        accessibilityLabel="Listening. End the conversation"
                        accessibilityHint="Stops the spoken conversation. The coding turn keeps running."
                        onPress={onPress}
                        {...overrides}
                    />
                ) : null}
            </VoiceEnergyProvider>
        );
    }

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

    function root(): ReactTestInstance {
        return tree!.root;
    }

    /** The rendered Pressable, not the composite that produced it. */
    function control(): ReactTestInstance {
        const hosts = root().findAll(
            (node) => typeof node.type === 'string' && node.props?.testID === TEST_ID,
        );
        expect(hosts).toHaveLength(1);
        return hosts[0]!;
    }

    function clippingNodes(): ReactTestInstance[] {
        return root().findAll(
            (node) => typeof node.type === 'string'
                && flattenStyle(node.props?.style).overflow === 'hidden',
        );
    }

    it('fills the composer slot, so it reads as the submit button’s peer', () => {
        render(scene());

        // The drawn body fills the visual slot. Drawn under-size the planet reads as a
        // smaller, weaker sibling of the submit rather than its peer (§2.3).
        const disc = root().findByType('Svg' as never);
        expect(disc.props.width).toBe(VOICE_COMPOSER_PLANET_SLOT);
        expect(disc.props.height).toBe(VOICE_COMPOSER_PLANET_SLOT);
        expect(VOICE_COMPOSER_PLANET_SLOT).toBe(32);
    });

    it('keeps the 32pt visual inside a real platform-size target, with no phantom slop', () => {
        render(scene());

        const target = control();
        const targetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
        // A declared `hitSlop` here would be a target that does not exist on the
        // surface this ships on. The real Pressable frame owns the platform target;
        // the visual remains intentionally compact inside it.
        expect(target.props.hitSlop).toBeUndefined();
        expect(readPressBox(target)).toEqual({
            width: targetSize,
            height: targetSize,
        });
        expect(targetSize).toBeGreaterThanOrEqual(44);

        const disc = root().findByType('Svg' as never);
        expect({ width: disc.props.width, height: disc.props.height }).toEqual({
            width: VOICE_COMPOSER_PLANET_SLOT,
            height: VOICE_COMPOSER_PLANET_SLOT,
        });
    });

    it('never clips the breath', () => {
        render(scene());

        // A 12% inhale overshoots ~2pt per edge; the row's 8pt gap absorbs it.
        // The ONLY clip in this tree is the planet's own disc — anything else
        // eats the inhale and the body looks static (§2.3).
        const clipped = clippingNodes();
        expect(clipped).toHaveLength(1);
        expect(flattenStyle(clipped[0]!.props.style)).toMatchObject({
            width: VOICE_COMPOSER_PLANET_SLOT,
            borderRadius: VOICE_COMPOSER_PLANET_SLOT,
        });
    });

    it('is a visible energy consumer for exactly as long as it is mounted', () => {
        render(scene({}, { mounted: false }));
        const activations = (): readonly boolean[] => {
            const records = readReanimatedFrameCallbacks();
            expect(records).toHaveLength(1);
            return records[0]!.setActiveCalls;
        };
        expect(activations()).toEqual([false]);

        update(scene());
        expect(activations()).toEqual([false, true]);

        update(scene({}, { mounted: false }));
        expect(activations()).toEqual([false, true, false]);
    });

    it('does not re-render when the composer around it does', () => {
        render(scene());
        const before = control().props;

        // The composer body re-renders on every keystroke. A leaf whose props are
        // primitives plus one stable handler must not re-run with it — same
        // element, same style objects (§16.2).
        update(scene());
        const after = control().props;
        expect(after.style).toBe(before.style);
        expect(after).toBe(before);
    });

    it('carries the caller’s label and hint, and routes the press out', async () => {
        render(scene());

        const target = control();
        expect(target.props.accessibilityLabel).toBe('Listening. End the conversation');
        expect(target.props.accessibilityHint)
            .toBe('Stops the spoken conversation. The coding turn keeps running.');
        expect(target.props.accessibilityRole).toBe('button');

        await act(async () => {
            target.props.onPress();
        });
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('shows the meter only while the conversation is live', () => {
        render(scene({ live: false }));
        // The idle planet is luminous but has nothing to meter (§2.4a row 1).
        expect(root().findAllByType('Svg' as never).length).toBeGreaterThan(0);
        const idleBars = root().findAll((node) => node.props?.testID === 'voice-composer-planet-meter');
        expect(idleBars).toHaveLength(0);

        update(scene({ live: true }));
        expect(root().findAll((node) => node.props?.testID === 'voice-composer-planet-meter'))
            .toHaveLength(1);
    });

    it('marks a muted conversation without adding a second control', () => {
        render(scene({ live: true, muted: false }));
        expect(root().findAll((node) => node.props?.testID === 'voice-composer-planet-muted'))
            .toHaveLength(0);

        update(scene({ live: true, muted: true }));
        const marks = root().findAll((node) => node.props?.testID === 'voice-composer-planet-muted');
        expect(marks).toHaveLength(1);
        // §3.3: a control must never be a child of another control.
        expect(marks[0]!.props.accessibilityRole).toBeUndefined();
    });
});
