import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { FocusRingProps } from '@/components/ui/interaction/FocusRing';
import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reducedMotion = { value: false };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotion.value,
}));

const RING_TEST_ID = 'focus-ring';

async function renderRing(props: Omit<FocusRingProps, 'testID'>) {
    const { FocusRing } = await import('@/components/ui/interaction/FocusRing');
    return renderScreen(<FocusRing testID={RING_TEST_ID} {...props} />);
}

describe('FocusRing', () => {
    it('renders nothing for a control that has never been focused', async () => {
        const screen = await renderRing({ visible: false, radius: 8 });

        // Hosts, not composites: `FocusRing` itself carries the testID even while it renders null.
        expect(screen.findAllHostsByTestId(RING_TEST_ID)).toHaveLength(0);
    });

    it('paints the dedicated focus token when it becomes visible', async () => {
        const screen = await renderRing({ visible: true, radius: 8 });
        const ring = screen.findByTestId(RING_TEST_ID);

        const style = Object.assign({}, ...[ring?.props.style].flat(Infinity).filter(Boolean));
        expect(style.borderColor).toBe(lightTheme.colors.focus.ring);
        expect(style.opacity).toBe(1);
        expect(ring?.props.pointerEvents).toBe('none');
    });

    it('stays mounted at zero opacity after blur, so the exit can play out', async () => {
        const { FocusRing } = await import('@/components/ui/interaction/FocusRing');
        const screen = await renderScreen(<FocusRing testID={RING_TEST_ID} visible radius={8} />);

        await screen.update(<FocusRing testID={RING_TEST_ID} visible={false} radius={8} />);

        const ring = screen.findByTestId(RING_TEST_ID);
        const style = Object.assign({}, ...[ring?.props.style].flat(Infinity).filter(Boolean));
        expect(style.opacity).toBe(0);
    });

    it('traces the exact corner radii of a grouped row when the host supplies them', async () => {
        const screen = await renderRing({
            visible: true,
            placement: 'inside',
            cornerRadii: { borderTopLeftRadius: 10, borderTopRightRadius: 10 },
        });

        const ring = screen.findByTestId(RING_TEST_ID);
        const style = Object.assign({}, ...[ring?.props.style].flat(Infinity).filter(Boolean));
        expect(style.borderTopLeftRadius).toBe(10);
        expect(style.borderTopRightRadius).toBe(10);
        expect(style.borderBottomLeftRadius).toBeUndefined();
    });

    it('sits on the control bounds when placed inside, and outside them when placed outside', async () => {
        const inside = await renderRing({ visible: true, radius: 8, placement: 'inside' });
        const insideStyle = Object.assign(
            {},
            ...[inside.findByTestId(RING_TEST_ID)?.props.style].flat(Infinity).filter(Boolean),
        );
        expect(insideStyle.top).toBe(0);

        const outside = await renderRing({ visible: true, radius: 8, placement: 'outside' });
        const outsideStyle = Object.assign(
            {},
            ...[outside.findByTestId(RING_TEST_ID)?.props.style].flat(Infinity).filter(Boolean),
        );
        expect(outsideStyle.top).toBeLessThan(0);
        expect(outsideStyle.borderTopLeftRadius).toBeGreaterThan(8);
    });
});

describe('resolveFocusRingTimingMs', () => {
    it('appears instantly and leaves in 90ms', async () => {
        const { resolveFocusRingTimingMs } = await import('@/components/ui/interaction/FocusRing');

        expect(resolveFocusRingTimingMs({ visible: true, reducedMotion: false })).toBe(0);
        expect(resolveFocusRingTimingMs({ visible: false, reducedMotion: false })).toBe(90);
    });

    it('drops the exit fade under reduced motion', async () => {
        const { resolveFocusRingTimingMs } = await import('@/components/ui/interaction/FocusRing');

        expect(resolveFocusRingTimingMs({ visible: false, reducedMotion: true })).toBe(0);
        expect(resolveFocusRingTimingMs({ visible: true, reducedMotion: true })).toBe(0);
    });
});
