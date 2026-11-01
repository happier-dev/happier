import * as React from 'react';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createTranscriptMotionTestRuntime, installTranscriptMotionCommonModuleMocks } from './transcriptMotionTestHelpers';
import { TranscriptMotionContext } from './TranscriptMotionContext';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedTimingConfigs: any[] = [];

installTranscriptMotionCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      Platform: {
        OS: 'web',
      },
      Animated: {
        Value: function Value(this: any, initial: number) {
          this.__value = initial;
        },
        timing: (_value: any, config: any) => {
          return { start: () => { capturedTimingConfigs.push(config); } };
        },
        parallel: (_anims: any[]) => ({ start: () => undefined }),
      },
      View: (props: any) => React.createElement('View', props, props.children),
    });
  },
});

describe('TranscriptEnterWrapper (web native driver)', () => {
  beforeEach(() => {
    capturedTimingConfigs = [];
  });

  it('starts an opacity-only animation on commit without the native driver or a layout event', async () => {
    const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');

    await renderScreen(
      <TranscriptMotionContext.Provider value={createTranscriptMotionTestRuntime(1_000)}>
        <TranscriptEnterWrapper id="m1" createdAt={990}>
          <div />
        </TranscriptEnterWrapper>
      </TranscriptMotionContext.Provider>,
    );
    await flushHookEffects();

    expect(capturedTimingConfigs).toHaveLength(1);
    expect(capturedTimingConfigs[0]).toMatchObject({ toValue: 1, useNativeDriver: false });
  });
});
