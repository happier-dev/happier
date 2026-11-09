import { waitForAccountEncryptionObservation as waitForSharedOperation } from '@happier-dev/sync-client';
import type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import type { PendingResetStartBindingV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { evaluatePendingResetStartReadinessV1 } from '@happier-dev/protocol/sessions/pending/pendingResetStartReadinessV1';
import type { DurableBackoffRecoveryScheduler } from '../recoveryScheduler/DurableBackoffRecoveryScheduler';

export type PendingResetStartDemand = Readonly<{ localId: string; reset: PendingResetStartBindingV1 }>;
export type PendingResetStartSessionPorts = Readonly<{
  read: () => Promise<readonly PendingResetStartDemand[]>;
  readAuthority: (demand: PendingResetStartDemand) => Promise<boolean>;
  readWitness: (reset: PendingResetStartBindingV1) => Promise<ProviderAccountUsageSnapshotV1 | null>;
  readCurrent: (reset: PendingResetStartBindingV1) => Promise<ProviderAccountUsageSnapshotV1 | null>;
  release: (input: PendingResetStartDemand) => Promise<void>;
}>;
export type PendingResetStartRecoveryPorts = Readonly<{
  withSession: (sessionId: string, run: (ports: PendingResetStartSessionPorts) => Promise<void>, signal?: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
}>;

/** Pending owns persistence. This scheduler slice owns only retained demand and pre-release reads. */
export class PendingResetReconciliation {
  private disposed = false;
  private readonly demandKeys = new Map<string, Readonly<{ sessionId: string; localId: string }>>();
  private readonly reconciliations = new Map<string, Promise<void>>();

  constructor(private readonly deps: Readonly<{
    nowMs: () => number;
    ports?: PendingResetStartRecoveryPorts;
    scheduler: Pick<DurableBackoffRecoveryScheduler<never>, 'clearDemand' | 'scheduleDemand'>;
  }>) {}

  dispose(): void {
    this.disposed = true;
    this.demandKeys.clear();
  }

  async reconcile(sessionId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.disposed || !this.deps.ports) return;
    const existing = this.reconciliations.get(sessionId);
    if (existing) {
      // The incumbent operation belongs to another live wake; cancel only this borrow.
      await waitForSharedOperation(existing, signal);
      return await this.reconcile(sessionId, signal);
    }
    const operation = this.reconcileOnce(sessionId, signal);
    this.reconciliations.set(sessionId, operation);
    try { await operation; }
    finally {
      if (this.reconciliations.get(sessionId) === operation) this.reconciliations.delete(sessionId);
    }
  }

  async reconcileTracked(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const sessionIds = new Set([...this.demandKeys.values()].map(key => key.sessionId));
    // Join issued releases in other Sessions before returning a cancelled preparation.
    const settled = await Promise.allSettled([...sessionIds].map(sessionId => this.reconcile(sessionId, signal)));
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
  }

  private async reconcileOnce(sessionId: string, signal?: AbortSignal): Promise<void> {
    const ports = this.deps.ports;
    if (!ports || this.disposed) return;
    await ports.withSession(sessionId, async session => {
      signal?.throwIfAborted();
      const rows = await session.read();
      signal?.throwIfAborted();
      if (this.disposed) return;
      const localIds = new Set(rows.map(row => row.localId));
      for (const [id, key] of this.demandKeys) {
        if (key.sessionId === sessionId && !localIds.has(key.localId)) {
          this.deps.scheduler.clearDemand(key);
          this.demandKeys.delete(id);
        }
      }
      for (const row of rows) {
        signal?.throwIfAborted();
        if (this.disposed) return;
        const id = JSON.stringify([sessionId, row.localId]);
        const key = this.demandKeys.get(id) ?? { sessionId, localId: row.localId };
        this.demandKeys.set(id, key);
        this.deps.scheduler.clearDemand(key);
        const authorityCurrent = await session.readAuthority(row);
        signal?.throwIfAborted();
        if (!authorityCurrent || this.disposed) continue;
        const previous = await session.readWitness(row.reset);
        signal?.throwIfAborted();
        const current = await session.readCurrent(row.reset);
        signal?.throwIfAborted();
        const readiness = evaluatePendingResetStartReadinessV1({ reset: row.reset, witness: previous, current,
          nowMs: this.deps.nowMs(), authorityCurrent: !this.disposed });
        if (readiness.status === 'waiting' && readiness.nextCheckAtMs !== undefined) {
          this.deps.scheduler.scheduleDemand({ key, notBeforeMs: readiness.nextCheckAtMs, wake: () => {
            void this.reconcile(sessionId).catch(error => ports.onError?.(error));
          } });
          continue;
        }
        if (readiness.status !== 'ready') continue;
        // Shared readiness also admits the next fresh comparable window after
        // a missed reset. Release the original row; never rebind its witness.
        // Release is an issued Pending mutation. Retain and join its settlement after cancellation.
        await session.release(row);
        if (this.disposed) return;
        this.demandKeys.delete(id);
      }
    }, signal);
  }
}
