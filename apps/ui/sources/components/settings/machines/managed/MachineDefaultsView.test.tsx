import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineRetentionDefaultsV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { MachineRetentionDefaultsV1Schema } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { z } from 'zod/mini';

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

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Load the real owner after transport setup, outside an individual test's deadline.
await loadSyncSingletonForTests();
const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const settingsWrite = z.object({ expectedVersion: z.number().check(z.int()), content: z.object({
  t: z.literal('plain'), v: z.record(z.string(), z.unknown()),
}) });
let home: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
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
  state.defaults = { v: 1 };
  state.writes = [];
  state.params = {};
  state.device = 'desktop';
  state.routerPush.mockReset();
  state.creationEnabled = true;
  state.creationWrites = [];
  concurrentCategoryWrite = false;
});
afterEach(async () => {
  await standardCleanup();
  await connection?.dispose();
  connection = undefined;
});

async function render() {
  const { ActionsSettingsV1Schema, setActionApprovalOverride } = await import('@happier-dev/protocol/actions/actionSettings');
  // Serve the raw persisted document; settingsParse owns the defaulted local projection.
  let current: Record<string, unknown> = {
    machineRetentionDefaultsV1: state.defaults, managedMachineCreationEnabled: state.creationEnabled,
    actionsSettingsV1: setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
      actionId: 'settings.set', surface: 'ui', approvalRequired: false }),
  };
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
  if (!connection) {
    // A credential binding alone is not the restored Account lifetime used by Settings writes.
    harness.answer(home, '/v1/account/profile', { body: AccountProfileSchema.parse({ id: 'owner' }) });
    const saved = harness.findByServerUrl('https://build.example');
    if (!saved?.token) throw new Error('Machine Defaults fixture requires its saved Home credential');
    connection = await restoreServerAccountForTest({ serverUrl: saved.serverUrl,
      serverIdentityId: 'srv_build', accountId: 'owner', credentials: { token: saved.token }, request: harness.request });
    home = connection.serverId;
    await (await import('@/sync/sync')).sync.awaitBootstrapForegroundAcquisition();
  }
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
  it('names declared provisioner kinds without a controller or a live catalog answer', async () => {
    const screen = await render();
    const local = screen.findAll(node => node.props?.testID === 'settings.machineDefaults.local.header'
      && node.props?.subtitle !== undefined)[0]?.props.subtitle;
    expect(local).toContain('Lima');
    expect(local).toContain('Lume');
    expect(local).toContain('Cua');
    expect(harness.requests.some(request => request.path.includes('/machines.provisioners.'))).toBe(false);
  });
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
    // An inherited category has nothing to reset until its real Account write is published.
    expect(screen.findByTestId('settings.machineDefaults.local.keep:reset')).toBeNull();

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

    // The applied local override now offers Reset; removing another category preserves it.
    await waitForHomeGovernance(() => expect(
      screen.findByTestId('settings.machineDefaults.local.keep:reset'),
    ).not.toBeNull());
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
    const { storage } = await import('@/sync/domains/state/storage');
    await waitForHomeGovernance(() => expect(storage.getState().settings.machineRetentionDefaultsV1).toEqual(state.writes.at(-1)));
    await waitForHomeGovernance(() => expect(screen.findByTestId('settings.machineDefaults.unknown.keep:reset')).toBeNull());
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
