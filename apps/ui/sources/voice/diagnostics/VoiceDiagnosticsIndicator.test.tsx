import * as React from 'react';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { createMachineFixture, registerStandardCleanupTarget, renderScreen, renderHook, standardCleanup, waitForTestEvent, type RenderScreenResult } from '@/dev/testkit';
import { createDiagnosticsTestEvents } from './diagnosticsTestEvents';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { VoiceSpeechDiagnosticsConfigureRequestV1Schema, VoiceSpeechDiagnosticsRevokeCaptureRequestV1Schema, VoiceSpeechDiagnosticsStatusResponseV1Schema,
  resolveVoiceSpeechDiagnosticsStoragePolicy } from '@happier-dev/protocol/voice/diagnostics';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { tLoose } from '@/text';

const runtimeState = vi.hoisted(() => ({ daemonStateVersion: 1, isOnline: true }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const diagnostics = vi.hoisted(() => ({ v: 1 as const, enabled: true, consentVersion: 1 as 1 | null,
  captureSttInput: true, captureTtsOutput: false }));
const machineState = vi.hoisted(() => ({ machineId: 'm1' as string | null }));
const modalState = vi.hoisted(() => ({ confirmed: true }));
const revokeState = vi.hoisted(() => ({ error: null as Error | null, pending: null as Promise<void> | null }));
const configureState = vi.hoisted(() => ({ failedCalls: new Set<string>() }));
const platformState = vi.hoisted(() => ({ OS: 'web' }));
const announceForAccessibility = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ AccessibilityInfo: { announceForAccessibility },
    Platform: { get OS() { return platformState.OS; } } });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// React-test-renderer is the host boundary here; ModalManager, ModalProvider,
// WebAlertModal and its actual confirmation buttons remain real.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));
const revokeCaptureAuthorization = vi.hoisted(() => vi.fn(async () => {
  if (revokeState.pending) await revokeState.pending;
  if (revokeState.error) throw revokeState.error;
}));
const configure = vi.hoisted(() => vi.fn(async (machineId: string, settings: Readonly<{ enabled: boolean }>) => {
  const key = `${machineId}:${settings.enabled ? 'enabled' : 'disabled'}`;
  if (configureState.failedCalls.has(key)) throw new Error(`configure_failed:${key}`);
  return { ok: true, settings };
}));
const diagnosticsEvents = createDiagnosticsTestEvents();
vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
const rpcRequests = installSessionActionRpcBoundary(async request => {
  const separator = request.method.indexOf(':');
  const machineId = request.method.slice(0, separator);
  const method = request.method.slice(separator + 1);
  if (method === RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_REVOKE_CAPTURE) {
    VoiceSpeechDiagnosticsRevokeCaptureRequestV1Schema.parse(request.params);
    const pending = revokeCaptureAuthorization();
    diagnosticsEvents.notify();
    try { await pending; } finally { diagnosticsEvents.notify(); }
    return { ok: true };
  }
  if (method !== RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_CONFIGURE) throw new Error(`Unexpected daemon RPC: ${method}`);
  const requestSettings = VoiceSpeechDiagnosticsConfigureRequestV1Schema.parse(request.params).settings;
  const pending = configure(machineId, requestSettings);
  diagnosticsEvents.notify();
  try { await pending; } finally { diagnosticsEvents.notify(); }
  return VoiceSpeechDiagnosticsStatusResponseV1Schema.parse({ ok: true, root: `/private/${machineId}`, settings: requestSettings,
    artifacts: [], health: { captureFailure: false, cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 } },
    backupPolicy: resolveVoiceSpeechDiagnosticsStoragePolicy('daemon_desktop') });
});
const { storage } = await import('@/sync/domains/state/storage');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { useMachineCliDetectionTarget } = await import('@/sync/store/hooks');
const { setVoiceSessionSnapshot, resetVoiceSessionStoreForTests } = await import('@/voice/session/voiceSessionStore');
const { VoiceDiagnosticsIndicator: Indicator } = await import('./VoiceDiagnosticsIndicator');
const { ModalProvider } = await import('@/modal');
const { WebAlertModal } = await import('@/modal/components/WebAlertModal');
let modalScreen: RenderScreenResult;
function readAlertDialogs() {
  return modalScreen.findAllByType(WebAlertModal).filter(node => node.props.config.type === 'alert');
}
async function respondToVisibleConfirmation(required = false) {
  if (required) await waitForHomeGovernance(() => {
    expect(modalScreen.findAllByType(WebAlertModal).some(node => node.props.visible !== false && node.props.config.type === 'confirm')).toBe(true);
  });
  // The host retains hidden dialogs during exit. Only a visible confirmation
  // can accept another user gesture.
  if (modalScreen.findAllByType(WebAlertModal).some(node => node.props.visible !== false && node.props.config.type === 'confirm')) {
    await modalScreen.pressByTestIdAsync(modalState.confirmed ? 'web-modal-confirm' : 'web-modal-cancel');
  }
}
let home: Awaited<ReturnType<typeof serveAccountHomes>>;
let disconnect: (() => Promise<void>) | undefined;
function VoiceDiagnosticsIndicator(props: React.ComponentProps<typeof Indicator>) {
  React.useLayoutEffect(() => {
    if (props.sessionId) setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: props.sessionId,
      status: 'connected', mode: 'listening', canStop: true });
    const machines = ['m1', 'm2'].map(id => createMachineFixture({ id, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, active: runtimeState.isOnline,
      activeAt: runtimeState.isOnline ? Date.now() : 0, daemonStateVersion: runtimeState.daemonStateVersion,
      daemonState: { status: 'running', startedAt: runtimeState.daemonStateVersion } }));
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
      machineListByServerId: { [home.homes.diagnostics!.id]: machines } });
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse({ diagnostics,
      executionMachine: { mode: 'fixed', machineId: machineState.machineId } }) }, storage.getState().settings));
  });
  return React.createElement(Indicator, props);
}

import {
  beginVoiceDiagnosticsRevocationObligation,
  publishVoiceDiagnosticsRuntimeStatus,
  readVoiceDiagnosticsRuntimeStatus,
  resetVoiceDiagnosticsRuntimeStatusForTests,
  updateVoiceDiagnosticsRevocationObligation,
  useVoiceDiagnosticsRuntimeStatus,
} from './runtimeStatus';
import {
  resetVoiceDiagnosticsSessionPolicyForTests,
  resolveVoiceDiagnosticsCaptureContextFromSettings,
} from './capturePolicy';
import { useVoiceDiagnosticsRuntimeSync } from './useVoiceDiagnosticsRuntimeSync';
import { resetVoiceDiagnosticsRevocationForTests } from './runtimeRevocation';

function RuntimeSyncIndicatorHarness(props: Readonly<{
  voice: unknown;
  sessionId: string;
  includeSecondSurface?: boolean;
}>) {
  useVoiceDiagnosticsRuntimeSync(props.voice);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(VoiceDiagnosticsIndicator, { key: 'primary', sessionId: props.sessionId }),
    props.includeSecondSurface
      ? React.createElement(VoiceDiagnosticsIndicator, { key: 'secondary', sessionId: props.sessionId })
      : null,
  );
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle));
  }
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('VoiceDiagnosticsIndicator', () => {
  afterEach(async () => {
    standardCleanup();
    diagnosticsEvents.clear();
    // Every Home credential fixture was written on the web SDK boundary.
    // Native presentation probes must not move its teardown to another store.
    platformState.OS = 'web';
    await disconnect?.();
    await home?.dispose();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    resetVoiceSessionStoreForTests();
    platformState.OS = 'web';
    home = await serveAccountHomes({ homes: [{ key: 'diagnostics', serverUrl: 'https://diagnostics-indicator.test', accountId: 'account-a' }],
      route: ({ path, method, body }) => path === '/v1/machines'
        ? Response.json(['m1', 'm2'].map(id => createPlainMachineRowFixture({ id, accountId: 'account-a' })))
        : createPlainMachineReadHttpResponseFixture(path,
        { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, 'account-a') ?? undefined });
    disconnect = await home.restoreActiveConnection();
    modalScreen = await renderScreen(React.createElement(ModalProvider, { children: null }));
    diagnostics.enabled = true;
    diagnostics.consentVersion = 1;
    machineState.machineId = 'm1';
    runtimeState.daemonStateVersion = 1;
    runtimeState.isOnline = true;
    resetVoiceDiagnosticsRuntimeStatusForTests();
    resetVoiceDiagnosticsRevocationForTests();
    publishVoiceDiagnosticsRuntimeStatus({ phase: 'active', machineId: 'm1' });
    revokeCaptureAuthorization.mockReset();
    revokeCaptureAuthorization.mockImplementation(async () => {
      if (revokeState.pending) await revokeState.pending;
      if (revokeState.error) throw revokeState.error;
    });
    configure.mockClear();
    configureState.failedCalls.clear();
    rpcRequests.length = 0;
    announceForAccessibility.mockClear();
    modalState.confirmed = true;
    revokeState.error = null;
    revokeState.pending = null;
    resetVoiceDiagnosticsSessionPolicyForTests();
    const machine = createMachineFixture({ id: 'm1', activeAt: Date.now() });
    storage.setState({ machines: { m1: machine }, machineListByServerId: { [home.homes.diagnostics!.id]: [machine] } });
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse({ diagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm1' } }) }, storage.getState().settings));
    const readiness = await renderHook(() => useMachineCliDetectionTarget('m1'));
    await waitForTestEvent(readiness.subscribe, readiness.getCurrent, value => value.isOnline);
    expect(readiness.getCurrent().isOnline).toBe(true);
    await readiness.unmount();
    const runtimeStatus = await renderHook(useVoiceDiagnosticsRuntimeStatus);
    registerStandardCleanupTarget({ unmount: runtimeStatus.subscribe(diagnosticsEvents.notify) });
  });

  it('reflects disabled settings Actions on session opt-out and restores availability', async () => {
    const screen = await renderScreen(<VoiceDiagnosticsIndicator sessionId="session-1" />);
    const action = () => screen.tree.root.findByProps({ accessibilityLabel: tLoose('settingsVoice.diagnostics.sessionOptOut') });
    expect(action().props.disabled).not.toBe(true);
    const settings = storage.getState().settings.actionsSettingsV1;
    await act(async () => { storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } } }) }); });
    expect(action().props.disabled).toBe(true);
    expect(action().props.accessibilityState).toMatchObject({ disabled: true });
    await act(async () => { storage.getState().applySettingsLocal({ actionsSettingsV1: settings }); });
    expect(action().props.disabled).not.toBe(true);
  });

  it('uses persistent text plus color and is removed for a session opt-out', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' })); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();
    expect(tree.root.findByProps({ accessibilityLabel: tLoose('settingsVoice.diagnostics.sessionOptOut') })).toBeTruthy();
    expect(JSON.stringify(tree.toJSON())).toContain(tLoose('settingsVoice.diagnostics.activeIndicator'));

    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
    });
    await respondToVisibleConfirmation(true);
    await waitForHomeGovernance(() => expect(tree.toJSON()).toBeNull());
    expect(rpcRequests).toContainEqual(expect.objectContaining({ method: `m1:${RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_REVOKE_CAPTURE}`,
      params: expect.objectContaining({ authorizationId: expect.any(String) }) }));
  });

  it('draws the action at the pointer floor on web', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' })); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();

    const action = tree.root.findByType('Pressable' as any);
    const style = typeof action.props.style === 'function'
      ? action.props.style({ pressed: false })
      : action.props.style;
    const frame = flattenStyle(style);
    const expectedMinimum = resolveMinimumInteractiveTargetSize('web');
    expect(frame.minWidth).toBe(expectedMinimum);
    expect(frame.minHeight).toBe(expectedMinimum);
  });

  it('keeps a failed risk message shrinkable beside a compact, fully named retry control', async () => {
    beginVoiceDiagnosticsRevocationObligation(
      { kind: 'machine_policy', machineId: 'm-layout' },
      'failed',
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator)); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();

    const root = tree.root.findByType('View' as any);
    const rootStyle = flattenStyle(root.props.style);
    const message = tree.root.findAllByType('Text' as any).find(
      (node) => node.children.join('') === tLoose('settingsVoice.diagnostics.shutdownFailedIndicator'),
    )!;
    const messageStyle = flattenStyle(message.props.style);
    const messageBlock = tree.root.findAllByType('View' as any).find((node) => {
      const style = flattenStyle(node.props.style);
      return style.flex === 1 && style.minWidth === 0;
    });
    const retry = tree.root.findByType('Pressable' as any);
    const retryLabel = tree.root.findAllByType('Text' as any).find(
      (node) => node.children.join('') === tLoose('common.retry'),
    );

    // These are the semantic layout constraints for a narrow actions block:
    // the disclosure can take the remaining width, while the actual control
    // stays an independent compact target that can wrap beneath it.
    expect(rootStyle.flexWrap).toBe('wrap');
    expect(messageBlock).toBeTruthy();
    expect(messageStyle.flexShrink).toBe(1);
    expect(retry.props.accessibilityLabel).toBe(tLoose('settingsVoice.diagnostics.retryShutdown'));
    expect(retryLabel).toBeTruthy();
  });

  it('keeps a failed shutdown status discoverable without an automatic announcement', async () => {
    platformState.OS = 'ios';
    beginVoiceDiagnosticsRevocationObligation(
      { kind: 'machine_policy', machineId: 'm-announcement' },
      'failed',
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(VoiceDiagnosticsIndicator),
        ),
      ); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();

    expect(tree.root.findAllByType('Text' as any).filter(
      (node) => node.children.join('') === tLoose('settingsVoice.diagnostics.shutdownFailedIndicator'),
    )).toHaveLength(1);
    expect(tree.root.findAllByProps({ accessibilityLiveRegion: 'assertive' })).toHaveLength(0);
    expect(tree.root.findAll((node) => node.props?.accessibilityRole === 'alert')).toHaveLength(0);
    expect(announceForAccessibility).not.toHaveBeenCalled();
  });

  it('keeps a failed retry inline and re-enables it without a generic error modal', async () => {
    beginVoiceDiagnosticsRevocationObligation(
      { kind: 'machine_policy', machineId: 'm-inline-retry' },
      'failed',
    );
    configureState.failedCalls.add('m-inline-retry:disabled');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator)); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();

    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await respondToVisibleConfirmation();
    await diagnosticsEvents.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toContainEqual(
      expect.objectContaining({
        target: { kind: 'machine_policy', machineId: 'm-inline-retry' },
        status: 'failed',
      }),
    ));

    expect(readAlertDialogs()).toEqual([]);
    expect(tree.root.findByType('Pressable' as any).props.disabled).toBe(false);
    expect(tree.root.findAllByType('Text' as any).some(
      (node) => node.children.join('') === tLoose('settingsVoice.diagnostics.shutdownFailedIndicator'),
    )).toBe(true);
  });




  it('is absent unless current explicit consent is active', async () => {
    diagnostics.consentVersion = null;
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' })); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();
    expect(tree.toJSON()).toBeNull();
  });

  it('does not claim capture is active until the selected daemon accepted the policy', async () => {
    publishVoiceDiagnosticsRuntimeStatus({ phase: 'inactive_confirmed', machineId: 'm1' });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' })); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();
    expect(tree.toJSON()).toBeNull();
  });

  it('keeps capture visibly active and offers retry when exact-machine revocation fails', async () => {
    revokeState.error = new Error('daemon disconnected');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' })); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();
    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    await respondToVisibleConfirmation();

    expect(tree.toJSON()).not.toBeNull();
    expect(readAlertDialogs().map(node => node.props.config)).toContainEqual(expect.objectContaining({
      title: tLoose('common.error'), message: tLoose('settingsVoice.diagnostics.sessionOptOutFailed'),
    }));
    expect(JSON.stringify(tree.toJSON())).toContain(tLoose('settingsVoice.diagnostics.shutdownFailedIndicator'));

    revokeState.error = null;
    await modalScreen.pressByTestIdAsync('web-modal-button-0');
    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    await respondToVisibleConfirmation();
    expect(revokeCaptureAuthorization).toHaveBeenCalledTimes(2);
    expect(tree.toJSON()).toBeNull();
  });

  it('keeps an automatically recovered session opted out across a later daemon replacement', async () => {
    const captureSettings = {
      voice: {
        diagnostics: {
          v: 1,
          enabled: true,
          consentVersion: 1,
          captureSttInput: true,
          captureTtsOutput: false,
        },
      },
    };
    let revokeAttempt = 0;
    revokeCaptureAuthorization.mockImplementation(async () => {
      revokeAttempt += 1;
      if (revokeAttempt === 1) throw new Error('old_daemon_runtime_lost');
    });
    const voice = {
      diagnostics: { ...diagnostics },
      executionMachine: { mode: 'fixed', machineId: 'm1' },
    };
    const resolveCaptureContext = () => resolveVoiceDiagnosticsCaptureContextFromSettings({
      settings: captureSettings,
      sessionId: 'session-1',
      direction: 'stt_input',
      durationMs: null,
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(RuntimeSyncIndicatorHarness, {
        voice,
        sessionId: 'session-1',
      })); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();

    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    await respondToVisibleConfirmation();
    await diagnosticsEvents.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]));
    expect(resolveCaptureContext()).toMatchObject({
      sessionId: 'session-1',
      captureAllowed: true,
    });

    runtimeState.daemonStateVersion = 2;
    await act(async () => {
      tree.update(React.createElement(RuntimeSyncIndicatorHarness, {
        voice,
        sessionId: 'session-1',
      }));
    });
    await respondToVisibleConfirmation();
    await diagnosticsEvents.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]));

    runtimeState.daemonStateVersion = 3;
    await act(async () => {
      tree.update(React.createElement(RuntimeSyncIndicatorHarness, {
        voice,
        sessionId: 'session-1',
      }));
    });
    await respondToVisibleConfirmation();
    await diagnosticsEvents.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'active',
    }));
    expect(resolveCaptureContext()).toBeUndefined();
    expect(tree.toJSON()).toBeNull();
    await act(async () => { tree.unmount(); });
    await respondToVisibleConfirmation();
  });

  it('does not revoke on cancel and suppresses duplicate actions while a revoke is pending', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' })); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();
    modalState.confirmed = false;
    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
    });
    await respondToVisibleConfirmation(true);
    expect(revokeCaptureAuthorization).not.toHaveBeenCalled();
    await waitForHomeGovernance(() => expect(tree.root.findByType('Pressable' as any).props.disabled).toBe(false));

    modalState.confirmed = true;
    let release!: () => void;
    revokeState.pending = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => {
      const press = tree.root.findByType('Pressable' as any).props.onPress;
      press();
      press();
      await Promise.resolve();
    });
    await respondToVisibleConfirmation(true);
    await waitForHomeGovernance(() => expect(revokeCaptureAuthorization).toHaveBeenCalledOnce());
    await act(async () => {
      release();
      await revokeState.pending;
      await Promise.resolve();
    });
    await respondToVisibleConfirmation();
    await waitForHomeGovernance(() => expect(tree.toJSON()).toBeNull());
  });

  it('completes an exact-machine opt-out without disabling a newly selected daemon', async () => {
    let tree!: renderer.ReactTestRenderer;
    let release!: () => void;
    revokeState.pending = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' })); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();
    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
    });
    await respondToVisibleConfirmation(true);
    await waitForHomeGovernance(() => expect(revokeCaptureAuthorization).toHaveBeenCalledOnce());
    await act(async () => {
      publishVoiceDiagnosticsRuntimeStatus({ phase: 'status_unknown', machineId: 'm2' });
      tree.update(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' }));
      await Promise.resolve();
    });
    await respondToVisibleConfirmation();
    await act(async () => {
      release();
      await revokeState.pending;
      await Promise.resolve();
    });
    await respondToVisibleConfirmation();

    await waitForHomeGovernance(() => expect(tree.toJSON()).toBeNull());
    expect(readAlertDialogs()).toEqual([]);
    expect(rpcRequests).toContainEqual(expect.objectContaining({ method: `m1:${RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_REVOKE_CAPTURE}` }));
  });

  it('keeps a failed exact-old-machine shutdown visible and retryable through the real runtime sync path', async () => {
    const voiceFor = (machineId: string) => ({
      diagnostics: { ...diagnostics },
      executionMachine: { mode: 'fixed', machineId },
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(RuntimeSyncIndicatorHarness, {
        voice: voiceFor('m1'),
        sessionId: 'session-1',
      })); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();
    await diagnosticsEvents.waitFor(() => expect(configure).toHaveBeenCalledWith('m1', expect.objectContaining({ enabled: true })));

    configureState.failedCalls.add('m1:disabled');
    configureState.failedCalls.add('m2:enabled');
    machineState.machineId = 'm2';
    const m2Voice = voiceFor('m2');
    await act(async () => {
      tree.update(React.createElement(RuntimeSyncIndicatorHarness, {
        voice: m2Voice,
        sessionId: 'session-1',
      }));
    });
    await respondToVisibleConfirmation();
    await diagnosticsEvents.waitFor(() => expect(configure).toHaveBeenCalledWith('m2', expect.objectContaining({ enabled: true })));

    expect(tree.toJSON()).not.toBeNull();
    const renderedFailureLabels = tree.root.findAllByType('Text' as any).filter(
      (node) => node.children.join('') === tLoose('settingsVoice.diagnostics.shutdownFailedIndicator'),
    );
    expect(renderedFailureLabels).toHaveLength(1);
    await act(async () => {
      tree.update(React.createElement(RuntimeSyncIndicatorHarness, {
        voice: m2Voice,
        sessionId: 'session-1',
        includeSecondSurface: true,
      }));
    });
    await respondToVisibleConfirmation();
    await act(async () => {
      tree.update(React.createElement(RuntimeSyncIndicatorHarness, {
        voice: m2Voice,
        sessionId: 'session-1',
      }));
    });
    await respondToVisibleConfirmation();
    const failedObligation = readVoiceDiagnosticsRuntimeStatus().revocationObligations.find(
      (candidate) => candidate.status === 'failed',
    )!;
    await act(async () => {
      updateVoiceDiagnosticsRevocationObligation(failedObligation, 'pending');
    });
    await respondToVisibleConfirmation();
    await act(async () => {
      updateVoiceDiagnosticsRevocationObligation(failedObligation, 'failed');
    });
    await respondToVisibleConfirmation();
    const retryActionStyle = tree.root.findByType('Pressable' as any).props.style;
    expect(retryActionStyle.minWidth).toBeGreaterThanOrEqual(resolveMinimumInteractiveTargetSize('web'));
    expect(retryActionStyle.minHeight).toBeGreaterThanOrEqual(resolveMinimumInteractiveTargetSize('web'));

    configureState.failedCalls.delete('m1:disabled');
    const oldMachineDisableCallsBeforeRetry = configure.mock.calls.filter(
      ([machineId, settings]) => machineId === 'm1' && settings.enabled === false,
    ).length;
    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    await respondToVisibleConfirmation();
    expect(configure.mock.calls.filter(
      ([machineId, settings]) => machineId === 'm1' && settings.enabled === false,
    )).toHaveLength(oldMachineDisableCallsBeforeRetry + 1);
    expect(configure.mock.calls.filter(
      ([machineId, settings]) => machineId === 'm2' && settings.enabled === false,
    )).toHaveLength(0);
  });

  it('draws the action at the pointer floor on Android and reaches the canonical 48dp target by hit area', async () => {
    platformState.OS = 'android';
    vi.resetModules();
    const freshRuntimeStatus = await import('./runtimeStatus');
    const { storage: nativeStorage } = await import('@/sync/domains/state/storage');
    const { voiceSettingsParse: parseNativeVoice } = await import('@/sync/domains/settings/voiceSettings');
    const { normalizeVoiceSettingsLocalDelta: normalizeNativeVoice } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    nativeStorage.getState().applySettingsLocal(normalizeNativeVoice({ voice: parseNativeVoice({ diagnostics }) }, nativeStorage.getState().settings));
    freshRuntimeStatus.publishVoiceDiagnosticsRuntimeStatus({ phase: 'active', machineId: 'm1' });
    const { VoiceDiagnosticsIndicator: AndroidVoiceDiagnosticsIndicator } = await import(
      './VoiceDiagnosticsIndicator'
    );
    const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(
        HappierUiPlatformProvider,
        { platform: { platform: 'android', colorScheme: 'light' } },
        React.createElement(AndroidVoiceDiagnosticsIndicator, { sessionId: 'session-android' }),
      )); registerStandardCleanupTarget(tree);
    });
    await respondToVisibleConfirmation();

    const action = tree.root.findByType('Pressable' as any);
    const style = typeof action.props.style === 'function'
      ? action.props.style({ pressed: false })
      : action.props.style;
    const frame = flattenStyle(style);
    // The action draws at the WCAG 2.2 pointer floor; the finger's 48dp is hit slop around it.
    expect(frame.minWidth).toBe(24);
    expect(frame.minHeight).toBe(24);
    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 60, height: 24 } } });
    });
    const slop = tree.root.findByType('Pressable' as any).props.hitSlop as Record<'top' | 'bottom', number>;
    expect(24 + slop.top + slop.bottom).toBe(resolveMinimumInteractiveTargetSize('android'));
  });
});
