import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodePlainMachineStoredContent,
  encodePlainMachineStoredContent,
  MACHINE_PLAIN_DATA_KEY_MARKER,
} from '@happier-dev/protocol/machines/machineStoredContent';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storage';
import { apiSocket } from '@/sync/api/session/apiSocket';

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
const machineHttp = vi.hoisted(() => ({ read: null as null | (() => Response) }));
// The Machine record read is an HTTP boundary; every other Home request keeps the real client.
vi.mock('@/sync/http/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/http/client')>();
  return { ...actual, serverFetch: async (...args: Parameters<typeof actual.serverFetch>) =>
    args[0] === '/v1/machines/m1' && machineHttp.read ? machineHttp.read() : await actual.serverFetch(...args) };
});

let fixture:
  | Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>
  | undefined;
afterEach(() => {
  machineHttp.read = null;
  fixture?.dispose();
  fixture = undefined;
  vi.restoreAllMocks();
});

/**
 * The Machine's real metadata read (Home HTTP) and its metadata CAS socket are the boundaries; the
 * finite-policy semantic mutation, Action policy and the settings rows above them are production code.
 */
async function setup() {
  const machine = createMachineFixture({
    id: 'm1',
    storageMode: 'plain',
    metadataVersion: 4,
    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
  });
  let metadata: Record<string, unknown> = { ...machine.metadata };
  let version = 4;
  // The Machine policy port reads the sync owner's encryption context (absent for Plain).
  const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
  await loadSyncSingletonForTests();
  fixture = await createPlainArtifactHomeFixture('https://machine-work.test');
  machineHttp.read = () => new Response(JSON.stringify({ machine: { id: 'm1', metadata: encodePlainMachineStoredContent(metadata),
    metadataVersion: version, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } }), { headers: { 'Content-Type': 'application/json' } });
  const sent: Record<string, unknown>[] = [];
  vi.spyOn(apiSocket, 'emitWithAck').mockImplementation((async (
    event: string,
    request: { metadata: string; expectedVersion: number },
  ) => {
    if (event !== 'machine-update-metadata')
      throw new Error(`Unexpected socket event ${event}`);
    metadata = decodePlainMachineStoredContent(request.metadata) as Record<
      string,
      unknown
    >;
    sent.push(metadata);
    version = request.expectedVersion + 1;
    return { result: 'success', version, metadata: request.metadata };
  }) as typeof apiSocket.emitWithAck);
  storage.getState().applyMachines([machine]);
  // Ask first is the Action default; these cases waive it in the Account's canonical settings.
  const { settingsParse } = await import('@/sync/domains/settings/settings');
  const settingsScope = storage.getState().settingsScope;
  if (!settingsScope) throw new Error('expected_settings_scope');
  storage
    .getState()
    .applySettingsForScope(
      settingsScope,
      settingsParse({
        ...storage.getState().settings,
        actionsSettingsV1: {
          v: 1,
          actions: {},
          approvalWaivedSurfaces: { 'machines.worker.policy.set': ['ui'] },
        },
      }),
      (storage.getState().settingsVersion ?? 0) + 1,
    );
  const { MachineProjectWorkSection } =
    await import('./MachineProjectWorkSection');
  const screen = await renderScreen(
    <MachineProjectWorkSection
      testID="work"
      serverId={fixture.home.id}
      machineId="m1"
      machineName="hz-build-1"
    />,
  );
  await vi.waitFor(() =>
    expect(screen.findAllByTestId('work.accepting')[0]?.props.disabled).toBe(false),
  );
  return { screen, sent };
}

describe('Machine › Work from your projects through the Machine policy Actions', () => {
  it('offers Fresh-copy removal only for a proven worker target, never ordinary Sync or the worker SOURCE', async () => {
    const { screen } = await setup();
    const scope = storage.getState().profileScope;
    if (!scope || scope.serverId !== fixture?.home.id) throw new Error('expected_current_project_account_scope');
    const source = { id: 'fresh-source', serverId: scope.serverId, machineId: 'source-machine',
      rootPath: '/source/project', label: 'Original source checkout', createdAtMs: 1, projectKey: 'fresh-project' };
    const target = { id: 'fresh-target', serverId: scope.serverId, machineId: 'm1',
      rootPath: '/worker/project', label: 'Worker target checkout', createdAtMs: 1, projectKey: 'fresh-project' };
    const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const ordinary: WorkspaceSyncRelationshipV1 = { v: 1, relationshipId: 'ordinary-sync', controllerMachineId: 'source-machine',
      alphaWorkspaceRefId: source.id, betaWorkspaceRefId: target.id, mode: 'keep_synced', enabled: true,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 };
    const workerTarget: WorkspaceSyncRelationshipV1 = { ...ordinary, relationshipId: 'proven-worker-target',
      alphaWorkspaceRefId: target.id, betaWorkspaceRefId: source.id,
      provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: source.id, targetWorkspaceRefId: target.id } };
    const workerSource: WorkspaceSyncRelationshipV1 = { ...ordinary, relationshipId: 'machine-is-worker-source',
      provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: target.id, targetWorkspaceRefId: source.id } };
    await act(async () => {
      storage.getState().activateProjectAccountRowsScope(scope);
      storage.getState().setProjectAccountRowsStatusForScope(scope, 'idle');
    });
    expect(screen.findAllByTestId('work.copies.loading').length).toBeGreaterThan(0);
    expect(screen.findAllByTestId('work.copies.unavailable').length).toBe(0);
    expect(screen.findAllByTestId('work.copies.empty').length).toBe(0);
    await act(async () => {
      storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
        workspaceRefs: [source, target], relationships: [ordinary, workerTarget, workerSource], organizations: [], revisionsByPhysicalKey: {} });
    });
    // Prove the real row subscription consumed the scoped fixture before testing exclusions.
    // The row component forwards its testID; the rendered list row is the one carrying a title.
    const row = () => screen.findAllByTestId('work.copy:proven-worker-target').find((node) => typeof node.props.title === 'string');
    await vi.waitFor(() => expect(row()?.props.title).toBe(source.label));
    expect(screen.findAllByTestId('work.copy:proven-worker-target.remove').length).toBeGreaterThan(0);
    expect(screen.findAllByTestId('work.copy:ordinary-sync').length).toBe(0);
    expect(screen.findAllByTestId('work.copy:machine-is-worker-source').length).toBe(0);
    // Unknown clean-sync time and size are omitted, never shown as a guessed value.
    const subtitle = String(row()?.props.subtitle);
    expect(subtitle).not.toContain('projectWorkers.copyLastSynced');
    expect(subtitle).not.toMatch(/\d/);
    // Remove… offers the explicit choices; Ask first is rendered as a pending approval, never a local confirm.
    const menu = () => screen.findAll((node) => typeof node.props.onSelect === 'function'
      && Array.isArray(node.props.items) && node.props.items.some((item: { id: string }) => item.id === 'files'))[0]!;
    expect(menu().props.items.map((item: { id: string }) => item.id)).toEqual(['keep', 'files']);
    await act(async () => { menu().props.onSelect('keep'); });
    await vi.waitFor(() => expect(screen.findAllByTestId('work.copy:proven-worker-target.notice')[0]?.props).toMatchObject({
      title: 'projectWorkers.approvalPending', action: { testID: 'work.copy:proven-worker-target.approval' } }));
    // No duplicate Remove while the first one is pending.
    expect(screen.findAllByTestId('work.copy:proven-worker-target.remove')[0]?.props.disabled).toBe(true);
    expect(screen.findAllByTestId('work.copy:proven-worker-target').length).toBeGreaterThan(0);
  });

  it('does not claim Fresh-copy emptiness when the current Account/Home row observation is unavailable', async () => {
    const { screen } = await setup();
    const scope = storage.getState().profileScope;
    if (!scope || scope.serverId !== fixture?.home.id) throw new Error('expected_current_project_account_scope');
    await act(async () => {
      storage.getState().activateProjectAccountRowsScope(scope);
      storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
        workspaceRefs: [], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
    });
    expect(screen.findAllByTestId('work.copies.empty').length).toBeGreaterThan(0);
    expect(screen.findAllByTestId('work.copies.loading').length).toBe(0);
    await act(async () => { storage.getState().setProjectAccountRowsStatusForScope(scope, 'locked'); });
    expect(screen.findAllByTestId('work.copies.empty').length).toBe(0);
    expect(screen.findAllByTestId('work.copies.unavailable').length).toBeGreaterThan(0);
    expect(screen.findAllByTestId('work.accepting').length).toBeGreaterThan(0);
  });

  it('refuses a non-positive Run at most without writing, and No limit clears the ceiling', async () => {
    const { screen, sent } = await setup();
    const capacity = () => screen.findAllByTestId('work.capacity')[0]!;
    await act(async () => {
      capacity().props.onCommit('0');
    });
    expect(capacity().props.error).toBe('projectWorkers.capacityInvalid');
    expect(sent).toEqual([]);
    await act(async () => {
      capacity().props.onDraftChange('3');
      capacity().props.onCommit('3');
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      finitePolicyV1: { accepting: true, runAtMost: 3 },
    });
    expect(capacity().props.error).toBeNull();
    await vi.waitFor(() => expect(capacity().props.value).toBe('3'));
    await act(async () => {
      capacity().props.onCommit('');
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({
      finitePolicyV1: { accepting: true, runAtMost: null },
    });
  });

  it('turns off new work only, keeping the ceiling, and says what that means now', async () => {
    const { screen, sent } = await setup();
    await act(async () => {
      screen
        .findAllByTestId('work.accepting.switch')[0]
        ?.props.onValueChange(false);
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      finitePolicyV1: { accepting: false, runAtMost: null },
    });
    await vi.waitFor(() =>
      expect(
        String(screen.findAllByTestId('work.accepting')[0]?.props.subtitle),
      ).toContain('projectWorkers.notAccepting'),
    );
  });
});
