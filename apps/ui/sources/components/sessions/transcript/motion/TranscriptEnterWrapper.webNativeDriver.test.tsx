import * as React from 'react';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installTranscriptMotionCommonModuleMocks } from './transcriptMotionTestHelpers';


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
          capturedTimingConfigs.push(config);
          return { start: () => undefined };
        },
        parallel: (_anims: any[]) => ({ start: () => undefined }),
      },
      View: (props: any) => React.createElement('View', props, props.children),
    });
  },
});

vi.mock('./TranscriptMotionContext', () => ({
  useTranscriptMotion: () => ({
    config: { preset: 'full', animateNewItemsEnabled: true },
    gate: { consumeFreshness: () => true },
  }),
}));

describe('TranscriptEnterWrapper (web native driver)', () => {
  beforeEach(() => {
    capturedTimingConfigs = [];
  });

  it('does not use native driver on web (avoids Animated warnings and jitter)', async () => {
    const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');

    await renderScreen(<TranscriptEnterWrapper id="m1" createdAt={1}>
          <div />
        </TranscriptEnterWrapper>);
    await flushHookEffects();

    expect(capturedTimingConfigs.length).toBeGreaterThan(0);
    for (const cfg of capturedTimingConfigs) {
      expect(cfg.useNativeDriver).toBe(false);
    }
  });

  it('does not animate translateY on web (avoids hit-target overlap during enter)', async () => {
    const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');

    await renderScreen(<TranscriptEnterWrapper id="m1" createdAt={1}>
          <div />
        </TranscriptEnterWrapper>);
    await flushHookEffects();

    // The translateY timing uses `toValue: 0`. On web we skip it to avoid
    // temporarily overlapping neighboring rows and intercepting pointer events.
    expect(capturedTimingConfigs.some((cfg) => cfg?.toValue === 0)).toBe(false);
  });
});
