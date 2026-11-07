import * as React from 'react';
import { TextInput, View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('SoftSlideTransitionFrame', () => {
    it('keeps the outgoing slide state and mount while it exits', async () => {
        const { SoftSlideTransitionFrame } = await import('./SoftSlideTransitionFrame');
        const mounts: string[] = [];
        function StatefulSlide(props: Readonly<{ name: string }>) {
            const [value, setValue] = React.useState('initial');
            React.useEffect(() => {
                mounts.push(`mount:${props.name}`);
                return () => { mounts.push(`unmount:${props.name}`); };
            }, [props.name]);
            return <TextInput testID={`slide-${props.name}`} value={value} onChangeText={setValue} />;
        }
        const frame = (key: string) => <SoftSlideTransitionFrame
            direction="forward" reducedMotion testID="soft" transitionKey={key}
        ><StatefulSlide name={key} /></SoftSlideTransitionFrame>;
        const screen = await renderScreen(frame('one'));
        await act(async () => {
            screen.findByTestId('slide-one')?.props.onChangeText('changed');
        });
        await screen.update(frame('two'));
        expect(screen.findByTestId('slide-one')?.props.value).toBe('changed');
        expect(mounts).toEqual(['mount:one', 'mount:two']);
        await act(async () => {
            screen.findByTestId('slide-two')?.props.onChangeText('second');
        });
        await screen.update(frame('three'));
        expect(screen.findByTestId('slide-two')?.props.value).toBe('second');
        expect(mounts).toEqual(['mount:one', 'mount:two', 'unmount:one', 'mount:three']);
    });
    it('keeps a retained layer mounted and hidden after it exits, and returns to it without a remount', async () => {
        vi.useFakeTimers();
        try {
            const { SoftSlideTransitionFrame } = await import('./SoftSlideTransitionFrame');
            const mounts: string[] = [];
            function StatefulSlide(props: Readonly<{ name: string }>) {
                const [value, setValue] = React.useState('initial');
                React.useEffect(() => {
                    mounts.push(`mount:${props.name}`);
                    return () => { mounts.push(`unmount:${props.name}`); };
                }, [props.name]);
                return <TextInput testID={`slide-${props.name}`} value={value} onChangeText={setValue} />;
            }
            // A sheet's own view stays mounted under the view pushed over it (the pushed view lives inside it).
            const frame = (stack: readonly string[], direction: 'forward' | 'backward' | 'replace') => {
                const top = stack[stack.length - 1]!;
                return <SoftSlideTransitionFrame direction={direction} reducedMotion testID="soft" transitionKey={top}
                    retainedLayers={stack.map((key) => ({ key, children: <StatefulSlide name={key} /> }))}
                ><StatefulSlide name={top} /></SoftSlideTransitionFrame>;
            };
            const screen = await renderScreen(frame(['menu'], 'replace'));
            await act(async () => { screen.findByTestId('slide-menu')?.props.onChangeText('scrolled'); });
            await screen.update(frame(['menu', 'picker'], 'forward'));
            await act(async () => { vi.advanceTimersByTime(1000); });
            // The menu has exited but is still mounted, with its state.
            expect(screen.findByTestId('slide-menu')?.props.value).toBe('scrolled');
            await screen.update(frame(['menu'], 'backward'));
            await act(async () => { vi.advanceTimersByTime(1000); });
            expect(screen.findByTestId('slide-menu')?.props.value).toBe('scrolled');
            expect(mounts).toEqual(['mount:menu', 'mount:picker', 'unmount:picker']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('lets a bounded consumer make the current slide fill the available viewport', async () => {
        const { SoftSlideTransitionFrame } = await import('./SoftSlideTransitionFrame');
        const screen = await renderScreen(
            <SoftSlideTransitionFrame
                contentStyle={{ flex: 1, minHeight: 0 }}
                direction="replace"
                reducedMotion={false}
                testID="soft"
                transitionKey="one"
            >
                <View testID="slide-one" />
            </SoftSlideTransitionFrame>,
        );

        expect(flattenStyle(screen.findByTestId('soft-current-layer')?.props.style)).toMatchObject({
            flex: 1,
            minHeight: 0,
        });
    });

    it('renders the first web slide without an initial blur transition', async () => {
        const { SoftSlideTransitionFrame } = await import('./SoftSlideTransitionFrame');
        const screen = await renderScreen(
            <SoftSlideTransitionFrame
                direction="replace"
                reducedMotion={false}
                testID="soft"
                transitionKey="one"
            >
                <View testID="slide-one" />
            </SoftSlideTransitionFrame>,
        );

        const currentStyle = flattenStyle(screen.findByTestId('soft-current-layer')?.props.style);

        expect(currentStyle.opacity).toBe(1);
        expect(currentStyle.filter).toBe('blur(0px)');
        expect(currentStyle.transitionProperty).toBe('opacity, transform, filter');
    });

    it('keeps outgoing and incoming web slides mounted during the blur transition', async () => {
        const { SoftSlideTransitionFrame } = await import('./SoftSlideTransitionFrame');
        const screen = await renderScreen(
            <SoftSlideTransitionFrame
                direction="replace"
                reducedMotion={false}
                testID="soft"
                transitionKey="one"
            >
                <View testID="slide-one" />
            </SoftSlideTransitionFrame>,
        );

        await screen.update(
            <SoftSlideTransitionFrame
                direction="forward"
                reducedMotion={false}
                testID="soft"
                transitionKey="two"
            >
                <View testID="slide-two" />
            </SoftSlideTransitionFrame>,
        );

        const currentStyle = flattenStyle(screen.findByTestId('soft-current-layer')?.props.style);
        const exitStyle = flattenStyle(screen.findByTestId('soft-exit-layer')?.props.style);

        expect(screen.findByTestId('slide-one')).not.toBeNull();
        expect(screen.findByTestId('slide-two')).not.toBeNull();
        expect(currentStyle.filter).toBe('blur(10px)');
        expect(exitStyle.filter).toBe('blur(0px)');
        expect(exitStyle.transitionProperty).toBe('opacity, transform, filter');
        expect(screen.findByTestId('soft-exit-layer')?.props).toMatchObject({
            'aria-hidden': true,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        });
    });

    it('keeps outgoing and incoming web slides mounted during a reduced-motion crossfade', async () => {
        const { SoftSlideTransitionFrame } = await import('./SoftSlideTransitionFrame');
        const screen = await renderScreen(
            <SoftSlideTransitionFrame
                direction="replace"
                reducedMotion
                testID="soft"
                transitionKey="one"
            >
                <View testID="slide-one" />
            </SoftSlideTransitionFrame>,
        );

        await screen.update(
            <SoftSlideTransitionFrame
                direction="forward"
                reducedMotion
                testID="soft"
                transitionKey="two"
            >
                <View testID="slide-two" />
            </SoftSlideTransitionFrame>,
        );

        const currentStyle = flattenStyle(screen.findByTestId('soft-current-layer')?.props.style);
        const exitStyle = flattenStyle(screen.findByTestId('soft-exit-layer')?.props.style);

        expect(screen.findByTestId('slide-one')).not.toBeNull();
        expect(screen.findByTestId('slide-two')).not.toBeNull();
        expect(currentStyle.transform).toEqual([{ translateX: 0 }]);
        expect(currentStyle.filter).toBe('blur(0px)');
        expect(exitStyle.transform).toEqual([{ translateX: 0 }]);
        expect(exitStyle.filter).toBe('blur(0px)');
    });

    it('crossfades each role for its own reduced-motion duration', async () => {
        const { SoftSlideTransitionFrame } = await import('./SoftSlideTransitionFrame');
        const { slideTransitionTokens } = await import('./slideTransitionTokens');
        for (const preset of ['signature', 'routine'] as const) {
            const screen = await renderScreen(
                <SoftSlideTransitionFrame direction="replace" preset={preset} reducedMotion testID="soft" transitionKey="one">
                    <View testID="slide-one" />
                </SoftSlideTransitionFrame>,
            );
            await screen.update(
                <SoftSlideTransitionFrame direction="forward" preset={preset} reducedMotion testID="soft" transitionKey="two">
                    <View testID="slide-two" />
                </SoftSlideTransitionFrame>,
            );

            const expected = `${slideTransitionTokens[preset].reducedMotionDurationMs}ms`;
            expect(flattenStyle(screen.findByTestId('soft-current-layer')?.props.style).transitionDuration).toBe(expected);
            expect(flattenStyle(screen.findByTestId('soft-exit-layer')?.props.style).transitionDuration).toBe(expected);
            await screen.unmount();
        }
    });
});
