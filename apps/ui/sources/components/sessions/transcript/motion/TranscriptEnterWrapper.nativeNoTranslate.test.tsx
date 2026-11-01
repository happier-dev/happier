import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

import { createTranscriptMotionTestRuntime, installTranscriptMotionCommonModuleMocks } from './transcriptMotionTestHelpers';
import { TranscriptMotionContext } from './TranscriptMotionContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedTimingConfigs: any[] = [];
let constructedAnimatedInitialValues: number[] = [];

installTranscriptMotionCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
            Animated: {
                Value: function Value(this: any, initial: number) {
                    constructedAnimatedInitialValues.push(initial);
                    this.__value = initial;
                    this.setValue = (next: number) => { this.__value = next; };
                },
                timing: (_value: any, config: any) => {
                    capturedTimingConfigs.push(config);
                    return { start: () => undefined };
                },
                parallel: (_anims: any[]) => ({ start: () => undefined }),
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

/**
 * J/D4: a fresh row enters by fade only, on NATIVE too. The previous code read
 * `const animateTranslateOnWeb = Platform.OS !== 'web'` — true on native — so native rows also slid
 * 6px, twice per send (the pending row and its committed twin), while web faded. That asymmetry was
 * invisible in the identifier and is native-only movement inside the send window.
 */
describe('TranscriptEnterWrapper (native)', () => {
    beforeEach(() => {
        capturedTimingConfigs = [];
        constructedAnimatedInitialValues = [];
    });

    it('animates opacity only — no translate timing and no transform on the row', async () => {
        const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');

        const screen = await renderScreen(
            <TranscriptMotionContext.Provider value={createTranscriptMotionTestRuntime(1_000)}>
                <TranscriptEnterWrapper id="m1" createdAt={990}>
                    <div />
                </TranscriptEnterWrapper>
            </TranscriptMotionContext.Provider>,
        );
        await flushHookEffects();

        const animatedView = screen.findByType('Animated.View');
        expect(animatedView.props.style?.transform).toBeUndefined();

        expect(capturedTimingConfigs).toHaveLength(1);
        // The translate timing was the only `toValue: 0` animation; opacity animates to 1.
        expect(capturedTimingConfigs[0]?.toValue).toBe(1);
        expect(capturedTimingConfigs.some((cfg) => cfg?.toValue === 0)).toBe(false);
        expect(constructedAnimatedInitialValues).toEqual([0]);
    });
});
