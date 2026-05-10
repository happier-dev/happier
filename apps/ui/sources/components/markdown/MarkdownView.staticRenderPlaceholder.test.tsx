import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const animatedCapture = vi.hoisted(() => ({
    platformOS: 'web' as 'web' | 'ios' | 'android',
    timingTargets: [] as unknown[],
    sequenceStepCounts: [] as number[],
    loopStartCount: 0,
    loopStopCount: 0,
}));

type TestAnimation = {
    start: (callback?: (result: { finished: boolean }) => void) => void;
    stop?: () => void;
};

installMarkdownCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const module = await createReactNativeWebMock();
        return {
            ...module,
            Platform: {
                get OS() {
                    return animatedCapture.platformOS;
                },
                select: (values: Record<string, unknown>) =>
                    values?.[animatedCapture.platformOS] ?? values?.default,
            },
            Animated: {
                ...module.Animated,
                timing: (_value: unknown, config: { toValue?: unknown }): TestAnimation => {
                    animatedCapture.timingTargets.push(config.toValue);
                    return {
                        start: (callback) => callback?.({ finished: true }),
                        stop: () => {},
                    };
                },
                sequence: (steps: TestAnimation[]): TestAnimation => {
                    animatedCapture.sequenceStepCounts.push(steps.length);
                    return {
                        start: (callback) => {
                            for (const step of steps) {
                                step.start();
                            }
                            callback?.({ finished: true });
                        },
                        stop: () => {
                            for (const step of steps) {
                                step.stop?.();
                            }
                        },
                    };
                },
                loop: (animation: TestAnimation): TestAnimation => ({
                    start: (callback) => {
                        animatedCapture.loopStartCount += 1;
                        animation.start();
                        callback?.({ finished: true });
                    },
                    stop: () => {
                        animatedCapture.loopStopCount += 1;
                        animation.stop?.();
                    },
                }),
            },
        };
    },
});

describe('MarkdownView (static render placeholder)', () => {
    beforeEach(() => {
        animatedCapture.platformOS = 'web';
        animatedCapture.timingTargets.length = 0;
        animatedCapture.sequenceStepCounts.length = 0;
        animatedCapture.loopStartCount = 0;
        animatedCapture.loopStopCount = 0;
        vi.resetModules();
        vi.useFakeTimers();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('shows a delayed placeholder for native static markdown until content layout is reported', async () => {
        animatedCapture.platformOS = 'android';
        const { MarkdownView } = await import('./MarkdownView');

        const screen = await renderScreen(
            <MarkdownView markdown="Hello **world**" profile="transcript" />,
        );

        expect(screen.findByTestId('markdown-static-render-placeholder')).toBe(null);

        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });

        expect(screen.findByTestId('markdown-static-render-placeholder')).not.toBe(null);
        expect(animatedCapture.loopStartCount).toBe(1);
        expect(animatedCapture.sequenceStepCounts).toEqual([2]);
        expect(animatedCapture.timingTargets).toEqual([1, 0.45]);

        const content = screen.findByTestId('markdown-static-render-content');
        await act(async () => {
            content?.props.onLayout?.({ nativeEvent: { layout: { width: 320, height: 48 } } });
        });

        expect(screen.findByTestId('markdown-static-render-placeholder')).toBe(null);
        expect(animatedCapture.loopStopCount).toBe(1);
    });

    it('does not show a placeholder for web static markdown because web renders immediate fallback content', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const screen = await renderScreen(
            <MarkdownView markdown="Hello **world**" profile="transcript" />,
        );

        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });

        expect(screen.findByTestId('markdown-static-render-placeholder')).toBe(null);
        expect(animatedCapture.loopStartCount).toBe(0);
    });

    it('does not show a placeholder for streaming markdown', async () => {
        animatedCapture.platformOS = 'android';
        const { MarkdownView } = await import('./MarkdownView');

        const screen = await renderScreen(
            <MarkdownView markdown="Hello **world**" profile="transcript" streamingMode="streaming" />,
        );

        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });

        expect(screen.findByTestId('markdown-static-render-placeholder')).toBe(null);
    });
});
