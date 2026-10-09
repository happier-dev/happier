import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceExecutionSettingsV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';

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

async function setup(options: Readonly<{ running: boolean }>) {
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
          return json({ status: 'absent' });
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
  remote.mockImplementation(async ({ machineId }) => ({
    protocolVersion: 1,
    snapshot: {
      v: 1,
      machineId,
      updatedAt: 1,
      targets:
        options.running && machineId === source.machineId ? [target] : [],
    },
  }));
  const { ProjectServicePlacementControls } =
    await import('./ProjectServicePlacementControls');
  const { WorkerDestinationPicker } =
    await import('@/components/projects/workers/WorkerDestinationPicker');
  const screen = await renderScreen(
    <ProjectServicePlacementControls
      testID="placement"
      serviceName="server"
      source={{ serverId, refId: source.id, machineId: source.machineId }}
    />,
  );
  await vi.waitFor(() =>
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
  return { screen, writes, choose };
}

describe('Service Runs on through the placement and relocation Actions', () => {
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
