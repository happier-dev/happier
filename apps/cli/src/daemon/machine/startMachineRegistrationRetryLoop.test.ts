import type { ManagedEndpointSupervisorState } from '@happier-dev/connection-supervisor';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Machine, MachineMetadata } from '@/api/types';
import { MachineContentPublicKeyMismatchError } from '@/api/machine/machineRegistrationErrors';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import { createDeferred } from '@/testkit/async/deferred';
import { createHttpStatusError } from '@/api/client/httpStatusError';

import {
  startMachineRegistrationRetryLoop,
  type StartMachineRegistrationRetryLoopParams,
} from './startMachineRegistrationRetryLoop';

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
  ensureMachineRegistered: vi.fn(),
}));

type RetryWakeSource = Readonly<{
  reportFailure: (report: Readonly<{ errorMessage?: string }>) => void;
  invalidate: () => void;
  subscribe: (listener: (state: ManagedEndpointSupervisorState) => void) => () => void;
}>;

function createState(
  phase: ManagedEndpointSupervisorState['phase'],
  reason: ManagedEndpointSupervisorState['reason'],
): ManagedEndpointSupervisorState {
  return {
    phase,
    reason,
    attempt: 0,
    nextRetryAt: null,
    lastConnectedAt: phase === 'online' ? Date.now() : null,
    lastDisconnectedAt: null,
    lastErrorMessage: null,
    lastProbe: phase === 'online' ? { status: 'ready' } : null,
  };
}

function createRetryWakeSourceHarness(): Readonly<{
  source: RetryWakeSource;
  publish: (state: ManagedEndpointSupervisorState) => void;
  listenerCount: () => number;
}> {
  const listeners = new Set<(state: ManagedEndpointSupervisorState) => void>();
  let state = createState('offline', 'server_unreachable');
  const source = {
    reportFailure: vi.fn(),
    invalidate: vi.fn(),
    subscribe: vi.fn((listener: (state: ManagedEndpointSupervisorState) => void) => {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    }),
  } satisfies RetryWakeSource;

  return {
    source,
    publish: (nextState) => {
      state = nextState;
      for (const listener of [...listeners]) {
        listener(nextState);
      }
    },
    listenerCount: () => listeners.size,
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
  overrides: Partial<StartMachineRegistrationRetryLoopParams> &
    Readonly<{ machineRegistrationRetryWakeSource?: RetryWakeSource }> = {},
): StartMachineRegistrationRetryLoopParams & Readonly<{ machineRegistrationRetryWakeSource?: RetryWakeSource }> {
  let machineId = 'machine-1';
  let shuttingDown = false;
  const shutdown = createDeferred<void>();
  const params = {
    api: {
      getOrCreateMachine: async () => {
        throw new Error('ensureMachineRegistered is mocked in this test');
      },
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
  } satisfies StartMachineRegistrationRetryLoopParams & Readonly<{ machineRegistrationRetryWakeSource?: RetryWakeSource }>;

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
    vi.mocked(ensureMachineRegistered).mockReset();
  });

  it('wakes a retryable endpoint-outage registration retry when readiness returns online', async () => {
    vi.useFakeTimers();
    const ensureMachineRegisteredMock = vi.mocked(ensureMachineRegistered);
    const retryWakeSource = createRetryWakeSourceHarness();

    ensureMachineRegisteredMock
      .mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce({
        machineId: 'machine-1',
        didRotateMachineId: false,
        machine: createMachine('machine-1'),
      });

    const params = createLoopParams({
      machineRegistrationRetryWakeSource: retryWakeSource.source,
    });

    startMachineRegistrationRetryLoop(params);

    await flushTimers();
    expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);
    expect(ensureMachineRegisteredMock).toHaveBeenCalledWith(
      expect.objectContaining({ isShuttingDown: expect.any(Function) }),
    );
    expect(ensureMachineRegisteredMock.mock.calls[0]?.[0].isShuttingDown?.()).toBe(false);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);

    retryWakeSource.publish(createState('online', 'initial_connect'));
    await flushTimers();

    expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(2);
    expect(params.onMachineRegistered).toHaveBeenCalledWith({
      machineId: 'machine-1',
      machine: expect.objectContaining({ id: 'machine-1' }),
    });
  });

  it('wakes a retryable server-error registration retry when readiness returns online', async () => {
    vi.useFakeTimers();
    const ensureMachineRegisteredMock = vi.mocked(ensureMachineRegistered);
    const retryWakeSource = createRetryWakeSourceHarness();

    ensureMachineRegisteredMock
      .mockRejectedValueOnce(createHttpStatusError(503, 'Server encountered an error'))
      .mockResolvedValueOnce({
        machineId: 'machine-1',
        didRotateMachineId: false,
        machine: createMachine('machine-1'),
      });

    const params = createLoopParams({
      machineRegistrationRetryWakeSource: retryWakeSource.source,
    });

    startMachineRegistrationRetryLoop(params);

    await flushTimers();
    expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);

    retryWakeSource.publish(createState('online', 'initial_connect'));
    await flushTimers();

    expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(2);
    expect(params.onMachineRegistered).toHaveBeenCalledWith({
      machineId: 'machine-1',
      machine: expect.objectContaining({ id: 'machine-1' }),
    });
  });

  it('does not arm readiness wake after a terminal content-key mismatch', async () => {
    vi.useFakeTimers();
    const ensureMachineRegisteredMock = vi.mocked(ensureMachineRegistered);
    const retryWakeSource = createRetryWakeSourceHarness();
    ensureMachineRegisteredMock.mockRejectedValueOnce(
      new MachineContentPublicKeyMismatchError('machine-1', 'content_public_key_mismatch'),
    );

    const params = createLoopParams({
      machineRegistrationRetryWakeSource: retryWakeSource.source,
    });

    startMachineRegistrationRetryLoop(params);
    await flushTimers();

    retryWakeSource.publish(createState('online', 'initial_connect'));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);
    expect(retryWakeSource.source.reportFailure).not.toHaveBeenCalled();
    expect(params.onMachineRegistered).not.toHaveBeenCalled();
  });

  it('cleans up a pending readiness wake when shutdown cancels retry sleep', async () => {
    vi.useFakeTimers();
    const ensureMachineRegisteredMock = vi.mocked(ensureMachineRegistered);
    const retryWakeSource = createRetryWakeSourceHarness();
    const shutdown = createDeferred<void>();
    ensureMachineRegisteredMock.mockRejectedValueOnce(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
    );

    const params = createLoopParams({
      resolvesWhenShutdownRequested: shutdown.promise,
      isShuttingDown: () => false,
      machineRegistrationRetryWakeSource: retryWakeSource.source,
    });

    startMachineRegistrationRetryLoop(params);
    await flushTimers();
    expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);

    shutdown.resolve();
    await flushTimers();
    retryWakeSource.publish(createState('online', 'initial_connect'));
    await flushTimers();

    expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);
    expect(retryWakeSource.listenerCount()).toBe(0);
  });

  it('retains a registration completed during temporary quiescence and resumes bootstrap exactly once', async () => {
    const ensureMachineRegisteredMock = vi.mocked(ensureMachineRegistered);
    const registration = createDeferred<Awaited<ReturnType<typeof ensureMachineRegistered>>>();
    let quiescing = false;
    const setMachineId = vi.fn();
    const params = createLoopParams({
      setMachineId,
      isShuttingDown: () => false,
      isQuiescing: () => quiescing,
    });

    ensureMachineRegisteredMock.mockReturnValueOnce(registration.promise);
    const handle = startMachineRegistrationRetryLoop(params);
    await vi.waitFor(() => expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1));

    quiescing = true;
    const registrationGuard = ensureMachineRegisteredMock.mock.calls[0]?.[0].isShuttingDown;
    expect(registrationGuard?.()).toBe(true);
    registration.resolve({
      machineId: 'machine-1',
      didRotateMachineId: false,
      machine: createMachine('machine-1'),
    });
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

    expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);
    expect(setMachineId).toHaveBeenCalledTimes(1);
    expect(params.onMachineRegistered).toHaveBeenCalledWith({
      machineId: 'machine-1',
      machine: expect.objectContaining({ id: 'machine-1' }),
    });
  });
});
