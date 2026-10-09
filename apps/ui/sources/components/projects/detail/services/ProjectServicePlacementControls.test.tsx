import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceExecutionSettingsV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { buildLocalServiceRows } from '@/sync/domains/local/services/serviceRow';

import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storage';

const remote = vi.hoisted(() => vi.fn());
// The addressed daemons are the network boundary; placement, relocation and Action policy stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: remote }),
);
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    View: 'View',
    ScrollView: 'ScrollView',
    TextInput: 'TextInput',
  });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key) => key,
  }),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

let fixture:
  | Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>
  | undefined;
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
  remote.mockReset();
  storage.getState().clearProjectAccountRowsScope();
  vi.restoreAllMocks();
});

const base: WorkspaceExecutionSettingsV1 = {
  enabled: false,
  unavailable: 'ask',
  allowAdHoc: false,
  scriptOverrides: {},
  services: {},
};

async function setup(options: Readonly<{
  running: boolean;
  /** The Machine that owns the service binding observation fails to answer. */
  actualFails?: boolean;
  saved?: WorkspaceExecutionSettingsV1['services'][string];
  portable?: boolean;
  modelOnly?: boolean;
  /** Wait for an enabled Runs on (custody known); off for states that keep it disabled. */
  waitEnabled?: boolean;
}>) {
  const writes: WorkspaceExecutionSettingsV1[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  fixture = await createPlainArtifactHomeFixture(
    'https://service-placement-ui.test',
    {
      handleRequest: async (path, init) => {
        if (path === '/v1/projects/execution/config/read')
          return json(options.saved
            ? { status: 'present', revision: 1, content: { t: 'plain', v: { ...base, services: { server: options.saved } } } }
            : { status: 'absent' });
        if (path === '/v1/projects/execution/config/mutate') {
          const request = JSON.parse(String(init?.body)) as {
            content: { v: WorkspaceExecutionSettingsV1 } | null;
          };
          if (request.content) writes.push(request.content.v);
          return json({
            status: 'updated',
            revision: writes.length,
            cursor: writes.length,
          });
        }
        return null;
      },
    },
  );
  // Ask first is the Action default; these cases waive it in the Account's canonical settings.
  const { settingsParse } = await import('@/sync/domains/settings/settings');
  const settingsScope = storage.getState().settingsScope;
  if (!settingsScope) throw new Error('expected_settings_scope');
  storage.getState().applySettingsForScope(settingsScope, settingsParse({ ...storage.getState().settings,
    actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.service.placement.set': ['ui'], 'projects.service.relocate': ['ui'] } },
  }), (storage.getState().settingsVersion ?? 0) + 1);
  const serverId = fixture.home.id;
  const scope = { serverId, accountId: 'artifact-account' };
  const source = {
    id: 'checkout',
    serverId,
    machineId: 'devbox',
    rootPath: '/src/happier',
    createdAtMs: 1,
  };
  storage.getState().activateProjectAccountRowsScope(scope);
  storage
    .getState()
    .applyProjectAccountRowsForScope(scope, {
      scope,
      status: 'ready',
      coverage: 'complete',
      workspaceRefs: [source],
      relationships: [],
      organizations: [],
      revisionsByPhysicalKey: {},
    });
  const target = {
    id: 'server-target',
    source: 'managed_service',
    sourceClass: { kind: 'managed_service', managedServiceId: 'instance' },
    machineId: source.machineId,
    workspaceId: source.id,
    workspace: {
      serverId,
      workspaceId: source.id,
      machineId: source.machineId,
      rootPath: source.rootPath,
    },
    cwd: source.rootPath,
    declaration: {
      workspaceRefId: source.id,
      selection: { kind: 'manifest', name: 'server' },
    },
    serviceState: 'running',
    readiness: 'ready',
    title: 'server',
    state: 'available',
    confidence: 'high',
    actions: ['manage'],
  };
  remote.mockImplementation(async ({ machineId }) => {
    if (options.actualFails) throw new Error('owner_unavailable');
    return {
    protocolVersion: 1,
    snapshot: {
      v: 1,
      machineId,
      updatedAt: 1,
      targets:
        options.running && machineId === source.machineId ? [target] : [],
    },
  };
  });
  let setLifecycle: (key: string) => void = () => {};
  const { ProjectServicePlacementControls, useProjectServicePlacement } =
    await import('./ProjectServicePlacementControls');
  let model: ReturnType<typeof useProjectServicePlacement> | null = null;
  function ModelProbe() {
    model = useProjectServicePlacement({ serverId, refId: source.id, machineId: source.machineId }, 'server');
    return null;
  }
  const { WorkerDestinationPicker } =
    await import('@/components/projects/workers/WorkerDestinationPicker');
  function Host() {
    const [lifecycleKey, setKey] = React.useState('initial');
    setLifecycle = setKey;
    if (options.modelOnly) return <ModelProbe />;
    return (
      <ProjectServicePlacementControls
        testID="placement"
        serviceName="server"
        source={{ serverId, refId: source.id, machineId: source.machineId }}
        declaration={{ portable: options.portable !== false }}
        lifecycleKey={lifecycleKey}
      />
    );
  }
  const screen = await renderScreen(<Host />);
  if (options.modelOnly) await vi.waitFor(() => expect(model?.state.kind).toBe('ready'));
  else if (options.waitEnabled !== false) await vi.waitFor(() =>
    expect(screen.findAllByTestId('placement.runsOn')[0]?.props.disabled, JSON.stringify([fixture?.requests, screen.findAllByTestId('placement.unavailable').length])).toBe(false),
  );
  const choose = async (machineId: string) => {
    await act(async () => {
      screen.tree
        .findByType(WorkerDestinationPicker)
        .props.onChoose({
          kind: 'workers',
          destination: { kind: 'machine', machineId },
        });
    });
  };
  const runsOn = () => screen.findAllByTestId('placement.runsOn')[0]!;
  return { screen, writes, choose, runsOn, model: () => model!, setLifecycle: (key: string) => setLifecycle(key) };
}

describe('Service Runs on through the placement and relocation Actions', () => {
  it('passes the current declaration portability and memory to the row placement owner', async () => {
    const { createProjectServicePlacementRenderer } = await import('./ProjectServicePlacementControls');
    const facts = { portable: false, memoryDemand: { bytes: 2147483648 } };
    const source = { serverId: 'home', machineId: 'devbox', refId: 'checkout' };
    const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [{
      id: 'declared', source: 'managed_service', machineId: 'devbox', title: 'server',
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } },
      confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [],
    }], sessionId: null, scope: 'workspace' });
    const render = createProjectServicePlacementRenderer(source, { server: facts });
    expect((render?.(row!) as React.ReactElement<{ declaration: typeof facts }>).props.declaration).toEqual(facts);
  });
  it('refreshes placement when a new native occurrence replaces one with the same row id and running state', async () => {
    const { createProjectServicePlacementRenderer } = await import('./ProjectServicePlacementControls');
    const target = { id: 'service', source: 'managed_service' as const, machineId: 'source',
      sourceClass: { kind: 'managed_service' as const, managedServiceId: 'first' }, serviceState: 'running' as const,
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest' as const, name: 'web' } },
      confidence: 'high' as const, state: 'available' as const, title: 'web', actions: [] };
    const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' });
    const render = createProjectServicePlacementRenderer({ serverId: 'home', refId: 'checkout', machineId: 'source' }, { web: { portable: true } });
    const first = render?.(row!) as React.ReactElement<{ lifecycleKey: string }>;
    const next = render?.({ ...row!, target: { ...target, sourceClass: { kind: 'managed_service', managedServiceId: 'replacement' } } }) as React.ReactElement<{ lifecycleKey: string }>;
    expect(next.props.lifecycleKey).not.toBe(first.props.lifecycleKey);
  });
  it.each([false, true])('the placement model itself refuses a stopped save for uncertain or live custody (live=%s)', async running => {
    const { model, writes } = await setup({ running, actualFails: !running, modelOnly: true });
    expect(model()).toMatchObject({
      actual: { status: running ? 'present' : 'unavailable' },
      desiredPlacement: { runsOn: { kind: 'primary' } },
      canSaveNextStart: false,
      canMove: running,
    });
    await act(async () => { await model().save({ runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } }, unavailable: 'fail' }); });
    expect(writes).toEqual([]);
  });
  it('displays the actual Machine rather than the differing desired placement for a live service', async () => {
    const { model } = await setup({ running: true, modelOnly: true,
      saved: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } }, unavailable: 'fail' } });
    expect(model()).toMatchObject({ displayChoice: { kind: 'primary' },
      desiredPlacement: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } } } });
  });

  it('does not treat an unobservable binding as stopped: no save, and a way to check again', async () => {
    const { screen, writes, choose, runsOn } = await setup({ running: false, actualFails: true, waitEnabled: false });
    await vi.waitFor(() => expect(screen.findByTestId('placement.custody')).toBeTruthy());
    expect(runsOn().props.disabled).toBe(true);
    await choose('hz-build-1');
    expect(writes).toEqual([]);
  });

  it('offers no workers for a primary-only service', async () => {
    const { screen, runsOn } = await setup({ running: false, portable: false, waitEnabled: false });
    await vi.waitFor(() => expect(String(runsOn().props.subtitle)).toBe('projectServices.primaryOnly'));
    const { WorkerDestinationPicker } = await import('@/components/projects/workers/WorkerDestinationPicker');
    expect(screen.tree.findAllByType(WorkerDestinationPicker)).toHaveLength(0);
  });

  it('does not claim primary-only custody when the actual binding is unavailable', async () => {
    const { screen, runsOn } = await setup({ running: false, actualFails: true, portable: false, waitEnabled: false });
    await vi.waitFor(() => expect(screen.findByTestId('placement.custody')).toBeTruthy());
    expect(runsOn().props.detail).toBe('projectServices.actualUnavailable');
    expect(runsOn().props.subtitle).toBe('projectServices.actualUnavailable');
  });

  it('re-reads the binding when the Services feed observes a lifecycle change', async () => {
    const { setLifecycle } = await setup({ running: false });
    const reads = () => remote.mock.calls.length;
    const before = reads();
    await act(async () => { setLifecycle('running:devbox'); });
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('saves a stopped service’s next start without opening a Move', async () => {
    const { screen, writes, choose } = await setup({ running: false });
    await choose('hz-build-1');
    await vi.waitFor(() => expect(writes, JSON.stringify([fixture?.requests, screen.findAllByTestId('placement.notice')[0]?.props.title])).toHaveLength(1));
    expect(writes[0]?.services.server).toEqual({
      runsOn: {
        kind: 'workers',
        destination: { kind: 'machine', machineId: 'hz-build-1' },
      },
      unavailable: 'fail',
    });
    expect(screen.findByTestId('placement.move')).toBeNull();
  });

  it('asks before moving a running service; Cancel and an unavailable Move both leave placement unsaved', async () => {
    const { screen, writes, choose } = await setup({ running: true });
    await choose('hz-build-1');
    await vi.waitFor(() =>
      expect(screen.findByTestId('placement.move')).toBeTruthy(),
    );
    await screen.pressByTestIdAsync('placement.move.cancel');
    expect(screen.findByTestId('placement.move')).toBeNull();
    await choose('hz-build-1');
    await vi.waitFor(() =>
      expect(screen.findByTestId('placement.move')).toBeTruthy(),
    );
    await screen.pressByTestIdAsync('placement.move.confirm');
    // The single reviewed set-plus-Move producer is not published: its real refusal is shown as is.
    await vi.waitFor(() =>
      expect(screen.findAllByTestId('placement.move.refused')[0]?.props.title, JSON.stringify(screen.findAllByTestId('placement.move.refused')[0]?.props.details)).toBe(
        'projectServices.moveUnavailable',
      ),
    );
    expect(writes).toEqual([]);
  });
});
