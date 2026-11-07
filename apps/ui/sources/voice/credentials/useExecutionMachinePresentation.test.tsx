/** @vitest-environment jsdom */
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installDisconnectedServerSocketBoundary();
// Node supplies the unavailable native crypto adapters; Account/settings owners stay real.
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));

await loadSyncSingletonForTests();
const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { requireOneShotAccountSettingsMutationApplied } = await import('@/sync/engine/settings/syncSettings');
const { sync } = await import('@/sync/sync');
const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
const { recordMachineRequestFailed, recordMachineRequestSucceeded, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { persistVoiceAutoTargetMachineId } = await import('@/voice/persistence/voiceAutoTargetMachineSettings');
const { t } = await import('@/text');
const { resolveMachineDisplayNames } = await import('@/utils/sessions/machineDisplayNames');
const { useVoiceExecutionMachineId, useVoiceExecutionMachinePresentation } = await import('./useExecutionMachinePresentation');

let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>>;
let webLocks: ReturnType<typeof installWebLockManagerMock>;

function publishMachines(...machines: ReturnType<typeof createMachineFixture>[]) {
  storage.getState().applyMachines(machines.map(machine => createMachineFixture({ ...machine, activeAt: Date.now() })), true,
    { sourceServerId: account.scope.serverId });
}

async function selectMachine(machineId: string) {
  const current = storage.getState();
  if (current.settingsVersion === null) throw new Error('Expected hydrated Account settings version');
  requireOneShotAccountSettingsMutationApplied(await sync.mutateAccountSettingsOnce({
    expectedSettingsScope: account.scope,
    expectedSettingsVersion: current.settingsVersion,
    mutate: (raw) => ({
      settings: { ...raw, ...normalizeVoiceSettingsLocalDelta({ voice: {
        ...settingsParse(raw).voice,
        executionMachine: { mode: 'fixed', machineId },
      } }, settingsParse(raw)) },
      value: undefined,
    }),
  }));
}

describe('useVoiceExecutionMachinePresentation', () => {
  beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
    useVoiceTargetStore.setState({ autoTargetMachineByScope: {} });
  });

  afterEach(async () => {
    standardCleanup();
    clearMachineRequestReachabilityForTest();
    await account?.dispose();
    useVoiceTargetStore.setState({ autoTargetMachineByScope: {} });
    webLocks?.restore();
  });

  it('updates on a failed request and a later reply without an Account write or a Machine identity change', async () => {
    publishMachines(createMachineFixture({ id: 'machine-a', metadata: { ...createMachineFixture().metadata!, displayName: 'Studio' } }));
    await selectMachine('machine-a');
    const hook = await renderHook(() => useVoiceExecutionMachinePresentation());
    const settings = storage.getState().settings;
    await act(async () => { recordMachineRequestFailed({ ...account.scope, machineId: 'machine-a' }); });
    expect(hook.getCurrent()).toEqual({ selectedMachineId: 'machine-a', machineId: null, machineLabel: 'Studio', selectionKind: 'selected_unreachable' });
    await act(async () => { recordMachineRequestSucceeded({ ...account.scope, machineId: 'machine-a' }); });
    expect(hook.getCurrent()).toEqual({ selectedMachineId: 'machine-a', machineId: 'machine-a', machineLabel: 'Studio', selectionKind: 'resolved' });
    expect(storage.getState().settings).toBe(settings);
  });

  it('reacts to local auto-target memory without an Account settings write', async () => {
    publishMachines(
      createMachineFixture({ id: 'machine-a', metadata: { ...createMachineFixture().metadata!, displayName: 'Machine A' } }),
      createMachineFixture({ id: 'machine-b', metadata: { ...createMachineFixture().metadata!, displayName: 'Machine B' } }),
    );
    const hook = await renderHook(() => useVoiceExecutionMachinePresentation());
    const settings = storage.getState().settings;
    await act(async () => { persistVoiceAutoTargetMachineId('machine-b', account.scope); });
    expect(hook.getCurrent()).toEqual({ selectedMachineId: 'machine-b', machineId: 'machine-b', machineLabel: 'Machine B', selectionKind: 'resolved' });
    expect(storage.getState().settings).toBe(settings);
    expect(account.settingsWrites).toEqual([]);
  });

  it('keeps execution-only subscribers local when the selected machine label changes', async () => {
    const machine = createMachineFixture({ id: 'machine-a', metadata: { ...createMachineFixture().metadata!, displayName: 'Machine A' } });
    publishMachines(machine);
    await selectMachine(machine.id);
    let renders = 0;
    const hook = await renderHook(() => {
      renders += 1;
      return useVoiceExecutionMachineId();
    });
    expect(hook.getCurrent()).toBe(machine.id);
    const rendersBeforeRename = renders;
    await act(async () => {
      publishMachines({ ...machine, metadata: { ...machine.metadata!, displayName: 'Renamed machine' } });
    });
    expect(hook.getCurrent()).toBe(machine.id);
    expect(renders).toBe(rendersBeforeRename);
  });

  it('reacts when hydration supplies the canonical execution-machine selection', async () => {
    publishMachines();
    const hook = await renderHook(() => useVoiceExecutionMachinePresentation());
    expect(hook.getCurrent()).toEqual({ selectedMachineId: null, machineId: null, machineLabel: null, selectionKind: 'none' });

    await act(async () => {
      publishMachines(createMachineFixture({ id: 'machine-a', metadata: { ...createMachineFixture().metadata!, displayName: 'Machine A' } }));
      const current = storage.getState().settings;
      account.replaceSettings(settingsParse({ ...current, ...normalizeVoiceSettingsLocalDelta({ voice: {
        ...current.voice, executionMachine: { mode: 'fixed', machineId: 'machine-a' },
      } }, current) }), { version: 2, publish: false });
      await sync.refreshAccountSettingsFromServer(2, account.scope);
    });

    expect(hook.getCurrent()).toEqual({ selectedMachineId: 'machine-a', machineId: 'machine-a', machineLabel: 'Machine A', selectionKind: 'resolved' });
    expect(account.persistedSettings.voice.executionMachine).toEqual({ mode: 'fixed', machineId: 'machine-a' });
  });

  it('labels an unnamed execution machine as unnamed, never by its id', async () => {
    publishMachines(createMachineFixture({ id: 'f98b860d-63e0', metadata: { ...createMachineFixture().metadata!, host: '', displayName: '' } }));
    await selectMachine('f98b860d-63e0');
    const hook = await renderHook(() => useVoiceExecutionMachinePresentation());
    expect(hook.getCurrent().machineLabel).toBe(t('machine.unnamedMachine'));
  });

  it('uses the picker-qualified name and names a missing selection without exposing its id', async () => {
    const first = createMachineFixture({ id: 'aaaa-1111', metadata: { ...createMachineFixture().metadata!, displayName: 'Studio', host: 'studio-a' } });
    const second = createMachineFixture({ id: 'bbbb-2222', metadata: { ...createMachineFixture().metadata!, displayName: 'Studio', host: 'studio-b' } });
    publishMachines(first, second);
    await selectMachine(first.id);
    const hook = await renderHook(() => useVoiceExecutionMachinePresentation());
    expect(hook.getCurrent().machineLabel).toBe(resolveMachineDisplayNames([first, second]).get(first.id));
    await act(async () => { publishMachines(); });
    expect(hook.getCurrent().machineLabel).toBe(t('machine.unlistedMachine'));
    expect(hook.getCurrent().selectedMachineId).toBe(first.id);
  });

  it('reacts to a committed machine replacement and its label', async () => {
    publishMachines(
      createMachineFixture({ id: 'machine-a', metadata: { ...createMachineFixture().metadata!, displayName: 'Machine A' } }),
      createMachineFixture({ id: 'machine-b', metadata: { ...createMachineFixture().metadata!, displayName: 'Machine B' } }),
    );
    await selectMachine('machine-a');

    const hook = await renderHook(() => useVoiceExecutionMachinePresentation());
    expect(hook.getCurrent()).toEqual({ selectedMachineId: 'machine-a', machineId: 'machine-a', machineLabel: 'Machine A', selectionKind: 'resolved' });

    await act(async () => { await selectMachine('machine-b'); });

    expect(hook.getCurrent()).toEqual({ selectedMachineId: 'machine-b', machineId: 'machine-b', machineLabel: 'Machine B', selectionKind: 'resolved' });
    expect(account.persistedSettings.voice.executionMachine).toEqual({ mode: 'fixed', machineId: 'machine-b' });
  });
});
