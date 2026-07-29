import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const reducedMotionState = { current: false };
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.current,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Platform: { OS: 'ios', select: (spec: any) => spec?.ios ?? spec?.default },
    StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
}));

afterEach(() => {
    reducedMotionState.current = false;
});

describe('VoiceLevelVisualizer', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('does NOT re-render the React tree when the audio level is driven (level stays off React)', async () => {
        const { voiceRuntimeLevelStore } = await import('@/voice/runtime/levels/voiceRuntimeLevelStore');
        const { VoiceLevelVisualizer } = await import('./VoiceLevelVisualizer');

        let renderCount = 0;
        function Counter() {
            renderCount += 1;
            return React.createElement(VoiceLevelVisualizer, { isActive: true, color: '#fff' });
        }

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Counter));
        });

        const baseline = renderCount;
        const writer = voiceRuntimeLevelStore.open({ channel: 'input', sourceId: 'test-capture' });

        // Drive the audio level at "audio-frame" frequency.
        await act(async () => {
            for (let i = 0; i < 240; i += 1) {
                writer.write((i % 60) / 60);
            }
        });

        expect(renderCount).toBe(baseline);
        writer.close();
        await act(async () => {
            tree.unmount();
        });
    });

    it('renders an idle fallback (no crash) when inactive and no level is wired', async () => {
        const { VoiceLevelVisualizer } = await import('./VoiceLevelVisualizer');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(VoiceLevelVisualizer, { isActive: false, color: '#fff' }));
        });
        expect(tree.toJSON()).not.toBeNull();
        await act(async () => {
            tree.unmount();
        });
    });

    it('accepts distinct runtime input and output channels', async () => {
        const { VoiceLevelVisualizer } = await import('./VoiceLevelVisualizer');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(VoiceLevelVisualizer, {
                isActive: true,
                color: '#fff',
                channel: 'output',
                fallbackPulse: true,
            }));
        });
        expect(tree.toJSON()).not.toBeNull();
        await act(async () => tree.unmount());
    });

    it('uses the fallback only when no real meter owns the channel', async () => {
        const { resolveVoiceLevelTarget } = await import('./VoiceLevelVisualizer');
        expect(resolveVoiceLevelTarget(0, true, true, 0)).toBe(0);
        expect(resolveVoiceLevelTarget(0, false, false, 0)).toBe(0);
        expect(resolveVoiceLevelTarget(0, false, true, 0)).toBeGreaterThan(0);
    });
});
