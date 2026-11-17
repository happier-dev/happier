import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
// The platform recycler renders one measured window; domain rows and selection stay real.
vi.mock('@legendapp/list/react-native', async () =>
  (await import('@/dev/testkit/mocks/legendList')).createLegendListModuleMock({ renderItems: true, renderItemLimit: 12 }),
);

const { ThemeDevicePickerView } = await import('./ThemeDevicePickerView');
type Props = import('./themeDevicePickerViewTypes').ThemeDevicePickerViewProps;

function props(overrides: Partial<Props> = {}): Props {
  return {
    themeName: 'Notebook',
    mode: 'light',
    state: 'ready',
    dispatching: false,
    rows: [
      {
        id: 'mac',
        label: 'MacBook Pro',
        computer: true,
        current: true,
        checked: true,
        outcome: null,
      },
      {
        id: 'office',
        label: 'Office desktop',
        computer: true,
        current: false,
        checked: false,
        outcome: null,
      },
      {
        id: 'phone',
        label: null,
        computer: false,
        current: false,
        checked: false,
        outcome: null,
      },
    ],
    onToggle: vi.fn(),
    onUse: vi.fn(),
    onRetry: vi.fn(),
    onDismiss: vi.fn(),
    testID: 'picker',
    ...overrides,
  };
}

const find = (screen: Awaited<ReturnType<typeof renderScreen>>, id: string) =>
  screen.tree.findAll(
    (node) =>
      node.props?.testID === id && typeof node.props?.onPress === 'function',
  )[0];

describe('ThemeDevicePickerView', () => {
  it('mounts device rows in the platform window while keeping offscreen choices in the Use count', async () => {
    const input = props({ rows: Array.from({ length: 200 }, (_, index) => ({
      id: `device-${index}`, label: `Device ${index}`, computer: true,
      current: index === 0, checked: index === 199, outcome: null,
    })) });
    const screen = await renderScreen(<ThemeDevicePickerView {...input} />);
    const rows = screen.tree.findAll(node => typeof node.type === 'string'
      && typeof node.props.testID === 'string' && /^picker:row:device-/.test(node.props.testID));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
    console.info('[theme-window-cost] devices', { source: input.rows.length, mounted: rows.length });
    expect(find(screen, 'picker:use')?.props.disabled).toBe(false);
    await pressTestInstanceAsync(find(screen, 'picker:row:device-1')!);
    expect(input.onToggle).toHaveBeenCalledWith('device-1');
    expect(input.onToggle).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it('lists this device as already wearing the theme and asks for a choice before Use', async () => {
    const input = props();
    const screen = await renderScreen(<ThemeDevicePickerView {...input} />);
    // With nothing chosen the picker still offers Use (not Done), and Use applies nothing.
    expect(screen.tree.findAll((node) => node.props?.testID === 'picker:use').length).toBeGreaterThan(0);
    expect(screen.tree.findAll((node) => node.props?.testID === 'picker:done').length).toBe(0);
    expect(screen.tree.findAll((node) => node.props?.testID === 'picker:use').some((node) => node.props?.disabled === true),
      'nothing chosen, nothing to apply').toBe(true);
    expect(screen.tree.findAll((node) => node.props?.testID === 'picker:row:mac').some((node) => node.props?.disabled === true),
      'this device is not a target').toBe(true);
    await pressTestInstanceAsync(find(screen, 'picker:row:office')!);
    expect(input.onToggle).toHaveBeenCalledWith('office');
    expect(input.onUse).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it('applies only through Use, and offers Done once every chosen device is applied', async () => {
    const chosen = props({
      rows: props().rows.map((row) =>
        row.id === 'office' ? { ...row, checked: true } : row,
      ),
    });
    const screen = await renderScreen(<ThemeDevicePickerView {...chosen} />);
    await pressTestInstanceAsync(find(screen, 'picker:use')!);
    expect(chosen.onUse).toHaveBeenCalledTimes(1);
    await screen.unmount();
    const applied = props({
      rows: props().rows.map((row) =>
        row.id === 'office'
          ? { ...row, checked: true, outcome: 'applied' }
          : row,
      ),
    });
    const done = await renderScreen(<ThemeDevicePickerView {...applied} />);
    expect(find(done, 'picker:use')).toBeUndefined();
    await pressTestInstanceAsync(find(done, 'picker:done')!);
    expect(applied.onDismiss).toHaveBeenCalledTimes(1);
    expect(applied.onUse).not.toHaveBeenCalled();
    await done.unmount();
  });
});
