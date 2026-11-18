import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WORKSPACE_OPEN_IN_WINDOW_ID } from '@/components/appShell/workspace/useWorkspaceOpenActions';

// Native host acquisition is the real external boundary; role selection and the shared builder stay real.
vi.hoisted(() => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) =>
    command === 'desktop_host_get_availability'
      ? {
          activity: { kind: 'available' },
          pet: { kind: 'available' },
          windows: { kind: 'available' },
        }
      : undefined,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      pathname: '/',
    }).module,
);

const { NotchConversationMenu } = await import('./DesktopActivityOverlayFaces');

afterEach(() => {
  standardCleanup();
});

const target = { serverId: 'home', sessionId: 'session-1' };

describe('Notch conversation menu', () => {
  it('takes its window item from the shared open builder and adds the overlay as its second presentation', async () => {
    const onOpenIn = vi.fn();
    const screen = await renderScreen(
      <NotchConversationMenu
        target={target}
        handlers={{ onOpen: vi.fn(), onOpenIn }}
        testID="session-menu"
        trigger={() => <React.Fragment />}
      />,
    );
    const menu = () => screen.tree.findByType(DropdownMenu);
    await vi.waitFor(() =>
      expect(menu().props.items.map((item: { id: string }) => item.id)[0]).toBe(
        WORKSPACE_OPEN_IN_WINDOW_ID,
      ),
    );
    const ids = menu().props.items.map((item: { id: string }) => item.id);
    expect(ids).toHaveLength(2);
    await act(async () => {
      menu().props.onSelect(ids[0]);
    });
    await act(async () => {
      menu().props.onSelect(ids[1]);
    });
    expect(onOpenIn.mock.calls).toEqual([
      [target, 'window'],
      [target, 'overlay'],
    ]);
  });
});
