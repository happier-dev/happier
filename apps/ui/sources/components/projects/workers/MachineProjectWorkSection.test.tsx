import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodePlainMachineStoredContent,
  encodePlainMachineStoredContent,
  MACHINE_PLAIN_DATA_KEY_MARKER,
} from '@happier-dev/protocol/machines/machineStoredContent';

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
