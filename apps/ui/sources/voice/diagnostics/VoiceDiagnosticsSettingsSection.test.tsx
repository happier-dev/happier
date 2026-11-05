import * as React from 'react';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, registerStandardCleanupTarget, renderScreen, renderHook, standardCleanup, waitForTestEvent, type RenderScreenResult } from '@/dev/testkit';
import { createDiagnosticsTestEvents } from './diagnosticsTestEvents';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { VoiceSpeechDiagnosticsConfigureRequestV1Schema, VoiceSpeechDiagnosticsRevokeCaptureRequestV1Schema, VoiceSpeechDiagnosticsSettingsV1Schema, VoiceSpeechDiagnosticsStatusResponseV1Schema,
  resolveVoiceSpeechDiagnosticsStoragePolicy, type VoiceSpeechDiagnosticsSettingsV1 } from '@happier-dev/protocol/voice/diagnostics';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { tLoose } from '@/text';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const machineState = vi.hoisted(() => ({
  machineId: 'm1',
  daemonStateVersion: 1,
  isOnline: true,
}));
const activeVoiceAttempt = vi.hoisted(() => ({ sessionId: null as string | null }));
type DiagnosticsStatus = ReturnType<typeof VoiceSpeechDiagnosticsStatusResponseV1Schema.parse>;
const testState = vi.hoisted(() => ({
  artifacts: [] as DiagnosticsStatus['artifacts'],
  deleteError: null as Error | null,
  configureError: null as Error | null,
  statusError: null as Error | null,
  blockedEnabledMachineId: null as string | null,
  configureBarrier: null as Promise<void> | null,
  policyByMachine: new Map<string, boolean>(),
  configureCompletions: [] as Array<readonly [machineId: string, enabled: boolean]>,
  health: {
    captureFailure: false,
    cleanup: { status: 'healthy' as const, code: null, ownedEntryCount: 0 as number | null },
  } as DiagnosticsStatus['health'],
}));
const fireAndForgetError = vi.hoisted(() => vi.fn());
const configure = vi.hoisted(() => vi.fn(async (machineId: string, settings: VoiceSpeechDiagnosticsSettingsV1) => {
  if (testState.blockedEnabledMachineId === machineId && settings.enabled && testState.configureBarrier) {
    await testState.configureBarrier;
  }
  const enabled = settings.enabled === true;
  testState.policyByMachine.set(machineId, enabled);
  testState.configureCompletions.push([machineId, enabled]);
  return {
    ok: true as const,
    root: `/private/${machineId}`,
    settings,
    artifacts: testState.artifacts,
    health: testState.health,
    backupPolicy: resolveVoiceSpeechDiagnosticsStoragePolicy('daemon_desktop'),
  };
}));
const status = vi.hoisted(() => vi.fn(async (machineId: string) => ({
  ok: true as const,
  root: `/private/${machineId}`,
  artifacts: testState.artifacts,
  health: testState.health,
})));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Only the browser SDK's renderer boundary is substituted; the real Modal
// owner and WebAlertModal confirmation buttons settle the user's choice.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));
vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
const statusSignals: AbortSignal[] = [];
const diagnosticsEvents = createDiagnosticsTestEvents();
installSessionActionRpcBoundary(async (request, context) => {
  const separator = request.method.indexOf(':');
  const machineId = request.method.slice(0, separator);
  const method = request.method.slice(separator + 1);
  if (method === RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_CONFIGURE) {
    if (testState.configureError) throw testState.configureError;
    const pending = configure(machineId, VoiceSpeechDiagnosticsConfigureRequestV1Schema.parse(request.params).settings);
    diagnosticsEvents.notify();
    try { return VoiceSpeechDiagnosticsStatusResponseV1Schema.parse(await pending); }
    finally { diagnosticsEvents.notify(); }
  }
  if (method === RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS) {
    statusSignals.push(context.signal);
    context.signal.addEventListener('abort', diagnosticsEvents.notify, { once: true });
    diagnosticsEvents.notify();
    if (testState.statusError) throw testState.statusError;
    return VoiceSpeechDiagnosticsStatusResponseV1Schema.parse({ ...await status(machineId), settings: diagnostics,
      backupPolicy: resolveVoiceSpeechDiagnosticsStoragePolicy('daemon_desktop') });
  }
  if (method === RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_DELETE_ALL) {
    if (testState.deleteError) throw testState.deleteError;
    return { ok: true };
  }
  if (method === RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_REVOKE_CAPTURE) {
    VoiceSpeechDiagnosticsRevokeCaptureRequestV1Schema.parse(request.params);
    return { ok: true };
  }
  throw new Error(`Unexpected daemon RPC: ${method}`);
});
const { storage } = await import('@/sync/domains/state/storage');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { useMachineCliDetectionTarget } = await import('@/sync/store/hooks');
const { setVoiceSessionSnapshot, resetVoiceSessionStoreForTests } = await import('@/voice/session/voiceSessionStore');
const { VoiceDiagnosticsSettingsSection: SettingsSection } = await import('./VoiceDiagnosticsSettingsSection');
const { ModalProvider } = await import('@/modal');
const { WebAlertModal } = await import('@/modal/components/WebAlertModal');
let modalScreen: RenderScreenResult;
let home: Awaited<ReturnType<typeof serveAccountHomes>>;
let disconnect: (() => Promise<void>) | undefined;
function publishSettingsFixture(voice: unknown) {
  const machines = ['m1', 'm2', 'former-machine'].map(id => createMachineFixture({ id, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, active: machineState.isOnline,
    activeAt: machineState.isOnline ? Date.now() : 0, daemonStateVersion: machineState.daemonStateVersion }));
  storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
    machineListByServerId: { [home.homes.diagnostics!.id]: machines } });
  observeMachinePresenceForTest({ serverId: home.homes.diagnostics!.id, accountId: 'account-a' }, machines.map(machine => machine.id));
  storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse({ ...voiceSettingsParse(voice),
    executionMachine: { mode: 'fixed', machineId: machineState.machineId } }) }, storage.getState().settings));
  home.replaceAccountSettings('diagnostics', { settings: storage.getState().settings, version: 1 });
  if (activeVoiceAttempt.sessionId) setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: activeVoiceAttempt.sessionId,
    status: 'connected', mode: 'listening', canStop: true });
}
function commitVoiceSettings(voice: React.ComponentProps<typeof SettingsSection>['voice']) {
  storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice }, storage.getState().settings));
}
function createSettingsSection(props: React.ComponentProps<typeof SettingsSection>) {
  publishSettingsFixture(props.voice);
  return React.createElement(SettingsSection, props);
}

import { VOICE_PRIVACY_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { useVoiceDiagnosticsRuntimeSync } from './useVoiceDiagnosticsRuntimeSync';
import {
  beginVoiceDiagnosticsRevocationObligation,
  publishVoiceDiagnosticsRuntimeStatus,
  resetVoiceDiagnosticsRuntimeStatusForTests,
} from './runtimeStatus';
import { resetVoiceDiagnosticsRevocationForTests } from './runtimeRevocation';
import { resetVoiceDiagnosticsSessionPolicyForTests } from './capturePolicy';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

function RuntimeSyncSettingsHarness(props: Readonly<{ voice: unknown }>) {
  useVoiceDiagnosticsRuntimeSync(props.voice);
  const voice = React.useMemo(() => voiceSettingsParse(props.voice), [props.voice]);
  return React.createElement(SettingsSection, {
    voice,
    setVoice: commitVoiceSettings,
  });
}

function createRuntimeSettingsHarness(props: { voice: unknown }) {
  publishSettingsFixture(props.voice);
  return React.createElement(RuntimeSyncSettingsHarness, props);
}

async function mountRuntimeSettingsHarness(props: { voice: unknown }) {
  storage.setState({ machines: {}, machineListByServerId: { [home.homes.diagnostics!.id]: [] } });
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(React.createElement(RuntimeSyncSettingsHarness, props));
    registerStandardCleanupTarget(tree);
  });
  await act(async () => { tree.update(createRuntimeSettingsHarness(props)); });
  return tree;
}

const diagnostics = VoiceSpeechDiagnosticsSettingsV1Schema.parse({
  v: 1 as const,
  enabled: true,
  consentVersion: 1 as const,
  captureSttInput: true,
  captureTtsOutput: false,
});

describe('VoiceDiagnosticsSettingsSection selected-machine status', () => {
  afterEach(async () => { standardCleanup(); diagnosticsEvents.clear(); await disconnect?.(); await home?.dispose(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    home = await serveAccountHomes({ homes: [{ key: 'diagnostics', serverUrl: 'https://diagnostics-settings.test', accountId: 'account-a' }],
      route: ({ path, method, body }) => path === '/v1/machines'
        ? Response.json(['m1', 'm2', 'former-machine'].map(id => createPlainMachineRowFixture({ id, accountId: 'account-a' })))
        : createPlainMachineReadHttpResponseFixture(path,
        { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, 'account-a') ?? undefined });
    disconnect = await home.restoreActiveConnection();
    modalScreen = await renderScreen(React.createElement(ModalProvider, { children: null }));
    resetVoiceSessionStoreForTests();
    vi.spyOn(console, 'error').mockImplementation(fireAndForgetError);
    machineState.machineId = 'm1';
    machineState.daemonStateVersion = 1;
    machineState.isOnline = true;
    activeVoiceAttempt.sessionId = null;
    resetVoiceDiagnosticsRuntimeStatusForTests();
    resetVoiceDiagnosticsRevocationForTests();
    resetVoiceDiagnosticsSessionPolicyForTests();
    configure.mockClear();
    status.mockClear();
    statusSignals.length = 0;
    testState.artifacts = [];
    testState.deleteError = null;
    testState.configureError = null;
    testState.statusError = null;
    testState.blockedEnabledMachineId = null;
    testState.configureBarrier = null;
    testState.policyByMachine.clear();
    testState.configureCompletions = [];
    testState.health = {
      captureFailure: false,
      cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 },
    };
    fireAndForgetError.mockClear();
    const machine = createMachineFixture({ id: 'm1', activeAt: Date.now() });
    storage.setState({ machines: { m1: machine }, machineListByServerId: { [home.homes.diagnostics!.id]: [machine] } });
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse({ diagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm1' } }) }, storage.getState().settings));
    const readiness = await renderHook(() => useMachineCliDetectionTarget('m1'));
    await waitForTestEvent(readiness.subscribe, readiness.getCurrent, value => value.isOnline);
    expect(readiness.getCurrent().isOnline).toBe(true);
    await readiness.unmount();
  });

  it('does not enable diagnostics through a click when settings.invoke is disabled', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(createSettingsSection({ voice: voiceSettingsParse({ diagnostics: { ...diagnostics, enabled: false, consentVersion: null } }), setVoice: commitVoiceSettings }));
      registerStandardCleanupTarget(tree);
    });
    storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } } }) });
    await act(async () => { tree.root.findByProps({ testID: 'settings-voice-diagnostics-enabled-switch' }).props.onValueChange(true); });
    // Disabled admission must happen before the operation's consent confirmation.
    expect(modalScreen.findAllByType(WebAlertModal).some(node => node.props.config.title === tLoose('settingsVoice.diagnostics.consentTitle'))).toBe(false);
  });

  it('reflects disabled settings Actions on export, cleanup and delete controls and restores availability', async () => {
    testState.artifacts = [{ id: 'abcdef12-dead-beef', createdAtMs: 1, direction: 'stt_input', format: 'webm', durationMs: null, byteLength: 1236 }];
    testState.health = { captureFailure: false, cleanup: { status: 'required', code: 'cleanup_failed', ownedEntryCount: 1 } };
    const screen = await renderScreen(createSettingsSection({ voice: voiceSettingsParse({ diagnostics }), setVoice: commitVoiceSettings }));
    await act(async () => { await diagnosticsEvents.waitFor(() => { expect(statusSignals.length).toBeGreaterThan(0); }); });
    const artifact = () => screen.tree.root.findAllByProps({ testID: 'settings-voice-diagnostics-artifact-abcdef12-dead-beef' })[0];
    expect(artifact()).toBeDefined();
    const controls = () => [artifact(),
      screen.tree.root.findAllByProps({ title: tLoose('settingsVoice.diagnostics.retryCleanup') })[0],
      screen.tree.root.findByProps({ testID: 'settings-voice-diagnostics-delete-all' }),
      screen.tree.root.findByProps({ testID: 'settings-voice-diagnostics-enabled-switch' })];
    expect(controls().every(control => control?.props.disabled !== true)).toBe(true);
    const settings = storage.getState().settings.actionsSettingsV1;
    await act(async () => { storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } } }) }); });
    expect(controls().every(control => control?.props.disabled === true)).toBe(true);
    await act(async () => { storage.getState().applySettingsLocal({ actionsSettingsV1: settings }); });
    expect(controls().every(control => control?.props.disabled !== true)).toBe(true);
  });

  it('gives every diagnostics switch a programmatic accessible name', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(createSettingsSection( {
        voice: voiceSettingsParse({ diagnostics }),
        setVoice: commitVoiceSettings,
      })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    const switchLabels = tree.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'switch')
      .map((node) => node.props.accessibilityLabel)
      .filter((label): label is string => typeof label === 'string');
    expect(switchLabels).toEqual([
      tLoose('settingsVoice.diagnostics.enabled'),
      tLoose('settingsVoice.diagnostics.sttInput'),
      tLoose('settingsVoice.diagnostics.ttsOutput'),
    ]);
  });

  it('retires an unanswered diagnostics status read when the settings owner unmounts', async () => {
    status.mockImplementationOnce(async () => await new Promise(() => {}));
    const screen = await renderScreen(createSettingsSection({ voice: voiceSettingsParse({ diagnostics }), setVoice: commitVoiceSettings }));
    await diagnosticsEvents.waitFor(() => expect(statusSignals.length).toBeGreaterThan(0));
    await screen.unmount();
    await diagnosticsEvents.waitFor(() => expect(statusSignals.every(signal => signal.aborted)).toBe(true));
    const retry = await renderScreen(createSettingsSection({ voice: voiceSettingsParse({ diagnostics }), setVoice: commitVoiceSettings }));
    await waitForTestEvent(retry.subscribe, () => retry.tree.root.findAllByProps({ title: tLoose('settingsVoice.diagnostics.location') })[0]?.props.subtitle,
      value => typeof value === 'string');
    // The machine is proved by the status read above; the row names it as a place, never a path.
    expect(String(retry.tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.location') }).props.subtitle)).not.toContain('/private/');
    await retry.unmount();
  });

  it('rebinds diagnostics after the Account runtime retires without changing its machine', async () => {
    const screen = await renderScreen(createSettingsSection({ voice: voiceSettingsParse({ diagnostics }), setVoice: commitVoiceSettings }));
    const location = () => screen.tree.root.findAllByProps({ title: tLoose('settingsVoice.diagnostics.location') });
    const reboundArtifact = () => screen.tree.root.findAllByProps({ testID: 'settings-voice-diagnostics-artifact-rebound-1' });
    await waitForTestEvent(screen.subscribe, () => location().length, count => count > 0);
    // The location names the machine's private folder, never its path.
    expect(String(location()[0]?.props.subtitle)).not.toContain('/private/');
    expect(reboundArtifact()).toHaveLength(0);
    status.mockResolvedValueOnce({ ok: true, root: '/private/rebound', health: testState.health,
      artifacts: [{ id: 'rebound-1', createdAtMs: 1, direction: 'stt_input', format: 'webm', durationMs: null, byteLength: 1236 }] });
    const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    await act(async () => { retireActiveServerAccountScopeLifetime(); });
    await waitForTestEvent(screen.subscribe, () => reboundArtifact().length, count => count > 0);
    await screen.unmount();
  });

  it('keeps a failed persisted shutdown visible and retryable in Voice Settings', async () => {
    beginVoiceDiagnosticsRevocationObligation(
      { kind: 'machine_policy', machineId: 'former-machine' },
      'failed',
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(createSettingsSection( {
        voice: voiceSettingsParse({ diagnostics }),
        setVoice: commitVoiceSettings,
      })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    expect(tree.root.findAllByType('Text' as any).some(
      (node) => node.children.join('') === tLoose('settingsVoice.diagnostics.shutdownFailedIndicator'),
    )).toBe(true);
    const retry = tree.root.findByProps({
      accessibilityLabel: tLoose('settingsVoice.diagnostics.retryShutdown'),
    });
    expect(retry.props.accessibilityRole).toBe('button');
    expect(retry.props.disabled).toBe(false);
  });

  it('offers session opt-out in Voice Settings for the canonical active Voice attempt', async () => {
    activeVoiceAttempt.sessionId = 'active-diagnostics-session';
    publishVoiceDiagnosticsRuntimeStatus({ machineId: 'm1', phase: 'active' });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(createSettingsSection( {
        voice: voiceSettingsParse({ diagnostics }),
        setVoice: commitVoiceSettings,
      })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    const optOut = tree.root.findByProps({
      accessibilityLabel: tLoose('settingsVoice.diagnostics.sessionOptOut'),
    });
    expect(optOut.props.accessibilityRole).toBe('button');
    expect(optOut.props.disabled).toBe(false);
  });

  it('invalidates retained artifacts and reloads status from the newly selected machine', async () => {
    let tree!: renderer.ReactTestRenderer;
    const first = voiceSettingsParse({ diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } });
    const second = voiceSettingsParse({ diagnostics, executionMachine: { mode: 'fixed', machineId: 'm2' } });
    await act(async () => {
      tree = renderer.create(createSettingsSection( { voice: first, setVoice: commitVoiceSettings })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');
    // The machine is proved by the status read above; the row names it as a place, never a path.
    expect(String(tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.location') }).props.subtitle)).not.toContain('/private/');

    machineState.machineId = 'm2';
    await act(async () => {
      tree.update(createSettingsSection( { voice: second, setVoice: commitVoiceSettings }));
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    expect(status.mock.calls.map(([machineId]) => machineId)).toEqual(['m1', 'm2']);
    expect(configure).not.toHaveBeenCalled();
    // The machine is proved by the status read above; the row names it as a place, never a path.
    expect(String(tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.location') }).props.subtitle)).not.toContain('/private/');
  });

  it('invalidates stale daemon status during restart reconciliation and reloads it after acknowledgement', async () => {
    let tree!: renderer.ReactTestRenderer;
    const voice = voiceSettingsParse({ diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } });
    await act(async () => {
      tree = renderer.create(createSettingsSection( { voice, setVoice: commitVoiceSettings })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');
    expect(status).toHaveBeenCalledTimes(1);

    await act(async () => {
      publishVoiceDiagnosticsRuntimeStatus({ machineId: 'm1', phase: 'transitioning' });
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');
    expect(tree.root.findByProps({ testID: 'settings-voice-diagnostics-unavailable' })).toBeTruthy();
    expect(tree.root.findAllByProps({ title: tLoose('settingsVoice.diagnostics.location') })).toHaveLength(0);

    await act(async () => {
      publishVoiceDiagnosticsRuntimeStatus({ machineId: 'm1', phase: 'active' });
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');
    expect(status).toHaveBeenCalledTimes(2);
    // The machine is proved by the status read above; the row names it as a place, never a path.
    expect(String(tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.location') }).props.subtitle)).not.toContain('/private/');
  });

  it('does not let an older cleanup retry re-enable or republish a revoked former machine', async () => {
    testState.health = {
      captureFailure: false,
      cleanup: { status: 'required', code: 'cleanup_failed', ownedEntryCount: 1 },
    };
    const voiceFor = (machineId: string) => ({
      diagnostics,
      executionMachine: { mode: 'fixed', machineId },
    });
    let releaseCleanup!: () => void;
    const cleanupBarrier = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let tree!: renderer.ReactTestRenderer;
    tree = await mountRuntimeSettingsHarness({ voice: voiceFor('m1') });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');
    expect(testState.policyByMachine.get('m1')).toBe(true);

    testState.blockedEnabledMachineId = 'm1';
    testState.configureBarrier = cleanupBarrier;
    await act(async () => {
      tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.retryCleanup') }).props.onPress();
      await Promise.resolve();
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');
    await diagnosticsEvents.waitFor(() => expect(configure.mock.calls.filter(
      ([machineId, settings]) => machineId === 'm1' && settings.enabled === true,
    )).toHaveLength(2));

    machineState.machineId = 'm2';
    await act(async () => {
      tree.update(createRuntimeSettingsHarness({ voice: voiceFor('m2') }));
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    await act(async () => {
      releaseCleanup();
      await diagnosticsEvents.waitFor(() => {
        expect(testState.configureCompletions.filter(([machineId]) => machineId === 'm1').at(-1))
          .toEqual(['m1', false]);
        expect(testState.policyByMachine.get('m1')).toBe(false);
      });
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');
    expect(testState.configureCompletions.filter(([machineId]) => machineId === 'm1').at(-1))
      .toEqual(['m1', false]);
    expect(testState.policyByMachine.get('m1')).toBe(false);
    expect(tree.root.findAllByProps({ subtitle: '/private/m1' })).toHaveLength(0);
    await act(async () => { tree.unmount(); });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');
  });

  it('discloses best-effort cache protection instead of claiming OS-enforced backup exclusion', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(createSettingsSection( {
        voice: voiceSettingsParse({ diagnostics }),
        setVoice: commitVoiceSettings,
      })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    // Said as the outcome for the person, without the storage mechanism.
    expect(tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.backupPolicy') }).props.subtitle)
      .toBe(tLoose('settingsVoice.diagnostics.backupPolicyBestEffort'));
  });

  it('reports a failed delete-all privacy action instead of failing silently', async () => {
    testState.artifacts = [{
      id: 'abcdef12-dead-beef',
      createdAtMs: 1,
      direction: 'stt_input',
      format: 'webm',
      durationMs: null,
      byteLength: 1236,
    }];
    testState.deleteError = new Error('daemon unavailable');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(createSettingsSection( {
        voice: voiceSettingsParse({ diagnostics }),
        setVoice: commitVoiceSettings,
      })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    expect(tree.root.findByProps({ testID: 'settings-voice-diagnostics-artifact-abcdef12-dead-beef' }).props.subtitle)
      .toBe('WEBM · 1.24 KB');

    await act(async () => {
      tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.deleteAll') }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    expect(modalScreen.findAllByType(WebAlertModal).map(node => node.props.config)).toContainEqual(expect.objectContaining({
      title: tLoose('common.error'), message: tLoose('settingsVoice.diagnostics.deleteFailed'),
    }));
  });

  it('keeps an offline enable intent without leaking the expected machine failure to fire-and-forget', async () => {
    testState.configureError = new Error('machine unavailable');
    testState.statusError = new Error('machine unavailable');
    const disabledDiagnostics = VoiceSpeechDiagnosticsSettingsV1Schema.parse({ ...diagnostics, enabled: false, consentVersion: null });
    const setVoice = vi.fn(commitVoiceSettings);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(createSettingsSection( {
        voice: voiceSettingsParse({ diagnostics: disabledDiagnostics }),
        setVoice,
      })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    await act(async () => {
      tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.enabled') })
        .props.rightElement.props.onValueChange(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitForHomeGovernance(() => expect(modalScreen.findByTestId('web-modal-confirm')).not.toBeNull());
    await modalScreen.pressByTestIdAsync('web-modal-confirm');
    await waitForHomeGovernance(() => expect(storage.getState().settings.voice.diagnostics.enabled).toBe(true));
    expect(fireAndForgetError.mock.calls.filter(([message]) => (
      typeof message === 'string' && message.startsWith('[fireAndForget] VoiceDiagnosticsSettingsSection')
    ))).toEqual([]);
    expect(storage.getState().settings.voice.diagnostics).toMatchObject({ enabled: true, consentVersion: 1 });
    expect(configure).not.toHaveBeenCalled();
    expect(tree.root.findByProps({ testID: 'settings-voice-diagnostics-unavailable' })).toBeTruthy();
  });

  it('commits desired diagnostics settings without writing current-machine policy from the settings surface', async () => {
    const disabledDiagnostics = VoiceSpeechDiagnosticsSettingsV1Schema.parse({ ...diagnostics, enabled: false, consentVersion: null });
    const setVoice = vi.fn(commitVoiceSettings);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(createSettingsSection( {
        voice: voiceSettingsParse({ diagnostics: disabledDiagnostics }),
        setVoice,
      })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    await act(async () => {
      tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.enabled') })
        .props.rightElement.props.onValueChange(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitForHomeGovernance(() => expect(modalScreen.findByTestId('web-modal-confirm')).not.toBeNull());
    await modalScreen.pressByTestIdAsync('web-modal-confirm');
    await waitForHomeGovernance(() => expect(storage.getState().settings.voice.diagnostics.enabled).toBe(true));
    expect(storage.getState().settings.voice.diagnostics).toMatchObject({ enabled: true, consentVersion: 1 });
    expect(configure).not.toHaveBeenCalled();
  });

  it('keeps degraded cleanup visible and retryable when no committed artifacts can be listed', async () => {
    testState.health = {
      captureFailure: false,
      cleanup: { status: 'required', code: 'catalog_unreadable', ownedEntryCount: null },
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(createSettingsSection( {
        voice: voiceSettingsParse({ diagnostics }),
        setVoice: commitVoiceSettings,
      })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    expect(tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.cleanupRequired') })).toBeTruthy();
    expect(tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.deleteAll') }).props.disabled).toBe(false);
    expect(tree.root.findAllByProps({ subtitle: tLoose('settingsVoice.diagnostics.noArtifacts') })).toHaveLength(0);
    const beforeRetry = configure.mock.calls.length;
    await act(async () => {
      tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.retryCleanup') }).props.onPress();
      await Promise.resolve();
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');
    expect(configure.mock.calls.length).toBeGreaterThan(beforeRetry);
  });

  it('does not mislabel a non-retaining capture failure as leftover private data', async () => {
    testState.health = {
      captureFailure: true,
      cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 },
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(createSettingsSection( {
        voice: voiceSettingsParse({ diagnostics }),
        setVoice: commitVoiceSettings,
      })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    expect(tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.captureFailed') })).toBeTruthy();
    expect(tree.root.findAllByProps({ nativeID: `setting-${VOICE_PRIVACY_SETTINGS.settings.diagnosticsExport.anchor}` })).toHaveLength(0);
    expect(tree.root.findAllByProps({ title: tLoose('settingsVoice.diagnostics.cleanupRequired') })).toHaveLength(0);
    expect(tree.root.findAllByProps({ title: tLoose('settingsVoice.diagnostics.retryCapture') })).toHaveLength(0);
    expect(tree.root.findAllByProps({ title: tLoose('settingsVoice.diagnostics.retryCleanup') })).toHaveLength(0);
    // Nothing is retained, so there is nothing to delete: the action is hidden, not a dead red row.
    expect(tree.root.findAllByProps({ title: tLoose('settingsVoice.diagnostics.deleteAll') })).toHaveLength(0);
  });

  it('says once that the Voice computer cannot be reached instead of an unavailable value on every row', async () => {
    testState.statusError = new Error('machine unavailable');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(createSettingsSection( {
        voice: voiceSettingsParse({ diagnostics }),
        setVoice: commitVoiceSettings,
      })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    const line = tree.root.findByProps({ testID: 'settings-voice-diagnostics-unavailable' });
    expect(line.props.title).toBe(tLoose('settingsVoice.pages.privacy.diagnosticsUnreachable'));
    expect(tree.root.findAll((node) => node.props?.subtitle === tLoose('settingsVoice.diagnostics.unavailable'))).toHaveLength(0);
    for (const title of ['location', 'backupPolicy', 'exportTitle', 'deleteAll']) {
      expect(tree.root.findAllByProps({ title: tLoose(`settingsVoice.diagnostics.${title}`) })).toHaveLength(0);
    }
    // The setting the user can still change stays.
    expect(tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.enabled') })).toBeTruthy();
  });

  it('shows independent capture and cleanup obligations with only truthful actions', async () => {
    testState.health = {
      captureFailure: true,
      cleanup: {
        status: 'required',
        code: 'cleanup_failed',
        ownedEntryCount: 1,
      },
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(createSettingsSection( {
        voice: voiceSettingsParse({ diagnostics }),
        setVoice: commitVoiceSettings,
      })); registerStandardCleanupTarget(tree);
    });
    if (modalScreen.findByTestId('web-modal-confirm')) await modalScreen.pressByTestIdAsync('web-modal-confirm');

    expect(tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.captureFailed') })).toBeTruthy();
    expect(tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.cleanupRequired') })).toBeTruthy();
    expect(tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.retryCleanup') })).toBeTruthy();
    expect(tree.root.findByProps({ title: tLoose('settingsVoice.diagnostics.deleteAll') }).props.disabled).toBe(false);
    expect(tree.root.findAllByProps({ title: tLoose('settingsVoice.diagnostics.retryCapture') })).toHaveLength(0);
  });
});
