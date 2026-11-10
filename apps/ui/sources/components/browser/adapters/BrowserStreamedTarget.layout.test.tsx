import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

// Frame measurement is an OS image boundary absent from the host renderer.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock, createMeasuredImageMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Image: createMeasuredImageMock({ width: 1280, height: 800 }) });
});

import {
  BrowserStreamedTarget,
  type BrowserStreamedPageRect,
  type BrowserStreamedSurfaceRuntime,
} from './BrowserStreamedTarget';

/** A frame the player has drawn: a 1280×800 desktop page the agent's viewer sized, watched from a narrow pane. */
function watchedRuntime(): BrowserStreamedSurfaceRuntime {
  return {
    machineName: 'NLDW4',
    playerState: {
      phase: 'playing',
      selectedCodec: null,
      activeRenderer: 'image',
      lastFrameUrl: 'data:image/png;base64,AA==',
      lastFrameAtMs: 1,
      decodedFrames: 1,
      droppedFrames: 0,
      bufferedBytes: 0,
      diagnostic: null,
      renderEvent: null,
    } as unknown as NonNullable<BrowserStreamedSurfaceRuntime['playerState']>,
    input: {
      sourceId: 'source_1',
      streamId: 'stream_1',
      send: () => {},
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    },
  };
}

describe('BrowserStreamedTarget page placement', () => {
  it('draws a watched page across the pane width from the top, not centred between grey bars', async () => {
    const rects: (BrowserStreamedPageRect | null)[] = [];
    const onPageRectChange = vi.fn((rect: BrowserStreamedPageRect | null) => {
      rects.push(rect);
    });
    const screen = await renderScreen(
      <BrowserStreamedTarget
        runtime={watchedRuntime()}
        agentName="Agent"
        onPageRectChange={onPageRectChange}
        testID="stream"
      />,
    );
    await act(async () => {
      screen
        .findHostByTestId('stream-live')
        ?.props.onLayout({
          nativeEvent: { layout: { x: 0, y: 0, width: 380, height: 700 } },
        });
    });
    const rect = rects.filter(Boolean).at(-1);
    expect(rect).toMatchObject({ x: 0, y: 0, width: 380 });
    expect(rect?.height).toBeCloseTo(237.5);
  });
});
