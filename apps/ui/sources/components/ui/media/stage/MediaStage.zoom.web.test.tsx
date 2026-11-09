import * as React from 'react';
import { PixelRatio, StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MediaStage } from './MediaStage';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Dimensions: { get: () => ({ width: 1024, height: 900, scale: 1, fontScale: 1 }) },
    });
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock({ settleTimingCallbacks: true });
});

// OS recognizers are the boundary: use the canonical recorder, not a mocked zoom owner.
type RecordedGesture = {
    __config?: { testId?: string };
    __handlers?: Record<string, (event: Record<string, number>, success?: boolean) => void>;
    gestures?: RecordedGesture[];
};
function recognizer(gesture: unknown, id: string): RecordedGesture | undefined {
    const root = gesture as RecordedGesture;
    return root.__config?.testId === id ? root : root.gestures?.map(child => recognizer(child, id)).find(Boolean);
}

describe('Media stage desktop small-picture zoom', () => {
    it.each([[100, true], [2000, false]] as const)('double-clicks a %ipx picture above fit, selects crisp pixels only for small pictures, then returns to fit', async (width, pixelated) => {
        setReducedMotionPreferenceOverride(true);
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><MediaStage initialIndex={0} onClose={() => {}}
            items={[{ kind: 'image', title: 'hero.png', source: { enabled: true, source: { kind: 'uri', uri: 'blob:hero-small' } } }]} /></InjectedAuthProvider>);
        try {
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width, height: width } }));
            const detector = screen.findAllByType('GestureDetector')[0]!;
            const doubleTap = recognizer(detector.props.gesture, 'media-double-tap')!.__handlers!.onEnd!;
            // Use the picture centre, not its dismiss backing.
            const viewport = StyleSheet.flatten(detector.parent!.props.style);
            const event = { x: viewport.width / 2, y: viewport.height / 2, pointerType: 2 };
            const zoomText = `${pixelated ? 200 * PixelRatio.get() : 100}%`;
            await act(async () => doubleTap(event, true));
            expect(screen.getTextContent()).toContain(zoomText);
            const picture = screen.findByTestId('media-stage-image')!;
            expect(picture.props.allowDownscaling).toBe(false);
            expect(flattenTestStyle(picture.props.style).imageRendering).toBe(pixelated ? 'pixelated' : undefined);
            await act(async () => doubleTap(event, true));
            expect(screen.getTextContent()).not.toContain(zoomText);
            expect(flattenTestStyle(screen.findByTestId('media-stage-image')!.props.style).imageRendering).toBeUndefined();
        } finally { await screen.unmount(); setReducedMotionPreferenceOverride(null); }
    });
});
