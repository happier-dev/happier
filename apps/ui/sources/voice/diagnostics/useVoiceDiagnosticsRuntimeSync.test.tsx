import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createMachineFixture, registerStandardCleanupTarget, renderHook, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { VoiceSpeechDiagnosticsConfigureRequestV1Schema, VoiceSpeechDiagnosticsRevokeCaptureRequestV1Schema, VoiceSpeechDiagnosticsSettingsV1Schema, VoiceSpeechDiagnosticsStatusResponseV1Schema,
  resolveVoiceSpeechDiagnosticsStoragePolicy } from '@happier-dev/protocol/voice/diagnostics';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';
import { addPersistedVoiceDiagnosticsMachineRevocation, readPersistedVoiceDiagnosticsMachineRevocations } from './revocationObligationPersistence';
import { createDiagnosticsTestEvents } from './diagnosticsTestEvents';

vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const machineState = {
  machineId: 'm1' as string | null,
  daemonStateVersion: 1,
  isOnline: true,
};
const runtimeTargetsByMachineId = new Map<string, Readonly<{
  daemonStateVersion: number;
  isOnline: boolean;
}>>();
let home: Awaited<ReturnType<typeof serveAccountHomes>>;
let disconnect: (() => Promise<void>) | undefined;
let scope: Readonly<{ serverId: string; accountId: string }>;
function clearPersistedFixtures() {
  getPersistenceStorage().delete(serverAccountScopedStorageKey('voice-diagnostics-machine-revocations-v1', scope));
}
const configureCalls = vi.hoisted(() => [] as Array<{
  machineId: string;
  settings: unknown;
  signal?: AbortSignal | null;
}>);
const configureImpl = vi.hoisted(() => vi.fn(async (
  machineId: string,
  settings: unknown,
  signal?: AbortSignal | null,
) => {
  configureCalls.push({ machineId, settings, signal });
  return { ok: true, settings };
}));
const revokeCalls = vi.hoisted(() => [] as Array<{
  machineId: string;
  authorizationId: string;
}>);
const revokeImpl = vi.hoisted(() => vi.fn(async (
  machineId: string,
  authorizationId: string,
  _signal?: AbortSignal | null,
) => {
  revokeCalls.push({ machineId, authorizationId });
}));
// Notifications come from real RPC admission/settlement/abort and the runtime
// status hook's commits; asynchronous phases are owned by the enclosing test.
const { notify: notifyDiagnosticsEvent, waitFor: waitForDiagnosticsEvent, clear: clearDiagnosticsEvents } = createDiagnosticsTestEvents();
installSessionActionRpcBoundary(async (request, context) => {
  context.signal.addEventListener('abort', notifyDiagnosticsEvent, { once: true });
  const machineId = request.method.slice(0, request.method.indexOf(':'));
  const method = request.method.slice(request.method.indexOf(':') + 1);
  if (method === RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_REVOKE_CAPTURE) {
    const payload = VoiceSpeechDiagnosticsRevokeCaptureRequestV1Schema.parse(request.params);
    const result = revokeImpl(machineId, payload.authorizationId, context.signal);
    notifyDiagnosticsEvent();
    try { await result; } finally { notifyDiagnosticsEvent(); }
    return { ok: true };
  }
  if (method !== RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_CONFIGURE) throw new Error(`Unexpected daemon RPC: ${method}`);
  const payload = VoiceSpeechDiagnosticsConfigureRequestV1Schema.parse(request.params);
  const pending = configureImpl(machineId, payload.settings, context.signal);
  notifyDiagnosticsEvent();
  let result: Awaited<typeof pending>;
  try { result = await pending; } finally { notifyDiagnosticsEvent(); }
  return VoiceSpeechDiagnosticsStatusResponseV1Schema.parse({ ...result, root: `/private/${machineId}`, artifacts: [],
    health: { captureFailure: false, cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 } },
    backupPolicy: resolveVoiceSpeechDiagnosticsStoragePolicy('daemon_desktop') });
});
const { storage } = await import('@/sync/domains/state/storage');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { useMachineCliDetectionTarget } = await import('@/sync/store/hooks');
const { resolveVoiceExecutionMachinePresentationFromState } = await import('@/voice/credentials/useExecutionMachinePresentation');

import { useVoiceDiagnosticsRuntimeSync } from './useVoiceDiagnosticsRuntimeSync';
import {
  publishVoiceDiagnosticsRuntimeStatus,
  readVoiceDiagnosticsRuntimeStatus,
  resetVoiceDiagnosticsRuntimeStatusForTests,
  useVoiceDiagnosticsRuntimeStatus,
} from './runtimeStatus';
import {
  applyVoiceDiagnosticsMachinePolicy,
  resetVoiceDiagnosticsRevocationForTests,
  revokeVoiceDiagnosticsSessionAuthorization,
  retryVoiceDiagnosticsRevocation,
} from './runtimeRevocation';
import { resetVoiceDiagnosticsSessionPolicyForTests, resolveVoiceDiagnosticsCaptureAuthorizationId } from './capturePolicy';

type RequestedDiagnosticsSettings = Readonly<{ enabled?: boolean }>;

function readRequestedDiagnosticsEnabled(settings: unknown): boolean | undefined {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return undefined;
  const { enabled } = settings as RequestedDiagnosticsSettings;
  return typeof enabled === 'boolean' ? enabled : undefined;
}

function RuntimeSync(props: { voice: unknown }) {
  useVoiceDiagnosticsRuntimeSync(props.voice);
  const status = useVoiceDiagnosticsRuntimeStatus();
  React.useLayoutEffect(notifyDiagnosticsEvent, [status]);
  return null;
}

function createHarness(props: { voice: unknown }) {
  const machines = ['m1', 'm2', 'm3'].map(id => {
    const target = runtimeTargetsByMachineId.get(id) ?? (id === machineState.machineId ? machineState : { daemonStateVersion: 0, isOnline: false });
    return createMachineFixture({ id, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      active: target.isOnline, activeAt: target.isOnline ? Date.now() : 0,
      daemonStateVersion: target.daemonStateVersion,
      daemonState: { status: 'running', startedAt: target.daemonStateVersion } });
  });
  storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
    machineListByServerId: { [scope.serverId]: machines } });
  storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse(props.voice) }, storage.getState().settings));
  return React.createElement(RuntimeSync, props);
}

async function mountHarness(props: { voice: unknown }) {
  // Mount the actual hook while this Account's machine list is still loading.
  // Its own credential-presence subscription settles before publishing targets;
  // warming a different hook cannot settle this reader's scoped lifetime.
  storage.setState({ machines: {}, machineListByServerId: { [scope.serverId]: [] } });
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(React.createElement(RuntimeSync, props));
    registerStandardCleanupTarget(tree);
  });
  await act(async () => { tree.update(createHarness(props)); });
  return tree;
}

const diagnostics = VoiceSpeechDiagnosticsSettingsV1Schema.parse({
  v: 1, enabled: true, consentVersion: 1,
  captureSttInput: true, captureTtsOutput: false,
});

describe('useVoiceDiagnosticsRuntimeSync', () => {
  afterEach(async () => {
    standardCleanup();
    clearDiagnosticsEvents();
    clearPersistedFixtures();
    await disconnect?.();
    await home?.dispose();
  });
  beforeEach(async () => {
    home = await serveAccountHomes({ homes: [{ key: 'diagnostics', serverUrl: 'https://runtime-diagnostics.test', accountId: 'account-a' }],
      route: ({ path, method, body }) => createPlainMachineReadHttpResponseFixture(path,
        { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, 'account-a') ?? undefined });
    disconnect = await home.restoreActiveConnection();
    scope = { serverId: home.homes.diagnostics!.id, accountId: 'account-a' };
    const machine = createMachineFixture({ id: 'm1', activeAt: Date.now(), daemonStateVersion: 1,
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.setState({ machines: { m1: machine }, machineListByServerId: { [scope.serverId]: [machine] },
      settings: { ...storage.getState().settings, voice: voiceSettingsParse({ diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } }) } });
    const readiness = await renderHook(() => useMachineCliDetectionTarget('m1'));
    await waitForTestEvent(readiness.subscribe, readiness.getCurrent, value => value.isOnline);
    expect(readiness.getCurrent().isOnline).toBe(true);
    await readiness.unmount();
    machineState.machineId = 'm1';
    machineState.daemonStateVersion = 1;
    machineState.isOnline = true;

    runtimeTargetsByMachineId.clear();
    clearPersistedFixtures();
    configureCalls.length = 0;
    configureImpl.mockReset();
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      return { ok: true, settings };
    });
    revokeCalls.length = 0;
    revokeImpl.mockReset();
    revokeImpl.mockImplementation(async (machineId: string, authorizationId: string, _signal?: AbortSignal | null) => {
      revokeCalls.push({ machineId, authorizationId });
    });
    resetVoiceDiagnosticsRuntimeStatusForTests();
    resetVoiceDiagnosticsRevocationForTests();
    resetVoiceDiagnosticsSessionPolicyForTests();
  });

  it.each([true, false])('configures diagnostics only when policy or daemon facts change (enabled: %s)', async (enabled) => {
    const initialDiagnostics = enabled ? diagnostics : VoiceSpeechDiagnosticsSettingsV1Schema.parse({});
    const first = { diagnostics: initialDiagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } };
    const tree = await mountHarness({ voice: first });
    expect(configureCalls).toHaveLength(1);
    const settledStatus = readVoiceDiagnosticsRuntimeStatus();

    // Real settings echoes replace object identities and can change other Voice
    // preferences. Neither is a new diagnostics policy or a daemon restart.
    for (const assistantLanguage of ['fr', 'de', 'en']) {
      await act(async () => {
        tree.update(createHarness({ voice: { ...first, diagnostics: { ...initialDiagnostics }, assistantLanguage } }));
      });
    }
    expect(configureCalls).toHaveLength(1);
    expect(readVoiceDiagnosticsRuntimeStatus()).toBe(settledStatus);

    const changedDiagnostics = { ...initialDiagnostics, maxFiles: initialDiagnostics.maxFiles + 1 };
    await act(async () => { tree.update(createHarness({ voice: { ...first, diagnostics: changedDiagnostics } })); });
    expect(configureCalls).toHaveLength(2);
    expect(configureCalls.at(-1)?.settings).toEqual(changedDiagnostics);

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(createHarness({ voice: { ...first, diagnostics: { ...changedDiagnostics } } })); });
    expect(configureCalls).toHaveLength(3);
    expect(configureCalls.at(-1)?.settings).toEqual(changedDiagnostics);
    await act(async () => { tree.unmount(); });
  });

  it('does not reconfigure or replay a failed revocation for unrelated daemon-state publications', async () => {
    let failFormerMachine = false;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (failFormerMachine && machineId === 'm1') throw new Error('former_machine_unavailable');
      return { ok: true, settings };
    });
    const first = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } };
    const tree = await mountHarness({ voice: first });
    failFormerMachine = true;
    runtimeTargetsByMachineId.set('m1', { isOnline: true, daemonStateVersion: 1 });
    machineState.machineId = 'm2';
    machineState.daemonStateVersion = 2;
    const second = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm2' } };
    await act(async () => { tree.update(createHarness({ voice: second })); });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm2', phase: 'active',
      revocationObligations: [expect.objectContaining({ target: { kind: 'machine_policy', machineId: 'm1' }, status: 'failed' })],
    }));
    const settledCalls = configureCalls.length;
    const settledStatus = readVoiceDiagnosticsRuntimeStatus();
    // A resource/service publication increments the state version while the
    // published daemon start remains the same on both exact machines.
    await act(async () => {
      const machines = Object.fromEntries(Object.entries(storage.getState().machines).map(([id, machine]) => [
        id, { ...machine, daemonStateVersion: machine.daemonStateVersion + 1 },
      ]));
      storage.setState({ machines, machineListByServerId: { [scope.serverId]: Object.values(machines) } });
    });
    expect(configureCalls).toHaveLength(settledCalls);
    expect(readVoiceDiagnosticsRuntimeStatus()).toBe(settledStatus);
    await act(async () => { tree.unmount(); });
  });

  it('reapplies consent on mount, selected-machine changes, and a fresh runtime mount', async () => {
    let tree!: renderer.ReactTestRenderer;
    const first = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } };
    const second = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm2' } };
    tree = await mountHarness({ voice: first });
    expect(configureCalls).toEqual([expect.objectContaining({ machineId: 'm1', settings: diagnostics })]);
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({ machineId: 'm1', phase: 'active' });
    machineState.machineId = 'm2';
    await act(async () => { tree.update(createHarness({ voice: second })); });
    expect(configureCalls.slice(1)).toEqual([
      expect.objectContaining({ machineId: 'm1', settings: expect.objectContaining({ enabled: false, consentVersion: null }) }),
      expect.objectContaining({ machineId: 'm2', settings: diagnostics }),
    ]);
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({ machineId: 'm2', phase: 'active' });
    await act(async () => { tree.unmount(); });

    tree = await mountHarness({ voice: second });
    expect(configureCalls.at(-1)).toEqual(expect.objectContaining({ machineId: 'm2', settings: diagnostics }));
    await act(async () => { tree.unmount(); });
  });

  it('reapplies consent when the same selected daemon restarts', async () => {
    let tree!: renderer.ReactTestRenderer;
    const voice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } };
    tree = await mountHarness({ voice });
    expect(configureCalls).toHaveLength(1);

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(createHarness({ voice })); });

    expect(configureCalls).toEqual([
      expect.objectContaining({ machineId: 'm1', settings: diagnostics }),
      expect.objectContaining({ machineId: 'm1', settings: diagnostics }),
    ]);
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({ machineId: 'm1', phase: 'active' });
    await act(async () => { tree.unmount(); });
  });

  it('does not turn a default-off daemon restart race into a durable shutdown warning', async () => {
    const persistenceScope = scope;
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });

    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      throw new Error('daemon_restarting');
    });
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm1' },
    };

    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'status_unknown',
    }));

    // The request outcome remains unknown, but no prior diagnostic enablement
    // exists to turn this default-off reconciliation into a durable revocation
    // obligation. A later successful reconciliation can still confirm off.
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]);
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scope) ?? []).toEqual([]);
    expect(configureCalls).toEqual([
      expect.objectContaining({
        machineId: 'm1',
        settings: expect.objectContaining({ enabled: false, consentVersion: null }),
      }),
    ]);
    await act(async () => { tree.unmount(); });
  });

  it('revalidates an in-flight session revocation once after the selected daemon runtime reconnects', async () => {
    const oldRuntimeRevoke = createDeferred<void>();
    const currentRuntimeRevoke = createDeferred<void>();
    let revokeAttempt = 0;
    revokeImpl.mockImplementation(async (machineId: string, authorizationId: string) => {
      revokeCalls.push({ machineId, authorizationId });
      revokeAttempt += 1;
      await (revokeAttempt === 1 ? oldRuntimeRevoke.promise : currentRuntimeRevoke.promise);
    });
    const voice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } };
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice });

    const oldRuntimeResult = revokeVoiceDiagnosticsSessionAuthorization({
      machineId: 'm1',
      sessionId: 'session-1',
      authorizationId: resolveVoiceDiagnosticsCaptureAuthorizationId('session-1'),
    });
    await waitForDiagnosticsEvent(() => expect(revokeCalls).toEqual([
      { machineId: 'm1', authorizationId: resolveVoiceDiagnosticsCaptureAuthorizationId('session-1') },
    ]));

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(createHarness({ voice })); });
    oldRuntimeRevoke.reject(new Error('old_daemon_runtime_lost'));
    await expect(oldRuntimeResult).resolves.toMatchObject({ ok: false });

    await waitForDiagnosticsEvent(() => expect(revokeCalls).toEqual([
      { machineId: 'm1', authorizationId: resolveVoiceDiagnosticsCaptureAuthorizationId('session-1') },
      { machineId: 'm1', authorizationId: resolveVoiceDiagnosticsCaptureAuthorizationId('session-1') },
    ]));
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      phase: 'transitioning',
      revocationObligations: [
        expect.objectContaining({
          target: {
            kind: 'session_authorization',
            machineId: 'm1',
            sessionId: 'session-1',
            authorizationId: resolveVoiceDiagnosticsCaptureAuthorizationId('session-1'),
          },
          status: 'pending',
        }),
      ],
    });

    currentRuntimeRevoke.resolve();
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]));
    await act(async () => {
      tree.update(createHarness({ voice }));
      tree.update(createHarness({ voice }));
    });
    expect(revokeCalls).toHaveLength(2);
    await act(async () => { tree.unmount(); });
  });

  it('does not repeat a session revocation already confirmed by the former runtime', async () => {
    const oldRuntimeRevoke = createDeferred<void>();
    revokeImpl.mockImplementation(async (machineId: string, authorizationId: string) => {
      revokeCalls.push({ machineId, authorizationId });
      await oldRuntimeRevoke.promise;
    });
    const voice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } };
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice });

    const oldRuntimeResult = revokeVoiceDiagnosticsSessionAuthorization({
      machineId: 'm1',
      sessionId: 'session-1',
      authorizationId: resolveVoiceDiagnosticsCaptureAuthorizationId('session-1'),
    });
    await waitForDiagnosticsEvent(() => expect(revokeCalls).toHaveLength(1));

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(createHarness({ voice })); });
    oldRuntimeRevoke.resolve();
    await expect(oldRuntimeResult).resolves.toMatchObject({ ok: true });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'active',
      revocationObligations: [],
    }));
    await act(async () => { tree.update(createHarness({ voice })); });
    expect(revokeCalls).toHaveLength(1);
    await act(async () => { tree.unmount(); });
  });

  it('revalidates a failed session revocation only after the selected daemon runtime reconnects', async () => {
    let revokeAttempt = 0;
    revokeImpl.mockImplementation(async (machineId: string, authorizationId: string) => {
      revokeCalls.push({ machineId, authorizationId });
      revokeAttempt += 1;
      if (revokeAttempt === 1) throw new Error('daemon_unavailable');
    });
    const voice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } };
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice });

    await expect(revokeVoiceDiagnosticsSessionAuthorization({
      machineId: 'm1',
      sessionId: 'session-1',
      authorizationId: resolveVoiceDiagnosticsCaptureAuthorizationId('session-1'),
    })).resolves.toMatchObject({ ok: false });
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
    await act(async () => { tree.update(createHarness({ voice })); });
    expect(revokeCalls).toHaveLength(1);

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(createHarness({ voice })); });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]));
    expect(revokeCalls).toHaveLength(2);
    await act(async () => { tree.update(createHarness({ voice })); });
    expect(revokeCalls).toHaveLength(2);
    await act(async () => { tree.unmount(); });
  });

  it('abandons a superseded reconnect revoke so the current disabled policy does not wait for it', async () => {
    let revokeAttempt = 0;
    let reconnectSignal: AbortSignal | null = null;
    let currentDisableSignal: AbortSignal | null = null;
    const readReconnectSignal = (): AbortSignal | null => reconnectSignal;
    const readCurrentDisableSignal = (): AbortSignal | null => currentDisableSignal;
    revokeImpl.mockImplementation(async (machineId: string, authorizationId: string, signal?: AbortSignal | null) => {
      revokeCalls.push({ machineId, authorizationId });
      revokeAttempt += 1;
      if (revokeAttempt === 1) throw new Error('old_daemon_runtime_lost');
      reconnectSignal = signal ?? null;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('reconnect_revoke_aborted')), { once: true });
      });
    });
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (!(settings as typeof diagnostics).enabled) {
        currentDisableSignal = signal ?? null;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('current_disable_aborted')), { once: true });
        });
      }
      return { ok: true, settings };
    });
    const enabledVoice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } };
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    const disabledVoice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm1' },
    };
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice: enabledVoice });
    await expect(revokeVoiceDiagnosticsSessionAuthorization({
      machineId: 'm1',
      sessionId: 'session-1',
      authorizationId: resolveVoiceDiagnosticsCaptureAuthorizationId('session-1'),
    })).resolves.toMatchObject({ ok: false });

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(createHarness({ voice: enabledVoice })); });
    await waitForDiagnosticsEvent(() => expect(reconnectSignal).toBeInstanceOf(AbortSignal));

    machineState.daemonStateVersion = 3;
    await act(async () => { tree.update(createHarness({ voice: disabledVoice })); });
    await waitForDiagnosticsEvent(() => expect(readReconnectSignal()?.aborted).toBe(true));
    await waitForDiagnosticsEvent(() => expect(currentDisableSignal).toBeInstanceOf(AbortSignal));
    expect(revokeCalls).toHaveLength(2);

    await act(async () => { tree.unmount(); });
    expect(readCurrentDisableSignal()?.aborted).toBe(true);
  });

  it('does not let a reconnect waiter block a newer disabled policy behind a manual session revoke', async () => {
    const initialManualRevoke = createDeferred<void>();
    let disabledConfigureStarted = false;
    revokeImpl.mockImplementation(async (machineId: string, authorizationId: string) => {
      revokeCalls.push({ machineId, authorizationId });
      await initialManualRevoke.promise;
    });
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (!(settings as typeof diagnostics).enabled) disabledConfigureStarted = true;
      return { ok: true, settings };
    });
    const enabledVoice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } };
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    const disabledVoice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm1' },
    };
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice: enabledVoice });

    const manualRevocation = revokeVoiceDiagnosticsSessionAuthorization({
      machineId: 'm1',
      sessionId: 'session-1',
      authorizationId: resolveVoiceDiagnosticsCaptureAuthorizationId('session-1'),
    });
    await waitForDiagnosticsEvent(() => expect(revokeCalls).toHaveLength(1));

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(createHarness({ voice: enabledVoice })); });
    expect(revokeCalls).toHaveLength(1);

    machineState.daemonStateVersion = 3;
    await act(async () => { tree.update(createHarness({ voice: disabledVoice })); });
    let disabledConfigureStartedBeforeManualRelease = false;
    try {
      await waitForDiagnosticsEvent(() => expect(disabledConfigureStarted).toBe(true));
      disabledConfigureStartedBeforeManualRelease = true;
    } catch {
      // Drain the held manual request before asserting the pre-release state.
    }

    initialManualRevoke.resolve();
    await expect(manualRevocation).resolves.toMatchObject({ ok: true });
    await waitForDiagnosticsEvent(() => expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(1));
    await act(async () => { tree.unmount(); });

    expect(disabledConfigureStartedBeforeManualRelease).toBe(true);
    expect(revokeCalls).toHaveLength(1);
  });

  it('settles a restored exact-machine shutdown after the selected daemon confirms diagnostics off', async () => {
    const persistenceScope = scope;

    (['m1']).forEach(machineId => addPersistedVoiceDiagnosticsMachineRevocation(scope, machineId));
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm1' },
    };

    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'inactive_confirmed',
      revocationObligations: [],
    }));

    expect(readPersistedVoiceDiagnosticsMachineRevocations(scope)).toEqual([]);
    await act(async () => { tree.unmount(); });
  });

  it('retains a persisted former-machine shutdown when a different selected daemon cannot acknowledge its retry', async () => {
    const persistenceScope = scope;
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.machineId = 'm2';

    (['m1']).forEach(machineId => addPersistedVoiceDiagnosticsMachineRevocation(scope, machineId));
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false) {
        throw new Error('former_machine_offline');
      }
      return { ok: true, settings };
    });
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm2' },
    };

    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm2',
      phase: 'inactive_confirmed',
      revocationObligations: [
        expect.objectContaining({
          target: { kind: 'machine_policy', machineId: 'm1' },
          status: 'failed',
        }),
      ],
    }));
    const obligation = readVoiceDiagnosticsRuntimeStatus().revocationObligations[0]!;
    const selectedDisableCallsBeforeRetry = configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm2'
        && readRequestedDiagnosticsEnabled(settings) === false,
    ).length;

    await expect(retryVoiceDiagnosticsRevocation({
      obligation,
      settings: disabledDiagnostics,
      persistenceScope,
    })).resolves.toMatchObject({ ok: false });

    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1'
        && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(1);
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm2'
        && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(selectedDisableCallsBeforeRetry);
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scope)).toEqual(['m1']);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: { kind: 'machine_policy', machineId: 'm1' },
        status: 'failed',
      }),
    ]);
    await act(async () => { tree.unmount(); });
  });

  it('retries a persisted former-machine shutdown only when that exact daemon reconnects', async () => {
    const persistenceScope = scope;
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.machineId = 'm2';

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 1, isOnline: false });
    (['m1']).forEach(machineId => addPersistedVoiceDiagnosticsMachineRevocation(scope, machineId));
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm2' },
    };

    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm2',
      phase: 'inactive_confirmed',
      revocationObligations: [
        expect.objectContaining({
          target: { kind: 'machine_policy', machineId: 'm1' },
          status: 'failed',
        }),
      ],
    }));
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1'
        && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(0);

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 2, isOnline: true });
    await act(async () => { tree.update(createHarness({ voice })); });

    await waitForDiagnosticsEvent(() => expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1'
        && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(1));
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm2'
        && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(1);
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scope)).toEqual([]);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]);
    await act(async () => { tree.unmount(); });
  });

  it('replays every independently current persisted former-machine shutdown', async () => {
    const persistenceScope = scope;
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.machineId = 'm2';

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 1, isOnline: false });
    runtimeTargetsByMachineId.set('m3', { daemonStateVersion: 2, isOnline: true });
    (['m1', 'm3']).forEach(machineId => addPersistedVoiceDiagnosticsMachineRevocation(scope, machineId));
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm2' },
    };

    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice });

    await waitForDiagnosticsEvent(() => expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm3'
        && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(1));
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1'
        && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(0);
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scope)).toEqual(['m1']);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: { kind: 'machine_policy', machineId: 'm1' },
        status: 'failed',
      }),
    ]);
    await act(async () => { tree.unmount(); });
  });

  it('does not replay an unchanged former-machine failure for an unrelated runtime status update', async () => {
    const persistenceScope = scope;
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.machineId = 'm2';

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 1, isOnline: false });
    runtimeTargetsByMachineId.set('m3', { daemonStateVersion: 2, isOnline: true });
    (['m1', 'm3']).forEach(machineId => addPersistedVoiceDiagnosticsMachineRevocation(scope, machineId));
    let m3ShutdownAttempts = 0;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm3' && readRequestedDiagnosticsEnabled(settings) === false) {
        m3ShutdownAttempts += 1;
        throw new Error('m3_shutdown_rejected');
      }
      return { ok: true, settings };
    });
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm2' },
    };

    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({ target: { kind: 'machine_policy', machineId: 'm1' }, status: 'failed' }),
      expect.objectContaining({ target: { kind: 'machine_policy', machineId: 'm3' }, status: 'failed' }),
    ]));
    expect(m3ShutdownAttempts).toBe(1);

    await act(async () => {
      publishVoiceDiagnosticsRuntimeStatus({ machineId: 'm2', phase: 'transitioning' });
      publishVoiceDiagnosticsRuntimeStatus({ machineId: 'm2', phase: 'inactive_confirmed' });
    });

    expect(m3ShutdownAttempts).toBe(1);
    await act(async () => { tree.unmount(); });
  });

  it('retains a failed former-machine shutdown until that exact daemon advances again', async () => {
    const persistenceScope = scope;
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.machineId = 'm2';

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 1, isOnline: false });
    (['m1']).forEach(machineId => addPersistedVoiceDiagnosticsMachineRevocation(scope, machineId));
    let formerMachineShutdownAttempts = 0;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false) {
        formerMachineShutdownAttempts += 1;
        if (formerMachineShutdownAttempts === 1) throw new Error('former_daemon_rejected_shutdown');
      }
      return { ok: true, settings };
    });
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm2' },
    };

    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: { kind: 'machine_policy', machineId: 'm1' },
        status: 'failed',
      }),
    ]));
    expect(formerMachineShutdownAttempts).toBe(0);

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 2, isOnline: true });
    await act(async () => { tree.update(createHarness({ voice })); });
    await waitForDiagnosticsEvent(() => expect(formerMachineShutdownAttempts).toBe(1));
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: { kind: 'machine_policy', machineId: 'm1' },
        status: 'failed',
      }),
    ]));
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scope)).toEqual(['m1']);

    await act(async () => { tree.update(createHarness({ voice })); });
    expect(formerMachineShutdownAttempts).toBe(1);

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 3, isOnline: true });
    await act(async () => { tree.update(createHarness({ voice })); });
    await waitForDiagnosticsEvent(() => expect(formerMachineShutdownAttempts).toBe(2));
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scope)).toEqual([]);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]);
    await act(async () => { tree.unmount(); });
  });

  it('replaces an in-flight former-machine replay when that exact daemon advances', async () => {
    const persistenceScope = scope;
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.machineId = 'm2';

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 1, isOnline: false });
    (['m1']).forEach(machineId => addPersistedVoiceDiagnosticsMachineRevocation(scope, machineId));
    let formerMachineShutdownAttempts = 0;
    let firstReplaySignal: AbortSignal | undefined;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false) {
        formerMachineShutdownAttempts += 1;
        if (formerMachineShutdownAttempts === 1) {
          firstReplaySignal = signal ?? undefined;
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('former_daemon_replaced')), { once: true });
          });
        }
      }
      return { ok: true, settings };
    });
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm2' },
    };

    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: { kind: 'machine_policy', machineId: 'm1' },
        status: 'failed',
      }),
    ]));

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 2, isOnline: true });
    await act(async () => { tree.update(createHarness({ voice })); });
    await waitForDiagnosticsEvent(() => expect(firstReplaySignal).toBeDefined());

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 3, isOnline: true });
    await act(async () => { tree.update(createHarness({ voice })); });
    await waitForDiagnosticsEvent(() => expect(firstReplaySignal?.aborted).toBe(true));
    await waitForDiagnosticsEvent(() => expect(formerMachineShutdownAttempts).toBe(2));
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scope)).toEqual([]);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]);
    await act(async () => { tree.unmount(); });
  });

  it('aborts an unresolved disable before reconciling a restarted selected daemon', async () => {
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    let firstSignal: AbortSignal | undefined;
    let releaseFirst!: () => void;
    configureImpl.mockImplementationOnce(async (
      machineId: string,
      settings: unknown,
      signal?: AbortSignal | null,
    ) => {
      configureCalls.push({ machineId, settings, signal });
      firstSignal = signal ?? undefined;
      await new Promise<void>((resolve, reject) => {
        releaseFirst = resolve;
        signal?.addEventListener('abort', () => reject(new Error('daemon_generation_changed')), { once: true });
      });
      return { ok: true, settings };
    });

    let tree!: renderer.ReactTestRenderer;
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm1' },
    };
    tree = await mountHarness({ voice });
    expect(configureCalls).toHaveLength(1);

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(createHarness({ voice })); });
    await Promise.resolve();
    const firstWasAborted = firstSignal?.aborted === true;
    const callsBeforeManualRelease = configureCalls.length;

    // Let the pre-fix implementation drain so RED leaves no pending work.
    releaseFirst();
    await waitForDiagnosticsEvent(() => expect(configureCalls).toHaveLength(2));
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'inactive_confirmed',
      revocationObligations: [],
    }));
    await act(async () => { tree.unmount(); });

    expect(firstWasAborted).toBe(true);
    expect(callsBeforeManualRelease).toBe(2);
  });

  it('recovers desired consent when the selected daemon returns online', async () => {
    let tree!: renderer.ReactTestRenderer;
    const voice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } };
    tree = await mountHarness({ voice });
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (!machineState.isOnline) throw new Error('daemon_offline');
      return { ok: true, settings };
    });

    machineState.isOnline = false;
    await act(async () => { tree.update(createHarness({ voice })); });
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({ machineId: null, phase: 'status_unknown' });
    expect(resolveVoiceExecutionMachinePresentationFromState(storage.getState())).toMatchObject({
      selectedMachineId: 'm1', machineId: null, selectionKind: 'selected_unreachable',
    });

    machineState.isOnline = true;
    await act(async () => { tree.update(createHarness({ voice })); });
    expect(configureCalls).toHaveLength(3);
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({ machineId: 'm1', phase: 'active' });
    await act(async () => { tree.unmount(); });
  });

  it('aborts the in-flight configure request during runtime teardown', async () => {
    let observedSignal: AbortSignal | undefined;
    const response = createDeferred<void>();
    configureImpl.mockImplementationOnce(async (_machineId: string, _settings: unknown, signal?: AbortSignal | null) => {
      observedSignal = signal ?? undefined;
      await response.promise;
      return { ok: true, settings: _settings };
    });
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice: { diagnostics, executionMachine: { mode: 'auto', machineId: null } } });
    await waitForDiagnosticsEvent(() => expect(observedSignal?.aborted).toBe(false));
    await act(async () => { tree.unmount(); });
    expect(observedSignal?.aborted).toBe(true);
    response.resolve();
  });

  it('settles a late old-machine configure before disabling it and never republishes it as active', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true) await first;
      return { ok: true, settings };
    });

    let tree!: renderer.ReactTestRenderer;
    const firstVoice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } };
    const secondVoice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm2' } };
    tree = await mountHarness({ voice: firstVoice });
    await waitForDiagnosticsEvent(() => expect(configureCalls).toHaveLength(1));

    machineState.machineId = 'm2';
    await act(async () => { tree.update(createHarness({ voice: secondVoice })); });
    releaseFirst();
    await waitForDiagnosticsEvent(() => expect(configureCalls).toHaveLength(3));

    expect(configureCalls.map(({ machineId, settings }) => [
      machineId,
      readRequestedDiagnosticsEnabled(settings),
    ])).toEqual([
      ['m1', true],
      ['m1', false],
      ['m2', true],
    ]);
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({ machineId: 'm2', phase: 'active' });
    await act(async () => { tree.unmount(); });
  });

  it('makes an interrupted former-machine cleanup retryable while reconciling the current daemon', async () => {
    let cleanupSignal: AbortSignal | undefined;
    let releaseCleanup!: () => void;
    configureImpl.mockImplementation(async (
      machineId: string,
      settings: unknown,
      signal?: AbortSignal | null,
    ) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false) {
        cleanupSignal = signal ?? undefined;
        await new Promise<void>((resolve, reject) => {
          releaseCleanup = resolve;
          signal?.addEventListener('abort', () => reject(new Error('selected_daemon_generation_changed')), {
            once: true,
          });
        });
      }
      return { ok: true, settings };
    });

    const voiceFor = (machineId: string) => ({
      diagnostics,
      executionMachine: { mode: 'fixed', machineId },
    });
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice: voiceFor('m1') });

    machineState.machineId = 'm2';
    await act(async () => { tree.update(createHarness({ voice: voiceFor('m2') })); });
    await waitForDiagnosticsEvent(() => expect(cleanupSignal).toBeDefined());

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(createHarness({ voice: voiceFor('m2') })); });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm2',
      phase: 'active',
      revocationObligations: [
        expect.objectContaining({
          target: { kind: 'machine_policy', machineId: 'm1' },
          status: 'failed',
        }),
      ],
    }));
    const cleanupWasAborted = cleanupSignal?.aborted === true;
    const callsBeforeManualRelease = configureCalls.length;

    // Resolve the pre-fix gate if this assertion is ever replayed against old bytes.
    releaseCleanup();
    await act(async () => { tree.unmount(); });

    expect(cleanupWasAborted).toBe(true);
    expect(callsBeforeManualRelease).toBe(3);
  });

  it('supersedes a stale shutdown obligation when that exact machine is later re-authorized', async () => {
    let failM1Disable = true;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false && failM1Disable) {
        throw new Error('m1_shutdown_unavailable');
      }
      return { ok: true, settings };
    });
    const voiceFor = (machineId: string) => ({
      diagnostics,
      executionMachine: { mode: 'fixed', machineId },
    });
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice: voiceFor('m1') });

    machineState.machineId = 'm2';
    await act(async () => { tree.update(createHarness({ voice: voiceFor('m2') })); });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ kind: 'machine_policy', machineId: 'm1' }),
        status: 'failed',
      }),
    ]));
    const staleObligation = readVoiceDiagnosticsRuntimeStatus().revocationObligations[0]!;

    failM1Disable = false;
    machineState.machineId = 'm1';
    await act(async () => { tree.update(createHarness({ voice: voiceFor('m1') })); });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'active',
      revocationObligations: [],
    }));
    const disableCallsAfterReauthorization = configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false,
    ).length;
    await retryVoiceDiagnosticsRevocation({ obligation: staleObligation, settings: diagnostics });
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(disableCallsAfterReauthorization);
    await act(async () => { tree.unmount(); });
  });

  it('orders re-authorization after an already-started exact-machine shutdown retry', async () => {
    let failInitialM1Disable = true;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false && failInitialM1Disable) {
        throw new Error('m1_shutdown_unavailable');
      }
      return { ok: true, settings };
    });
    const voiceFor = (machineId: string) => ({
      diagnostics,
      executionMachine: { mode: 'fixed', machineId },
    });
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice: voiceFor('m1') });
    machineState.machineId = 'm2';
    await act(async () => { tree.update(createHarness({ voice: voiceFor('m2') })); });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toHaveLength(1));
    const obligation = readVoiceDiagnosticsRuntimeStatus().revocationObligations[0]!;

    failInitialM1Disable = false;
    let releaseRetry!: () => void;
    const retryBlocked = new Promise<void>((resolve) => { releaseRetry = resolve; });
    let retryStarted = false;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false) {
        retryStarted = true;
        await retryBlocked;
        throw new Error('retry_shutdown_failed_after_reauthorization_queued');
      }
      return { ok: true, settings };
    });
    const enabledM1CallsBeforeRetry = configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true,
    ).length;
    const retry = retryVoiceDiagnosticsRevocation({ obligation, settings: diagnostics });
    await waitForDiagnosticsEvent(() => expect(retryStarted).toBe(true));

    machineState.machineId = 'm1';
    await act(async () => { tree.update(createHarness({ voice: voiceFor('m1') })); });
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true,
    )).toHaveLength(enabledM1CallsBeforeRetry);

    releaseRetry();
    await expect(retry).resolves.toMatchObject({ ok: false });
    await waitForDiagnosticsEvent(() => expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true,
    )).toHaveLength(enabledM1CallsBeforeRetry + 1));
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'active',
      revocationObligations: [],
    }));
    await act(async () => { tree.unmount(); });
  });

  it('keeps an exact-machine shutdown obligation when queued re-authorization fails', async () => {
    let failM1Disable = true;
    let failM1Enable = false;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false && failM1Disable) {
        throw new Error('m1_shutdown_unavailable');
      }
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true && failM1Enable) {
        throw new Error('m1_reauthorization_unavailable');
      }
      return { ok: true, settings };
    });
    const voiceFor = (machineId: string) => ({
      diagnostics,
      executionMachine: { mode: 'fixed', machineId },
    });
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice: voiceFor('m1') });

    machineState.machineId = 'm2';
    await act(async () => { tree.update(createHarness({ voice: voiceFor('m2') })); });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ kind: 'machine_policy', machineId: 'm1' }),
        status: 'failed',
      }),
    ]));

    failM1Disable = false;
    failM1Enable = true;
    machineState.machineId = 'm1';
    await act(async () => { tree.update(createHarness({ voice: voiceFor('m1') })); });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'status_unknown',
      revocationObligations: [
        expect.objectContaining({
          target: expect.objectContaining({ kind: 'machine_policy', machineId: 'm1' }),
          status: 'failed',
        }),
      ],
    }));
    const obligation = readVoiceDiagnosticsRuntimeStatus().revocationObligations[0]!;
    const m1DisableCallsBeforeRetry = configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false,
    ).length;
    failM1Enable = false;
    await expect(retryVoiceDiagnosticsRevocation({ obligation, settings: diagnostics })).resolves.toEqual({
      ok: true,
      acknowledged: true,
    });
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(m1DisableCallsBeforeRetry + 1);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]);
    await act(async () => { tree.unmount(); });
  });

  it('does not let a captured stale retry trail a newer queued enable intent', async () => {
    let failM1Disable = true;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false && failM1Disable) {
        throw new Error('m1_shutdown_unavailable');
      }
      return { ok: true, settings };
    });
    const voiceFor = (machineId: string) => ({
      diagnostics,
      executionMachine: { mode: 'fixed', machineId },
    });
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice: voiceFor('m1') });
    machineState.machineId = 'm2';
    await act(async () => { tree.update(createHarness({ voice: voiceFor('m2') })); });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toHaveLength(1));
    const staleObligation = readVoiceDiagnosticsRuntimeStatus().revocationObligations[0]!;

    failM1Disable = false;
    let releaseM1Enable!: () => void;
    const m1EnableBlocked = new Promise<void>((resolve) => { releaseM1Enable = resolve; });
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true) await m1EnableBlocked;
      return { ok: true, settings };
    });
    machineState.machineId = 'm1';
    await act(async () => { tree.update(createHarness({ voice: voiceFor('m1') })); });
    await waitForDiagnosticsEvent(() => expect(configureCalls.some(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true,
    )).toBe(true));
    const disablesBeforeStaleRetry = configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false,
    ).length;
    const staleRetry = retryVoiceDiagnosticsRevocation({ obligation: staleObligation, settings: diagnostics });
    await Promise.resolve();
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(disablesBeforeStaleRetry);

    releaseM1Enable();
    await expect(staleRetry).resolves.toEqual({ ok: true, acknowledged: false });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'active',
      revocationObligations: [],
    }));
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(disablesBeforeStaleRetry);
    await act(async () => { tree.unmount(); });
  });

  it('makes the latest same-machine enable win an enable-disable-enable race', async () => {
    let releaseFirstEnable!: () => void;
    const firstEnableBlocked = new Promise<void>((resolve) => { releaseFirstEnable = resolve; });
    let enabledCalls = 0;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true && enabledCalls++ === 0) {
        await firstEnableBlocked;
      }
      return { ok: true, settings };
    });
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    const voiceWith = (nextDiagnostics: typeof diagnostics | typeof disabledDiagnostics) => ({
      diagnostics: nextDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm1' },
    });
    let tree!: renderer.ReactTestRenderer;
    // A request owned by another caller has no mounted-hook abort signal.
    // Keep that real queue head pending so the hook's disable and newer enable
    // are genuinely queued intents, not a disable already sent before the user
    // changes their mind. The real Socket client otherwise aborts immediately.
    const firstEnable = applyVoiceDiagnosticsMachinePolicy({ machineId: 'm1', settings: diagnostics });
    await waitForDiagnosticsEvent(() => expect(configureCalls).toHaveLength(1));
    tree = await mountHarness({ voice: voiceWith(diagnostics) });
    await waitForDiagnosticsEvent(() => expect(configureCalls).toHaveLength(1));

    await act(async () => { tree.update(createHarness({ voice: voiceWith(disabledDiagnostics) })); });
    await act(async () => { tree.update(createHarness({ voice: voiceWith(diagnostics) })); });
    releaseFirstEnable();
    await firstEnable;

    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'active',
      revocationObligations: [],
    }));
    expect(configureCalls.map(({ machineId, settings }) => [
      machineId,
      readRequestedDiagnosticsEnabled(settings),
    ])).toEqual([
      ['m1', true],
      ['m1', true],
    ]);
    await act(async () => { tree.unmount(); });
  });

  it('does not let a stale enable completion clear a newer disable obligation', async () => {
    let failInitialM1Disable = true;
    let blockM1Enable = false;
    let releaseM1Enable!: () => void;
    const m1EnableBlocked = new Promise<void>((resolve) => { releaseM1Enable = resolve; });
    let blockFinalM1Disable = false;
    let finalM1DisableStarted = false;
    let releaseFinalM1Disable!: () => void;
    const finalM1DisableBlocked = new Promise<void>((resolve) => { releaseFinalM1Disable = resolve; });
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false && failInitialM1Disable) {
        throw new Error('m1_shutdown_unavailable');
      }
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true && blockM1Enable) {
        await m1EnableBlocked;
      }
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false && blockFinalM1Disable) {
        finalM1DisableStarted = true;
        await finalM1DisableBlocked;
      }
      return { ok: true, settings };
    });
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    const voiceFor = (
      machineId: string,
      nextDiagnostics: typeof diagnostics | typeof disabledDiagnostics = diagnostics,
    ) => ({
      diagnostics: nextDiagnostics,
      executionMachine: { mode: 'fixed', machineId },
    });
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice: voiceFor('m1') });
    machineState.machineId = 'm2';
    await act(async () => { tree.update(createHarness({ voice: voiceFor('m2') })); });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toHaveLength(1));

    failInitialM1Disable = false;
    blockM1Enable = true;
    machineState.machineId = 'm1';
    await act(async () => { tree.update(createHarness({ voice: voiceFor('m1') })); });
    await waitForDiagnosticsEvent(() => expect(configureCalls.some(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true,
    )).toBe(true));

    blockFinalM1Disable = true;
    await act(async () => {
      tree.update(createHarness({ voice: voiceFor('m1', disabledDiagnostics) }));
    });
    const newerDisableObligation = readVoiceDiagnosticsRuntimeStatus().revocationObligations[0]!;
    expect(newerDisableObligation).toMatchObject({
      target: { kind: 'machine_policy', machineId: 'm1' },
      status: 'pending',
    });

    releaseM1Enable();
    await waitForDiagnosticsEvent(() => expect(finalM1DisableStarted).toBe(true));
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({ revision: newerDisableObligation.revision, status: 'pending' }),
    ]);

    releaseFinalM1Disable();
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'inactive_confirmed',
      revocationObligations: [],
    }));
    await act(async () => { tree.unmount(); });
  });

  it('does not publish inactive from a disable acknowledgement superseded by a failing retry', async () => {
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    let disableCalls = 0;
    let releaseFirstDisable!: () => void;
    const firstDisableBlocked = new Promise<void>((resolve) => { releaseFirstDisable = resolve; });
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false) {
        disableCalls += 1;
        if (disableCalls === 1) await firstDisableBlocked;
        if (disableCalls === 2) throw new Error('newer_disable_failed');
      }
      return { ok: true, settings };
    });
    let tree!: renderer.ReactTestRenderer;
    tree = await mountHarness({ voice: { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } } });
    await waitForDiagnosticsEvent(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'active',
    }));
    await act(async () => {
      tree.update(createHarness({
        voice: {
          diagnostics: disabledDiagnostics,
          executionMachine: { mode: 'fixed', machineId: 'm1' },
        },
      }));
    });
    await waitForDiagnosticsEvent(() => expect(disableCalls).toBe(1));
    const obligation = readVoiceDiagnosticsRuntimeStatus().revocationObligations[0]!;
    const retry = retryVoiceDiagnosticsRevocation({ obligation, settings: disabledDiagnostics });
    releaseFirstDisable();
    await expect(retry).resolves.toMatchObject({ ok: false });

    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'status_unknown',
      revocationObligations: [expect.objectContaining({ status: 'failed' })],
    });
    await act(async () => { tree.unmount(); });
  });
});
