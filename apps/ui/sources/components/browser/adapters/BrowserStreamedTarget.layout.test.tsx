import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

// Frame measurement is an OS image boundary absent from the host renderer.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock, createMeasuredImageMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Image: createMeasuredImageMock({ width: 1280, height: 800 }) });
});

// The primary-pointer media queries are the platform boundary: the control bar stands only for a finger.
const pointer = vi.hoisted(() => ({ coarse: false }));
Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: (query: string) => ({
  matches: query === '(pointer: coarse)' || query === '(hover: none)' ? pointer.coarse
    : query === '(pointer: fine)' || query === '(hover: hover)' ? !pointer.coarse : false,
  media: query, onchange: null, addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
}) });
afterEach(() => { pointer.coarse = false; });

import {
  BrowserStreamedTarget,
  type BrowserStreamedPageRect,
  type BrowserStreamedSurfaceRuntime,
} from './BrowserStreamedTarget';

/** A frame the player has drawn: a 1280×800 desktop page the agent's viewer sized, watched from a narrow pane. */
function watchedRuntime(viewport = { width: 1280, height: 800, deviceScaleFactor: 1 }): BrowserStreamedSurfaceRuntime {
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
      viewport,
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

  it('draws a page smaller than the pane at its own size, centred, never blown up (DESIGN-ACCEPT-138 fix 21)', async () => {
    const rects: (BrowserStreamedPageRect | null)[] = [];
    const screen = await renderScreen(
      <BrowserStreamedTarget
        runtime={watchedRuntime({ width: 390, height: 500, deviceScaleFactor: 3 })}
        agentName="Agent"
        onPageRectChange={rect => { rects.push(rect); }}
        testID="stream"
      />,
    );
    await act(async () => {
      screen.findHostByTestId('stream-live')?.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 598, height: 760 } },
      });
    });
    expect(rects.filter(Boolean).at(-1)).toMatchObject({ x: 104, y: 130, width: 390, height: 500 });
  });

  it('fits a controlled page above the finger\'s control bar, so the bar has its own row and covers no page', async () => {
    pointer.coarse = true;
    const rects: (BrowserStreamedPageRect | null)[] = [];
    const runtime = watchedRuntime({ width: 390, height: 700, deviceScaleFactor: 3 });
    const controlled: BrowserStreamedSurfaceRuntime = { ...runtime, input: { ...runtime.input!,
      viewerInput: { controlling: true, controlEpoch: 1 } as NonNullable<NonNullable<BrowserStreamedSurfaceRuntime['input']>['viewerInput']>,
      sendInput: vi.fn() } };
    const screen = await renderScreen(
      <BrowserStreamedTarget runtime={controlled} agentName="Agent" onPageRectChange={rect => { rects.push(rect); }} testID="stream" />,
    );
    await act(async () => {
      screen.findHostByTestId('stream-live')?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } } });
    });
    // The bar stands 12 above the stage's foot and is 128 tall: its top edge is at 560.
    await act(async () => {
      screen.findHostByTestId('stream-input-controls')!.props.onLayout({ nativeEvent: { layout: { x: 12, y: 560, width: 366, height: 128 } } });
    });
    const rect = rects.filter(Boolean).at(-1)!;
    expect(rect.y + rect.height).toBeLessThanOrEqual(560);
    // Taking control brings the presence capsule in under the stage: the stage shortens to 470, and the bar
    // reports its new place before the stage does. The page still ends above the bar.
    await act(async () => {
      screen.findHostByTestId('stream-input-controls')!.props.onLayout({ nativeEvent: { layout: { x: 12, y: 330, width: 366, height: 128 } } });
    });
    await act(async () => {
      screen.findHostByTestId('stream-live')?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 470 } } });
    });
    const shortened = rects.filter(Boolean).at(-1)!;
    expect(shortened.y + shortened.height).toBeLessThanOrEqual(330);
    await screen.unmount();
  });
});
