import { AsyncLocalStorage } from 'node:async_hooks';

export type ConnectedServiceSessionAuthSwitchReason =
  | 'automatic_runtime_failure'
  | 'manual'
  | 'pre_turn_group_policy';

export type ConnectedServiceSessionAuthSwitchActor = 'runtime' | 'user';

export function resolveConnectedServiceSessionAuthSwitchActor(
  reason: ConnectedServiceSessionAuthSwitchReason,
): ConnectedServiceSessionAuthSwitchActor {
  return reason === 'manual' ? 'user' : 'runtime';
}

type LockTail = Promise<void>;
type ActiveSessionLockOwner = Readonly<{
  registry: ConnectedServiceSessionAuthSwitchLockRegistry;
  sessionId: string;
  ownerId: symbol;
}>;

const activeSessionLockOwners = new AsyncLocalStorage<ReadonlyArray<ActiveSessionLockOwner>>();

export class ConnectedServiceSessionAuthSwitchLockRegistry {
  private readonly tailsBySessionId = new Map<string, LockTail>();
  private readonly activeOwnerIdsBySessionId = new Map<string, Set<symbol>>();

  async runExclusive<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.hasActiveOwner(sessionId)) {
      return await operation();
    }

    const previous = this.tailsBySessionId.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextTail = previous.then(() => current, () => current);
    this.tailsBySessionId.set(sessionId, nextTail);

    await previous.catch(() => {});
    const ownerId = Symbol('connected-service-session-auth-switch-lock-owner');
    this.addActiveOwner(sessionId, ownerId);
    try {
      const parentOwners = activeSessionLockOwners.getStore() ?? [];
      return await activeSessionLockOwners.run([
        ...parentOwners,
        { registry: this, sessionId, ownerId },
      ], operation);
    } finally {
      this.removeActiveOwner(sessionId, ownerId);
      release();
      if (this.tailsBySessionId.get(sessionId) === nextTail) {
        this.tailsBySessionId.delete(sessionId);
      }
    }
  }

  clearSession(sessionId: string): void {
    this.tailsBySessionId.delete(sessionId);
    this.activeOwnerIdsBySessionId.delete(sessionId);
  }

  private hasActiveOwner(sessionId: string): boolean {
    const owners = activeSessionLockOwners.getStore();
    if (!owners) return false;
    const activeOwnerIds = this.activeOwnerIdsBySessionId.get(sessionId);
    if (!activeOwnerIds) return false;
    return owners.some((owner) => (
      owner.registry === this
      && owner.sessionId === sessionId
      && activeOwnerIds.has(owner.ownerId)
    ));
  }

  private addActiveOwner(sessionId: string, ownerId: symbol): void {
    const existing = this.activeOwnerIdsBySessionId.get(sessionId);
    if (existing) {
      existing.add(ownerId);
      return;
    }
    this.activeOwnerIdsBySessionId.set(sessionId, new Set([ownerId]));
  }

  private removeActiveOwner(sessionId: string, ownerId: symbol): void {
    const existing = this.activeOwnerIdsBySessionId.get(sessionId);
    if (!existing) return;
    existing.delete(ownerId);
    if (existing.size === 0) {
      this.activeOwnerIdsBySessionId.delete(sessionId);
    }
  }
}

export type ConnectedServiceSessionAuthSwitchCore = Readonly<{
  run<T>(params: Readonly<{
    sessionId: string;
    reason: ConnectedServiceSessionAuthSwitchReason;
    execute: () => Promise<T>;
  }>): Promise<T>;
  clearSession(sessionId: string): void;
}>;

export function createConnectedServiceSessionAuthSwitchCore(params?: Readonly<{
  locks?: ConnectedServiceSessionAuthSwitchLockRegistry;
}>): ConnectedServiceSessionAuthSwitchCore {
  const locks = params?.locks ?? new ConnectedServiceSessionAuthSwitchLockRegistry();
  return {
    async run<T>(input: Readonly<{
      sessionId: string;
      reason: ConnectedServiceSessionAuthSwitchReason;
      execute: () => Promise<T>;
    }>): Promise<T> {
      void input.reason;
      return await locks.runExclusive(input.sessionId, input.execute);
    },
    clearSession(sessionId: string): void {
      locks.clearSession(sessionId);
    },
  };
}
