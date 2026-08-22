import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import {
  callSessionProviderInputAdmission,
  clearProviderInputAdmissionAfterDurableAdoption,
  continueProviderInputAdmissionReconciliationAfterLifecycleFence,
  createProviderInputAdmissionRecordTracker,
  requestProviderInputAdmissionWithBoundedRetry,
  waitForProviderInputAdmissionGrace,
} from './providerInputAdmissionRuntime';

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc: vi.fn(),
}));

describe('provider input admission daemon composition', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(callSessionRpc).mockReset();
  });

  it('admits provider input for a plain Session with token-only credentials', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 'session-plain-123',
          encryptionMode: 'plain',
          metadata: '{}',
          dataEncryptionKey: null,
        }),
      },
    } as never);
    vi.mocked(callSessionRpc).mockResolvedValueOnce({ status: 'enforced' });

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

    expect(get).toHaveBeenCalledTimes(1);
    expect(callSessionRpc).toHaveBeenCalledWith({
      token: 'token-only',
      sessionId: 'session-plain-123',
      ctx: null,
      mode: 'plain',
      method: 'session-plain-123:session.providerInput.admission',
      request: {
        action: 'enforce',
        serviceId: 'openai-codex',
        groupId: 'group-1',
        reason: 'group_unavailable',
      },
    });
  });

  it('preserves typed material-unavailable failure for a retained E2EE Session', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 'session-e2ee-123',
          encryptionMode: 'e2ee',
          metadata: 'retained-ciphertext',
          dataEncryptionKey: 'retained-data-key-envelope',
        }),
      },
    } as never);

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
    expect(callSessionRpc).not.toHaveBeenCalled();
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

    await expect(requestProviderInputAdmissionWithBoundedRetry({
      requestAdmission: vi.fn(async () => { throw unavailable; }),
      isMethodUnavailable: (error) => error === unavailable,
    })).rejects.toBe(unavailable);
  });

  it('waits for a fresh runner to register provider-input admission within the bounded grace', async () => {
    const unavailable = new Error('RPC method not available');
    let requests = 0;
    const requestAdmission = vi.fn(async () => {
      requests += 1;
      if (requests < 3) throw unavailable;
    });
    const waitBeforeRetry = vi.fn(async () => 'continue' as const);

    await expect(requestProviderInputAdmissionWithBoundedRetry({
      requestAdmission,
      isMethodUnavailable: (error) => error === unavailable,
      methodUnavailableRetry: {
        maxAttempts: 2,
        waitBeforeRetry,
      },
    })).resolves.toEqual({ status: 'admitted', value: undefined });
    expect(requestAdmission).toHaveBeenCalledTimes(3);
    expect(waitBeforeRetry).toHaveBeenCalledTimes(2);
  });

  it('returns method-unavailable after bounded registration grace is exhausted', async () => {
    const unavailable = new Error('RPC method not available');
    const requestAdmission = vi.fn(async () => { throw unavailable; });
    const waitBeforeRetry = vi.fn(async () => 'continue' as const);

    await expect(requestProviderInputAdmissionWithBoundedRetry({
      requestAdmission,
      isMethodUnavailable: (error) => error === unavailable,
      methodUnavailableRetry: {
        maxAttempts: 2,
        waitBeforeRetry,
      },
    })).rejects.toBe(unavailable);
    expect(requestAdmission).toHaveBeenCalledTimes(3);
    expect(waitBeforeRetry).toHaveBeenCalledTimes(2);
  });

  it('fails fast without waiting for a non-method admission error', async () => {
    const transportFailure = new Error('session_provider_input_admission_transport_unavailable');
    const waitBeforeRetry = vi.fn(async () => 'continue' as const);

    await expect(requestProviderInputAdmissionWithBoundedRetry({
      requestAdmission: vi.fn(async () => { throw transportFailure; }),
      isMethodUnavailable: () => false,
      methodUnavailableRetry: {
        maxAttempts: 2,
        waitBeforeRetry,
      },
    })).rejects.toBe(transportFailure);

    expect(waitBeforeRetry).not.toHaveBeenCalled();
  });

  it('rechecks exact target identity before retrying admission against a replacement runner', async () => {
    const unavailable = new Error('RPC method not available');
    const released = new Error('provider_input_admission_target_released');
    const targetA = { runtimeIdentityKey: 'runtime-a', revision: 7 };
    let currentTarget: typeof targetA | null = targetA;
    const requestAdmission = vi.fn(async () => { throw unavailable; });

    await expect(requestProviderInputAdmissionWithBoundedRetry({
      targetFence: {
        expected: Object.freeze({
          targetReference: targetA,
          runtimeIdentityKey: targetA.runtimeIdentityKey,
          revision: targetA.revision,
        }),
        resolveCurrentTarget: () => currentTarget,
        createSupersededError: () => released,
      },
      requestAdmission,
      isMethodUnavailable: (error) => error === unavailable,
      methodUnavailableRetry: {
        maxAttempts: 2,
        waitBeforeRetry: async () => {
          currentTarget = { runtimeIdentityKey: 'runtime-a', revision: 7 };
          return 'continue';
        },
      },
    })).rejects.toBe(released);
    expect(requestAdmission).toHaveBeenCalledTimes(1);
  });

  it('rejects a final failed admission when the target changes during the request', async () => {
    const unavailable = new Error('RPC method not available');
    const released = new Error('provider_input_admission_target_released');
    const targetA = { runtimeIdentityKey: 'runtime-a', revision: 7 };
    let currentTarget: typeof targetA | null = targetA;

    await expect(requestProviderInputAdmissionWithBoundedRetry({
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

    await expect(requestProviderInputAdmissionWithBoundedRetry({
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

  it('does not retry when the same target object mutates its captured runtime key during grace', async () => {
    const unavailable = new Error('RPC method not available');
    const released = new Error('provider_input_admission_target_released');
    const target = { runtimeIdentityKey: 'runtime-a', revision: 7 };
    const requestAdmission = vi.fn(async () => { throw unavailable; });

    await expect(requestProviderInputAdmissionWithBoundedRetry({
      targetFence: {
        expected: Object.freeze({
          targetReference: target,
          runtimeIdentityKey: target.runtimeIdentityKey,
          revision: target.revision,
        }),
        resolveCurrentTarget: () => target,
        createSupersededError: () => released,
      },
      requestAdmission,
      isMethodUnavailable: (error) => error === unavailable,
      methodUnavailableRetry: {
        maxAttempts: 1,
        waitBeforeRetry: async () => {
          target.runtimeIdentityKey = 'runtime-mutated';
          return 'continue';
        },
      },
    })).rejects.toBe(released);

    expect(requestAdmission).toHaveBeenCalledTimes(1);
  });

  it('settles without retry when shutdown aborts the grace wait', async () => {
    const unavailable = new Error('RPC method not available');
    const abortController = new AbortController();
    const requestAdmission = vi.fn(async () => { throw unavailable; });

    const reconciliation = requestProviderInputAdmissionWithBoundedRetry({
      isCancelled: () => abortController.signal.aborted,
      requestAdmission,
      isMethodUnavailable: (error) => error === unavailable,
      methodUnavailableRetry: {
        maxAttempts: 1,
        waitBeforeRetry: async () => await waitForProviderInputAdmissionGrace(60_000, abortController.signal),
      },
    });
    await Promise.resolve();
    abortController.abort();

    await expect(reconciliation).resolves.toEqual({ status: 'cancelled' });
    expect(requestAdmission).toHaveBeenCalledTimes(1);
  });

  it('does no admission work when shutdown was already aborted', async () => {
    const requestAdmission = vi.fn(async () => undefined);

    await expect(requestProviderInputAdmissionWithBoundedRetry({
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
