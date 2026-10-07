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
  PreparedPluginDevelopmentCandidate,
} from './changeContract';
import { PluginRegistryProfileRequiredError } from './changeContract';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import { logger } from '@/ui/logger';
import type {
  DaemonPluginDevelopmentControlRequest,
  DaemonPluginDevelopmentControlResult,
} from './developmentRoots';

type PendingPluginChange = {
  readonly id: string;
  readonly prepared: PreparedDaemonPluginChange;
  readonly key: string;
  state: 'awaitingDecision' | 'applying';
  applyPromise: Promise<PluginChangeDecisionResult> | null;
};

function isDevelopmentCandidate(
  prepared: PreparedDaemonPluginChange,
): prepared is PreparedPluginDevelopmentCandidate {
  return 'kind' in prepared && prepared.kind === 'preparedDevelopmentCandidate';
}

function preparedChangeKey(prepared: PreparedDaemonPluginChange): string {
  return `plugin:${prepared.pluginId}`;
}

function preparedChangeLabel(prepared: PreparedDaemonPluginChange): string {
  return prepared.pluginId;
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
  /** Thin daemon-owned development-root registration/reload/status seam. */
  controlPluginDevelopment?: (
    request: DaemonPluginDevelopmentControlRequest,
  ) => Promise<DaemonPluginDevelopmentControlResult>;
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

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
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
  sourceRootPath?: string,
): Readonly<{ kind: 'failed'; code: string; message?: string }> {
  logger.warnLocalFile(`[plugins] ${code}`, { code, ...(sourceRootPath ? { sourceRootPath } : {}), error });
  const message = describePluginChangeFailureCause(error);
  return { kind: 'failed', code, ...(message ? { message } : {}) };
}

export function createDaemonPluginChangeService(params: Readonly<{
  prepare: (request: PluginChangeRequest) => Promise<PreparedDaemonPluginChange>;
  createPendingChangeId?: () => string;
  onCleanupFailure?: (pluginId: string, error: unknown) => void;
  applyDevelopment?: (
    prepared: PreparedPluginDevelopmentCandidate,
    decision?: Parameters<PreparedDaemonPluginChangeCandidate['apply']>[0],
  ) => Promise<PluginChangeApplyResult>;
}>): DaemonPluginChangeOwner {
  const pendingById = new Map<string, PendingPluginChange>();
  const pendingIdByPluginId = new Map<string, string>();
  // Rejoin results belong to this daemon lifetime, just like pending decisions.
  const terminalById = new Map<string, PluginChangeTerminalResult>();
  const applyingByPluginId = new Map<string, Readonly<{
    released: Promise<void>;
    release: () => void;
  }>>();
  const activeRequestDrains = new Set<Promise<void>>();
  const createPendingChangeId = params.createPendingChangeId ?? randomUUID;
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
    try {
      await prepared.cleanup();
      return true;
    } catch (error) {
      params.onCleanupFailure?.(preparedChangeLabel(prepared), error);
      return false;
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

  async function cleanupAfterApply(
    prepared: PreparedDaemonPluginChange,
    result: PluginChangeApplyOrBusyResult,
  ): Promise<PluginChangeApplyOrBusyResult> {
    if (isDevelopmentCandidate(prepared) && result.kind === 'committed') {
      // Successful publication transfers the evaluated graph into the active
      // runtime registry. Candidate cleanup is rejection-only for this arm.
      return result;
    }
    return appendCleanupPendingSurface(result, await cleanupPrepared(prepared));
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
    terminalById.set(pending.id, result);
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
    if (pending.prepared.review) {
      return {
        kind: 'reviewRequired',
        reviewKind: 'installation',
        pendingChangeId: pending.id,
        reason: pending.prepared.reviewReason ?? 'firstInstall',
        currentVersion: pending.prepared.currentVersion ?? null,
        authorityExpansion: [...(pending.prepared.authorityExpansion ?? [])],
        review: pending.prepared.review,
      };
    }
    return null;
  }

  async function tryApply(
    prepared: PreparedDaemonPluginChangeCandidate | PreparedPluginDevelopmentCandidate,
    decision?: Extract<PluginChangeDecision, { decision: 'installAndTrust' }>,
  ): Promise<PluginChangeApplyOrBusyResult> {
    const lease = tryAcquireApplyExclusion(prepared.pluginId);
    if (!lease) {
      return { kind: 'busy', pluginId: prepared.pluginId };
    }
    try {
      if (isDevelopmentCandidate(prepared)) {
        if (!params.applyDevelopment) {
          return failedPluginChange('plugin_development_runtime_unavailable', undefined, prepared.sourceAuthority.canonicalRoot);
        }
        const result = await params.applyDevelopment(prepared, decision ? {
          optionalSelections: decision.optionalSelections ?? [],
        } : undefined);
        return result.kind === 'failed'
          ? failedPluginChange(result.code, result.message, prepared.sourceAuthority.canonicalRoot)
          : result;
      }
      return await prepared.apply(decision ? {
        optionalSelections: decision.optionalSelections ?? [],
      } : undefined, { onApplied: lease.release });
    } catch (error) {
      return failedPluginChange(
        error instanceof DaemonPluginChangePreparationError
          ? error.code
          : 'plugin_change_failed',
        error,
        isDevelopmentCandidate(prepared) ? prepared.sourceAuthority.canonicalRoot : undefined,
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
        let prepared: PreparedDaemonPluginChange;
        try {
          prepared = await params.prepare(request);
        } catch (error) {
          if (error instanceof PluginRegistryProfileRequiredError) {
            return { kind: 'registryProfileRequired', ...error.requirement };
          }
          return failedPluginChange(
            error instanceof DaemonPluginChangePreparationError
              ? error.code
              : 'plugin_change_preparation_failed',
            error,
            request.kind === 'development' ? request.sourceRootPath : undefined,
          );
        }

        if (!acceptsChanges()) {
          await cleanupPrepared(prepared);
          return { kind: 'unavailable', code: 'daemon_shutting_down' };
        }
        const key = preparedChangeKey(prepared);
        if (
          pendingIdByPluginId.has(key)
          || applyingByPluginId.has(prepared.pluginId)
        ) {
          await cleanupPrepared(prepared);
          return { kind: 'busy', pluginId: prepared.pluginId };
        }
        if (prepared.requiresReview === false) {
          const result = await tryApply(prepared);
          return await cleanupAfterApply(prepared, result);
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
          state: 'awaitingDecision',
          applyPromise: null,
        };
        retainPending(pending);
        return {
          kind: 'reviewRequired',
          reviewKind: 'installation',
          pendingChangeId: id,
          reason: prepared.reviewReason ?? 'firstInstall',
          currentVersion: prepared.currentVersion ?? null,
          authorityExpansion: [...(prepared.authorityExpansion ?? [])],
          review: prepared.review,
        };
      } finally {
        finishActiveRequest();
      }
    },

    async decidePluginChange(decision) {
      const finishActiveRequest = beginActiveRequest();
      try {
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

        const prepared = pending.prepared;

        pending.state = 'applying';
        pending.applyPromise = (async () => {
          const result = await tryApply(prepared, decision);
          releasePendingChangeKey(pending);
          const settled = await cleanupAfterApply(prepared, result);
          removePending(pending);
          recordTerminal(pending, settled);
          return settled;
        })();
        return await pending.applyPromise;
      } finally {
        finishActiveRequest();
      }
    },

    async statusPluginChange(request) {
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
          result: terminal,
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
