import { canAdvanceActionOperationSnapshotV1, ActionOperationFailureV1Schema, ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import type {
  ActionOperationDomainRefV1,
  ActionOperationFailureV1,
  ActionOperationProgressV1,
  ActionOperationSnapshotV1,
  ActionOperationStateV1,
} from '@happier-dev/protocol/actions';

import type { ActionOperationQueryScope, ActionOperationScope } from './actionOperationTypes';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { LiveWorkCategoryV1, LiveWorkItemV1, LiveWorkInventoryV1 } from '@/daemon/lifecycle/managedActivity';

const SETTLED_RETENTION_LIMIT = 50;
const SETTLED_RETENTION_MS = 24 * 60 * 60 * 1_000;

const TERMINAL_STATES = new Set<ActionOperationStateV1>(['succeeded', 'failed', 'cancelled']);

type CreateActionOperationInput = Readonly<{
  operationId: string;
  actionId: string;
  scope: ActionOperationScope;
  title: string;
  requestId?: string;
  cancellation: ActionOperationSnapshotV1['cancellation'];
  domainRef?: ActionOperationSnapshotV1['domainRef'];
  inputIdentity: string;
  requesterWorkAttributionV1?: RequesterWorkAttributionV1;
}>;

type ListActionOperationsInput = ActionOperationQueryScope & Readonly<{
  states?: readonly ActionOperationStateV1[];
  cursor?: string;
}>;

function isTerminal(snapshot: ActionOperationSnapshotV1): boolean {
  return TERMINAL_STATES.has(snapshot.state);
}

function materialCategory(snapshot: ActionOperationSnapshotV1): LiveWorkCategoryV1 | null {
  if (snapshot.domainRef?.kind === 'projectCommand') {
    return snapshot.domainRef.purpose === 'setup' || snapshot.domainRef.purpose === 'teardown' ? 'setup' : 'finite';
  }
  if (snapshot.domainRef?.kind === 'handoff' || snapshot.actionId.startsWith('session.handoff')) return 'handoff';
  if (snapshot.actionId.startsWith('workspace.sync.')) return 'sync';
  if (snapshot.actionId === 'daemon.filesystem.upload' || snapshot.actionId === 'daemon.filesystem.download') return 'transfer';
  if (snapshot.actionId === 'projects.script.run' || snapshot.actionId === 'projects.compute.exec') return 'finite';
  if (snapshot.actionId === 'machines.managed.power.set' || snapshot.actionId === 'machines.managed.delete') return 'finite';
  if (snapshot.actionId === 'projects.prepare' || snapshot.actionId === 'session.spawn_new' || snapshot.actionId === 'session.fork'
    || snapshot.actionId === 'machines.managed.acquire' || snapshot.domainRef?.kind === 'systemTask') return 'setup';
  if (snapshot.actionId === 'projects.service.relocate') return 'service';
  return null;
}

function inScope(snapshot: ActionOperationSnapshotV1, scope: ActionOperationQueryScope): boolean {
  return snapshot.scope.accountId === scope.accountId
    && snapshot.scope.machineId === scope.machineId
    && (scope.sessionId === undefined || snapshot.scope.sessionId === scope.sessionId);
}

function freezeSnapshot(snapshot: ActionOperationSnapshotV1): ActionOperationSnapshotV1 {
  return Object.freeze({
    ...snapshot,
    scope: Object.freeze({ ...snapshot.scope }),
    ...(snapshot.progress ? { progress: Object.freeze({ ...snapshot.progress }) } : {}),
    ...(snapshot.error ? { error: Object.freeze({ ...snapshot.error }) } : {}),
    ...(snapshot.domainRef ? { domainRef: Object.freeze({ ...snapshot.domainRef }) } : {}),
    ...(snapshot.observation ? { observation: Object.freeze({ ...snapshot.observation }) } : {}),
    ...(snapshot.setupReview ? { setupReview: Object.freeze({ ...snapshot.setupReview }) } : {}),
  });
}

export function createActionOperationStore(options?: Readonly<{
  now?: () => number;
  settledRetentionLimit?: number;
  settledRetentionMs?: number;
  onSnapshot?: (snapshot: ActionOperationSnapshotV1) => void;
}>) {
  const now = options?.now ?? Date.now;
  const settledRetentionLimit = options?.settledRetentionLimit ?? SETTLED_RETENTION_LIMIT;
  const settledRetentionMs = options?.settledRetentionMs ?? SETTLED_RETENTION_MS;
  const snapshots = new Map<string, ActionOperationSnapshotV1>();
  const invocationMetadata = new Map<string, Readonly<{ inputIdentity: string; requesterWorkAttributionV1?: RequesterWorkAttributionV1 }>>();
  const subscribers = new Set<() => void>();
  const notifySubscribers = (): void => {
    for (const subscriber of subscribers) {
      try { subscriber(); } catch { /* Observation cannot change execution custody. */ }
    }
  };

  const notify = (snapshot: ActionOperationSnapshotV1): void => {
    try {
      options?.onSnapshot?.(snapshot);
    } catch {
      // Push is a recoverable projection. It must never change the historical
      // Action result; connection-time list reconciliation repairs a miss.
    }
    notifySubscribers();
  };

  const prune = (): void => {
    const cutoff = now() - settledRetentionMs;
    const retainedSettled = [...snapshots.values()]
      .filter(isTerminal)
      .sort((left, right) => (right.settledAt ?? 0) - (left.settledAt ?? 0));
    const retainedIds = new Set(
      retainedSettled
        .filter((snapshot) => (snapshot.settledAt ?? 0) >= cutoff)
        .slice(0, settledRetentionLimit)
        .map((snapshot) => snapshot.operationId),
    );
    let removed = false;
    for (const snapshot of retainedSettled) {
      if (!retainedIds.has(snapshot.operationId)) {
        snapshots.delete(snapshot.operationId);
        invocationMetadata.delete(snapshot.operationId);
        removed = true;
      }
    }
    if (removed) notifySubscribers();
  };

  const mutate = (
    operationId: string,
    update: (current: ActionOperationSnapshotV1) => ActionOperationSnapshotV1,
  ): ActionOperationSnapshotV1 | null => {
    const current = snapshots.get(operationId);
    if (!current) return null;
    if (isTerminal(current)) return current;
    const next = freezeSnapshot(update(current));
    snapshots.set(operationId, next);
    notify(next);
    if (isTerminal(next)) prune();
    return next;
  };

  return Object.freeze({
    /** Private daemon read of this owner's real custody, independent of the public Account projection. */
    readLiveWork(): Omit<LiveWorkInventoryV1, 'idleSince'> {
      const items: LiveWorkItemV1[] = [...snapshots.values()].filter(snapshot => {
        // The native intent owner reports these passive phases before an
        // idle/deadline Stop/Delete is submitted. Waiting itself must not hold
        // the guest busy; the owner changes phase before native custody starts.
        return !((snapshot.actionId === 'machines.managed.power.set' || snapshot.actionId === 'machines.managed.delete')
          && !isTerminal(snapshot) && !snapshot.observation
          && snapshot.progress?.kind === 'phase'
          && (snapshot.progress.phase === 'managed.intent.waiting-idle'
            || snapshot.progress.phase === 'managed.intent.waiting-deadline'));
      }).map(snapshot => {
        const category = materialCategory(snapshot);
        return {
          category: category ?? 'setup',
          ownerRef: snapshot.operationId,
          attribution: invocationMetadata.get(snapshot.operationId)?.requesterWorkAttributionV1 ?? { kind: 'unknown' },
          state: isTerminal(snapshot) ? 'settled' : snapshot.observation || category === null ? 'unknown' : 'active',
          ...(snapshot.domainRef?.kind === 'projectCommand' && snapshot.domainRef.terminalId
            ? { associatedTerminal: snapshot.domainRef.terminalId } : {}),
        };
      });
      return { items, coverage: 'complete' };
    },
    /** Host observers re-read through get(scope, id), preserving the canonical scope decision. */
    subscribe(listener: () => void): () => void {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    project(input: ActionOperationSnapshotV1): void {
      const incoming = ActionOperationSnapshotV1Schema.parse(input);
      const current = snapshots.get(incoming.operationId);
      if (current && !canAdvanceActionOperationSnapshotV1(current, incoming)) return;
      const snapshot = freezeSnapshot(incoming);
      snapshots.set(snapshot.operationId, snapshot);
      notify(snapshot);
      prune();
    },

    removeOwnerProjections(actionIds: readonly string[], scope?: ActionOperationQueryScope, operationId?: string): void {
      let removed = false;
      for (const snapshot of snapshots.values()) {
        if (actionIds.includes(snapshot.actionId) && (!scope || inScope(snapshot, scope))
          && (operationId === undefined || snapshot.operationId === operationId)) {
          snapshots.delete(snapshot.operationId);
          invocationMetadata.delete(snapshot.operationId);
          removed = true;
        }
      }
      if (removed) notifySubscribers();
    },

    reconcileOwner(scope: ActionOperationQueryScope, actionIds: readonly string[], incoming: readonly ActionOperationSnapshotV1[]): void {
      let removed = false;
      const retainedIds = new Set(incoming.map((snapshot) => snapshot.operationId));
      for (const snapshot of snapshots.values()) {
        if (inScope(snapshot, scope) && actionIds.includes(snapshot.actionId) && !retainedIds.has(snapshot.operationId)) {
          snapshots.delete(snapshot.operationId);
          removed = true;
        }
      }
      if (removed) notifySubscribers();
    },

    create(input: CreateActionOperationInput): ActionOperationSnapshotV1 {
      if (snapshots.has(input.operationId)) {
        throw new Error(`Duplicate action operation id: ${input.operationId}`);
      }
      const attribution = input.requesterWorkAttributionV1
        ? Object.freeze(RequesterWorkAttributionV1Schema.parse(input.requesterWorkAttributionV1)) : undefined;
      if (attribution && (attribution.accountId !== input.scope.accountId || attribution.machineId !== input.scope.machineId)) {
        throw new Error('action_operation_attribution_scope_mismatch');
      }
      const snapshot = freezeSnapshot({
        version: 1,
        operationId: input.operationId,
        revision: 1,
        actionId: input.actionId,
        state: 'accepted',
        scope: input.scope,
        title: input.title,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        createdAt: now(),
        cancellation: input.cancellation,
        ...(input.domainRef ? { domainRef: input.domainRef } : {}),
      });
      snapshots.set(input.operationId, snapshot);
      invocationMetadata.set(input.operationId, { inputIdentity: input.inputIdentity,
        ...(attribution ? { requesterWorkAttributionV1: attribution } : {}) });
      notify(snapshot);
      prune();
      return snapshot;
    },

    markRunning(operationId: string): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => ({
        ...current,
        revision: current.revision + 1,
        state: 'running',
        startedAt: current.startedAt ?? now(),
      }));
    },

    updateProgress(operationId: string, progress: ActionOperationProgressV1): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => ({
        ...current,
        revision: current.revision + 1,
        progress,
      }));
    },

    updateDomainRef(operationId: string, domainRef: ActionOperationDomainRefV1): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => ({
        ...current,
        revision: current.revision + 1,
        domainRef,
      }));
    },

    updateObservation(operationId: string, observation: NonNullable<ActionOperationSnapshotV1['observation']> | null): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => {
        const { observation: _observation, ...retained } = current;
        return { ...retained, revision: current.revision + 1, ...(observation ? { observation } : {}) };
      });
    },

    updateSetupReview(operationId: string, setupReview: ActionOperationSnapshotV1['setupReview']): ActionOperationSnapshotV1 | null {
      return mutate(operationId, current => {
        const { setupReview: _review, ...live } = current;
        return { ...live, revision: current.revision + 1, ...(setupReview ? { setupReview } : {}) };
      });
    },

    succeed(operationId: string, result: unknown): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => {
        const { observation: _observation, setupReview: _review, ...settled } = current;
        return {
          ...settled,
          revision: current.revision + 1,
          state: 'succeeded',
          startedAt: current.startedAt ?? now(),
          settledAt: now(),
          result,
        };
      });
    },

    fail(operationId: string, error: ActionOperationFailureV1): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => {
        const failure = ActionOperationFailureV1Schema.parse(error);
        const { observation: _observation, setupReview: _review, ...settled } = current;
        return {
          ...settled,
          revision: current.revision + 1,
          state: 'failed',
          startedAt: current.startedAt ?? now(),
          settledAt: now(),
          error: failure,
        };
      });
    },

    cancel(operationId: string): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => {
        const { observation: _observation, setupReview: _review, ...settled } = current;
        return {
          ...settled,
          revision: current.revision + 1,
          state: 'cancelled',
          startedAt: current.startedAt ?? now(),
          settledAt: now(),
        };
      });
    },

    get(scope: ActionOperationQueryScope, operationId: string): ActionOperationSnapshotV1 | null {
      prune();
      const snapshot = snapshots.get(operationId);
      return snapshot && inScope(snapshot, scope) ? snapshot : null;
    },

    findByRequestIdentity(
      scope: ActionOperationQueryScope,
      actionId: string,
      requestId: string,
    ): ActionOperationSnapshotV1 | null {
      prune();
      return [...snapshots.values()].find((snapshot) => (
        inScope(snapshot, scope)
        && snapshot.actionId === actionId
        && snapshot.requestId === requestId
      )) ?? null;
    },

    hasMatchingInputIdentity(operationId: string, inputIdentity: string): boolean {
      return invocationMetadata.get(operationId)?.inputIdentity === inputIdentity;
    },
    readRequesterWorkAttribution(operationId: string): RequesterWorkAttributionV1 | null {
      return invocationMetadata.get(operationId)?.requesterWorkAttributionV1 ?? null;
    },

    list(input: ListActionOperationsInput): Readonly<{
      items: readonly ActionOperationSnapshotV1[];
      nextCursor: string | null;
    }> {
      prune();
      const states = input.states ? new Set(input.states) : null;
      const ordered = [...snapshots.values()]
        .filter((snapshot) => inScope(snapshot, input))
        .filter((snapshot) => !states || states.has(snapshot.state))
        .sort((left, right) => {
          const terminalDifference = Number(isTerminal(left)) - Number(isTerminal(right));
          if (terminalDifference !== 0) return terminalDifference;
          return isTerminal(left)
            ? (right.settledAt ?? 0) - (left.settledAt ?? 0)
            : right.createdAt - left.createdAt;
        });
      const cursorIndex = input.cursor
        ? ordered.findIndex((snapshot) => snapshot.operationId === input.cursor)
        : -1;
      const page = cursorIndex >= 0 ? ordered.slice(cursorIndex + 1) : ordered;
      return {
        items: page.map((snapshot) => {
          if (!isTerminal(snapshot) || snapshot.result === undefined) return snapshot;
          const { result: _result, ...summary } = snapshot;
          return freezeSnapshot(summary);
        }),
        nextCursor: null,
      };
    },

  });
}

export type ActionOperationStore = ReturnType<typeof createActionOperationStore>;
