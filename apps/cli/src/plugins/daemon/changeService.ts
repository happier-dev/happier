import { randomUUID } from 'node:crypto';

import type {
  PluginChangeDecision,
  PluginChangeDecisionResult,
  PluginChangeApplyResult,
  PluginChangeRequest,
  PluginChangeRequestResult,
  PreparedDaemonPluginChange,
} from './changeContract';

type PendingPluginChange = {
  readonly id: string;
  readonly prepared: PreparedDaemonPluginChange;
  readonly expiresAtMs: number;
  state: 'awaitingDecision' | 'applying';
  applyPromise: Promise<PluginChangeDecisionResult> | null;
};

type PluginChangeApplyOrBusyResult =
  | PluginChangeApplyResult
  | Readonly<{ kind: 'busy'; pluginId: string }>;

export type DaemonPluginChangeService = Readonly<{
  requestPluginChange: (request: PluginChangeRequest) => Promise<PluginChangeRequestResult>;
  decidePluginChange: (decision: PluginChangeDecision) => Promise<PluginChangeDecisionResult>;
  shutdown: () => Promise<void>;
}>;

export type DaemonPluginChangeOwner = DaemonPluginChangeService & Readonly<{
  quiesceForHandoff: () => Promise<Readonly<{ resume: () => void }>>;
  isQuiescing: () => boolean;
  runAutomaticCurrentnessChange: (
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

export function createDaemonPluginChangeService(params: Readonly<{
  prepare: (request: PluginChangeRequest) => Promise<PreparedDaemonPluginChange>;
  createPendingChangeId?: () => string;
  nowMs?: () => number;
  cleanupTimeoutMs?: number;
  onCleanupFailure?: (pluginId: string, error: unknown) => void;
}>): DaemonPluginChangeOwner {
  const pendingById = new Map<string, PendingPluginChange>();
  const pendingIdByPluginId = new Map<string, string>();
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
            reject(new Error(`Plugin '${prepared.pluginId}' temporary candidate cleanup timed out`));
          }, cleanupTimeoutMs);
          timeoutHandle.unref?.();
        }),
      ]);
      return true;
    } catch (error) {
      params.onCleanupFailure?.(prepared.pluginId, error);
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

  function removePending(pending: PendingPluginChange): void {
    if (pendingById.get(pending.id) === pending) pendingById.delete(pending.id);
    if (pendingIdByPluginId.get(pending.prepared.pluginId) === pending.id) {
      pendingIdByPluginId.delete(pending.prepared.pluginId);
    }
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
  }

  async function tryApply(
    prepared: PreparedDaemonPluginChange,
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
      return {
        kind: 'failed',
        code: 'plugin_change_failed',
        message: error instanceof Error ? error.message : String(error),
      };
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
        if (pendingById.size + activeRequestDrains.size > maximumPendingChanges) {
          return { kind: 'unavailable', code: 'pending_confirmation_capacity' };
        }

        let prepared: PreparedDaemonPluginChange;
        try {
          prepared = await params.prepare(request);
        } catch (error) {
          return error instanceof DaemonPluginChangePreparationError
            ? { kind: 'failed', code: error.code, message: error.message }
            : { kind: 'failed', code: 'plugin_change_preparation_failed' };
        }

        if (!acceptsChanges()) {
          await cleanupPrepared(prepared);
          return { kind: 'unavailable', code: 'daemon_shutting_down' };
        }
        if (pendingIdByPluginId.has(prepared.pluginId) || applyingByPluginId.has(prepared.pluginId)) {
          await cleanupPrepared(prepared);
          return { kind: 'busy', pluginId: prepared.pluginId };
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
          expiresAtMs: nowMs() + pendingLifetimeMs,
          state: 'awaitingDecision',
          applyPromise: null,
        };
        pendingById.set(id, pending);
        pendingIdByPluginId.set(prepared.pluginId, id);
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
        await cleanupPrepared(pending.prepared);
        return { kind: 'cancelled' };
      }

      pending.state = 'applying';
      pending.applyPromise = (async () => {
        const result = await tryApply(pending.prepared, decision);
        removePending(pending);
        return appendCleanupPendingSurface(result, await cleanupPrepared(pending.prepared));
      })();
      return await pending.applyPromise;
    },

    async runAutomaticCurrentnessChange(pluginId, change) {
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
    },
  });
}
