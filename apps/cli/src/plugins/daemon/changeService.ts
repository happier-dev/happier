import { randomUUID } from 'node:crypto';

import type {
  PluginChangeDecision,
  PluginChangeDecisionResult,
  PluginChangeApplyResult,
  PluginChangeListResult,
  PluginChangeRequest,
  PluginChangeRequestResult,
  PluginChangeStatusRequest,
  PluginChangeStatusResult,
  PluginChangeTerminalResult,
  PluginPendingChangeEntry,
  PreparedDaemonPluginChange,
  PreparedDaemonPluginChangeCandidate,
  PreparedDaemonPluginSourceRootApproval,
} from './changeContract';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';

type PendingPluginChange = {
  readonly id: string;
  prepared: PreparedDaemonPluginChange;
  key: string;
  readonly expiresAtMs: number;
  state: 'awaitingDecision' | 'applying';
  applyPromise: Promise<PluginChangeDecisionResult> | null;
};

type TerminalPluginChange = Readonly<{
  result: PluginChangeTerminalResult;
  expiresAtMs: number;
}>;

function isSourceRootApproval(
  prepared: PreparedDaemonPluginChange,
): prepared is PreparedDaemonPluginSourceRootApproval {
  return 'kind' in prepared && prepared.kind === 'sourceRootApprovalRequired';
}

function preparedChangeKey(prepared: PreparedDaemonPluginChange): string {
  return isSourceRootApproval(prepared)
    ? `source:${prepared.pendingKey}`
    : `plugin:${prepared.pluginId}`;
}

function preparedChangeLabel(prepared: PreparedDaemonPluginChange): string {
  return isSourceRootApproval(prepared) ? prepared.review.source.locator : prepared.pluginId;
}

type PluginChangeApplyOrBusyResult =
  | PluginChangeApplyResult
  | Readonly<{ kind: 'busy'; pluginId: string }>;

export type DaemonPluginChangeService = Readonly<{
  requestPluginChange: (request: PluginChangeRequest) => Promise<PluginChangeRequestResult>;
  decidePluginChange: (decision: PluginChangeDecision) => Promise<PluginChangeDecisionResult>;
  statusPluginChange: (request: PluginChangeStatusRequest) => Promise<PluginChangeStatusResult>;
  /** Every change still awaiting or executing a present-user decision. */
  listPendingPluginChanges: () => Promise<PluginChangeListResult>;
  shutdown: () => Promise<void>;
}>;

export type DaemonPluginChangeOwner = DaemonPluginChangeService & Readonly<{
  quiesceForHandoff: () => Promise<Readonly<{ resume: () => void }>>;
  isQuiescing: () => boolean;
  runHardRevocationCurrentnessChange: (
    pluginId: string,
    change: (control: Readonly<{ onApplied: () => void }>) => Promise<void>,
  ) => Promise<void>;
}>;

export class DaemonPluginChangePreparationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DaemonPluginChangePreparationError';
    this.code = code;
  }
}

function describePluginChangeFailureCause(error: unknown): string | undefined {
  const projected = projectPluginFailureText(error);
  return projected === 'Plugin operation failed' ? undefined : projected;
}

function failedPluginChange(
  code: string,
  error: unknown,
): Readonly<{ kind: 'failed'; code: string; message?: string }> {
  const message = describePluginChangeFailureCause(error);
  return { kind: 'failed', code, ...(message ? { message } : {}) };
}

export function createDaemonPluginChangeService(params: Readonly<{
  prepare: (request: PluginChangeRequest) => Promise<PreparedDaemonPluginChange>;
  createPendingChangeId?: () => string;
  nowMs?: () => number;
  cleanupTimeoutMs?: number;
  onCleanupFailure?: (pluginId: string, error: unknown) => void;
}>): DaemonPluginChangeOwner {
  const pendingById = new Map<string, PendingPluginChange>();
  const pendingIdByPluginId = new Map<string, string>();
  // This is intentionally an in-memory, bounded service cache rather than an
  // operation ledger. It makes an interrupted UI/CLI request observable long
  // enough to rejoin the same daemon-owned change, and disappears on restart.
  const terminalById = new Map<string, TerminalPluginChange>();
  const applyingByPluginId = new Map<string, Readonly<{
    released: Promise<void>;
    release: () => void;
  }>>();
  const activeRequestDrains = new Set<Promise<void>>();
  const nowMs = params.nowMs ?? Date.now;
  const createPendingChangeId = params.createPendingChangeId ?? randomUUID;
  const pendingLifetimeMs = 10 * 60_000;
  const maximumPendingChanges = 64;
  const cleanupTimeoutMs = Math.max(0, Math.trunc(params.cleanupTimeoutMs ?? 5_000));
  let stopped = false;
  let handoffQuiescenceHolders = 0;
  let handoffQuiescenceDrain: Promise<void> | null = null;

  const acceptsChanges = (): boolean => !stopped && handoffQuiescenceHolders === 0;

  function beginActiveRequest(): () => void {
    let resolveDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    activeRequestDrains.add(drain);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      activeRequestDrains.delete(drain);
      resolveDrain();
    };
  }

  function tryAcquireApplyExclusion(pluginId: string): Readonly<{
    released: Promise<void>;
    release: () => void;
  }> | null {
    if (applyingByPluginId.has(pluginId)) return null;
    let resolveReleased!: () => void;
    const released = new Promise<void>((resolve) => { resolveReleased = resolve; });
    let exclusive = true;
    const lease = Object.freeze({
      released,
      release: () => {
        if (!exclusive) return;
        exclusive = false;
        if (applyingByPluginId.get(pluginId) === lease) applyingByPluginId.delete(pluginId);
        resolveReleased();
      },
    });
    applyingByPluginId.set(pluginId, lease);
    return lease;
  }

  async function acquireApplyExclusion(pluginId: string): Promise<Readonly<{
    released: Promise<void>;
    release: () => void;
  }> | null> {
    while (acceptsChanges()) {
      const acquired = tryAcquireApplyExclusion(pluginId);
      if (acquired) return acquired;
      const current = applyingByPluginId.get(pluginId);
      if (current) await current.released;
    }
    return null;
  }

  async function cleanupPrepared(prepared: PreparedDaemonPluginChange): Promise<boolean> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        prepared.cleanup(),
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Plugin change '${preparedChangeLabel(prepared)}' temporary candidate cleanup timed out`));
          }, cleanupTimeoutMs);
          timeoutHandle.unref?.();
        }),
      ]);
      return true;
    } catch (error) {
      params.onCleanupFailure?.(preparedChangeLabel(prepared), error);
      return false;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  function appendCleanupPendingSurface(
    result: PluginChangeApplyOrBusyResult,
    cleanupSucceeded: boolean,
  ): PluginChangeApplyOrBusyResult {
    if (cleanupSucceeded || result.kind !== 'committed') return result;
    return Object.freeze({
      ...result,
      pendingSurfaces: Object.freeze([
        ...result.pendingSurfaces,
        'temporaryCandidateCleanup' as const,
      ]),
    });
  }

  function releasePendingChangeKey(pending: PendingPluginChange): void {
    if (pendingIdByPluginId.get(pending.key) === pending.id) {
      pendingIdByPluginId.delete(pending.key);
    }
  }

  function removePending(pending: PendingPluginChange): void {
    if (pendingById.get(pending.id) === pending) pendingById.delete(pending.id);
    releasePendingChangeKey(pending);
  }

  function retainPending(pending: PendingPluginChange): void {
    // IDs are daemon-issued UUIDs in production. Deleting a stale test/reused
    // entry keeps the current pending candidate authoritative even if a caller
    // supplies a deterministic ID factory.
    terminalById.delete(pending.id);
    pendingById.set(pending.id, pending);
    pendingIdByPluginId.set(pending.key, pending.id);
  }

  function recordTerminal(
    pending: PendingPluginChange,
    result: PluginChangeTerminalResult,
  ): void {
    terminalById.delete(pending.id);
    while (terminalById.size >= maximumPendingChanges) {
      const oldestId = terminalById.keys().next().value;
      if (typeof oldestId !== 'string') break;
      terminalById.delete(oldestId);
    }
    terminalById.set(pending.id, Object.freeze({
      result,
      expiresAtMs: nowMs() + pendingLifetimeMs,
    }));
  }

  /**
   * The one projection of a change that a present user still owes a decision
   * on. Both the by-id rejoin and the enumeration read it, so a listed change
   * and a rejoined change can never disagree about what is outstanding.
   *
   * `null` means this pending record carries no outstanding decision — a
   * candidate the daemon admitted without a review is applied by the request
   * itself and never waits for anybody.
   */
  function projectOutstandingPendingChange(
    pending: PendingPluginChange,
  ): PluginPendingChangeEntry | null {
    if (pending.state === 'applying') {
      return { kind: 'applying', pendingChangeId: pending.id };
    }
    if (isSourceRootApproval(pending.prepared)) {
      return {
        kind: 'sourceRootReviewRequired',
        pendingChangeId: pending.id,
        review: pending.prepared.review,
      };
    }
    if (pending.prepared.review) {
      return {
        kind: 'reviewRequired',
        pendingChangeId: pending.id,
        review: pending.prepared.review,
      };
    }
    return null;
  }

  async function expirePendingChanges(): Promise<void> {
    const expired = [...pendingById.values()].filter((pending) => (
      pending.state === 'awaitingDecision' && pending.expiresAtMs <= nowMs()
    ));
    for (const pending of expired) {
      removePending(pending);
      // Expiry is bookkeeping for a different request. Cleanup is bounded and
      // diagnostic, but must never hold unrelated plugin preparation hostage.
      void cleanupPrepared(pending.prepared);
    }
    for (const [id, terminal] of terminalById) {
      if (terminal.expiresAtMs <= nowMs()) terminalById.delete(id);
    }
  }

  async function tryApply(
    prepared: PreparedDaemonPluginChangeCandidate,
    decision?: Extract<PluginChangeDecision, { decision: 'installAndTrust' }>,
  ): Promise<PluginChangeApplyOrBusyResult> {
    const lease = tryAcquireApplyExclusion(prepared.pluginId);
    if (!lease) {
      return { kind: 'busy', pluginId: prepared.pluginId };
    }
    try {
      return await prepared.apply(decision ? {
        actorEvidence: decision.actorEvidence,
        optionalSelections: decision.optionalSelections ?? [],
      } : undefined, { onApplied: lease.release });
    } catch (error) {
      return failedPluginChange(
        error instanceof DaemonPluginChangePreparationError
          ? error.code
          : 'plugin_change_failed',
        error,
      );
    } finally {
      lease.release();
    }
  }

  return Object.freeze({
    async requestPluginChange(request) {
      if (!acceptsChanges()) return { kind: 'unavailable', code: 'daemon_shutting_down' };
      const finishActiveRequest = beginActiveRequest();
      try {
        await expirePendingChanges();
        if (!acceptsChanges()) return { kind: 'unavailable', code: 'daemon_shutting_down' };
        const pendingConfirmationCount = [...pendingById.values()].filter((pending) => (
          pending.state === 'awaitingDecision'
        )).length;
        if (pendingConfirmationCount + activeRequestDrains.size > maximumPendingChanges) {
          return { kind: 'unavailable', code: 'pending_confirmation_capacity' };
        }

        let prepared: PreparedDaemonPluginChange;
        try {
          prepared = await params.prepare(request);
        } catch (error) {
          return failedPluginChange(
            error instanceof DaemonPluginChangePreparationError
              ? error.code
              : 'plugin_change_preparation_failed',
            error,
          );
        }

        if (!acceptsChanges()) {
          await cleanupPrepared(prepared);
          return { kind: 'unavailable', code: 'daemon_shutting_down' };
        }
        const key = preparedChangeKey(prepared);
        if (
          pendingIdByPluginId.has(key)
          || (!isSourceRootApproval(prepared) && applyingByPluginId.has(prepared.pluginId))
        ) {
          await cleanupPrepared(prepared);
          return isSourceRootApproval(prepared)
            ? { kind: 'unavailable', code: 'plugin_source_root_busy' }
            : { kind: 'busy', pluginId: prepared.pluginId };
        }
        if (isSourceRootApproval(prepared)) {
          const id = createPendingChangeId();
          const pending: PendingPluginChange = {
            id,
            prepared,
            key,
            expiresAtMs: nowMs() + pendingLifetimeMs,
            state: 'awaitingDecision',
            applyPromise: null,
          };
          retainPending(pending);
          return {
            kind: 'sourceRootReviewRequired',
            pendingChangeId: id,
            review: prepared.review,
          };
        }
        if (prepared.requiresReview === false) {
          const result = await tryApply(prepared);
          return appendCleanupPendingSurface(result, await cleanupPrepared(prepared));
        }

        if (!prepared.review) {
          await cleanupPrepared(prepared);
          return { kind: 'failed', code: 'plugin_change_review_missing' };
        }

        const id = createPendingChangeId();
        const pending: PendingPluginChange = {
          id,
          prepared,
          key,
          expiresAtMs: nowMs() + pendingLifetimeMs,
          state: 'awaitingDecision',
          applyPromise: null,
        };
        retainPending(pending);
        return {
          kind: 'reviewRequired',
          pendingChangeId: id,
          review: prepared.review,
        };
      } finally {
        finishActiveRequest();
      }
    },

    async decidePluginChange(decision) {
      await expirePendingChanges();
      const pending = pendingById.get(decision.pendingChangeId);
      if (!pending) return { kind: 'expired' };
      if (pending.state === 'applying') {
        return await pending.applyPromise!;
      }
      if (decision.decision === 'cancel') {
        removePending(pending);
        const result = { kind: 'cancelled' } as const;
        recordTerminal(pending, result);
        await cleanupPrepared(pending.prepared);
        return result;
      }

      if (decision.decision === 'trustSourceRoot') {
        if (!isSourceRootApproval(pending.prepared)) {
          return { kind: 'failed', code: 'plugin_source_review_not_pending' };
        }
        const sourceApproval = pending.prepared;
        pending.state = 'applying';
        pending.applyPromise = (async () => {
          let prepared: PreparedDaemonPluginChangeCandidate;
          try {
            prepared = await sourceApproval.continueAfterSourceRootApproval(
              decision.actorEvidence,
            );
          } catch (error) {
            const result = failedPluginChange(
              error instanceof DaemonPluginChangePreparationError
                ? error.code
                : 'plugin_change_preparation_failed',
              error,
            );
            releasePendingChangeKey(pending);
            await cleanupPrepared(sourceApproval);
            removePending(pending);
            recordTerminal(pending, result);
            return result;
          }
          await cleanupPrepared(sourceApproval);
          const nextKey = preparedChangeKey(prepared);
          const occupiedPendingId = pendingIdByPluginId.get(nextKey);
          if (
            (occupiedPendingId && occupiedPendingId !== pending.id)
            || applyingByPluginId.has(prepared.pluginId)
          ) {
            const result = { kind: 'busy' as const, pluginId: prepared.pluginId };
            releasePendingChangeKey(pending);
            await cleanupPrepared(prepared);
            removePending(pending);
            recordTerminal(pending, result);
            return result;
          }
          if (pendingIdByPluginId.get(pending.key) === pending.id) {
            pendingIdByPluginId.delete(pending.key);
          }
          pending.prepared = prepared;
          pending.key = nextKey;
          pendingIdByPluginId.set(nextKey, pending.id);
          if (prepared.requiresReview === false) {
            pending.state = 'applying';
            releasePendingChangeKey(pending);
            pending.applyPromise = (async () => {
              const result = await tryApply(prepared);
              const settled = appendCleanupPendingSurface(result, await cleanupPrepared(prepared));
              removePending(pending);
              recordTerminal(pending, settled);
              return settled;
            })();
            return await pending.applyPromise;
          }
          if (!prepared.review) {
            pending.state = 'applying';
            const result = { kind: 'failed' as const, code: 'plugin_change_review_missing' };
            releasePendingChangeKey(pending);
            await cleanupPrepared(prepared);
            removePending(pending);
            recordTerminal(pending, result);
            return result;
          }
          pending.state = 'awaitingDecision';
          pending.applyPromise = null;
          return {
            kind: 'reviewRequired' as const,
            pendingChangeId: pending.id,
            review: prepared.review,
          };
        })();
        return await pending.applyPromise;
      }

      if (isSourceRootApproval(pending.prepared)) {
        return { kind: 'failed', code: 'plugin_source_trust_required' };
      }
      const prepared = pending.prepared;

      pending.state = 'applying';
      pending.applyPromise = (async () => {
        const result = await tryApply(prepared, decision);
        releasePendingChangeKey(pending);
        const settled = appendCleanupPendingSurface(result, await cleanupPrepared(prepared));
        removePending(pending);
        recordTerminal(pending, settled);
        return settled;
      })();
      return await pending.applyPromise;
    },

    async statusPluginChange(request) {
      if (!acceptsChanges()) return { kind: 'daemonUnavailable' };
      await expirePendingChanges();
      if (!acceptsChanges()) return { kind: 'daemonUnavailable' };
      const pending = pendingById.get(request.pendingChangeId);
      if (pending) {
        const outstanding = projectOutstandingPendingChange(pending);
        if (outstanding) return outstanding;
      }
      const terminal = terminalById.get(request.pendingChangeId);
      if (terminal) {
        return {
          kind: 'terminal',
          pendingChangeId: request.pendingChangeId,
          result: terminal.result,
        };
      }
      return { kind: 'expired' };
    },

    /**
     * Enumerates the outstanding decisions this daemon still holds.
     *
     * A stopped or quiescing daemon reports none rather than a stale snapshot:
     * pending changes are in-memory and daemon-lifetime, so there is nothing a
     * successor could honour.
     */
    async listPendingPluginChanges() {
      if (!acceptsChanges()) return { changes: [] };
      await expirePendingChanges();
      if (!acceptsChanges()) return { changes: [] };
      return {
        changes: [...pendingById.values()].flatMap((pending) => {
          const outstanding = projectOutstandingPendingChange(pending);
          return outstanding ? [outstanding] : [];
        }),
      };
    },

    async runHardRevocationCurrentnessChange(pluginId, change) {
      const lease = await acquireApplyExclusion(pluginId);
      if (!lease) return;
      try {
        await change({ onApplied: lease.release });
      } finally {
        lease.release();
      }
    },

    async quiesceForHandoff() {
      handoffQuiescenceHolders += 1;
      if (!handoffQuiescenceDrain) {
        const awaiting = [...pendingById.values()].filter((pending) => pending.state === 'awaitingDecision');
        for (const pending of awaiting) removePending(pending);
        const applyingAtHandoff = [...applyingByPluginId.values()];
        const activeRequestsAtHandoff = [...activeRequestDrains];
        handoffQuiescenceDrain = (async () => {
          await Promise.all([
            ...awaiting.map(async (pending) => await cleanupPrepared(pending.prepared)),
            ...applyingAtHandoff.map(async (lease) => await lease.released),
            ...activeRequestsAtHandoff,
          ]);
        })();
      }
      await handoffQuiescenceDrain;

      let resumed = false;
      return Object.freeze({
        resume: () => {
          if (resumed) return;
          resumed = true;
          handoffQuiescenceHolders = Math.max(0, handoffQuiescenceHolders - 1);
          if (handoffQuiescenceHolders === 0) handoffQuiescenceDrain = null;
        },
      });
    },

    isQuiescing() {
      return handoffQuiescenceHolders > 0;
    },

    async shutdown() {
      if (stopped) return;
      stopped = true;
      const awaiting = [...pendingById.values()].filter((pending) => pending.state === 'awaitingDecision');
      for (const pending of awaiting) removePending(pending);
      await Promise.all([
        ...awaiting.map(async (pending) => await cleanupPrepared(pending.prepared)),
        ...[...pendingById.values()].flatMap((pending) => (
          pending.applyPromise ? [pending.applyPromise.then(() => undefined)] : []
        )),
        ...[...applyingByPluginId.values()].map(async (lease) => await lease.released),
        ...activeRequestDrains,
      ]);
      terminalById.clear();
    },
  });
}
