import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import {
  callSessionProviderInputAdmission,
  clearProviderInputAdmissionAfterDurableAdoption,
  continueProviderInputAdmissionReconciliationAfterLifecycleFence,
  createProviderInputAdmissionRecordTracker,
  requestProviderInputAdmissionWhenReady,
} from './providerInputAdmissionRuntime';

const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));

const rpcRequests: Array<Readonly<{ method: string; params: unknown }>> = [];

function serveSession(mode: 'plain' | 'e2ee') {
  return vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') {
      return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    }
    if (path === `/v2/sessions/session-${mode}-123`) {
      return { status: 200, data: { session: createSessionRecordFixture({
        id: `session-${mode}-123`,
        encryptionMode: mode,
        metadata: mode === 'plain' ? '{}' : 'retained-ciphertext',
        dataEncryptionKey: mode === 'plain' ? null : 'retained-data-key-envelope',
      }) } };
    }
    throw new Error(`Unexpected HTTP path: ${path}`);
  });
}

describe('provider input admission daemon composition', () => {
  it('keeps fresh input admission pending beyond the removed five-second grace until actual readiness', async () => {
    vi.useFakeTimers();
    const changes = createSessionLiveWorkProducer({ readSessions: () => [],
      readActivity: async () => ({ session: 'unknown', input: 'unknown' }) });
    let ready = false;
    const unavailable = new Error('RPC method not available');
    const requestAdmission = vi.fn(async () => { if (!ready) throw unavailable; return { status: 'enforced' as const }; });
    const admission = requestProviderInputAdmissionWhenReady({
      requestAdmission, isMethodUnavailable: error => error === unavailable,
      readiness: { read: () => ready, subscribeChanges: listener => changes.subscribe(listener, 'pending') },
    });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requestAdmission).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      ready = true;
      changes.notifySessionChanged('pending');
      await expect(admission).resolves.toEqual({ status: 'admitted', value: { status: 'enforced' } });
      expect(requestAdmission).toHaveBeenCalledTimes(2);
    } finally { ready = true; changes.notifySessionChanged('pending'); await admission; vi.useRealTimers(); }
  });
  it('admits an already callable runner once despite a stale pending notification', async () => {
    const changes = createSessionLiveWorkProducer({ readSessions: () => [],
      readActivity: async () => ({ session: 'unknown', input: 'unknown' }) });
    const requestAdmission = vi.fn(async () => ({ status: 'enforced' as const }));
    await expect(requestProviderInputAdmissionWhenReady({ requestAdmission, isMethodUnavailable: () => false,
      readiness: { read: () => false, subscribeChanges: listener => changes.subscribe(listener, 'pending') },
    })).resolves.toEqual({ status: 'admitted', value: { status: 'enforced' } });
    expect(requestAdmission).toHaveBeenCalledOnce();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    io.mockReset();
    rpcRequests.length = 0;
    const socket = createApiSessionSocketStub({
      emitWithAck: (event, payload) => {
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        if (!payload || typeof payload !== 'object' || !('method' in payload)
          || typeof payload.method !== 'string' || !('params' in payload)) {
          throw new Error('Malformed Session RPC request');
        }
        rpcRequests.push({ method: payload.method, params: payload.params });
        return { ok: true, result: { status: 'enforced' } };
      },
    });
    bindApiSessionSocketMock(io, socket);
  });
  afterEach(() => { vi.restoreAllMocks(); io.mockReset(); });

  it('admits provider input for a plain Session with token-only credentials', async () => {
    const get = serveSession('plain');

    await expect(callSessionProviderInputAdmission({
      credentials: {
        token: 'token-only',
        encryption: null,
      },
      sessionId: 'session-plain-123',
      action: 'enforce',
      serviceId: 'openai-codex',
      groupId: 'group-1',
      reason: 'group_unavailable',
    })).resolves.toEqual({ status: 'enforced' });

    expect(get.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v1/account/encryption/currentness',
      '/v2/sessions/session-plain-123',
    ]);
    expect(rpcRequests).toEqual([{
      method: 'session-plain-123:session.providerInput.admission',
      params: {
        action: 'enforce',
        serviceId: 'openai-codex',
        groupId: 'group-1',
        reason: 'group_unavailable',
      },
    }]);
  });

  it('preserves typed material-unavailable failure for a retained E2EE Session', async () => {
    serveSession('e2ee');

    await expect(callSessionProviderInputAdmission({
      credentials: {
        token: 'token-only',
        encryption: null,
      },
      sessionId: 'session-e2ee-123',
      action: 'clear',
      serviceId: 'openai-codex',
      groupId: 'group-1',
    })).rejects.toMatchObject({
      code: 'encryption_material_unavailable',
      name: 'AccountEncryptionMaterialUnavailableError',
    });
    expect(rpcRequests).toEqual([]);
    expect(io).not.toHaveBeenCalled();
  });

  it('tracks exact admission records by both adopted proof object and session', () => {
    const tracker = createProviderInputAdmissionRecordTracker<{ epochId: string }>();
    const adoptedA = {};
    const adoptedB = {};
    const admissionA = { epochId: 'epoch-a' };
    const admissionB = { epochId: 'epoch-b' };

    tracker.record({ sessionId: 'session-a', adoptedTarget: adoptedA, record: admissionA });
    tracker.record({ sessionId: 'session-a', adoptedTarget: adoptedB, record: admissionB });

    expect(tracker.read({ sessionId: 'session-a', adoptedTarget: adoptedA })).toBe(admissionA);
    expect(tracker.read({ sessionId: 'session-a', adoptedTarget: adoptedB })).toBe(admissionB);
    expect(tracker.read({ sessionId: 'session-b', adoptedTarget: adoptedA })).toBeUndefined();

    tracker.delete({ sessionId: 'session-a', adoptedTarget: adoptedA });
    expect(tracker.read({ sessionId: 'session-a', adoptedTarget: adoptedA })).toBeUndefined();
    expect(tracker.read({ sessionId: 'session-a', adoptedTarget: adoptedB })).toBe(admissionB);
  });

  it('returns the method-unavailable failure when no registration grace is configured', async () => {
    const unavailable = new Error('RPC method not available');

    await expect(requestProviderInputAdmissionWhenReady({
      requestAdmission: vi.fn(async () => { throw unavailable; }),
      isMethodUnavailable: (error) => error === unavailable,
    })).rejects.toBe(unavailable);
  });

  it.each([undefined, true])('makes one probe and preserves unavailable when readiness is %s', async ready => {
    const unavailable = Object.assign(new Error('RPC method not available'), { code: 'RPC_METHOD_NOT_AVAILABLE' });
    const requestAdmission = vi.fn(async () => { throw unavailable; });
    const changes = createSessionLiveWorkProducer({ readSessions: () => [],
      readActivity: async () => ({ session: 'unknown', input: 'unknown' }) });
    await expect(requestProviderInputAdmissionWhenReady({
      requestAdmission, isMethodUnavailable: error => error === unavailable,
      readiness: { read: () => ready, subscribeChanges: listener => changes.subscribe(listener, 'retained') },
    })).rejects.toBe(unavailable);
    expect(requestAdmission).toHaveBeenCalledOnce();
  });

  it.each(['replacement', 'mutation'] as const)('refuses a target %s while parked for provider readiness', async replacement => {
    const released = new Error('provider_input_admission_target_released');
    const target = { runtimeIdentityKey: 'runtime-a', revision: 7 };
    let currentTarget = target;
    const changes = createSessionLiveWorkProducer({ readSessions: () => [],
      readActivity: async () => ({ session: 'unknown', input: 'unknown' }) });
    const unavailable = new Error('RPC method not available');
    const requestAdmission = vi.fn(async () => { throw unavailable; });
    const admission = requestProviderInputAdmissionWhenReady({
      targetFence: {
        expected: Object.freeze({ targetReference: target, runtimeIdentityKey: target.runtimeIdentityKey, revision: target.revision }),
        resolveCurrentTarget: () => currentTarget,
        createSupersededError: () => released,
      },
      requestAdmission, isMethodUnavailable: error => error === unavailable,
      readiness: { read: () => false, subscribeChanges: listener => changes.subscribe(listener, 'pending') },
    });
    const settled = expect(admission).rejects.toBe(released);
    await Promise.resolve();
    if (replacement === 'replacement') currentTarget = { ...target };
    else target.runtimeIdentityKey = 'runtime-b';
    changes.notifySessionChanged('pending');
    await settled;
    expect(requestAdmission).toHaveBeenCalledOnce();
  });

  it('rejects a final failed admission when the target changes during the request', async () => {
    const unavailable = new Error('RPC method not available');
    const released = new Error('provider_input_admission_target_released');
    const targetA = { runtimeIdentityKey: 'runtime-a', revision: 7 };
    let currentTarget: typeof targetA | null = targetA;

    await expect(requestProviderInputAdmissionWhenReady({
      targetFence: {
        expected: Object.freeze({
          targetReference: targetA,
          runtimeIdentityKey: targetA.runtimeIdentityKey,
          revision: targetA.revision,
        }),
        resolveCurrentTarget: () => currentTarget,
        createSupersededError: () => released,
      },
      requestAdmission: vi.fn(async () => {
        currentTarget = { runtimeIdentityKey: 'runtime-a', revision: 7 };
        throw unavailable;
      }),
      isMethodUnavailable: (error) => error === unavailable,
    })).rejects.toBe(released);
  });

  it('rejects a successful admission response from a target replaced during the request', async () => {
    const released = new Error('provider_input_admission_target_released');
    const targetA = { runtimeIdentityKey: 'runtime-a', revision: 7 };
    let currentTarget: typeof targetA | null = targetA;

    await expect(requestProviderInputAdmissionWhenReady({
      targetFence: {
        expected: Object.freeze({
          targetReference: targetA,
          runtimeIdentityKey: targetA.runtimeIdentityKey,
          revision: targetA.revision,
        }),
        resolveCurrentTarget: () => currentTarget,
        createSupersededError: () => released,
      },
      requestAdmission: vi.fn(async () => {
        currentTarget = { runtimeIdentityKey: 'runtime-a', revision: 7 };
        return { status: 'enforced' as const };
      }),
      isMethodUnavailable: () => false,
    })).rejects.toBe(released);
  });

  it('settles a parked readiness observer when shutdown aborts', async () => {
    const controller = new AbortController();
    const changes = createSessionLiveWorkProducer({ readSessions: () => [],
      readActivity: async () => ({ session: 'unknown', input: 'unknown' }) });
    const unavailable = new Error('RPC method not available');
    const requestAdmission = vi.fn(async () => { throw unavailable; });
    const admission = requestProviderInputAdmissionWhenReady({
      isCancelled: () => controller.signal.aborted,
      requestAdmission, isMethodUnavailable: error => error === unavailable,
      readiness: { read: () => false, subscribeChanges: listener => changes.subscribe(listener, 'pending'), signal: controller.signal },
    });
    await Promise.resolve();
    controller.abort();
    await expect(admission).resolves.toEqual({ status: 'cancelled' });
    expect(requestAdmission).toHaveBeenCalledOnce();
  });

  it('does no admission work when shutdown was already aborted', async () => {
    const requestAdmission = vi.fn(async () => undefined);

    await expect(requestProviderInputAdmissionWhenReady({
      isCancelled: () => true,
      requestAdmission,
      isMethodUnavailable: () => false,
    })).resolves.toEqual({ status: 'cancelled' });

    expect(requestAdmission).not.toHaveBeenCalled();
  });

  it('does not fetch projection or continue generation reconciliation when lifecycle is already aborted', async () => {
    const fetchAccountProfile = vi.fn(async () => undefined);
    const readMetadata = vi.fn(async () => undefined);
    const reconcileGeneration = vi.fn(async () => undefined);
    const clearDurable = vi.fn(async () => undefined);

    await expect(continueProviderInputAdmissionReconciliationAfterLifecycleFence({
      isCancelled: () => true,
      continueReconciliation: async () => {
        await fetchAccountProfile();
        await readMetadata();
        await reconcileGeneration();
        await clearDurable();
      },
    })).resolves.toEqual({ status: 'cancelled' });

    expect(fetchAccountProfile).not.toHaveBeenCalled();
    expect(readMetadata).not.toHaveBeenCalled();
    expect(reconcileGeneration).not.toHaveBeenCalled();
    expect(clearDurable).not.toHaveBeenCalled();
  });

  it('does not fetch projection when shutdown begins inside the zero-side-effect lifecycle boundary', async () => {
    let cancelled = false;
    const fetchAccountProfile = vi.fn(async () => undefined);
    const readMetadata = vi.fn(async () => undefined);
    const reconcileGeneration = vi.fn(async () => undefined);
    const clearDurable = vi.fn(async () => undefined);

    const reconciliation = continueProviderInputAdmissionReconciliationAfterLifecycleFence({
      isCancelled: () => cancelled,
      continueReconciliation: async () => {
        await fetchAccountProfile();
        await readMetadata();
        await reconcileGeneration();
        await clearDurable();
      },
    });
    cancelled = true;

    await expect(reconciliation).resolves.toEqual({ status: 'cancelled' });
    expect(fetchAccountProfile).not.toHaveBeenCalled();
    expect(readMetadata).not.toHaveBeenCalled();
    expect(reconcileGeneration).not.toHaveBeenCalled();
    expect(clearDurable).not.toHaveBeenCalled();
  });

  it('clears runner admission only after exact durable adoption clears', async () => {
    const order: string[] = [];

    await expect(clearProviderInputAdmissionAfterDurableAdoption({
      verifyAdoptionStillCurrent: vi.fn(async () => true),
      clearDurableAdoption: vi.fn(async () => {
        order.push('durable');
        return { status: 'cleared' as const };
      }),
      clearRunnerAdmission: vi.fn(async () => {
        order.push('runner');
      }),
    })).resolves.toEqual({ status: 'cleared' });
    expect(order).toEqual(['durable', 'runner']);
  });

  it('treats an exact runner clear that did not match as non-success', async () => {
    await expect(clearProviderInputAdmissionAfterDurableAdoption({
      verifyAdoptionStillCurrent: vi.fn(async () => true),
      clearDurableAdoption: vi.fn(async () => ({ status: 'cleared' as const })),
      clearRunnerAdmission: vi.fn(async () => ({ status: 'not_matched' as const })),
    })).rejects.toThrow('provider_input_admission_clear_not_matched');
  });

  it('does not clear runner admission after durable persistence fails or supersedes', async () => {
    const clearRunnerAdmission = vi.fn(async () => undefined);
    await expect(clearProviderInputAdmissionAfterDurableAdoption({
      verifyAdoptionStillCurrent: vi.fn(async () => true),
      clearDurableAdoption: vi.fn(async () => ({ status: 'superseded' as const })),
      clearRunnerAdmission,
    })).resolves.toEqual({ status: 'superseded' });
    expect(clearRunnerAdmission).not.toHaveBeenCalled();

    await expect(clearProviderInputAdmissionAfterDurableAdoption({
      verifyAdoptionStillCurrent: vi.fn(async () => true),
      clearDurableAdoption: vi.fn(async () => { throw new Error('persist failed'); }),
      clearRunnerAdmission,
    })).rejects.toThrow('persist failed');
    expect(clearRunnerAdmission).not.toHaveBeenCalled();
  });

  it('retries an outstanding exact runner clear when durable adoption was already cleared by the first attempt', async () => {
    let durablePresent = true;
    let clearAttempts = 0;
    const clearWithOutstandingReplay = clearProviderInputAdmissionAfterDurableAdoption as unknown as (
      params: Readonly<{
        verifyAdoptionStillCurrent: () => boolean | Promise<boolean>;
        clearDurableAdoption: () => Promise<Readonly<{ status: 'cleared' | 'superseded' }>>;
        hasOutstandingRunnerAdmission: () => boolean;
        clearRunnerAdmission: () => Promise<void>;
      }>,
    ) => Promise<Readonly<{ status: 'cleared' | 'superseded' }>>;
    const params = {
      verifyAdoptionStillCurrent: async () => true,
      clearDurableAdoption: async () => {
        if (!durablePresent) return { status: 'superseded' as const };
        durablePresent = false;
        return { status: 'cleared' as const };
      },
      hasOutstandingRunnerAdmission: () => clearAttempts < 2,
      clearRunnerAdmission: async () => {
        clearAttempts += 1;
        if (clearAttempts === 1) throw new Error('transient runner RPC failure');
      },
    };

    await expect(clearWithOutstandingReplay(params)).rejects.toThrow('transient runner RPC failure');
    await expect(clearWithOutstandingReplay(params)).resolves.toEqual({ status: 'cleared' });
    expect(clearAttempts).toBe(2);
  });
});
