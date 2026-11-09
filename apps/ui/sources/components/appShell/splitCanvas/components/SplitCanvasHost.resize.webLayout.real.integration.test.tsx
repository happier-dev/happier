// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';

import { SplitCanvasHost } from './SplitCanvasHost';
import type { SplitCanvasLeafNode } from '../model/splitCanvasTypes';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  const { StyleSheet } =
    await vi.importActual<typeof import('react-native')>('react-native-web');
  return createUnistylesMock({
    styleSheet: { absoluteFillObject: StyleSheet.absoluteFillObject },
  });
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const SINGLE_LEAF: SplitCanvasLeafNode<null> = { kind: 'leaf', id: 'group:1', leafKind: 'tabs', payload: null };

function Canvas(props: Readonly<{ widthPx: number }>) {
  return (
    <View testID="window" style={{ width: props.widthPx, height: 600 }}>
      <SplitCanvasHost
        state={{
          root: SINGLE_LEAF,
          focusedLeafId: 'group:1',
          maximizedLeafId: null,
        }}
        dispatch={() => {}}
        keyboardEnabled={false}
        getLeafMinimumSizePx={() => ({ width: 320, height: 100 })}
        renderLeafHeader={() => <View style={{ height: 40 }} />}
        retainedLeafContents={[
          {
            id: 'session',
            leafId: 'group:1',
            isActive: true,
            render: () => <View testID="session-content" style={{ flex: 1 }} />,
          },
        ]}
      />
    </View>
  );
}

describe('a workspace leaf, as a browser lays it out across a window resize', () => {
  it('follows the window to a phone width before the host is measured again', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Canvas widthPx={1060} />);
    });
    // The desktop window is measured: the host and the leaf's content slot know their 1060 px.
    await measureWebLayout(host, {
      viewport: { width: 1060, height: 700 },
      settle: (replay) => act(replay),
    });
    expect(
      host.querySelector('[data-testid="session-content"]'),
    ).not.toBeNull();

    // The window narrows; the browser lays out the new frame before any `onLayout` arrives.
    await act(async () => {
      root!.render(<Canvas widthPx={390} />);
    });
    const narrowed = await measureWebLayout(host, {
      viewport: { width: 400, height: 700 },
    });
    const window = narrowed.rect('window');
    const content = narrowed.rect('session-content');
    expect(content.right).toBeLessThanOrEqual(window.right + 0.5);
    expect(content.right).toBeCloseTo(window.right, 0);
  });
});
