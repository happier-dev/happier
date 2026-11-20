import * as React from 'react';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { getWidgetSizeFootprintV1 } from '@happier-dev/protocol/widgets';

import { act, createMachineFixture, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/atmosphere/glyph/glyphAtlas.native', async () => ({
  glyphAtlas: (await import('@/dev/testkit/mocks/reactNativeSkia')).createGlyphAtlasRasterMock,
}));

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest, captureMachinePresenceObservation } = await import('@/sync/domains/machines/reachability/machineReachability');
const { YourHomeWidgetBody } = await import('./YourHomeWidgetBody');
const { HomeOrbitMap } = await import('@/components/atmosphere/orbit/HomeOrbitMap');
const before = storage.getState();

afterEach(async () => {
  await standardCleanup();
  storage.setState(before, true);
  clearMachineRequestReachabilityForTest();
  network.resetRequests();
});
afterAll(() => network.dispose());

it('keeps the Your Home map and readable Machine legend on the shared reach owner without probing', async () => {
  const home = await network.addHome('https://your-home-shared-map.test', 'account-home');
  setActiveServerId(home.id);
  const scope = { serverId: home.id, accountId: 'account-home' };
  const machine = createMachineFixture({ id: 'studio', active: true, activeAt: Date.now(),
    metadata: { ...createMachineFixture().metadata!, displayName: 'Studio' } });
  storage.setState(state => ({ profileScope: scope, profile: { ...state.profile, id: scope.accountId },
    machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] } }));
  captureMachinePresenceObservation(scope)([machine.id]);
  network.resetRequests();
  const screen = await renderScreen(
    <WidgetPresentationProvider value={{ size: 'full', footprint: getWidgetSizeFootprintV1('home', 'full')!,
      geometry: { width: 900, height: 360 } }}>
      <YourHomeWidgetBody testID="your-home" />
    </WidgetPresentationProvider>,
  );
  try {
    const map = () => screen.findAllByType(HomeOrbitMap)[0]!;
    await vi.waitFor(() => expect(map()?.props.scene.moons).toEqual([expect.objectContaining({ key: 'studio', off: false })]));
    expect(screen.findByTestId('your-home.machine.studio')?.props.accessibilityLabel).toContain('Studio');
    const retained = map();
    await act(async () => recordMachineRequestFailed({ ...scope, machineId: 'studio' }));
    expect(map()).toBe(retained);
    expect(map().props.scene.moons).toEqual([expect.objectContaining({ key: 'studio', off: true })]);
    expect(screen.findByTestId('your-home.machine.studio')).not.toBeNull();
    expect(network.requests).toEqual([]);
  } finally { await screen.unmount(); }
});

it('does not redraw the Your Home map when a Session write changes no Machine\u2019s session states', async () => {
  const home = await network.addHome('https://your-home-quiet-map.test', 'account-home');
  setActiveServerId(home.id);
  const scope = { serverId: home.id, accountId: 'account-home' };
  const machine = createMachineFixture({ id: 'studio', active: true, activeAt: Date.now(),
    metadata: { ...createMachineFixture().metadata!, displayName: 'Studio' } });
  storage.setState(state => ({ profileScope: scope, profile: { ...state.profile, id: scope.accountId },
    machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] } }));
  captureMachinePresenceObservation(scope)([machine.id]);
  const session = createSessionFixture({ id: 'elsewhere', active: false, updatedAt: 10 });
  await act(async () => storage.getState().applySessions([session]));
  let renders = 0;
  const screen = await renderScreen(
    <React.Profiler id="your-home" onRender={() => { renders += 1; }}>
      <WidgetPresentationProvider value={{ size: 'full', footprint: getWidgetSizeFootprintV1('home', 'full')!,
        geometry: { width: 900, height: 360 } }}>
        <YourHomeWidgetBody testID="your-home" />
      </WidgetPresentationProvider>
    </React.Profiler>,
  );
  try {
    await vi.waitFor(() => expect(screen.findAllByType(HomeOrbitMap)[0]?.props.scene.moons).toEqual([expect.objectContaining({ key: 'studio' })]));
    renders = 0;
    for (let i = 1; i <= 3; i++) {
      await act(async () => storage.getState().applySessions([{ ...session, updatedAt: 10 + i, seq: 1 + i }]));
    }
    expect(renders).toBe(0);
  } finally { await screen.unmount(); }
});
