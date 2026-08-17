import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit';

vi.mock('@/sync/store/hooks', () => ({
  useActiveServerAccountScope: () => machineState.persistenceScope,
  useMachineCliDetectionTarget: (machineId: string | null) => {
    const target = runtimeTargetsByMachineId.get(machineId ?? '');
    if (target) return target;
    if (machineId === machineState.machineId) {
      return {
        daemonStateVersion: machineState.daemonStateVersion,
        isOnline: machineState.isOnline,
      };
    }
    return { daemonStateVersion: 0, isOnline: false };
  },
  useMachineCliDetectionTargets: (machineIds: readonly string[]) => Object.fromEntries(machineIds.map((machineId) => {
    const target = runtimeTargetsByMachineId.get(machineId);
    if (target) return [machineId, target];
    if (machineId === machineState.machineId) {
      return [machineId, {
        daemonStateVersion: machineState.daemonStateVersion,
        isOnline: machineState.isOnline,
      }];
    }
    return [machineId, { daemonStateVersion: 0, isOnline: false }];
  })),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const machineState = vi.hoisted(() => ({
  machineId: 'm1' as string | null,
  daemonStateVersion: 1,
  isOnline: true,
  persistenceScope: null as Readonly<{ serverId: string; accountId: string }> | null,
}));
const runtimeTargetsByMachineId = vi.hoisted(() => new Map<string, Readonly<{
  daemonStateVersion: number;
  isOnline: boolean;
}>>());
const persistedRevocations = vi.hoisted(() => new Map<string, string[]>());
vi.mock('./revocationObligationPersistence', () => ({
  addPersistedVoiceDiagnosticsMachineRevocation: (
    scope: Readonly<{ serverId: string; accountId: string }>,
    machineId: string,
  ) => {
    const key = `${scope.serverId}:${scope.accountId}`;
    persistedRevocations.set(key, [...new Set([...(persistedRevocations.get(key) ?? []), machineId])]);
  },
  clearPersistedVoiceDiagnosticsMachineRevocation: (
    scope: Readonly<{ serverId: string; accountId: string }>,
    machineId: string,
  ) => {
    const key = `${scope.serverId}:${scope.accountId}`;
    persistedRevocations.set(
      key,
      (persistedRevocations.get(key) ?? []).filter((candidate) => candidate !== machineId),
    );
  },
  readPersistedVoiceDiagnosticsMachineRevocations: (
    scope: Readonly<{ serverId: string; accountId: string }>,
  ) => persistedRevocations.get(`${scope.serverId}:${scope.accountId}`) ?? [],
}));
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
vi.mock('./client', () => ({
  createVoiceDiagnosticsClientForMachine: (machineId: string) => ({
    configure: (settings: unknown, signal?: AbortSignal | null) => configureImpl(machineId, settings, signal),
    revokeCaptureAuthorization: (authorizationId: string, signal?: AbortSignal | null) => (
      revokeImpl(machineId, authorizationId, signal)
    ),
  }),
}));
vi.mock('@/voice/credentials/useExecutionMachinePresentation', () => ({
  useVoiceExecutionMachinePresentation: () => ({ machineId: machineState.machineId, machineLabel: machineState.machineId }),
}));
vi.mock('@/sync/domains/settings/voiceSettings', () => ({
  voiceSettingsDefaults: { credentialBindings: [] },
  voiceSettingsParse: (value: unknown) => ({
    credentialBindings: [],
    ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  }),
  projectVoiceSettingsAnalytics: () => ({}),
}));

import { useVoiceDiagnosticsRuntimeSync } from './useVoiceDiagnosticsRuntimeSync';
import {
  publishVoiceDiagnosticsRuntimeStatus,
  readVoiceDiagnosticsRuntimeStatus,
  resetVoiceDiagnosticsRuntimeStatusForTests,
} from './runtimeStatus';
import {
  resetVoiceDiagnosticsRevocationForTests,
  revokeVoiceDiagnosticsSessionAuthorization,
  retryVoiceDiagnosticsRevocation,
} from './runtimeRevocation';
import { resetVoiceDiagnosticsSessionPolicyForTests } from './capturePolicy';

type RequestedDiagnosticsSettings = Readonly<{ enabled?: boolean }>;

function readRequestedDiagnosticsEnabled(settings: unknown): boolean | undefined {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return undefined;
  const { enabled } = settings as RequestedDiagnosticsSettings;
  return typeof enabled === 'boolean' ? enabled : undefined;
}

function Harness(props: { voice: unknown }) {
  useVoiceDiagnosticsRuntimeSync(props.voice);
  return null;
}

const diagnostics = Object.freeze({
  v: 1, enabled: true, consentVersion: 1,
  captureSttInput: true, captureTtsOutput: false,
  maxAgeMs: 86_400_000, maxFiles: 20, maxBytes: 104_857_600, maxDurationMs: 300_000,
});

describe('useVoiceDiagnosticsRuntimeSync', () => {
  beforeEach(() => {
    machineState.machineId = 'm1';
    machineState.daemonStateVersion = 1;
    machineState.isOnline = true;
    machineState.persistenceScope = null;
    runtimeTargetsByMachineId.clear();
    persistedRevocations.clear();
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

  it('reapplies consent on mount, selected-machine changes, and a fresh runtime mount', async () => {
    let tree!: renderer.ReactTestRenderer;
    const first = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null } };
    const second = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm2', autoMachineId: null } };
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice: first })); });
    expect(configureCalls).toEqual([expect.objectContaining({ machineId: 'm1', settings: diagnostics })]);
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({ machineId: 'm1', phase: 'active' });
    machineState.machineId = 'm2';
    await act(async () => { tree.update(React.createElement(Harness, { voice: second })); });
    expect(configureCalls.slice(1)).toEqual([
      expect.objectContaining({ machineId: 'm1', settings: expect.objectContaining({ enabled: false, consentVersion: null }) }),
      expect.objectContaining({ machineId: 'm2', settings: diagnostics }),
    ]);
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({ machineId: 'm2', phase: 'active' });
    await act(async () => { tree.unmount(); });

    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice: second })); });
    expect(configureCalls.at(-1)).toEqual(expect.objectContaining({ machineId: 'm2', settings: diagnostics }));
    await act(async () => { tree.unmount(); });
  });

  it('reapplies consent when the same selected daemon restarts', async () => {
    let tree!: renderer.ReactTestRenderer;
    const voice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null } };
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });
    expect(configureCalls).toHaveLength(1);

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });

    expect(configureCalls).toEqual([
      expect.objectContaining({ machineId: 'm1', settings: diagnostics }),
      expect.objectContaining({ machineId: 'm1', settings: diagnostics }),
    ]);
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({ machineId: 'm1', phase: 'active' });
    await act(async () => { tree.unmount(); });
  });

  it('does not turn a default-off daemon restart race into a durable shutdown warning', async () => {
    const persistenceScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.persistenceScope = persistenceScope;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      throw new Error('daemon_restarting');
    });
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null },
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'status_unknown',
    }));

    // The request outcome remains unknown, but no prior diagnostic enablement
    // exists to turn this default-off reconciliation into a durable revocation
    // obligation. A later successful reconciliation can still confirm off.
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]);
    expect(persistedRevocations.get('server-a:account-a') ?? []).toEqual([]);
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
    const voice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null } };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });

    const oldRuntimeResult = revokeVoiceDiagnosticsSessionAuthorization({
      machineId: 'm1',
      sessionId: 'session-1',
      authorizationId: 'authorization-1',
    });
    await vi.waitFor(() => expect(revokeCalls).toEqual([
      { machineId: 'm1', authorizationId: 'authorization-1' },
    ]));

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
    oldRuntimeRevoke.reject(new Error('old_daemon_runtime_lost'));
    await expect(oldRuntimeResult).resolves.toMatchObject({ ok: false });

    await vi.waitFor(() => expect(revokeCalls).toEqual([
      { machineId: 'm1', authorizationId: 'authorization-1' },
      { machineId: 'm1', authorizationId: 'authorization-1' },
    ]));
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      phase: 'transitioning',
      revocationObligations: [
        expect.objectContaining({
          target: {
            kind: 'session_authorization',
            machineId: 'm1',
            sessionId: 'session-1',
            authorizationId: 'authorization-1',
          },
          status: 'pending',
        }),
      ],
    });

    currentRuntimeRevoke.resolve();
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]));
    await act(async () => {
      tree.update(React.createElement(Harness, { voice }));
      tree.update(React.createElement(Harness, { voice }));
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
    const voice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null } };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });

    const oldRuntimeResult = revokeVoiceDiagnosticsSessionAuthorization({
      machineId: 'm1',
      sessionId: 'session-1',
      authorizationId: 'authorization-1',
    });
    await vi.waitFor(() => expect(revokeCalls).toHaveLength(1));

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
    oldRuntimeRevoke.resolve();
    await expect(oldRuntimeResult).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'active',
      revocationObligations: [],
    }));
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
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
    const voice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null } };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });

    await expect(revokeVoiceDiagnosticsSessionAuthorization({
      machineId: 'm1',
      sessionId: 'session-1',
      authorizationId: 'authorization-1',
    })).resolves.toMatchObject({ ok: false });
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
    expect(revokeCalls).toHaveLength(1);

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]));
    expect(revokeCalls).toHaveLength(2);
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
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
    const enabledVoice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null } };
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    const disabledVoice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null },
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice: enabledVoice })); });
    await expect(revokeVoiceDiagnosticsSessionAuthorization({
      machineId: 'm1',
      sessionId: 'session-1',
      authorizationId: 'authorization-1',
    })).resolves.toMatchObject({ ok: false });

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(React.createElement(Harness, { voice: enabledVoice })); });
    await vi.waitFor(() => expect(reconnectSignal).toBeInstanceOf(AbortSignal));

    machineState.daemonStateVersion = 3;
    await act(async () => { tree.update(React.createElement(Harness, { voice: disabledVoice })); });
    await vi.waitFor(() => expect(readReconnectSignal()?.aborted).toBe(true));
    await vi.waitFor(() => expect(currentDisableSignal).toBeInstanceOf(AbortSignal));
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
    const enabledVoice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null } };
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    const disabledVoice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null },
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice: enabledVoice })); });

    const manualRevocation = revokeVoiceDiagnosticsSessionAuthorization({
      machineId: 'm1',
      sessionId: 'session-1',
      authorizationId: 'authorization-1',
    });
    await vi.waitFor(() => expect(revokeCalls).toHaveLength(1));

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(React.createElement(Harness, { voice: enabledVoice })); });
    expect(revokeCalls).toHaveLength(1);

    machineState.daemonStateVersion = 3;
    await act(async () => { tree.update(React.createElement(Harness, { voice: disabledVoice })); });
    let disabledConfigureStartedBeforeManualRelease = false;
    try {
      await vi.waitFor(() => expect(disabledConfigureStarted).toBe(true));
      disabledConfigureStartedBeforeManualRelease = true;
    } catch {
      // Drain the held manual request before asserting the pre-release state.
    }

    initialManualRevoke.resolve();
    await expect(manualRevocation).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(1));
    await act(async () => { tree.unmount(); });

    expect(disabledConfigureStartedBeforeManualRelease).toBe(true);
    expect(revokeCalls).toHaveLength(1);
  });

  it('settles a restored exact-machine shutdown after the selected daemon confirms diagnostics off', async () => {
    const persistenceScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
    machineState.persistenceScope = persistenceScope;
    persistedRevocations.set('server-a:account-a', ['m1']);
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null },
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'inactive_confirmed',
      revocationObligations: [],
    }));

    expect(persistedRevocations.get('server-a:account-a')).toEqual([]);
    await act(async () => { tree.unmount(); });
  });

  it('retains a persisted former-machine shutdown when a different selected daemon cannot acknowledge its retry', async () => {
    const persistenceScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.machineId = 'm2';
    machineState.persistenceScope = persistenceScope;
    persistedRevocations.set('server-a:account-a', ['m1']);
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === false) {
        throw new Error('former_machine_offline');
      }
      return { ok: true, settings };
    });
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm2', autoMachineId: null },
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
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
    expect(persistedRevocations.get('server-a:account-a')).toEqual(['m1']);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: { kind: 'machine_policy', machineId: 'm1' },
        status: 'failed',
      }),
    ]);
    await act(async () => { tree.unmount(); });
  });

  it('retries a persisted former-machine shutdown only when that exact daemon reconnects', async () => {
    const persistenceScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.machineId = 'm2';
    machineState.persistenceScope = persistenceScope;
    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 1, isOnline: false });
    persistedRevocations.set('server-a:account-a', ['m1']);
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm2', autoMachineId: null },
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
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
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });

    await vi.waitFor(() => expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1'
        && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(1));
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm2'
        && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(1);
    expect(persistedRevocations.get('server-a:account-a')).toEqual([]);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]);
    await act(async () => { tree.unmount(); });
  });

  it('replays every independently current persisted former-machine shutdown', async () => {
    const persistenceScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.machineId = 'm2';
    machineState.persistenceScope = persistenceScope;
    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 1, isOnline: false });
    runtimeTargetsByMachineId.set('m3', { daemonStateVersion: 2, isOnline: true });
    persistedRevocations.set('server-a:account-a', ['m1', 'm3']);
    const voice = {
      diagnostics: disabledDiagnostics,
      executionMachine: { mode: 'fixed', machineId: 'm2', autoMachineId: null },
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });

    await vi.waitFor(() => expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm3'
        && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(1));
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1'
        && readRequestedDiagnosticsEnabled(settings) === false,
    )).toHaveLength(0);
    expect(persistedRevocations.get('server-a:account-a')).toEqual(['m1']);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: { kind: 'machine_policy', machineId: 'm1' },
        status: 'failed',
      }),
    ]);
    await act(async () => { tree.unmount(); });
  });

  it('does not replay an unchanged former-machine failure for an unrelated runtime status update', async () => {
    const persistenceScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.machineId = 'm2';
    machineState.persistenceScope = persistenceScope;
    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 1, isOnline: false });
    runtimeTargetsByMachineId.set('m3', { daemonStateVersion: 2, isOnline: true });
    persistedRevocations.set('server-a:account-a', ['m1', 'm3']);
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
      executionMachine: { mode: 'fixed', machineId: 'm2', autoMachineId: null },
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
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
    const persistenceScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.machineId = 'm2';
    machineState.persistenceScope = persistenceScope;
    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 1, isOnline: false });
    persistedRevocations.set('server-a:account-a', ['m1']);
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
      executionMachine: { mode: 'fixed', machineId: 'm2', autoMachineId: null },
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: { kind: 'machine_policy', machineId: 'm1' },
        status: 'failed',
      }),
    ]));
    expect(formerMachineShutdownAttempts).toBe(0);

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 2, isOnline: true });
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
    await vi.waitFor(() => expect(formerMachineShutdownAttempts).toBe(1));
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: { kind: 'machine_policy', machineId: 'm1' },
        status: 'failed',
      }),
    ]));
    expect(persistedRevocations.get('server-a:account-a')).toEqual(['m1']);

    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
    expect(formerMachineShutdownAttempts).toBe(1);

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 3, isOnline: true });
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
    await vi.waitFor(() => expect(formerMachineShutdownAttempts).toBe(2));
    expect(persistedRevocations.get('server-a:account-a')).toEqual([]);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]);
    await act(async () => { tree.unmount(); });
  });

  it('replaces an in-flight former-machine replay when that exact daemon advances', async () => {
    const persistenceScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
    const disabledDiagnostics = Object.freeze({ ...diagnostics, enabled: false, consentVersion: null });
    machineState.machineId = 'm2';
    machineState.persistenceScope = persistenceScope;
    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 1, isOnline: false });
    persistedRevocations.set('server-a:account-a', ['m1']);
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
      executionMachine: { mode: 'fixed', machineId: 'm2', autoMachineId: null },
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: { kind: 'machine_policy', machineId: 'm1' },
        status: 'failed',
      }),
    ]));

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 2, isOnline: true });
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
    await vi.waitFor(() => expect(firstReplaySignal).toBeDefined());

    runtimeTargetsByMachineId.set('m1', { daemonStateVersion: 3, isOnline: true });
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
    await vi.waitFor(() => expect(firstReplaySignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(formerMachineShutdownAttempts).toBe(2));
    expect(persistedRevocations.get('server-a:account-a')).toEqual([]);
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
      executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null },
    };
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });
    expect(configureCalls).toHaveLength(1);

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
    await Promise.resolve();
    const firstWasAborted = firstSignal?.aborted === true;
    const callsBeforeManualRelease = configureCalls.length;

    // Let the pre-fix implementation drain so RED leaves no pending work.
    releaseFirst();
    await vi.waitFor(() => expect(configureCalls).toHaveLength(2));
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
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
    const voice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null } };
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice })); });
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (!machineState.isOnline) throw new Error('daemon_offline');
      return { ok: true, settings };
    });

    machineState.isOnline = false;
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({ machineId: 'm1', phase: 'status_unknown' });

    machineState.isOnline = true;
    await act(async () => { tree.update(React.createElement(Harness, { voice })); });
    expect(configureCalls).toHaveLength(3);
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({ machineId: 'm1', phase: 'active' });
    await act(async () => { tree.unmount(); });
  });

  it('aborts the in-flight configure request during runtime teardown', async () => {
    let observedSignal: AbortSignal | undefined;
    configureImpl.mockImplementationOnce(async (_machineId: string, _settings: unknown, signal?: AbortSignal | null) => {
      observedSignal = signal ?? undefined;
      return { ok: true, settings: _settings };
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Harness, {
        voice: { diagnostics, executionMachine: { mode: 'auto', machineId: null, autoMachineId: null } },
      }));
    });
    expect(observedSignal?.aborted).toBe(false);
    await act(async () => { tree.unmount(); });
    expect(observedSignal?.aborted).toBe(true);
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
    const firstVoice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null } };
    const secondVoice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm2', autoMachineId: null } };
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice: firstVoice })); });
    await vi.waitFor(() => expect(configureCalls).toHaveLength(1));

    machineState.machineId = 'm2';
    await act(async () => { tree.update(React.createElement(Harness, { voice: secondVoice })); });
    releaseFirst();
    await vi.waitFor(() => expect(configureCalls).toHaveLength(3));

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
      executionMachine: { mode: 'fixed', machineId, autoMachineId: null },
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice: voiceFor('m1') })); });

    machineState.machineId = 'm2';
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m2') })); });
    await vi.waitFor(() => expect(cleanupSignal).toBeDefined());

    machineState.daemonStateVersion = 2;
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m2') })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
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
      executionMachine: { mode: 'fixed', machineId, autoMachineId: null },
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice: voiceFor('m1') })); });

    machineState.machineId = 'm2';
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m2') })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ kind: 'machine_policy', machineId: 'm1' }),
        status: 'failed',
      }),
    ]));
    const staleObligation = readVoiceDiagnosticsRuntimeStatus().revocationObligations[0]!;

    failM1Disable = false;
    machineState.machineId = 'm1';
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m1') })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
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
      executionMachine: { mode: 'fixed', machineId, autoMachineId: null },
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice: voiceFor('m1') })); });
    machineState.machineId = 'm2';
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m2') })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toHaveLength(1));
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
    await vi.waitFor(() => expect(retryStarted).toBe(true));

    machineState.machineId = 'm1';
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m1') })); });
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true,
    )).toHaveLength(enabledM1CallsBeforeRetry);

    releaseRetry();
    await expect(retry).resolves.toMatchObject({ ok: false });
    await vi.waitFor(() => expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true,
    )).toHaveLength(enabledM1CallsBeforeRetry + 1));
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'active',
      revocationObligations: [],
    });
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
      executionMachine: { mode: 'fixed', machineId, autoMachineId: null },
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice: voiceFor('m1') })); });

    machineState.machineId = 'm2';
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m2') })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ kind: 'machine_policy', machineId: 'm1' }),
        status: 'failed',
      }),
    ]));

    failM1Disable = false;
    failM1Enable = true;
    machineState.machineId = 'm1';
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m1') })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
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
      executionMachine: { mode: 'fixed', machineId, autoMachineId: null },
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice: voiceFor('m1') })); });
    machineState.machineId = 'm2';
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m2') })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toHaveLength(1));
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
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m1') })); });
    await vi.waitFor(() => expect(configureCalls.some(
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
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
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
      executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null },
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice: voiceWith(diagnostics) })); });
    await vi.waitFor(() => expect(configureCalls).toHaveLength(1));

    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceWith(disabledDiagnostics) })); });
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceWith(diagnostics) })); });
    releaseFirstEnable();

    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
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
      executionMachine: { mode: 'fixed', machineId, autoMachineId: null },
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Harness, { voice: voiceFor('m1') })); });
    machineState.machineId = 'm2';
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m2') })); });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toHaveLength(1));

    failInitialM1Disable = false;
    blockM1Enable = true;
    machineState.machineId = 'm1';
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m1') })); });
    await vi.waitFor(() => expect(configureCalls.some(
      ({ machineId, settings }) => machineId === 'm1' && readRequestedDiagnosticsEnabled(settings) === true,
    )).toBe(true));

    blockFinalM1Disable = true;
    await act(async () => {
      tree.update(React.createElement(Harness, { voice: voiceFor('m1', disabledDiagnostics) }));
    });
    const newerDisableObligation = readVoiceDiagnosticsRuntimeStatus().revocationObligations[0]!;
    expect(newerDisableObligation).toMatchObject({
      target: { kind: 'machine_policy', machineId: 'm1' },
      status: 'pending',
    });

    releaseM1Enable();
    await vi.waitFor(() => expect(finalM1DisableStarted).toBe(true));
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({ revision: newerDisableObligation.revision, status: 'pending' }),
    ]);

    releaseFinalM1Disable();
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
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
    await act(async () => {
      tree = renderer.create(React.createElement(Harness, {
        voice: {
          diagnostics,
          executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null },
        },
      }));
    });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'active',
    }));
    await act(async () => {
      tree.update(React.createElement(Harness, {
        voice: {
          diagnostics: disabledDiagnostics,
          executionMachine: { mode: 'fixed', machineId: 'm1', autoMachineId: null },
        },
      }));
    });
    await vi.waitFor(() => expect(disableCalls).toBe(1));
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
