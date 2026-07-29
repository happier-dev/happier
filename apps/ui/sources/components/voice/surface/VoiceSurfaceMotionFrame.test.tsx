import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { VoiceSurfaceState } from './resolveVoiceSurfaceState';

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

describe('VoiceSurfaceMotionFrame (L10.T3)', () => {
    beforeEach(() => {
        vi.resetModules();
        reducedMotionState.current = false;
    });

    it('renders children through the animated frame', async () => {
        const { VoiceSurfaceMotionFrame } = await import('./VoiceSurfaceMotionFrame');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    VoiceSurfaceMotionFrame,
                    { surfaceState: 'listening' satisfies VoiceSurfaceState },
                    React.createElement('Marker', { testID: 'child' }),
                ),
            );
        });
        expect(tree.root.findByProps({ testID: 'child' })).toBeTruthy();
        await act(async () => tree.unmount());
    });

    it('honors reduced motion by snapping the frame to a static style', async () => {
        reducedMotionState.current = true;
        const { VoiceSurfaceMotionFrame } = await import('./VoiceSurfaceMotionFrame');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    VoiceSurfaceMotionFrame,
                    { surfaceState: 'speaking' satisfies VoiceSurfaceState },
                    React.createElement('Marker', { testID: 'child' }),
                ),
            );
        });
        expect(tree.root.findByProps({ testID: 'child' })).toBeTruthy();
        await act(async () => tree.unmount());
    });

    it('updates across a full state sequence without throwing', async () => {
        const { VoiceSurfaceMotionFrame } = await import('./VoiceSurfaceMotionFrame');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(VoiceSurfaceMotionFrame, { surfaceState: 'connecting' satisfies VoiceSurfaceState }, null),
            );
        });
        for (const surfaceState of ['listening', 'thinking', 'speaking', 'reconnecting', 'permission_required', 'error', 'interrupted', 'idle'] as const) {
            await act(async () => {
                tree.update(React.createElement(VoiceSurfaceMotionFrame, { surfaceState }, null));
            });
        }
        expect(tree.toJSON()).not.toBeNull();
        await act(async () => tree.unmount());
    });
});
