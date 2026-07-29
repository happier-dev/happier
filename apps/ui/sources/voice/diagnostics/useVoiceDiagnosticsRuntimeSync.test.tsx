import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/store/hooks', () => ({
  useActiveServerAccountScope: () => null,
  useMachineCliDetectionTarget: () => ({
    daemonStateVersion: machineState.daemonStateVersion,
    isOnline: machineState.isOnline,
  }),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineState = vi.hoisted(() => ({
  machineId: 'm1' as string | null,
  daemonStateVersion: 1,
  isOnline: true,
}));
const configureCalls = vi.hoisted(() => [] as Array<{
  machineId: string;
  settings: any;
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
vi.mock('./client', () => ({
  createVoiceDiagnosticsClientForMachine: (machineId: string) => ({
    configure: (settings: unknown, signal?: AbortSignal | null) => configureImpl(machineId, settings, signal),
  }),
}));
vi.mock('@/voice/credentials/useExecutionMachinePresentation', () => ({
  useVoiceExecutionMachinePresentation: () => ({ machineId: machineState.machineId, machineLabel: machineState.machineId }),
}));
vi.mock('@/sync/domains/settings/voiceSettings', () => ({
  voiceSettingsParse: (value: any) => ({
    diagnostics: value.diagnostics,
    executionMachine: value.executionMachine,
  }),
}));

import { useVoiceDiagnosticsRuntimeSync } from './useVoiceDiagnosticsRuntimeSync';
import {
  readVoiceDiagnosticsRuntimeStatus,
  resetVoiceDiagnosticsRuntimeStatusForTests,
} from './runtimeStatus';
import {
  resetVoiceDiagnosticsRevocationForTests,
  retryVoiceDiagnosticsRevocation,
} from './runtimeRevocation';

function Harness(props: { voice: any }) {
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
    configureCalls.length = 0;
    configureImpl.mockClear();
    resetVoiceDiagnosticsRuntimeStatusForTests();
    resetVoiceDiagnosticsRevocationForTests();
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
      if (machineId === 'm1' && (settings as any).enabled === true) await first;
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

    expect(configureCalls.map(({ machineId, settings }) => [machineId, settings.enabled])).toEqual([
      ['m1', true],
      ['m1', false],
      ['m2', true],
    ]);
    expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({ machineId: 'm2', phase: 'active' });
    await act(async () => { tree.unmount(); });
  });

  it('supersedes a stale shutdown obligation when that exact machine is later re-authorized', async () => {
    let failM1Disable = true;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && (settings as any).enabled === false && failM1Disable) {
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
      ({ machineId, settings }) => machineId === 'm1' && settings.enabled === false,
    ).length;
    await retryVoiceDiagnosticsRevocation({ obligation: staleObligation, settings: diagnostics });
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && settings.enabled === false,
    )).toHaveLength(disableCallsAfterReauthorization);
    await act(async () => { tree.unmount(); });
  });

  it('orders re-authorization after an already-started exact-machine shutdown retry', async () => {
    let failInitialM1Disable = true;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && (settings as any).enabled === false && failInitialM1Disable) {
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
      if (machineId === 'm1' && (settings as any).enabled === false) {
        retryStarted = true;
        await retryBlocked;
        throw new Error('retry_shutdown_failed_after_reauthorization_queued');
      }
      return { ok: true, settings };
    });
    const enabledM1CallsBeforeRetry = configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && settings.enabled === true,
    ).length;
    const retry = retryVoiceDiagnosticsRevocation({ obligation, settings: diagnostics });
    await vi.waitFor(() => expect(retryStarted).toBe(true));

    machineState.machineId = 'm1';
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m1') })); });
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && settings.enabled === true,
    )).toHaveLength(enabledM1CallsBeforeRetry);

    releaseRetry();
    await expect(retry).resolves.toMatchObject({ ok: false });
    await vi.waitFor(() => expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && settings.enabled === true,
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
      if (machineId === 'm1' && (settings as any).enabled === false && failM1Disable) {
        throw new Error('m1_shutdown_unavailable');
      }
      if (machineId === 'm1' && (settings as any).enabled === true && failM1Enable) {
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
      ({ machineId, settings }) => machineId === 'm1' && settings.enabled === false,
    ).length;
    failM1Enable = false;
    await expect(retryVoiceDiagnosticsRevocation({ obligation, settings: diagnostics })).resolves.toEqual({
      ok: true,
      acknowledged: true,
    });
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && settings.enabled === false,
    )).toHaveLength(m1DisableCallsBeforeRetry + 1);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]);
    await act(async () => { tree.unmount(); });
  });

  it('does not let a captured stale retry trail a newer queued enable intent', async () => {
    let failM1Disable = true;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && (settings as any).enabled === false && failM1Disable) {
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
      if (machineId === 'm1' && (settings as any).enabled === true) await m1EnableBlocked;
      return { ok: true, settings };
    });
    machineState.machineId = 'm1';
    await act(async () => { tree.update(React.createElement(Harness, { voice: voiceFor('m1') })); });
    await vi.waitFor(() => expect(configureCalls.some(
      ({ machineId, settings }) => machineId === 'm1' && settings.enabled === true,
    )).toBe(true));
    const disablesBeforeStaleRetry = configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && settings.enabled === false,
    ).length;
    const staleRetry = retryVoiceDiagnosticsRevocation({ obligation: staleObligation, settings: diagnostics });
    await Promise.resolve();
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && settings.enabled === false,
    )).toHaveLength(disablesBeforeStaleRetry);

    releaseM1Enable();
    await expect(staleRetry).resolves.toEqual({ ok: true, acknowledged: false });
    await vi.waitFor(() => expect(readVoiceDiagnosticsRuntimeStatus()).toMatchObject({
      machineId: 'm1',
      phase: 'active',
      revocationObligations: [],
    }));
    expect(configureCalls.filter(
      ({ machineId, settings }) => machineId === 'm1' && settings.enabled === false,
    )).toHaveLength(disablesBeforeStaleRetry);
    await act(async () => { tree.unmount(); });
  });

  it('makes the latest same-machine enable win an enable-disable-enable race', async () => {
    let releaseFirstEnable!: () => void;
    const firstEnableBlocked = new Promise<void>((resolve) => { releaseFirstEnable = resolve; });
    let enabledCalls = 0;
    configureImpl.mockImplementation(async (machineId: string, settings: unknown, signal?: AbortSignal | null) => {
      configureCalls.push({ machineId, settings, signal });
      if (machineId === 'm1' && (settings as any).enabled === true && enabledCalls++ === 0) {
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
    expect(configureCalls.map(({ machineId, settings }) => [machineId, settings.enabled])).toEqual([
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
      if (machineId === 'm1' && (settings as any).enabled === false && failInitialM1Disable) {
        throw new Error('m1_shutdown_unavailable');
      }
      if (machineId === 'm1' && (settings as any).enabled === true && blockM1Enable) {
        await m1EnableBlocked;
      }
      if (machineId === 'm1' && (settings as any).enabled === false && blockFinalM1Disable) {
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
      ({ machineId, settings }) => machineId === 'm1' && settings.enabled === true,
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
      if (machineId === 'm1' && (settings as any).enabled === false) {
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
