import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';

import { CommandMenu } from '../CommandMenu';
import type { CommandMenuItem, CommandMenuProps } from '../commandMenuTypes';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
);
vi.mock('@legendapp/list/react-native', async () => {
  const { createLegendListModuleMock } =
    await import('@/dev/testkit/mocks/legendList');
  return await createLegendListModuleMock({
    renderItems: true,
    renderItemLimit: 20,
  });
});
// The floating surface is a platform host; the list/preview composition under it is what this test drives.
vi.mock('../CommandMenuSurface', () => ({
  CommandMenuSurface: (props: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, props.children),
}));

const previous = getStorage().getState();
afterEach(() => {
  getStorage().setState(previous, true);
});

const items: CommandMenuItem[] = [
  { id: 'a', label: 'Plan with a panel', group: 'Library' },
  { id: 'b', label: 'Fix the settings draft', group: 'Library' },
];

function menu(): React.ReactElement {
  const props: CommandMenuProps = {
    open: true,
    anchor: { kind: 'rect', rect: { left: 0, top: 0, width: 1, height: 1 } },
    query: '',
    items,
    selectedIndex: 0,
    onMoveUp: () => {},
    onMoveDown: () => {},
    onSelect: () => {},
    onRequestClose: () => {},
    testID: 'picker',
    preview: {
      content: React.createElement('PreviewProbe'),
      resizeKey: 'promptPicker',
      minListWidthPx: 240,
      minPreviewWidthPx: 320,
      preferredListRatio: 0.4,
    },
  };
  return <CommandMenu {...props} />;
}

async function layoutAt(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  width: number,
) {
  const split = screen.findHostByTestId('picker:split');
  if (!split) throw new Error('Missing list/preview split');
  await act(async () => {
    (split.props.onLayout as (event: unknown) => void)({
      nativeEvent: { layout: { width, height: 400, x: 0, y: 0 } },
    });
  });
}

describe('a command menu with a preview', () => {
  it('opens the list narrower than the preview, resizes through the shared divider and remembers the width on this device', async () => {
    getStorage().getState().applyLocalSettings({ collectionRailWidthsV1: {} });
    const screen = await renderScreen(menu());
    await layoutAt(screen, 880);
    const handle = () => screen.findHostByTestId('picker:split-resize-handle');
    // About 2:3: names on the left, the prompt's text on the right.
    expect(handle()?.props['aria-valuenow']).toBeCloseTo(352);
    await act(async () =>
      handle()!.props.onAccessibilityAction({
        nativeEvent: { actionName: 'increment' },
      }),
    );
    const adjusted = handle()!.props['aria-valuenow'];
    expect(adjusted).toBeGreaterThan(352);
    expect(
      getStorage().getState().localSettings.collectionRailWidthsV1.promptPicker,
    ).toBe(adjusted);
    await screen.unmount();
    const restored = await renderScreen(menu());
    await layoutAt(restored, 880);
    expect(
      restored.findHostByTestId('picker:split-resize-handle')?.props[
        'aria-valuenow'
      ],
    ).toBe(adjusted);
  });
});
