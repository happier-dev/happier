import {
  ActionOperationSnapshotV1Schema,
  type ActionOperationListV1Request,
  type ActionOperationListV1Response,
  type ActionOperationSnapshotV1,
} from '@happier-dev/protocol';

import type { ActionOperationAccessScope } from './actionOperationTypes';

const TERMINAL_RETENTION_LIMIT = 50;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1_000;
const LIST_PAGE_SIZE = 50;
const TERMINAL_STATES = new Set<ActionOperationSnapshotV1['state']>([
  'succeeded',
  'failed',
  'cancelled',
]);

function isTerminal(snapshot: ActionOperationSnapshotV1): boolean {
  return TERMINAL_STATES.has(snapshot.state);
}

function isInScope(snapshot: ActionOperationSnapshotV1, scope: ActionOperationAccessScope): boolean {
  return snapshot.scope.accountId === scope.accountId && snapshot.scope.machineId === scope.machineId;
}

function withoutListResult(snapshot: ActionOperationSnapshotV1): ActionOperationSnapshotV1 {
  if (!isTerminal(snapshot) || !Object.prototype.hasOwnProperty.call(snapshot, 'result')) return snapshot;
  const { result: _result, ...lightweight } = snapshot;
  return lightweight;
}

export type ActionOperationStore = ReturnType<typeof createActionOperationStore>;

export function createActionOperationStore(options?: Readonly<{
  now?: () => number;
  terminalRetentionLimit?: number;
  terminalRetentionMs?: number;
  listPageSize?: number;
  onRevision?: (snapshot: ActionOperationSnapshotV1) => void;
}>) {
  const now = options?.now ?? Date.now;
  const terminalRetentionLimit = options?.terminalRetentionLimit ?? TERMINAL_RETENTION_LIMIT;
  const terminalRetentionMs = options?.terminalRetentionMs ?? TERMINAL_RETENTION_MS;
  const listPageSize = options?.listPageSize ?? LIST_PAGE_SIZE;
  const snapshots = new Map<string, ActionOperationSnapshotV1>();
  const publishRevision = (snapshot: ActionOperationSnapshotV1): void => {
    try {
      options?.onRevision?.(snapshot);
    } catch {
      // The operation store is canonical. Socket publication is a best-effort
      // projection repaired by list reconciliation after (re)connection.
    }
  };

  const prune = () => {
    const cutoff = now() - terminalRetentionMs;
    const terminal = [...snapshots.values()]
      .filter(isTerminal)
      .sort((left, right) => (right.settledAt ?? 0) - (left.settledAt ?? 0));
    const retainedIds = new Set(
      terminal
        .filter((snapshot) => (snapshot.settledAt ?? 0) >= cutoff)
        .slice(0, terminalRetentionLimit)
        .map((snapshot) => snapshot.operationId),
    );
    for (const snapshot of terminal) {
      if (retainedIds.has(snapshot.operationId)) continue;
      snapshots.delete(snapshot.operationId);
    }
  };

  const create = (snapshot: ActionOperationSnapshotV1): ActionOperationSnapshotV1 => {
    if (snapshots.has(snapshot.operationId)) {
      throw new Error(`Action operation already exists: ${snapshot.operationId}`);
    }
    const parsed = ActionOperationSnapshotV1Schema.parse(snapshot);
    snapshots.set(parsed.operationId, parsed);
    publishRevision(parsed);
    prune();
    return parsed;
  };

  const get = (operationId: string, scope: ActionOperationAccessScope): ActionOperationSnapshotV1 | null => {
    prune();
    const snapshot = snapshots.get(operationId);
    return snapshot && isInScope(snapshot, scope) ? snapshot : null;
  };

  const update = (
    operationId: string,
    updater: (snapshot: ActionOperationSnapshotV1) => ActionOperationSnapshotV1,
  ): ActionOperationSnapshotV1 | null => {
    const current = snapshots.get(operationId);
    if (!current || isTerminal(current)) return null;
    const next = ActionOperationSnapshotV1Schema.parse({
      ...updater(current),
      operationId: current.operationId,
      revision: current.revision + 1,
      actionId: current.actionId,
      scope: current.scope,
      title: current.title,
      createdAt: current.createdAt,
      cancellation: current.cancellation,
    });
    snapshots.set(operationId, next);
    publishRevision(next);
    prune();
    return next;
  };

  const list = (
    request: ActionOperationListV1Request,
    scope: ActionOperationAccessScope,
  ): ActionOperationListV1Response => {
    prune();
    const stateFilter = request.states ? new Set(request.states) : null;
    const ordered = [...snapshots.values()]
      .filter((snapshot) => isInScope(snapshot, scope))
      .filter((snapshot) => !stateFilter || stateFilter.has(snapshot.state))
      .filter((snapshot) => !request.sessionId || snapshot.scope.sessionId === request.sessionId)
      .sort((left, right) => {
        const leftTerminal = isTerminal(left);
        const rightTerminal = isTerminal(right);
        if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
        return leftTerminal
          ? (right.settledAt ?? 0) - (left.settledAt ?? 0)
          : right.createdAt - left.createdAt;
      });
    const cursorIndex = request.cursor
      ? ordered.findIndex((snapshot) => snapshot.operationId === request.cursor)
      : -1;
    const offset = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const page = ordered.slice(offset, offset + listPageSize);
    const hasNext = offset + page.length < ordered.length;
    return {
      items: page.map(withoutListResult),
      nextCursor: hasNext ? page.at(-1)?.operationId ?? null : null,
    };
  };

  return { create, get, update, list, prune };
}
