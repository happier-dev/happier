import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    readReanimatedFrameCallbacks,
    resetReanimatedFrameCallbacks,
} from '@/dev/testkit/mocks/reanimated';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';

import { VoiceLevelVisualizer } from './VoiceLevelVisualizer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec?.ios ?? spec?.default },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

const FRAME_MS = 1000 / 60;

/**
 * The meter used to own a frame callback, a smoothing envelope (ATTACK 0.45 /
 * RELEASE 0.12) and a channel choice of its own — a third envelope beside the
 * level store's 0.65/0.25 and the energy provider's τ form, and a second
 * activation policy that never stopped. §16.4 allows exactly one of each, so
 * the meter reads the shared bus and draws it.
 */
describe('VoiceLevelVisualizer on the energy bus', () => {
    function scene(withMeter: boolean, color = '#fff'): React.ReactElement {
        return (
            <VoiceEnergyProvider
                state={{ luminosity: 0.62, energized: true, direction: 'outward' }}
                activation={{ providerReady: true, attemptActive: true, micCaptureActive: true }}
            >
                {withMeter ? <VoiceLevelVisualizer isActive color={color} /> : null}
            </VoiceEnergyProvider>
        );
    }

    function barScales(tree: renderer.ReactTestRenderer): readonly number[] {
        return tree.root
            .findAll((node) => node.type === ('Animated.View' as unknown as React.ElementType))
            .map((bar) => {
                const style: unknown = bar.props.style;
                const entries = Array.isArray(style) ? style : [style];
                const flat = Object.assign({}, ...entries.filter(Boolean)) as {
                    transform?: readonly { scaleY?: number }[];
                };
                return flat.transform?.[0]?.scaleY ?? 0;
            });
    }

    it('draws the shared amplitude without adding a second clock', () => {
        resetReanimatedFrameCallbacks();
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(scene(true));
        });

        const records = readReanimatedFrameCallbacks();
        expect(records).toHaveLength(1);
        // The meter is a visible consumer: the shared clock runs *because* it is
        // on screen, and stops when it leaves.
        expect(records[0]!.handle.isActive).toBe(true);

        let writer!: ReturnType<typeof voiceRuntimeLevelStore.open>;
        act(() => {
            writer = voiceRuntimeLevelStore.open({ channel: 'output', sourceId: 'test-output' });
            for (let i = 0; i < 24; i += 1) writer.write(1);
        });
        for (let i = 1; i <= 90; i += 1) {
            records[0]!.run({
                timestamp: i * FRAME_MS,
                timeSincePreviousFrame: FRAME_MS,
                timeSinceFirstFrame: i * FRAME_MS,
            });
        }

        // Re-render to sample the styles the bars would paint this frame; the
        // amplitude itself never went through React.
        act(() => {
            tree.update(scene(true, '#eee'));
        });

        expect(readReanimatedFrameCallbacks()).toHaveLength(1);
        const scales = barScales(tree);
        expect(scales).toHaveLength(3);
        expect(Math.max(...scales)).toBeGreaterThan(0.9);

        act(() => {
            tree.update(scene(false));
        });
        expect(records[0]!.handle.isActive).toBe(false);

        act(() => {
            writer.close();
            tree.unmount();
        });
    });

    it('rests instead of animating when no bus is mounted', () => {
        // The meter is a leaf any host may render. Without a clock the honest
        // rendering is the instrument at rest — not a crash, and not a second
        // frame callback quietly started to cover for the missing one.
        resetReanimatedFrameCallbacks();
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(<VoiceLevelVisualizer isActive color="#fff" />);
        });

        expect(readReanimatedFrameCallbacks()).toHaveLength(0);
        expect(barScales(tree).every((scale) => scale > 0 && scale < 0.5)).toBe(true);

        act(() => {
            tree.unmount();
        });
    });
});
