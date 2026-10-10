import {
  createManagedEndpointSupervisor,
  DEFAULT_MANAGED_CONNECTION_POLICY,
} from '@happier-dev/connection-supervisor';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Machine, MachineMetadata } from '@/api/types';
import { MachineContentPublicKeyMismatchError } from '@/api/machine/machineRegistrationErrors';
import type { Settings } from '@/persistence';
import { createDeferred } from '@/testkit/async/deferred';
import { createHttpStatusError } from '@/api/client/httpStatusError';

import {
  startMachineRegistrationRetryLoop,
  type StartMachineRegistrationRetryLoopParams,
} from './startMachineRegistrationRetryLoop';

// Settings persistence is a filesystem boundary; keep registration and retry logic real.
vi.mock('@/persistence', () => ({
  updateSettings: async (update: (settings: Settings) => Settings) => update({
    schemaVersion: 6,
    onboardingCompleted: true,
  }),
}));

function createRetryWakeSourceHarness() {
  let ready = false;
  const probeReadiness = vi.fn(async () => ready
    ? { status: 'ready' as const }
    : { status: 'server_unreachable' as const });
  const source = createManagedEndpointSupervisor({
    ...DEFAULT_MANAGED_CONNECTION_POLICY,
    probeReadiness,
  });
  return {
    source,
    probeReadiness,
    setReady: () => {
      ready = true;
      source.invalidate();
    },
  };
}

const metadataForRegistration = {
  host: 'test-host',
  platform: 'test-platform',
  happyCliVersion: '0.0.0-test',
  homeDir: '/tmp/home',
  happyHomeDir: '/tmp/happy',
  happyLibDir: '/tmp/happy/lib',
} satisfies MachineMetadata;

function createMachine(id: string): Machine {
  return {
    id,
    encryptionKey: new Uint8Array([1, 2, 3]),
    encryptionVariant: 'legacy',
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

function createLoopParams(
  overrides: Partial<StartMachineRegistrationRetryLoopParams> = {},
): StartMachineRegistrationRetryLoopParams {
  let machineId = 'machine-1';
  let shuttingDown = false;
  const shutdown = createDeferred<void>();
  const params = {
    api: {
      getOrCreateMachine: vi.fn<StartMachineRegistrationRetryLoopParams['api']['getOrCreateMachine']>(),
    },
    metadataForRegistration,
    initialDaemonState: { status: 'running' },
    machineRegistrationTimeoutMs: 1_000,
    machineRegistrationRetryBaseDelayMs: 10_000,
    machineRegistrationRetryMaxDelayMs: 10_000,
    machineRegistrationRetryJitterMs: 0,
    machineRegistrationMaxAttempts: 0,
    resolvesWhenShutdownRequested: shutdown.promise,
    initialPreflightMachineRegistration: null,
    resolveMachineId: () => machineId,
    setMachineId: (resolvedMachineId: string) => {
      machineId = resolvedMachineId;
    },
    isShuttingDown: () => shuttingDown,
    onMachineRegistered: vi.fn(async () => {}),
    ...overrides,
  } satisfies StartMachineRegistrationRetryLoopParams;

  return {
    ...params,
    isShuttingDown: () => shuttingDown || params.isShuttingDown(),
    resolvesWhenShutdownRequested: params.resolvesWhenShutdownRequested,
  };
}

async function flushTimers(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('startMachineRegistrationRetryLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('wakes a retryable endpoint-outage registration retry when readiness returns online', async () => {
    vi.useFakeTimers();
    const retryWakeSource = createRetryWakeSourceHarness();
    await retryWakeSource.source.start();

    const params = createLoopParams({
      machineRegistrationRetryWakeSource: retryWakeSource.source,
    });
    const registrationRequest = vi.mocked(params.api.getOrCreateMachine);
    registrationRequest
      .mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce(createMachine('machine-1'));

    startMachineRegistrationRetryLoop(params);

    await flushTimers();
    expect(registrationRequest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(registrationRequest).toHaveBeenCalledTimes(1);

    retryWakeSource.setReady();
    await flushTimers();

    expect(registrationRequest).toHaveBeenCalledTimes(2);
    expect(params.onMachineRegistered).toHaveBeenCalledWith({
      machineId: 'machine-1',
      machine: expect.objectContaining({ id: 'machine-1' }),
    });
  });

  it.each([500, 503])('preserves registration backoff for HTTP %s despite healthy endpoint probes and concurrent resume calls', async (status) => {
    vi.useFakeTimers();
    const shutdown = createDeferred<void>();
    const secondAttempt = createDeferred<Machine>();
    const retryWakeSource = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      // The readiness HTTP boundary succeeds while the machine HTTP boundary fails.
      probeReadiness: async () => ({ status: 'ready' }),
    });
    await retryWakeSource.start();
    const params = createLoopParams({
      machineRegistrationRetryBaseDelayMs: 300_000,
      machineRegistrationRetryMaxDelayMs: 300_000,
      resolvesWhenShutdownRequested: shutdown.promise,
      machineRegistrationRetryWakeSource: retryWakeSource,
    });
    const registrationRequest = vi.mocked(params.api.getOrCreateMachine);
    registrationRequest
      .mockRejectedValueOnce(createHttpStatusError(status, 'Machine lookup failed'))
      .mockReturnValueOnce(secondAttempt.promise)
      .mockResolvedValueOnce(createMachine('machine-1'));
    const handle = startMachineRegistrationRetryLoop(params);
    try {
      await flushTimers();
      retryWakeSource.invalidate();
      handle.resume();
      handle.resume();
      await vi.advanceTimersByTimeAsync(299_999);
      expect(registrationRequest).toHaveBeenCalledTimes(1);
      expect(params.onMachineRegistered).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(registrationRequest).toHaveBeenCalledTimes(2);
      retryWakeSource.invalidate();
      handle.resume();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(registrationRequest).toHaveBeenCalledTimes(2);

      secondAttempt.reject(createHttpStatusError(status, 'Machine lookup still failed'));
      await flushTimers();
      retryWakeSource.invalidate();
      await vi.advanceTimersByTimeAsync(299_999);
      expect(registrationRequest).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(params.onMachineRegistered).toHaveBeenCalledWith({
        machineId: 'machine-1',
        machine: expect.objectContaining({ id: 'machine-1' }),
      });
    } finally {
      shutdown.resolve();
      await flushTimers();
      await retryWakeSource.stop();
    }
  });

  it('does not arm readiness wake after a terminal content-key mismatch', async () => {
    vi.useFakeTimers();
    const retryWakeSource = createRetryWakeSourceHarness();

    const params = createLoopParams({
      machineRegistrationRetryWakeSource: retryWakeSource.source,
    });
    const registrationRequest = vi.mocked(params.api.getOrCreateMachine);
    registrationRequest.mockRejectedValueOnce(
      new MachineContentPublicKeyMismatchError('machine-1', 'content_public_key_mismatch'),
    );

    startMachineRegistrationRetryLoop(params);
    await flushTimers();

    retryWakeSource.setReady();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(registrationRequest).toHaveBeenCalledTimes(1);
    expect(retryWakeSource.probeReadiness).not.toHaveBeenCalled();
    expect(params.onMachineRegistered).not.toHaveBeenCalled();
  });

  it('cleans up a pending readiness wake when shutdown cancels retry sleep', async () => {
    vi.useFakeTimers();
    const retryWakeSource = createRetryWakeSourceHarness();
    await retryWakeSource.source.start();
    const shutdown = createDeferred<void>();

    const params = createLoopParams({
      resolvesWhenShutdownRequested: shutdown.promise,
      isShuttingDown: () => false,
      machineRegistrationRetryWakeSource: retryWakeSource.source,
    });
    const registrationRequest = vi.mocked(params.api.getOrCreateMachine);
    registrationRequest.mockRejectedValueOnce(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
    );

    startMachineRegistrationRetryLoop(params);
    await flushTimers();
    expect(registrationRequest).toHaveBeenCalledTimes(1);

    shutdown.resolve();
    await flushTimers();
    retryWakeSource.setReady();
    await flushTimers();

    expect(registrationRequest).toHaveBeenCalledTimes(1);
    expect(retryWakeSource.source.getState().phase).toBe('shutting_down');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a registration completed during temporary quiescence and resumes bootstrap exactly once', async () => {
    const registration = createDeferred<Machine>();
    let quiescing = false;
    const setMachineId = vi.fn();
    const params = createLoopParams({
      setMachineId,
      isShuttingDown: () => false,
      isQuiescing: () => quiescing,
    });

    const registrationRequest = vi.mocked(params.api.getOrCreateMachine);
    registrationRequest.mockReturnValueOnce(registration.promise);
    const handle = startMachineRegistrationRetryLoop(params);
    await vi.waitFor(() => expect(registrationRequest).toHaveBeenCalledTimes(1));

    quiescing = true;
    registration.resolve(createMachine('machine-1'));
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(setMachineId).not.toHaveBeenCalled();
        expect(params.onMachineRegistered).not.toHaveBeenCalled();
        quiescing = false;
        handle.resume();
        resolve();
      });
    });
    await vi.waitFor(() => expect(params.onMachineRegistered).toHaveBeenCalledTimes(1));

    expect(registrationRequest).toHaveBeenCalledTimes(1);
    expect(setMachineId).toHaveBeenCalledTimes(1);
    expect(params.onMachineRegistered).toHaveBeenCalledWith({
      machineId: 'machine-1',
      machine: expect.objectContaining({ id: 'machine-1' }),
    });
  });
});
