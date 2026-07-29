import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import type { Credentials } from '@/persistence';
import { requestSessionProviderInputAdmission } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';

export type ProviderInputAdmissionRequest = Readonly<{
  action: 'enforce';
  serviceId: string;
  groupId: string;
  reason?: 'group_unavailable' | 'generation_pending';
  epochId?: string;
}> | Readonly<{
  action: 'clear';
  serviceId: string;
  groupId: string;
  epochId?: string;
}>;

export async function callSessionProviderInputAdmission(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
}> & ProviderInputAdmissionRequest): Promise<Readonly<{ status: 'enforced' | 'cleared' | 'not_matched' }>> {
  const transport = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.sessionId,
  });
  if (!transport.ok) {
    throw new Error('session_provider_input_admission_transport_unavailable');
  }
  return await requestSessionProviderInputAdmission({
    ...params,
    callRpc: async (method, request) => await callSessionRpc({
      token: params.credentials.token,
      sessionId: transport.sessionId,
      ctx: transport.ctx,
      mode: transport.mode,
      method: `${transport.sessionId}:${method}`,
      request,
    }),
  });
}

export async function waitForProviderInputAdmissionGrace(
  delayMs: number,
  abortSignal: AbortSignal,
): Promise<'continue' | 'cancelled'> {
  if (abortSignal.aborted) return 'cancelled';
  try {
    await setTimeoutPromise(Math.max(0, delayMs), undefined, {
      signal: abortSignal,
      ref: false,
    });
    return abortSignal.aborted ? 'cancelled' : 'continue';
  } catch (error) {
    if (abortSignal.aborted) return 'cancelled';
    throw error;
  }
}

export type ProviderInputAdmissionRequestOutcome<T> =
  | Readonly<{ status: 'admitted'; value: T }>
  | Readonly<{ status: 'cancelled' }>;

export function createProviderInputAdmissionRecordTracker<TRecord>(): Readonly<{
  record(input: Readonly<{ sessionId: string; adoptedTarget: object; record: TRecord }>): void;
  read(input: Readonly<{ sessionId: string; adoptedTarget: object }>): TRecord | undefined;
  delete(input: Readonly<{ sessionId: string; adoptedTarget: object }>): void;
}> {
  const recordsByAdoptedTarget = new WeakMap<object, Map<string, TRecord>>();
  return {
    record: ({ sessionId, adoptedTarget, record }) => {
      const existing = recordsByAdoptedTarget.get(adoptedTarget);
      if (existing) {
        existing.set(sessionId, record);
        return;
      }
      recordsByAdoptedTarget.set(adoptedTarget, new Map([[sessionId, record]]));
    },
    read: ({ sessionId, adoptedTarget }) => recordsByAdoptedTarget.get(adoptedTarget)?.get(sessionId),
    delete: ({ sessionId, adoptedTarget }) => {
      const existing = recordsByAdoptedTarget.get(adoptedTarget);
      if (!existing) return;
      existing.delete(sessionId);
      if (existing.size === 0) recordsByAdoptedTarget.delete(adoptedTarget);
    },
  };
}

type ProviderInputAdmissionTargetFence = Readonly<{
  expected: Readonly<{
    targetReference: object;
    runtimeIdentityKey: string;
    revision: number;
  }>;
  resolveCurrentTarget: () => Readonly<{ runtimeIdentityKey: string; revision: number }> | null;
  createSupersededError: () => Error;
}>;

function assertProviderInputAdmissionTargetFence(fence: ProviderInputAdmissionTargetFence | undefined): void {
  if (!fence) return;
  const current = fence.resolveCurrentTarget();
  if (
    current !== fence.expected.targetReference
    || current.runtimeIdentityKey !== fence.expected.runtimeIdentityKey
    || current.revision !== fence.expected.revision
  ) {
    throw fence.createSupersededError();
  }
}

function readProviderInputAdmissionLifecycleStatus(
  isCancelled: (() => boolean) | undefined,
): 'active' | 'cancelled' {
  return isCancelled?.() ? 'cancelled' : 'active';
}

export async function requestProviderInputAdmissionWithBoundedRetry<T>(params: Readonly<{
  targetFence?: ProviderInputAdmissionTargetFence;
  isCancelled?: () => boolean;
  requestAdmission: () => Promise<T>;
  isMethodUnavailable: (error: unknown) => boolean;
  methodUnavailableRetry?: Readonly<{
    maxAttempts: number;
    waitBeforeRetry: () => Promise<'continue' | 'cancelled'>;
  }>;
}>): Promise<ProviderInputAdmissionRequestOutcome<T>> {
  let retryAttempts = 0;
  while (true) {
    if (readProviderInputAdmissionLifecycleStatus(params.isCancelled) === 'cancelled') return { status: 'cancelled' };
    assertProviderInputAdmissionTargetFence(params.targetFence);
    try {
      const value = await params.requestAdmission();
      assertProviderInputAdmissionTargetFence(params.targetFence);
      return { status: 'admitted', value };
    } catch (error) {
      assertProviderInputAdmissionTargetFence(params.targetFence);
      if (!params.isMethodUnavailable(error)) throw error;
      const retry = params.methodUnavailableRetry;
      if (retry && retryAttempts < retry.maxAttempts) {
        if (readProviderInputAdmissionLifecycleStatus(params.isCancelled) === 'cancelled') return { status: 'cancelled' };
        retryAttempts += 1;
        if (await retry.waitBeforeRetry() === 'cancelled') return { status: 'cancelled' };
        continue;
      }
      throw error;
    }
  }
}

export async function continueProviderInputAdmissionReconciliationAfterLifecycleFence<TContinuation>(params: Readonly<{
  isCancelled: () => boolean;
  continueReconciliation: () => Promise<TContinuation>;
}>): Promise<Readonly<{ status: 'continued'; value: TContinuation }> | Readonly<{ status: 'cancelled' }>> {
  if (readProviderInputAdmissionLifecycleStatus(params.isCancelled) === 'cancelled') {
    return { status: 'cancelled' };
  }
  // Yield once without I/O so a shutdown already queued for this turn wins before projection fetch.
  await Promise.resolve();
  if (readProviderInputAdmissionLifecycleStatus(params.isCancelled) === 'cancelled') {
    return { status: 'cancelled' };
  }
  return { status: 'continued', value: await params.continueReconciliation() };
}

export async function clearProviderInputAdmissionAfterDurableAdoption(params: Readonly<{
  verifyAdoptionStillCurrent: () => boolean | Promise<boolean>;
  clearDurableAdoption: () => Promise<Readonly<{ status: 'cleared' | 'superseded' }>>;
  /**
   * Durable adoption may have committed before a runner-RPC failure. On a later
   * replay that durable clear reports superseded, but its exact admission still
   * needs releasing while the current-target fence holds.
   */
  hasOutstandingRunnerAdmission?: () => boolean;
  clearRunnerAdmission: () => Promise<void | Readonly<{ status: 'cleared' | 'not_matched' }>>;
}>): Promise<Readonly<{ status: 'cleared' | 'superseded' }>> {
  if (!await params.verifyAdoptionStillCurrent()) {
    return { status: 'superseded' };
  }
  const durable = await params.clearDurableAdoption();
  if (durable.status !== 'cleared' && !params.hasOutstandingRunnerAdmission?.()) {
    return durable;
  }
  const runner = await params.clearRunnerAdmission();
  if (runner?.status === 'not_matched') {
    throw new Error('provider_input_admission_clear_not_matched');
  }
  return durable.status === 'cleared' ? durable : { status: 'cleared' };
}
