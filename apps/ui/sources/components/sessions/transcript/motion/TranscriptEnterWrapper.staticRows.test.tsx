import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installTranscriptMotionCommonModuleMocks } from './transcriptMotionTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const motionState = vi.hoisted(() => ({
    animatedValueConstructCount: 0,
    shouldAnimate: false,
}));

installTranscriptMotionCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Animated: {
                Value: function Value(this: any, initial: number) {
                    motionState.animatedValueConstructCount += 1;
                    this.__value = initial;
                },
                timing: () => ({ start: () => undefined }),
                parallel: () => ({ start: () => undefined }),
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

vi.mock('./TranscriptMotionContext', () => ({
    useTranscriptMotion: () => ({
        config: { preset: 'full', animateNewItemsEnabled: true },
        gate: { consumeFreshness: () => motionState.shouldAnimate },
    }),
}));

describe('TranscriptEnterWrapper static rows', () => {
    beforeEach(() => {
        motionState.animatedValueConstructCount = 0;
        motionState.shouldAnimate = false;
    });

    it('does not allocate animated values for rows that will not animate', async () => {
        const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');

        await renderScreen(
            <TranscriptEnterWrapper id="old-row" createdAt={1}>
                <div />
            </TranscriptEnterWrapper>,
        );

        expect(motionState.animatedValueConstructCount).toBe(0);
    });
});
