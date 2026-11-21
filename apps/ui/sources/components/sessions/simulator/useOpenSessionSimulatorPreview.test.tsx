import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import {
  DaemonSimulatorPreviewSnapshotRequestV1Schema,
  DaemonSimulatorPreviewSnapshotResponseV1Schema,
  SimulatorPreviewSnapshotV1Schema,
} from '@happier-dev/protocol/devices/simulator/runtimeV1';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import {
  createMachineFixture,
  flushHookEffects,
  renderScreen,
} from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionDetailsPanelCommonModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { CurrentUiContextProvider, usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { CurrentUiContextActionHost } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SimulatorPreviewPane } from '@/components/devices/simulator/SimulatorPreviewPane';
import { useSimulatorPreview } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import { DetailsTabGroupPanel } from '@/components/appShell/panes/details/workspace/DetailsTabGroupPanel';
import { t } from '@/text';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { registerMountedTabUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { detailsTabNavigationKey } from '@/components/appShell/panes/details/workspace/detailsTabLifetime';
import { createWorkspaceFileDetailsTab } from '@/components/appShell/panes/details/fileDetailsTab';

installSessionDetailsPanelCommonModuleMocks();

const bootedIphone = {
  v: 1,
  simulatorId: 'sim_1',
  platform: 'ios',
  deviceId: 'device_1',
  displayName: 'iPhone 16',
  capture: {
    status: 'available',
    sourceId: 'source_1',
    supportedCodecs: ['image.mjpeg'],
    inputMode: 'exclusive',
  },
} as const;

/** What the Home and the Session's daemon say, per case. */
const world = {
  simulatorFeature: true,
  daemon: 'listed' as 'listed' | 'empty' | 'unreachable' | 'pending',
  pending: [] as Array<(listed: boolean) => void>,
};
let snapshotReads = 0;
function snapshotResponse(listed: boolean) {
  return DaemonSimulatorPreviewSnapshotResponseV1Schema.parse({
    protocolVersion: 1,
    snapshot: SimulatorPreviewSnapshotV1Schema.parse({
      v: 1,
      machineId: 'machine-1',
      generatedAt: 1_000,
      refreshState: 'idle',
      resources: listed ? [bootedIphone] : [],
    }),
  });
}
const runtime = installSessionPaneRuntimeTestHarness({
  scopeId: ({ sessionId, serverId }) =>
    createSessionPaneScopeId(sessionId, serverId),
  features: () =>
    createRootLayoutFeaturesResponse({
      features: {
        devices: {
          enabled: true,
          simulatorPreview: { enabled: world.simulatorFeature },
        },
        // The simulator preview's declared dependencies (feature-flags catalog).
        machines: { liveStream: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true } } },
        browser: { enabled: true, viewTargets: { enabled: true } },
      },
    }),
  rpc: async (method, params) => {
    if (method !== RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT)
      throw new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND);
    expect(
      DaemonSimulatorPreviewSnapshotRequestV1Schema.parse(params).machineId,
    ).toBe('machine-1');
    snapshotReads += 1;
    if (world.daemon === 'unreachable') throw new Error('machine offline');
    if (world.daemon === 'pending')
      return await new Promise((resolve) =>
        world.pending.push((listed) => resolve(snapshotResponse(listed))),
      );
    return snapshotResponse(world.daemon === 'listed');
  },
});

beforeEach(() => {
  world.simulatorFeature = true;
  world.daemon = 'listed';
  world.pending = [];
  snapshotReads = 0;
  storage.getState().applySettingsLocal({ experiments: true });
  storage
    .getState()
    .applyMachines(
      [createMachineFixture({ storageMode: 'plain', activeAt: Date.now() })],
      true,
      { sourceServerId: runtime.serverId },
    );
});

const { useOpenSessionSimulatorPreview } =
  await import('./useOpenSessionSimulatorPreview');

let opener: ReturnType<typeof useOpenSessionSimulatorPreview> = null;
let initiallyActive = true;
let setMenuActive: (active: boolean) => void = () => {};
let showViewer = false;
let showRealMenu = false;
const resources = SimulatorPreviewSnapshotV1Schema.parse({
  v: 1, machineId: 'machine-1', generatedAt: 1_000, refreshState: 'idle',
  resources: [bootedIphone, { ...bootedIphone, simulatorId: 'sim_2', deviceId: 'device_2', displayName: 'iPhone 17' }],
}).resources;
function Viewer() {
  const preview = useSimulatorPreview({ viewerId: 'viewer-test', resources });
  return <SimulatorPreviewPane {...preview} testID="command-preview" />;
}
function Publication() {
  const commands = useCurrentUiContextComposedCommands();
  usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
  return null;
}
function Details() {
  const pane = useAppPaneScope(createSessionPaneScopeId('s1', runtime.serverId));
  const group = pane.scopeState?.details.groups?.[0];
  return group ? <DetailsTabGroupPanel pane={pane} group={group} renderTabContent={() => null} /> : null;
}
function OpenerProbe() {
  const [active, setActive] = React.useState(initiallyActive);
  setMenuActive = setActive;
  opener = useOpenSessionSimulatorPreview({
    sessionId: 's1',
    serverId: runtime.serverId,
    active,
  });
  return null;
}
function Probe() {
  return <>{showRealMenu
    ? <SessionHeaderActionMenu sessionId="s1" session={storage.getState().sessions.s1!} />
    : <OpenerProbe />}{showViewer ? <Viewer /> : null}<Details /></>;
}

/** Mounts after the Home's feature snapshot has settled, so the opener reads its current decision. */
async function mount(active = true) {
  opener = null;
  initiallyActive = active;
  const { getServerFeaturesSnapshot } =
    await import('@/sync/api/capabilities/serverFeaturesClient');
  // The harness restores the Home before a case sets its world; re-read the Home's answer.
  await getServerFeaturesSnapshot({ serverId: runtime.serverId, force: true });
  const screen = await renderScreen(
    <runtime.Wrapper>
      <MainAppTabStateProvider><CurrentUiContextProvider>
        <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
          <CurrentUiContextActionHost /><Publication /><Probe />
        </PluginSurfaceFocusEligibilityProvider>
      </CurrentUiContextProvider></MainAppTabStateProvider>
    </runtime.Wrapper>,
  );
  await flushHookEffects({ turns: 4 });
  return screen;
}

async function invokeCommand(title: string) {
  const executor = createDefaultActionExecutor();
  const context = { surface: 'agent', authority: 'present_user' } as const;
  const read = await executor.execute('ui.current_context.read', {}, context);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error('Current context unavailable');
  const snapshot = CurrentUiContextSnapshotV1Schema.parse(read.result);
  const command = snapshot.commands.find(entry => entry.title === title);
  expect(command, title).toBeDefined();
  return executor.execute('ui.current_context.command.invoke', { commandId: command!.id }, context);
}

function simulatorTabs() {
  const details = runtime.pane.scopeState?.details;
  return (details?.tabs ?? []).filter(
    (tab) =>
      (tab.resource as { kind?: unknown } | null)?.kind === 'simulatorPreview',
  );
}

describe('useOpenSessionSimulatorPreview', () => {
  it('opens a cold Session menu by agent intent before discovering and opening the preview', async () => {
    showRealMenu = true;
    try {
      await mount(false);
      expect(snapshotReads).toBe(0);
      await act(async () => { expect(await invokeCommand(t('session.actionMenu.openA11y'))).toMatchObject({ ok: true }); });
      await waitForHomeGovernance(() => expect(snapshotReads).toBe(1));
      await flushHookEffects({ turns: 4 });
      await act(async () => { expect(await invokeCommand(t('simulatorPreview.title'))).toMatchObject({ ok: true }); });
      expect(simulatorTabs()).toHaveLength(1);
    } finally { showRealMenu = false; }
  });
  it('lets an agent open the preview and close simulator and ordinary Details tabs through mounted commands', async () => {
    await mount();
    await waitForHomeGovernance(() => expect(opener).not.toBeNull());
    await act(async () => { expect(await invokeCommand(t('simulatorPreview.title'))).toMatchObject({ ok: true }); });
    expect(simulatorTabs()).toHaveLength(1);
    await act(async () => { expect(await invokeCommand(`${t('session.detailsPanel.closeTabA11y')}: ${t('simulatorPreview.title')}`)).toMatchObject({ ok: true }); });
    expect(simulatorTabs()).toHaveLength(0);
    const fileTab = createWorkspaceFileDetailsTab('a.txt');
    await act(async () => runtime.pane.openDetailsTab(fileTab, { intent: 'pinned' }));
    let decisions = 0;
    const unregister = registerMountedTabUnsavedChangesGuard(detailsTabNavigationKey(runtime.pane.scopeId, fileTab.key), {
      isDirtyRef: { current: true }, tag: 'file-editor', requestDecision: async () => { decisions += 1; return 'keepEditing'; },
    });
    try {
      let result: Awaited<ReturnType<typeof invokeCommand>> | undefined;
      await act(async () => { result = await invokeCommand(`${t('session.detailsPanel.closeTabA11y')}: a.txt`); });
      expect(runtime.pane.scopeState?.details.tabs).toHaveLength(1);
      expect(decisions).toBe(1);
      expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_action', error: 'stale_surface' });
    } finally { unregister(); }
    await act(async () => { expect(await invokeCommand(`${t('session.detailsPanel.closeTabA11y')}: a.txt`)).toMatchObject({ ok: true }); });
    expect(runtime.pane.scopeState?.details.tabs).toHaveLength(0);
  });

  it('selects the actual preview device through an agent command', async () => {
    showViewer = true;
    try {
      const screen = await mount();
      await act(async () => { expect(await invokeCommand(`${t('simulatorPreview.viewer.switchDevice')}: iPhone 17`)).toMatchObject({ ok: true }); });
      expect(screen.findByTestId('command-preview-bar-title')?.props.children).toBe('iPhone 17');
    } finally { showViewer = false; }
  });
  it('does not read the daemon until the menu opens, then discovers the simulator', async () => {
    await mount(false);
    expect(snapshotReads).toBe(0);
    expect(opener).toBeNull();
    await act(async () => setMenuActive(true));
    await waitForHomeGovernance(() => expect(opener).not.toBeNull());
    expect(snapshotReads).toBe(1);
  });

  it('opens one Simulator tab in Details and focuses it again instead of duplicating it', async () => {
    await mount();
    await waitForHomeGovernance(() => expect(opener).not.toBeNull());

    await act(async () => {
      opener!.open();
    });
    expect(runtime.pane.scopeState!.details.isOpen).toBe(true);
    expect(simulatorTabs()).toHaveLength(1);
    const simulatorKey = simulatorTabs()[0]!.key;

    const otherTab = {
      key: 'file:a',
      kind: 'file',
      title: 'a',
      resource: { kind: 'file', path: 'a' },
    } as const;
    await act(async () => {
      runtime.pane.openDetailsTab(otherTab, { intent: 'pinned' });
    });
    expect(runtime.pane.scopeState!.details.activeTabKey).toBe('file:a');

    await act(async () => {
      opener!.open();
    });
    expect(simulatorTabs()).toHaveLength(1);
    expect(runtime.pane.scopeState!.details.activeTabKey).toBe(simulatorKey);
  });

  it('offers nothing while the Home has simulator previews off, without asking the daemon', async () => {
    world.simulatorFeature = false;
    await mount();
    expect(opener).toBeNull();
    expect(snapshotReads).toBe(0);
  });

  it.each(['empty', 'unreachable'] as const)(
    "offers nothing when the Session's daemon is %s",
    async (daemon) => {
      world.daemon = daemon;
      await mount();
      await waitForHomeGovernance(() => expect(snapshotReads).toBe(1));
      await flushHookEffects({ turns: 4 });
      expect(opener).toBeNull();
    },
  );

  it('asks the daemon again on reopening and keeps its last answer meanwhile', async () => {
    await mount();
    await waitForHomeGovernance(() => expect(opener).not.toBeNull());
    const reads = snapshotReads;
    await act(async () => setMenuActive(false));
    expect(snapshotReads).toBe(reads);

    world.daemon = 'pending';
    await act(async () => {
      setMenuActive(true);
    });
    await waitForHomeGovernance(() => expect(snapshotReads).toBe(reads + 1));
    expect(opener).not.toBeNull();

    await act(async () => {
      world.pending.shift()!(false);
    });
    await waitForHomeGovernance(() => expect(opener).toBeNull());
  });
});
