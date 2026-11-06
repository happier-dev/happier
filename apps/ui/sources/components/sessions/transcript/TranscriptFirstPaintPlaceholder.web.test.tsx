import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

// Issue #864: on web, react-native-web runs `Animated` on the JS driver, so the pulsing first-paint
// placeholder re-rendered its animated surface through React every frame — the same main thread a
// session switch is waiting on (~470 React update roots over two live switches, 2026-11-05).
const animationStarts = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const timing = () => ({ start: () => { animationStarts.count += 1; }, stop: () => {} });
    return createReactNativeWebMock({
        View: 'View',
        Platform: {
            OS: 'web',
            select: (value: any) => value?.web ?? value?.default,
        },
        Animated: {
            View: 'AnimatedView',
            Value: class {
                constructor(public value: number) {}
                setValue(next: number) { this.value = next; }
            },
            timing,
            sequence: () => timing(),
            loop: () => ({
                start: () => { animationStarts.count += 1; },
                stop: () => {},
            }),
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, unknown>);
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('TranscriptFirstPaintPlaceholder on web', () => {
    it('pulses through a CSS animation and starts no JS-driven animation', async () => {
        animationStarts.count = 0;
        const { TranscriptFirstPaintPlaceholder } = await import('./TranscriptFirstPaintPlaceholder');
        const screen = await renderScreen(<TranscriptFirstPaintPlaceholder reducedMotion={false} />);

        expect(animationStarts.count).toBe(0);
        expect(screen.findAllByType('AnimatedView')).toHaveLength(0);
        const surface = screen.findHostByTestId('transcript-first-paint-placeholder:active');
        expect(surface?.type).toBe('View');
        expect(flattenStyle(surface?.props.style).animationName).toBe('happierTranscriptFirstPaintPulse');
    });

    it('stays still under reduced motion', async () => {
        animationStarts.count = 0;
        const { TranscriptFirstPaintPlaceholder } = await import('./TranscriptFirstPaintPlaceholder');
        const screen = await renderScreen(<TranscriptFirstPaintPlaceholder reducedMotion />);

        expect(animationStarts.count).toBe(0);
        expect(screen.findHostByTestId('transcript-first-paint-placeholder:static')).toBeTruthy();
        expect(screen.findHostByTestId('transcript-first-paint-placeholder:active')).toBeNull();
    });
});
