/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';

import { act, createMachineFixture, createSessionFixture, createRenderCommitCounter, renderHook, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createHydratedPlainMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

installDisconnectedServerSocketBoundary();
const { activateStorageAccountScope } = await import('@/dev/testkit/mocks/storage');
const { storage } = await import('@/sync/domains/state/storage');
const { resolveVoiceExecutionMachineIdFromState } = await import('@/voice/settings/executionMachine');
const { useVoiceExecutionMachineId, useVoiceExecutionMachineSelection, useVoiceExecutionMachinePresentation } = await import('./useExecutionMachinePresentation');
const machineNames = await import('@/utils/sessions/machineDisplayNames');
const publishedMachineNames = await import('@happier-dev/protocol/machines/machineDisplayNames');
const serverRuntime = await import('@/sync/domains/server/serverRuntime');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { useBundledConversationProviderSettings } = await import('@/voice/settings/panels/realtime/useBundledConversationProviderSettings');

const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof activateStorageAccountScope>> | undefined;
afterEach(async () => {
  await standardCleanup();
  vi.restoreAllMocks();
  account?.dispose();
  account = undefined;
  storage.setState(initialStorage, true);
});

it('resolves only the displayed name after real naming changes, across 150 Machines and unrelated arrivals', async () => {
  const scope = { serverId: 'voice-name-cost-home', accountId: 'voice-name-cost-account' };
  account = await activateStorageAccountScope(scope);
  const machines = Array.from({ length: 150 }, (_, index) => createHydratedPlainMachineFixture({
    id: `machine-${index}`, accountId: scope.accountId, machine: { active: true, activeAt: Date.now(),
    metadata: { ...createMachineFixture().metadata!, displayName: `Machine ${index}`, host: `host-${index}` },
  } }));
  storage.setState(state => ({
    settingsScope: scope,
    settings: { ...state.settings, voice: { ...state.settings.voice,
      executionMachine: { mode: 'fixed', machineId: machines[0]!.id },
    } },
  }));
  await publishMachineInventoryForTest(scope, machines);
  // Call-through instrumentation: the naming owner and its internal logic stay real.
  const names = vi.spyOn(machineNames, 'getMachineDisplayName');
  const qualifications = vi.spyOn(publishedMachineNames, 'resolveMachineDisplayNameParts');
  const counter = createRenderCommitCounter();
  const hook = await renderHook(() => {
    useRenderCommitCounter(counter);
    return useVoiceExecutionMachinePresentation();
  });
  expect(hook.getCurrent().machineLabel).toBe('Machine 0');
  // React may render more than once while mounting. Each demanded label must
  // qualify one row, independently of that mount lifecycle; the settled change
  // below separately requires exactly one resolution/render/commit.
  expect(new Set(qualifications.mock.calls.map(([inputs]) => inputs.length))).toEqual(new Set([1]));
  counter.reset();
  names.mockClear();
  qualifications.mockClear();
  for (let index = 0; index < 20; index += 1) {
    await act(async () => { storage.setState({ isDataReady: index % 2 === 0 }); });
  }
  expect({ resolutions: names.mock.calls.length, ...counter.read() })
    .toEqual({ resolutions: 0, renders: 0, commits: 0 });
  expect(qualifications).toHaveBeenCalledTimes(0);

  const renamed = { ...machines[0]!, metadata: { ...machines[0]!.metadata!, displayName: 'Renamed' } };
  await act(async () => {
    storage.getState().applyMachines([renamed], false, { sourceServerId: scope.serverId });
  });
  expect(hook.getCurrent().machineLabel).toBe('Renamed');
  expect({ resolutions: names.mock.calls.length, ...counter.read() })
    .toEqual({ resolutions: 1, renders: 1, commits: 1 });
  expect(qualifications.mock.calls.flatMap(([inputs]) => inputs)).toHaveLength(1);
  counter.reset();
  names.mockClear();
  await act(async () => {
    storage.getState().applyMachines([{ ...machines[1]!, metadata: { ...machines[1]!.metadata!, platform: 'darwin' } }], false,
      { sourceServerId: scope.serverId });
  });
  expect({ resolutions: names.mock.calls.length, ...counter.read() })
    .toEqual({ resolutions: 0, renders: 0, commits: 0 });

  // A different Machine matters only when it changes the displayed name's
  // qualification. Ingestion must preserve that dependency and its withdrawal.
  await act(async () => {
    storage.getState().applyMachines([{ ...machines[1]!, metadata: { ...machines[1]!.metadata!, displayName: 'Renamed' } }], false,
      { sourceServerId: scope.serverId });
  });
  expect(hook.getCurrent().machineLabel).toBe('Renamed · host-0');
  counter.reset();
  names.mockClear();
  await act(async () => {
    storage.getState().applyMachines([{ ...renamed, metadata: { ...renamed.metadata, platform: 'darwin' } }], false,
      { sourceServerId: scope.serverId });
  });
  expect({ resolutions: names.mock.calls.length, ...counter.read() })
    .toEqual({ resolutions: 0, renders: 0, commits: 0 });
  await act(async () => {
    storage.getState().applyMachines([{ ...renamed, revokedAt: Date.now() }], false, { sourceServerId: scope.serverId });
  });
  expect(hook.getCurrent()).toMatchObject({ selectedMachineId: renamed.id, machineId: null,
    machineLabel: (await import('@/text')).t('machine.unlistedMachine'), selectionKind: 'selected_unreachable' });
  await hook.unmount();
  names.mockClear();
  const readiness = await renderHook(() => useVoiceExecutionMachineSelection());
  expect(readiness.getCurrent()).toEqual({ selectedMachineId: renamed.id, machineId: null, selectionKind: 'selected_unreachable' });
  expect(names).toHaveBeenCalledTimes(0);
});

it('does not reread persisted Voice bindings on unrelated root notifications', async () => {
  const { voiceSessionBindingStore, syncPersistedVoiceConversationBindings } = await import('@/voice/binding/voiceConversationBindingStore');
  const { writeVoiceConversationBindingMetadata } = await import('@/voice/binding/voiceConversationBindingMetadata');
  const { buildSystemSessionMetadataV1 } = await import('@happier-dev/protocol/sessions/control/contract');
  const { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } = await import('@happier-dev/protocol/voice/sessionBinding');
  syncPersistedVoiceConversationBindings();
  const serverId = serverRuntime.getActiveServerSnapshot().serverId;
  // Observe Home reads beneath the real global subscription, not a substituted reader.
  const homeReads = vi.spyOn(serverRuntime, 'getActiveServerSnapshot');
  for (let index = 0; index < 10; index += 1) {
    storage.setState({ isDataReady: index % 2 === 0 });
  }
  expect(homeReads).toHaveBeenCalledTimes(0);
  const binding = { adapterId: 'local_conversation', controlSessionId: 'voice-global', conversationSessionId: 'perf-carrier',
    conversationSessionAddress: { serverId, sessionId: 'perf-carrier' }, transcriptMode: 'synthetic' as const,
    targetSessionAddress: null, updatedAt: 1 };
  const carrier = createSessionFixture({ id: 'perf-carrier', serverId, metadata: writeVoiceConversationBindingMetadata({
    ...createSessionFixture().metadata!,
    ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }),
  }, binding) });
  storage.setState(state => ({ sessions: { ...state.sessions, [carrier.id]: carrier } }));
  expect(homeReads.mock.calls.length).toBeGreaterThan(0);
  expect(voiceSessionBindingStore.getState().getByConversationSessionId(carrier.id)).toEqual(binding);
  storage.setState(state => ({ sessions: { ...state.sessions, [carrier.id]: { ...carrier, metadata: null } } }));
  expect(voiceSessionBindingStore.getState().list()).toEqual([]);
});

it.each(['execution', 'selection', 'catalog'] as const)('keeps the %s snapshot stable as time passes and observes an authoritative withdrawal', async consumer => {
  const scope = { serverId: 'voice-snapshot-home', accountId: 'voice-snapshot-account' };
  account = await activateStorageAccountScope(scope);
  const machine = createHydratedPlainMachineFixture({ id: 'machine-a', accountId: scope.accountId,
    machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 } });
  storage.setState(state => ({
    settingsScope: scope,
    settings: { ...state.settings, voice: { ...state.settings.voice,
      executionMachine: { mode: 'fixed', machineId: machine.id },
    } },
  }));
  await publishMachineInventoryForTest(scope, [machine]);
  const snapshot = storage.getState();
  expect(resolveVoiceExecutionMachineIdFromState(snapshot)).toBe(machine.id);
  const deadline = machine.activeAt + 120_000;
  let now = deadline - 1;
  const voice = voiceSettingsParse({ providerId: 'local_conversation' });
  // React's initial subscription may legitimately re-read selection. Move the
  // clock at the render boundary, not based on an internal function's stack.
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const consoleErrors = vi.spyOn(console, 'error');
  const hook = await renderHook(() => {
    return consumer === 'execution' ? useVoiceExecutionMachineId()
      : consumer === 'selection' ? useVoiceExecutionMachineSelection().machineId
      : useBundledConversationProviderSettings(voice).sessionChoice?.targetKey ?? null;
  });
  expect(storage.getState()).toBe(snapshot);
  expect(consoleErrors.mock.calls.filter(([message]) => (
    typeof message === 'string' && /getSnapshot|Maximum update depth exceeded/.test(message)
  ))).toEqual([]);
  const first = hook.getCurrent();
  if (consumer !== 'catalog') expect(first).toBe(machine.id);
  else expect(first).toEqual(expect.any(String));
  now = deadline + 1;
  await hook.rerender();
  expect(hook.getCurrent()).toBe(first);
  expect(storage.getState()).toBe(snapshot);
  await act(async () => storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: false, activeAt: now }], { sourceServerId: scope.serverId }));
  if (consumer !== 'catalog') expect(hook.getCurrent()).toBeNull();
  else expect(hook.getCurrent()).not.toBe(first);
  // Activity is owned separately from the immutable inventory snapshot.
  expect(snapshot.machineListByServerId[scope.serverId]?.[0]?.active).toBe(true);
  expect(storage.getState().machineListByServerId[scope.serverId]?.[0]?.metadata).toBe(machine.metadata);
});
