import type {
  ActionOperationDomainRefV1,
  ActionOperationFailureV1,
  ActionOperationProgressV1,
  ActionOperationSnapshotV1,
  ActionOperationStateV1,
} from '@happier-dev/protocol/actions';

import type { ActionOperationQueryScope, ActionOperationScope } from './actionOperationTypes';

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
}>;

type ListActionOperationsInput = ActionOperationQueryScope & Readonly<{
  states?: readonly ActionOperationStateV1[];
  cursor?: string;
}>;

function isTerminal(snapshot: ActionOperationSnapshotV1): boolean {
  return TERMINAL_STATES.has(snapshot.state);
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

  const notify = (snapshot: ActionOperationSnapshotV1): void => {
    try {
      options?.onSnapshot?.(snapshot);
    } catch {
      // Push is a recoverable projection. It must never change the historical
      // Action result; connection-time list reconciliation repairs a miss.
    }
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
    for (const snapshot of retainedSettled) {
      if (!retainedIds.has(snapshot.operationId)) snapshots.delete(snapshot.operationId);
    }
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
    create(input: CreateActionOperationInput): ActionOperationSnapshotV1 {
      if (snapshots.has(input.operationId)) {
        throw new Error(`Duplicate action operation id: ${input.operationId}`);
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
      notify(snapshot);
      prune();
      return snapshot;
    },

    markRunning(operationId: string): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => ({
        ...current,
        revision: current.revision + 1,
        state: 'running',
        startedAt: now(),
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

    succeed(operationId: string, result: unknown): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => ({
        ...current,
        revision: current.revision + 1,
        state: 'succeeded',
        startedAt: current.startedAt ?? now(),
        settledAt: now(),
        result,
      }));
    },

    fail(operationId: string, error: ActionOperationFailureV1): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => ({
        ...current,
        revision: current.revision + 1,
        state: 'failed',
        startedAt: current.startedAt ?? now(),
        settledAt: now(),
        error,
      }));
    },

    cancel(operationId: string): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => ({
        ...current,
        revision: current.revision + 1,
        state: 'cancelled',
        startedAt: current.startedAt ?? now(),
        settledAt: now(),
      }));
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
