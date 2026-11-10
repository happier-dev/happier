import { setTimeout, clearTimeout } from 'node:timers';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol';
import type { QualifiedConnectedAccountEstablishedInvocationBasis } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import type { ScheduledQualifiedAccountHealth } from '../refresh/ConnectedServiceRefreshCoordinator';
import type { QualifiedConnectedAccountQuotaRuntime } from './ConnectedServiceQuotasCoordinator';
import { logger } from '@/ui/logger';

type InvocationBasis = Pick<QualifiedConnectedAccountEstablishedInvocationBasis,
  'credentialRevision' | 'credentialConfigurationRevision' | 'isCurrent'>;

/** Qualified quota acquisition and one unauthorized recovery, sharing the incumbent budget. */
export async function invokeQuota(input: Readonly<{
  runtime: QualifiedConnectedAccountQuotaRuntime['establishedRuntimeOwner'];
  profile: QualifiedConnectedAccountProfileV4;
  signal?: AbortSignal;
  cancellationSignal?: AbortSignal;
  expectedCredentialRevision?: string;
  fetchTimeoutMs: number | null;
  scheduledHealth?: Readonly<{ work: ScheduledQualifiedAccountHealth; dispatched(): void }>;
  beforeInvoke(basis: InvocationBasis, signal?: AbortSignal): Promise<void>;
  recoverUnauthorized?(signal?: AbortSignal): Promise<boolean>;
  assertProviderCallAllowed(): void;
  onTimeout(): void;
}>) {
  // The caller supplies its incumbent acquisition budget; a containing probe can omit it.
  const fetchTimeoutMs = input.fetchTimeoutMs;
  const controller = fetchTimeoutMs === null ? null : new AbortController();
  const signal = input.signal && controller
    ? AbortSignal.any([input.signal, controller.signal])
    : input.signal ?? controller?.signal;
  const timeoutHandle = fetchTimeoutMs === null ? undefined : setTimeout(() => {
    controller?.abort(new Error('Connected-service quota fetch timed out'));
    input.onTimeout();
  }, fetchTimeoutMs);
  timeoutHandle?.unref?.();
  let abortListener: (() => void) | undefined;
  let pendingInvocation: Promise<unknown> | undefined;
  try {
    signal?.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      abortListener = () => reject(signal.reason ?? new Error('Connected-service quota fetch was aborted'));
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    const quota = {
      expectedCredentialRevision: input.expectedCredentialRevision,
      assertProviderCallAllowed: input.assertProviderCallAllowed,
      signal,
      beforeInvoke: async (basis: InvocationBasis) => {
        signal?.throwIfAborted();
        await input.beforeInvoke(basis, signal);
        signal?.throwIfAborted();
      },
    };
    const initial = input.scheduledHealth ? (async () => {
      input.scheduledHealth!.dispatched();
      const receipts = await input.runtime.invokeScheduledWithReceipts({
        account: input.profile.ref, status: { signal },
        quota, signal,
      });
      signal?.throwIfAborted();
      if (receipts.status) {
        try { await input.scheduledHealth!.work.settle(receipts.status, signal); }
        catch { signal?.throwIfAborted(); logger.warn('[DAEMON RUN] Qualified Connected Account health deadline failed'); }
      }
      if (!receipts.quota) throw new Error('Scheduled quota invocation did not return its receipt');
      if (receipts.quota.status === 'rejected') throw receipts.quota.reason;
      return receipts.quota.value;
    })() : input.runtime.invokeWithReceipt({ account: input.profile.ref,
      operation: { kind: 'quota' as const }, ...quota });
    const pending = (async () => {
      try {
        return await initial;
      } catch (error) {
        signal?.throwIfAborted();
        if (error !== null && typeof error === 'object' && 'status' in error && error.status === 401
          && input.recoverUnauthorized && await input.recoverUnauthorized(signal)) {
          signal?.throwIfAborted();
          // One replay uses the coordinator's settled credential, within this acquisition's budget.
          return input.runtime.invokeWithReceipt({ account: input.profile.ref,
            operation: { kind: 'quota' as const }, ...quota, expectedCredentialRevision: undefined });
        }
        throw error;
      }
    })();
    pendingInvocation = pending;
    // Loop cancellation must settle the underlying invocation before Stop resolves.
    const invocation = await (signal ? Promise.race([pending, aborted]) : pending);
    signal?.throwIfAborted();
    return invocation;
  } catch (error) {
    if (input.cancellationSignal?.aborted) {
      await pendingInvocation?.catch(() => {});
      input.cancellationSignal.throwIfAborted();
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    if (abortListener) signal?.removeEventListener('abort', abortListener);
  }
}
