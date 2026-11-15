import { waitForChangeOrDeadline } from '@/daemon/lifecycle/waitForChangeOrDeadline';

import { AccountEncryptionMaterialUnavailableError } from '@/api/client/encryptionKey';
import type { StoredCredentials } from '@/persistence';
import { requestSessionProviderInputAdmission } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { deferSessionRpcEncryption, type resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
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
  applicationSettled?: true;
}>;

export async function callSessionProviderInputAdmission(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  externalAction?: Parameters<typeof callSessionRpc>[0]['externalAction'];
  resolveAuthorizationHeaders?: Parameters<typeof resolveSessionTransportContext>[0]['resolveAuthorizationHeaders'];
}> & ProviderInputAdmissionRequest): Promise<Readonly<{ status: 'enforced' | 'cleared' | 'not_matched' }>> {
  const encryption = deferSessionRpcEncryption({ reason: 'session-control',
    credentials: params.credentials,
    idOrPrefix: params.sessionId,
    ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
    ...(params.externalAction?.context.signal ? { signal: params.externalAction.context.signal } : {}),
    unavailable: result => result?.code === 'encryption_material_unavailable'
      ? new AccountEncryptionMaterialUnavailableError()
      : new Error('session_provider_input_admission_transport_unavailable'),
  });
  return await requestSessionProviderInputAdmission({
    ...params,
    callRpc: async (method, request) => await callSessionRpc({
      token: params.credentials.token,
      sessionId: params.sessionId,
      ...encryption,
      method: `${params.sessionId}:${method}`,
      request,
      ...(params.externalAction ? { externalAction: params.externalAction } : {}),
      ...(params.externalAction?.context.signal ? { signal: params.externalAction.context.signal } : {}),
    }),
  });
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

export async function requestProviderInputAdmissionWhenReady<T>(params: Readonly<{
  targetFence?: ProviderInputAdmissionTargetFence;
  isCancelled?: () => boolean;
  requestAdmission: () => Promise<T>;
  isMethodUnavailable: (error: unknown) => boolean;
  readiness?: Readonly<{
    read: () => boolean | undefined;
    subscribeChanges: (listener: () => void) => () => void;
    signal?: AbortSignal;
  }>;
}>): Promise<ProviderInputAdmissionRequestOutcome<T>> {
  const readiness = params.readiness;
  let changed = false;
  let wake: (() => void) | undefined;
  const unsubscribe = readiness?.subscribeChanges(() => { changed = true; wake?.(); });
  const request = async (): Promise<ProviderInputAdmissionRequestOutcome<T>> => {
    if (readiness?.signal?.aborted || readProviderInputAdmissionLifecycleStatus(params.isCancelled) === 'cancelled') return { status: 'cancelled' };
    assertProviderInputAdmissionTargetFence(params.targetFence);
    try {
      const value = await params.requestAdmission();
      assertProviderInputAdmissionTargetFence(params.targetFence);
      return { status: 'admitted', value };
    } catch (error) {
      assertProviderInputAdmissionTargetFence(params.targetFence);
      throw error;
    }
  };
  try {
    try {
      // The effect owner is authoritative even if a delayed notification says pending.
      return await request();
    } catch (error) {
      if (!params.isMethodUnavailable(error) || readiness?.read() !== false) throw error;
    }
    while (true) {
      changed = false;
      if (readiness?.signal?.aborted || readProviderInputAdmissionLifecycleStatus(params.isCancelled) === 'cancelled') return { status: 'cancelled' };
      assertProviderInputAdmissionTargetFence(params.targetFence);
      // Only an actual producer's pending fact parks after a no-effect refusal.
      // Older runners retain the first RPC's visible, typed unavailable result.
      if (readiness?.read() !== false) break;
      if (changed) continue;
      await waitForChangeOrDeadline({ signal: readiness.signal,
        waitForChange: signal => new Promise<void>(resolve => {
          const settle = () => { wake = undefined; signal.removeEventListener('abort', settle); resolve(); };
          wake = settle;
          signal.addEventListener('abort', settle, { once: true });
          if (changed || signal.aborted) settle();
        }),
      });
    }
    return await request();
  } finally {
    unsubscribe?.();
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
