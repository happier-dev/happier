import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { createTranscriptMotionTestRuntime, installTranscriptMotionCommonModuleMocks } from './transcriptMotionTestHelpers';
import { TranscriptMotionContext } from './TranscriptMotionContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const motionState = vi.hoisted(() => ({
    animatedValueConstructCount: 0,
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

describe('TranscriptEnterWrapper static rows', () => {
    beforeEach(() => {
        motionState.animatedValueConstructCount = 0;
    });

    it('does not allocate animated values for rows that will not animate', async () => {
        const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');

        const screen = await renderScreen(
            <TranscriptMotionContext.Provider value={createTranscriptMotionTestRuntime(61_000)}>
                <TranscriptEnterWrapper id="old-row" createdAt={1}>
                    <div>Historical row</div>
                </TranscriptEnterWrapper>
            </TranscriptMotionContext.Provider>,
        );

        expect(motionState.animatedValueConstructCount).toBe(0);
        expect(screen.findByType('div').props.children).toBe('Historical row');
    });
});
