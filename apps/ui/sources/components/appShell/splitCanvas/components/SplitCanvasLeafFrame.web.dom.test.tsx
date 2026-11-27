/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'react-native';
import { SplitCanvasLeafFrame } from './SplitCanvasLeafFrame';

// RNW supplies the real DOM host, so the exposed role and name are what a browser's accessibility tree reads.
vi.mock('react-native', () => vi.importActual('react-native-web'));
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

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  vi.unstubAllGlobals();
});

async function renderFrame(accessibilityLabel: string | undefined) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SplitCanvasLeafFrame
        leafId="group:1"
        accessibilityLabel={accessibilityLabel}
        isFocused={false}
        isMaximized={false}
        showControls={false}
        showFocusRing={false}
        onFocus={() => {}}
        onClose={() => {}}
        onToggleMaximize={() => {}}
      >
        <Text>Pane body</Text>
      </SplitCanvasLeafFrame>,
    );
  });
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container.querySelector<HTMLElement>(
    '[data-testid="split-canvas-leaf-frame-group:1"]',
  );
}

describe('SplitCanvasLeafFrame on the web', () => {
  it('exposes a named pane as a region, never a name on a generic container (C77 F1)', async () => {
    const frame = await renderFrame('Browser');
    expect(frame?.getAttribute('aria-label')).toBe('Browser');
    expect(frame?.getAttribute('role')).toBe('region');
  });
  it('claims no landmark for a pane without a name', async () => {
    const frame = await renderFrame(undefined);
    expect(frame?.getAttribute('role')).toBeNull();
  });
});
