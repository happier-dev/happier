import type { createAccountSessionFollowRuleCache } from '@/agent/runtime/session/follow/accountSessionFollowRuleCache';
import { logger } from '@/ui/logger';
import type { AdmittedRequesterSessionBootstrap } from './requesterSessionCredentials';

type Reconcile = (sourceSessionId: string | null) => Promise<void>;

/** Reuses the captured Account feed and the daemon's bound receiver recovery. */
export function createRequesterSessionFollowSourceReconciliation(input: Readonly<{
  bootstrap: Pick<AdmittedRequesterSessionBootstrap, 'subscribeSessionFollowSources' | 'getBoundSessionId'>;
  sessionFollowRuleCache: ReturnType<typeof createAccountSessionFollowRuleCache>;
  receiverRecovery?: Readonly<{ machineId: string; installationId: string }>;
  isCurrent?: () => Promise<boolean>;
}>) {
  let disposed = false;
  type Recovery = { sourceSessionIds: Set<string> | null };
  let binding: { reconcile: Reconcile; signal: AbortSignal; running: boolean; pending: Recovery | null } | null = null;
  const release = input.bootstrap.subscribeSessionFollowSources((sourceSessionId, receiver, availabilityChanged, sourceChanged) => {
    const captured = binding;
    if (!captured || captured.signal.aborted || disposed) return;
    const destinationSessionId = input.bootstrap.getBoundSessionId();
    if (!destinationSessionId) return;
    const ownAvailability = !receiver && sourceSessionId === destinationSessionId;
    if (sourceChanged === false && !receiver && !ownAvailability) return;
    if (ownAvailability && (availabilityChanged === false
      || !input.sessionFollowRuleCache.originalWork.hasHeldReceiver(destinationSessionId))) return;
    if (receiver && sourceSessionId !== destinationSessionId) return;
    // Apply a notification once, before any awaited work. A captured feed owns
    // this operation when present; replaying it after an admission starts would
    // turn the same availability push into a second release.
    input.sessionFollowRuleCache.observeSourceChange(sourceSessionId, receiver, availabilityChanged, sourceChanged);
    const source = receiver || ownAvailability ? null : sourceSessionId;
    const previous = captured.pending;
    captured.pending = { sourceSessionIds: source === null || previous?.sourceSessionIds === null
      ? null : new Set([...(previous?.sourceSessionIds ?? []), source]) };
    if (captured.running) return;
    captured.running = true;
    void (async () => {
      try {
        // Receiver progress and reconnects remain receiver-wide. Only unrelated
        // source hints require private-rule demand. Preserve their exact source
        // identities when merging; only a receiver/gap hint demands a broad pass.
        while (captured === binding && !captured.signal.aborted && !disposed && captured.pending) {
          const request = captured.pending;
          captured.pending = null;
          for (const sourceSessionId of request.sourceSessionIds ?? [null]) {
            try {
              if (sourceSessionId !== null
                && !await input.sessionFollowRuleCache.hasEnabledSessionReceiver(destinationSessionId)) continue;
              if (input.isCurrent && !await input.isCurrent()) return;
              if (captured !== binding || captured.signal.aborted || disposed) return;
              await captured.reconcile(sourceSessionId);
            } catch { if (!disposed) logger.warn('[Session Follow] Requester source recovery remains pending'); }
          }
        }
      } finally { captured.running = false; }
    })();
  }, input.receiverRecovery ? { ...input.receiverRecovery, getBoundSessionId: input.bootstrap.getBoundSessionId } : undefined);
  return {
    bind: (reconcile: Reconcile, signal: AbortSignal) => {
      if (!disposed && !signal.aborted && binding?.signal !== signal) binding = { reconcile, signal, running: false, pending: null };
    },
    dispose: () => { disposed = true; binding = null; release(); },
  };
}
