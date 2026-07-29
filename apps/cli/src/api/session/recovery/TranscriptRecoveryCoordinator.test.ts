import type { ManagedConnectionState, ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpStatusError } from '@/api/client/httpStatusError';
import type { TranscriptLookupOutcome, TranscriptMessageLookupResult } from '../transcriptMessageLookup';
import { TranscriptRecoveryCoordinator } from './TranscriptRecoveryCoordinator';

function createState(overrides: Partial<ManagedConnectionState> = {}): ManagedConnectionState {
  return {
    phase: 'online',
    reason: null,
    attempt: 0,
    nextRetryAt: null,
    lastConnectedAt: 1,
    lastDisconnectedAt: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

function createSupervisor(state: ManagedConnectionState = createState()): ManagedConnectionSupervisor {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getState: vi.fn(() => state),
    reportProbeResult: vi.fn(),
  };
}

function createLookupMessage(): TranscriptMessageLookupResult {
  return {
    id: 'm1',
    seq: 1,
    localId: 'local-1',
    sidechainId: null,
    createdAt: 1,
    updatedAt: 1,
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('TranscriptRecoveryCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
    TranscriptRecoveryCoordinator.__resetForTesting();
  });

  it('returns the same singleton for the same serverUrl', () => {
    const first = TranscriptRecoveryCoordinator.forServer('http://server.test');
    const second = TranscriptRecoveryCoordinator.forServer('http://server.test');

    expect(second).toBe(first);
  });

  it('defers offline supervisors before running network work', async () => {
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', { delayMs: 0 });
    const runRequest = vi.fn(async (): Promise<TranscriptLookupOutcome> => ({ type: 'not_found' }));

    await expect(
      coordinator.scheduleByLocalId({
        sessionId: 'sid',
        localId: 'local-1',
        supervisor: createSupervisor(createState({ phase: 'offline', reason: 'server_unreachable' })),
        runRequest,
      }),
    ).resolves.toEqual({ type: 'deferred', reason: 'supervisor_offline' });
    expect(runRequest).not.toHaveBeenCalled();
  });

  it('single-flights concurrent requests for the same session and localId', async () => {
    vi.useFakeTimers();

    const supervisor = createSupervisor();
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', { delayMs: 0 });
    const deferred = createDeferred<TranscriptLookupOutcome>();
    const runRequest = vi.fn(async () => deferred.promise);

    const first = coordinator.scheduleByLocalId({ sessionId: 'sid', localId: 'local-1', supervisor, runRequest });
    const second = coordinator.scheduleByLocalId({ sessionId: 'sid', localId: 'local-1', supervisor, runRequest });

    await vi.runAllTimersAsync();
    expect(runRequest).toHaveBeenCalledTimes(1);

    deferred.resolve({ type: 'found', message: createLookupMessage() });

    await expect(first).resolves.toMatchObject({ type: 'success', value: { id: 'm1' } });
    await expect(second).resolves.toMatchObject({ type: 'success', value: { id: 'm1' } });
  });

  it('respects the per-server max concurrency for distinct localIds', async () => {
    vi.useFakeTimers();

    const supervisor = createSupervisor();
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', { delayMs: 0, maxConcurrent: 1 });
    const first = createDeferred<TranscriptLookupOutcome>();
    const started: string[] = [];

    const a = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'a',
      supervisor,
      runRequest: async () => {
        started.push('a');
        return await first.promise;
      },
    });
    const b = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'b',
      supervisor,
      runRequest: async () => {
        started.push('b');
        return { type: 'not_found' };
      },
    });

    await vi.runAllTimersAsync();
    expect(started).toEqual(['a']);

    first.resolve({ type: 'not_found' });
    await expect(a).resolves.toEqual({ type: 'not_found' });
    await vi.runAllTimersAsync();

    await expect(b).resolves.toEqual({ type: 'not_found' });
    expect(started).toEqual(['a', 'b']);
  });

  it('defers immediate retries during the per-key backoff window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', {
      delayMs: 0,
      errorBackoffBaseMs: 100,
      errorBackoffMaxMs: 100,
    });
    const runRequest = vi.fn(async (): Promise<TranscriptLookupOutcome> => ({
      type: 'unhealthy',
      reason: 'server_5xx',
      error: new Error('unavailable'),
    }));

    const first = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'local-1',
      supervisor: createSupervisor(),
      runRequest,
    });
    await vi.runAllTimersAsync();

    await expect(first).resolves.toMatchObject({ type: 'error', reason: 'unhealthy' });
    await expect(
      coordinator.scheduleByLocalId({
        sessionId: 'sid',
        localId: 'local-1',
        supervisor: createSupervisor(),
        runRequest,
      }),
    ).resolves.toEqual({ type: 'deferred', reason: 'backoff' });
    expect(runRequest).toHaveBeenCalledTimes(1);
  });

  it('reports authentication failures but keeps domain failures operation-local', async () => {
    vi.useFakeTimers();

    const supervisor = createSupervisor();
    const authError = new Error('expired token');
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', { delayMs: 0 });

    const authResult = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'auth-local',
      supervisor,
      runRequest: async () => ({ type: 'auth_failed', statusCode: 401, error: authError }),
    });
    await vi.runAllTimersAsync();
    await expect(authResult).resolves.toEqual({ type: 'error', reason: 'auth_failed', error: authError });

    const serverError = new HttpStatusError(503, 'service unavailable');
    const serverResult = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'server-local',
      supervisor,
      runRequest: async () => {
        throw serverError;
      },
    });
    await vi.runAllTimersAsync();
    await expect(serverResult).resolves.toEqual({ type: 'error', reason: 'unhealthy', error: serverError });

    expect(supervisor.reportProbeResult).toHaveBeenCalledOnce();
    expect(supervisor.reportProbeResult).toHaveBeenCalledWith({
      status: 'auth_failed',
      statusCode: 401,
      errorMessage: 'expired token',
    });
  });

  it.each([
    ['server 5xx', { type: 'unhealthy', reason: 'server_5xx', error: new Error('unavailable') }],
    ['network', { type: 'unhealthy', reason: 'network', error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) }],
    ['timeout', { type: 'unhealthy', reason: 'timeout', error: Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }) }],
    ['protocol', { type: 'protocol_error', error: new Error('malformed response') }],
  ] as const)('keeps %s lookup failures operation-local with keyed backoff', async (_name, outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const supervisor = createSupervisor();
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', {
      delayMs: 0,
      errorBackoffBaseMs: 100,
      errorBackoffMaxMs: 100,
    });
    const runRequest = vi.fn(async (): Promise<TranscriptLookupOutcome> => outcome);

    const result = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'local-1',
      supervisor,
      runRequest,
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({ type: 'error' });
    expect(supervisor.reportProbeResult).not.toHaveBeenCalled();
    await expect(
      coordinator.scheduleByLocalId({
        sessionId: 'sid',
        localId: 'local-1',
        supervisor,
        runRequest,
      }),
    ).resolves.toEqual({ type: 'deferred', reason: 'backoff' });
    expect(runRequest).toHaveBeenCalledTimes(1);
  });
});
