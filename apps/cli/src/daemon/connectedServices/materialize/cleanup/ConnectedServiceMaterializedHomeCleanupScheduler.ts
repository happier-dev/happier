import { rm } from 'node:fs/promises';

import { resolveConnectedServiceCredentialLifecycleDescriptor } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '../../credentials/lifecycleTypes';
import type { ConnectedServiceRuntimeRegistry } from '../../runtimeRegistry/registry';
import { normalizeMaterializationKeyForPath } from '../normalizeMaterializationKeyForPath';
import {
  listMaterializedAttemptTargets,
  listMaterializedHomeTargets,
  type ConnectedServiceMaterializedCleanupTarget,
} from './connectedServiceMaterializedHomeTargets';
import {
  createPendingPathCleanupQueue,
  type PendingPathCleanupRetryExhaustedEvent,
} from '../../cleanup/PendingPathCleanupQueue';

export type ConnectedServiceMaterializedHomeCleanupResult = Readonly<{
  cleaned: boolean;
  pending?: boolean;
  kind: 'home' | 'attempt';
  path: string;
}>;

type RetainedIdentityIds = ReadonlySet<string> | ReadonlyArray<string>;

type PendingMaterializedCleanupTarget = ConnectedServiceMaterializedCleanupTarget & Readonly<{
  cleanupAttempts?: number;
  lastCleanupError?: unknown;
}>;

type ResolveCredentialLifecycleDescriptor = (
  agentId: CatalogAgentId,
) => Promise<ConnectedServiceCredentialLifecycleDescriptor>;

const defaultRootTtlMs = 30 * 24 * 60 * 60_000;
const defaultAttemptsTtlMs = 60 * 60_000;

function targetKey(target: ConnectedServiceMaterializedCleanupTarget): string {
  return [
    target.kind,
    target.materializationIdentityId,
    target.agentId,
    target.path,
  ].join('\0');
}

function normalizeRetainedIdentityIds(ids: RetainedIdentityIds | null | undefined): ReadonlySet<string> {
  if (!ids) return new Set();
  return ids instanceof Set ? ids : new Set(ids);
}

function isStale(input: Readonly<{
  nowMs: number;
  mtimeMs: number;
  ttlMs: number;
}>): boolean {
  if (!Number.isFinite(input.mtimeMs)) return false;
  return input.nowMs - input.mtimeMs >= input.ttlMs;
}

export class ConnectedServiceMaterializedHomeCleanupScheduler {
  private readonly rootTtlMs: number;
  private readonly attemptsTtlMs: number;
  private readonly resolveCredentialLifecycleDescriptor: ResolveCredentialLifecycleDescriptor;
  private readonly cleanupQueue: ReturnType<typeof createPendingPathCleanupQueue<PendingMaterializedCleanupTarget>>;

  constructor(private readonly deps: Readonly<{
    baseDir: string;
    nowMs: () => number;
    rootTtlMs?: number;
    attemptsTtlMs?: number;
    maxCleanupRetries?: number;
    removePath?: typeof rm;
    resolveCredentialLifecycleDescriptor?: ResolveCredentialLifecycleDescriptor;
    onCleanupRetryExhausted?: (event: PendingPathCleanupRetryExhaustedEvent<PendingMaterializedCleanupTarget>) => void;
    runtimeRegistry?: ConnectedServiceRuntimeRegistry;
    hasLiveTarget(input: Readonly<{
      kind: 'home' | 'attempt';
      materializationIdentityId: string;
      agentId: CatalogAgentId;
      path: string;
    }>): boolean;
    listRetainedIdentityIds?: () => Promise<RetainedIdentityIds> | RetainedIdentityIds;
  }>) {
    this.rootTtlMs = Math.max(0, Math.trunc(deps.rootTtlMs ?? defaultRootTtlMs));
    this.attemptsTtlMs = Math.max(0, Math.trunc(deps.attemptsTtlMs ?? defaultAttemptsTtlMs));
    this.resolveCredentialLifecycleDescriptor = deps.resolveCredentialLifecycleDescriptor
      ?? resolveConnectedServiceCredentialLifecycleDescriptor;
    this.cleanupQueue = createPendingPathCleanupQueue<PendingMaterializedCleanupTarget>({
      maxCleanupRetries: deps.maxCleanupRetries,
      removePath: deps.removePath,
      beforeRemove: async (target) => {
        await this.deleteTargetCredentialStorage(target);
      },
      onRetryExhausted: deps.onCleanupRetryExhausted,
    });
  }

  private async deleteTargetCredentialStorage(target: ConnectedServiceMaterializedCleanupTarget): Promise<void> {
    const descriptor = await this.resolveCredentialLifecycleDescriptor(target.agentId);
    await descriptor.credentialStorageCleanup?.deleteCredentialStorageForHomeRoot({
      rootDir: target.path,
      kind: target.kind === 'home' ? 'materialized_home' : 'materialized_attempt',
    });
  }

  private hasLiveTarget(target: ConnectedServiceMaterializedCleanupTarget): boolean {
    // Execution runs use a distinct Run-key registry alongside their runner Session. Reuse that
    // live registration here; a persisted marker's running status is not process liveness.
    if (this.deps.runtimeRegistry?.listTargets().some((runtimeTarget) => {
      if (runtimeTarget.agentId !== target.agentId) return false;
      const identityId = runtimeTarget.connectedServiceMaterializationIdentityV1?.id
        ?? (runtimeTarget.materializationKey ? normalizeMaterializationKeyForPath(runtimeTarget.materializationKey) : null);
      return identityId === target.materializationIdentityId;
    })) return true;
    return this.deps.hasLiveTarget({
      kind: target.kind,
      materializationIdentityId: target.materializationIdentityId,
      agentId: target.agentId,
      path: target.path,
    });
  }

  private async scheduleCleanup(
    target: ConnectedServiceMaterializedCleanupTarget,
  ): Promise<ConnectedServiceMaterializedHomeCleanupResult> {
    if (this.hasLiveTarget(target)) {
      this.cleanupQueue.setPending(targetKey(target), target);
      return {
        cleaned: false,
        pending: true,
        kind: target.kind,
        path: target.path,
      };
    }
    await this.cleanupQueue.removeNow(targetKey(target), target);
    return {
      cleaned: true,
      kind: target.kind,
      path: target.path,
    };
  }

  /**
   * The retention listing pages every active and archived Session with full metadata (#832), so it
   * is read only when a home actually needs a retention decision, at most once per pass. A listing
   * failure still throws before that home (or any later one) can be removed.
   */
  private createRetainedIdentityIdsReader(): () => Promise<ReadonlySet<string>> {
    let retained: Promise<ReadonlySet<string>> | null = null;
    return () => {
      retained ??= Promise.resolve(this.deps.listRetainedIdentityIds?.()).then(normalizeRetainedIdentityIds);
      return retained;
    };
  }

  async reconcileMaterializedHomes(): Promise<ReadonlyArray<ConnectedServiceMaterializedHomeCleanupResult>> {
    const nowMs = this.deps.nowMs();
    const readRetainedIdentityIds = this.createRetainedIdentityIdsReader();
    const results: ConnectedServiceMaterializedHomeCleanupResult[] = [];

    for (const target of await listMaterializedHomeTargets(this.deps.baseDir)) {
      if (!isStale({ nowMs, mtimeMs: target.mtimeMs, ttlMs: this.rootTtlMs })) continue;
      if ((await readRetainedIdentityIds()).has(target.materializationIdentityId)) continue;
      const result = await this.scheduleCleanup(target);
      if (result.cleaned) results.push(result);
    }

    for (const target of await listMaterializedAttemptTargets(this.deps.baseDir)) {
      if (!isStale({ nowMs, mtimeMs: target.mtimeMs, ttlMs: this.attemptsTtlMs })) continue;
      const result = await this.scheduleCleanup(target);
      if (result.cleaned) results.push(result);
    }

    return results;
  }

  async cleanupPendingMaterializedHomes(): Promise<ReadonlyArray<Readonly<{
    cleaned: true;
    kind: 'home' | 'attempt';
    path: string;
  }>>> {
    const readRetainedIdentityIds = this.createRetainedIdentityIdsReader();
    return await this.cleanupQueue.drainPending({
      shouldDropPending: async (target) => target.kind === 'home'
        && (await readRetainedIdentityIds()).has(target.materializationIdentityId),
      shouldKeepPending: (target) => this.hasLiveTarget(target),
      toCleanedResult: (target) => ({
        cleaned: true,
        kind: target.kind,
        path: target.path,
      }),
    });
  }
}
