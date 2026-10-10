import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineRetentionDefaultsV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { MachineRetentionDefaultsV1Schema } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { z } from 'zod';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
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
  storage: 'real',
});

// Only Metro's lazy loader is substituted; the canonical Action/settings/CAS logic stays real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const settingsWrite = z.object({ expectedVersion: z.number().int(), content: z.object({
  t: z.literal('plain'), v: z.record(z.string(), z.unknown()),
}) });
let home: string;
let concurrentCategoryWrite = false;

// Platform boundary: the device class decides between the in-place rows and the phone push.
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
  useDeviceType: () => state.device,
}));

beforeEach(async () => {
  await harness.reset();
  resetScopedHomeActionExecutorsForTests();
  await loadSyncSingletonForTests();
  home = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
  await harness.requireUiApproval(home, 'settings.set');
  state.defaults = { v: 1 };
  state.writes = [];
  state.params = {};
  state.device = 'desktop';
  state.routerPush.mockReset();
  state.creationEnabled = true;
  state.creationWrites = [];
  concurrentCategoryWrite = false;
});
afterEach(() => standardCleanup());

async function render() {
  const { storage } = await import('@/sync/domains/state/storage');
  const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
  let current: Record<string, unknown> = { ...storage.getState().settings,
    machineRetentionDefaultsV1: state.defaults, managedMachineCreationEnabled: state.creationEnabled,
    actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } }),
  };
  const { settingsParse } = await import('@/sync/domains/settings/settings');
  storage.setState({ settings: settingsParse(current), settingsVersion: 1 });
  let version = 1;
  harness.answer(home, '/v2/account/settings', { select: () => ({ body: { content: { t: 'plain', v: current }, version } }) });
  harness.answer(home, 'POST /v2/account/settings', { select: input => {
    const request = settingsWrite.parse(input);
    // Another client changes only its category after our baseline read, before our CAS arrives.
    if (concurrentCategoryWrite) {
      concurrentCategoryWrite = false;
      current = { ...current, machineRetentionDefaultsV1: { v: 1, unknown: {
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
      } } };
      version += 1;
    }
    if (request.expectedVersion !== version) return { status: 409, body: { success: false, error: 'version-mismatch', currentVersion: version, currentContent: { t: 'plain', v: current } } };
    if (JSON.stringify(request.content.v.machineRetentionDefaultsV1) !== JSON.stringify(current.machineRetentionDefaultsV1)) {
      state.writes.push(MachineRetentionDefaultsV1Schema.parse(request.content.v.machineRetentionDefaultsV1));
    }
    if (request.content.v.managedMachineCreationEnabled !== current.managedMachineCreationEnabled) {
      state.creationWrites.push(z.boolean().parse(request.content.v.managedMachineCreationEnabled));
    }
    current = request.content.v;
    version += 1;
    return { body: { success: true, version } };
  } });
  const [{ MachineDefaultsView }, { NavigationTitleChromeProvider }] = await Promise.all([
    import('./MachineDefaultsView'),
    import('@/components/ui/layout/navigationTitleChrome'),
  ]);
  const screen = await renderSettingsView(
    <NavigationTitleChromeProvider showsTitle={state.device === 'phone'}>
      <MachineDefaultsView />
    </NavigationTitleChromeProvider>,
  );
  await waitForHomeGovernance(() => {
    const control = screen.findByTestId('settings.machineDefaults.creationEnabled.switch')
      ?? screen.findByTestId(`settings.machineDefaults.${state.params.category}.keep:retention`);
    expect(control).not.toBeNull();
    expect(control!.props.disabled).not.toBe(true);
  });
  return screen;
}

function detailOf(screen: Awaited<ReturnType<typeof render>>, testID: string): unknown {
  return screen.findAll((node) => node.props?.testID === testID && node.props?.detail !== undefined)[0]?.props.detail;
}

describe('MachineDefaultsView', () => {
  it('rebases a category choice after another client changes a different category', async () => {
    const screen = await render();
    await act(async () => { screen.pressByTestId('settings.machineDefaults.local.header'); });
    const field = screen.findAll(node => node.props?.itemTrigger?.title === 'When unused')[0];
    expect(field).toBeTruthy();
    concurrentCategoryWrite = true;
    await act(async () => field!.props.onSelect('unused:stop:1800000'));
    await waitForHomeGovernance(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toEqual({ v: 1,
      unknown: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
      local: { retention: { kind: 'unused', afterMs: 1_800_000, effect: 'stop' }, wakeOnAcceptedMessage: true },
    });
    expect(harness.requestsFor('/v2/account/settings').flatMap(request => {
      const parsed = settingsWrite.safeParse(request.input);
      return parsed.success ? [parsed.data.expectedVersion] : [];
    })).toEqual([1, 2]);
  });

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
    await waitForHomeGovernance(() => expect(state.creationWrites).toEqual([true]));
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
    await waitForHomeGovernance(() => expect(state.writes).toHaveLength(1));
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
    await waitForHomeGovernance(() => expect(state.writes).toHaveLength(2));
    expect(state.writes.at(-1)).toEqual({ v: 1, local: {
      retention: { kind: 'unused', afterMs: 1_800_000, effect: 'stop' },
      wakeOnAcceptedMessage: true,
    } });
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
    await waitForHomeGovernance(() => expect(state.writes).toHaveLength(1));
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
    await waitForHomeGovernance(() => expect(state.writes).toHaveLength(1));
    expect(state.writes.at(-1)).toEqual({
      v: 1,
      'running-only': {
        retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' },
        wakeOnAcceptedMessage: false,
      },
    });
  });
});
