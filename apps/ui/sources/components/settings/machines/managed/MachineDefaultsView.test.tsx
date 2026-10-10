import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineRetentionDefaultsV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit';
import { createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  defaults: { v: 1 } as MachineRetentionDefaultsV1,
  writes: [] as MachineRetentionDefaultsV1[],
  params: {} as Record<string, string>,
  device: 'desktop' as 'desktop' | 'phone',
  routerPush: vi.fn(),
  creationEnabled: true,
  creationWrites: [] as boolean[],
}));

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return {
      ...createExpoRouterMock(),
      useRouter: () => ({
        push: state.routerPush,
        replace: vi.fn(),
        back: vi.fn(),
      }),
      usePathname: () => '/settings/machines/defaults',
      useLocalSearchParams: () => state.params,
      useGlobalSearchParams: () => state.params,
    };
  },
  storage: async () => {
    const { createStorageModuleStub } =
      await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      useSettingMutable: createUseSettingMutableMockFromReader((name) => {
        if (name === 'managedMachineCreationEnabled') return [state.creationEnabled, (value: boolean) => state.creationWrites.push(value)];
        if (name === 'machineRetentionDefaultsV1') {
          return [
            state.defaults,
            (value: MachineRetentionDefaultsV1) => {
              state.writes.push(value);
            },
          ];
        }
        return [undefined, vi.fn()];
      }),
    });
  },
});

// Platform boundary: the device class decides between the in-place rows and the phone push.
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
  useDeviceType: () => state.device,
}));

beforeEach(() => {
  state.defaults = { v: 1 };
  state.writes = [];
  state.params = {};
  state.device = 'desktop';
  state.routerPush.mockReset();
  state.creationEnabled = true;
  state.creationWrites = [];
});
afterEach(() => standardCleanup());

async function render() {
  const [{ MachineDefaultsView }, { NavigationTitleChromeProvider }] = await Promise.all([
    import('./MachineDefaultsView'),
    import('@/components/ui/layout/navigationTitleChrome'),
  ]);
  return renderSettingsView(
    <NavigationTitleChromeProvider showsTitle={state.device === 'phone'}>
      <MachineDefaultsView />
    </NavigationTitleChromeProvider>,
  );
}

function detailOf(screen: Awaited<ReturnType<typeof render>>, testID: string): unknown {
  return screen.findAll((node) => node.props?.testID === testID && node.props?.detail !== undefined)[0]?.props.detail;
}

describe('MachineDefaultsView', () => {
  it('keeps the Defaults page identity in its content beneath phone Back navigation', async () => {
    state.device = 'phone';
    const screen = await render();
    const [{ t }, { getSettingsStackScreenDefinitions, resolveSettingsRouteParentPathname }] = await Promise.all([
      import('@/text'),
      import('@/components/settings/navigation/settingsRouteRegistry'),
    ]);
    const header = screen.findByTestId('settings.machineDefaults.header');
    const headings = header?.findAll((node) =>
      typeof node.type === 'string' && node.props.accessibilityRole === 'header',
    ).map((node) => node.props.children);
    expect(headings).toEqual([t('settingsMachines.defaultsTitle')]);

    const navigation = getSettingsStackScreenDefinitions(t, { navigator: 'machines' })
      .find((definition) => definition.name === 'defaults');
    expect(navigation?.options.headerShown).toBe(true);
    expect(navigation?.options.headerTitle).toBe('');
    expect(typeof navigation?.options.headerLeft).toBe('function');
    expect(resolveSettingsRouteParentPathname('/settings/machines/defaults')).toBe('/settings/machines');
    expect(state.writes).toEqual([]);
    expect(state.creationWrites).toEqual([]);
  });

  it('changes creation without changing retention defaults or existing machine policy', async () => {
    state.creationEnabled = false;
    const screen = await render();
    const control = screen.findByTestId('settings.machineDefaults.creationEnabled.switch');
    expect(control).not.toBeNull();
    expect(control!.props.value).toBe(false);
    await act(async () => control!.props.onValueChange(true));
    expect(state.creationWrites).toEqual([true]);
    expect(state.writes).toEqual([]);
  });
  it('summarizes each billing category from the D21 defaults until the person overrides one', async () => {
    state.defaults = {
      v: 1,
      'stopped-billed': {
        retention: { kind: 'unused', afterMs: 1_800_000, effect: 'delete' },
        wakeOnAcceptedMessage: false,
      },
    };
    const screen = await render();
    expect(
      detailOf(screen, 'settings.machineDefaults.local.header'),
    ).toBe('Stop after 1 h unused · wakes');
    expect(
      detailOf(screen, 'settings.machineDefaults.running-only.header'),
    ).toBe('Stop after 1 h unused · wakes');
    expect(
      detailOf(screen, 'settings.machineDefaults.stopped-billed.header'),
    ).toBe('Delete after 30 min unused');
    expect(
      detailOf(screen, 'settings.machineDefaults.unknown.header'),
    ).toBe('Until I delete it');
  });

  it('writes a category choice through the canonical preference and resets it to the default', async () => {
    state.defaults = {
      v: 1,
      unknown: {
        retention: { kind: 'until-delete' },
        wakeOnAcceptedMessage: false,
      },
    };
    const screen = await render();
    await act(async () => {
      screen.pressByTestId('settings.machineDefaults.local.header');
    });

    const field = screen.findAll(
      (node) => node.props?.itemTrigger?.title === 'When unused',
    )[0];
    expect(field).toBeTruthy();
    await act(async () => {
      field!.props.onSelect('unused:stop:1800000');
    });
    expect(state.writes.at(-1)).toEqual({
      v: 1,
      unknown: {
        retention: { kind: 'until-delete' },
        wakeOnAcceptedMessage: false,
      },
      local: {
        retention: { kind: 'unused', afterMs: 1_800_000, effect: 'stop' },
        wakeOnAcceptedMessage: true,
      },
    });

    // An inherited category has nothing to reset; an overridden one does, and Reset removes only it.
    expect(
      screen.findByTestId('settings.machineDefaults.local.keep:reset'),
    ).toBeNull();
    await act(async () => {
      screen.pressByTestId('settings.machineDefaults.unknown.header');
    });
    await act(async () => {
      screen.pressByTestId('settings.machineDefaults.unknown.keep:reset');
    });
    expect(state.writes.at(-1)).toEqual({ v: 1 });
  });

  it('offers explicit Until-delete wake off by default, preserves Stop wake defaults, and excludes destruction', async () => {
    state.defaults = {
      v: 1,
      unknown: {
        retention: { kind: 'unused', afterMs: 1_800_000, effect: 'delete' },
        wakeOnAcceptedMessage: false,
      },
    };
    const screen = await render();
    await act(async () => {
      screen.pressByTestId('settings.machineDefaults.local.header');
    });
    await act(async () => {
      screen.pressByTestId('settings.machineDefaults.stopped-billed.header');
    });
    await act(async () => {
      screen.pressByTestId('settings.machineDefaults.unknown.header');
    });
    expect(
      Boolean(screen.findByTestId('settings.machineDefaults.local.keep:wake')),
    ).toBe(true);
    expect(
      screen.findByTestId('settings.machineDefaults.local.keep:wake:switch')?.props.value,
    ).toBe(true);
    expect(
      Boolean(screen.findByTestId('settings.machineDefaults.stopped-billed.keep:wake')),
    ).toBe(true);
    const retainedWake = screen.findByTestId('settings.machineDefaults.stopped-billed.keep:wake:switch');
    expect(retainedWake?.props.value).toBe(false);
    expect(
      Boolean(screen.findByTestId('settings.machineDefaults.unknown.keep:wake')),
    ).toBe(false);
    expect(state.writes).toEqual([]);

    await act(async () => retainedWake!.props.onValueChange(true));
    expect(state.writes).toEqual([{
      v: 1,
      unknown: state.defaults.unknown,
      'stopped-billed': {
        retention: { kind: 'until-delete' },
        wakeOnAcceptedMessage: true,
      },
    }]);
  });

  it('pushes one category page on a phone and edits it there', async () => {
    state.device = 'phone';
    const list = await render();
    await act(async () => {
      list.pressByTestId('settings.machineDefaults.running-only');
    });
    expect(state.routerPush).toHaveBeenCalledWith(
      '/settings/machines/defaults?category=running-only',
    );
    list.unmount();

    state.params = { category: 'running-only' };
    const page = await render();
    const { t } = await import('@/text');
    const categoryHeader = page.findByTestId('settings.machineDefaults.category.header');
    expect(categoryHeader?.findAll((node) =>
      typeof node.type === 'string' && node.props.accessibilityRole === 'header',
    ).map((node) => node.props.children)).toEqual([t('settingsMachines.runningOnly')]);
    expect(
      page.findByTestId('settings.machineDefaults.running-only.keep:retention'),
    ).not.toBeNull();
    await act(async () => {
      page
        .findByTestId('settings.machineDefaults.running-only.keep:wake:switch')!
        .props.onValueChange(false);
    });
    expect(state.writes.at(-1)).toEqual({
      v: 1,
      'running-only': {
        retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' },
        wakeOnAcceptedMessage: false,
      },
    });
  });
});
