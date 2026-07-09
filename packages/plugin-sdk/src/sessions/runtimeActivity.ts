import {
  SESSION_RUNTIME_ACTIVITY_PROJECTION_LEASE_MS,
  type SessionRuntimeActivityProjectionV1,
  type SessionRuntimeActivitySourceClassV1,
  type SessionRuntimeActivitySourceKindV1,
} from '@happier-dev/protocol';

import type { SessionScopedServicesV1 } from './scoped.js';

const DEFAULT_RUNTIME_ACTIVITY_PROJECTION_RETRY_DELAY_MS = 5_000;

export type SessionRuntimeActivityPublisherSourceInput = Readonly<{
  sourceId: string;
  sourceKind: SessionRuntimeActivitySourceKindV1;
}>;

export type SessionRuntimeActivityPublisher = Readonly<{
  markSourceActive(source: SessionRuntimeActivityPublisherSourceInput): Promise<void>;
  renewSource(sourceId: string): Promise<void>;
  clearSource(sourceId: string): Promise<void>;
  clearAllSources(): Promise<void>;
}>;

export type CreateSessionRuntimeActivityPublisherOptions = Readonly<{
  session: Pick<SessionScopedServicesV1, 'writeStateField'>;
  nowMs?: () => number;
  projectionLeaseMs?: number;
}>;

type RuntimeActivitySourceState = Readonly<{
  id: string;
  kind: SessionRuntimeActivitySourceKindV1;
  observedAtMs: number;
  expiresAtMs: number;
}>;

function normalizeSourceId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTimestamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : Date.now();
}

function normalizeLeaseMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : SESSION_RUNTIME_ACTIVITY_PROJECTION_LEASE_MS;
}

function deriveSourceClass(sources: readonly RuntimeActivitySourceState[]): SessionRuntimeActivitySourceClassV1 | null {
  if (sources.length === 0) return null;
  const first = sources[0]!.kind;
  return sources.every((source) => source.kind === first) ? first : 'mixed';
}

function buildProjection(sources: readonly RuntimeActivitySourceState[]): SessionRuntimeActivityProjectionV1 {
  if (sources.length === 0) {
    return {
      v: 1,
      activeCount: 0,
      observedAtMs: null,
      expiresAtMs: null,
      sourceClass: null,
    };
  }

  return {
    v: 1,
    activeCount: sources.length,
    observedAtMs: Math.max(...sources.map((source) => source.observedAtMs)),
    expiresAtMs: Math.max(...sources.map((source) => source.expiresAtMs)),
    sourceClass: deriveSourceClass(sources),
  };
}

export function createSessionRuntimeActivityPublisher(
  options: CreateSessionRuntimeActivityPublisherOptions,
): SessionRuntimeActivityPublisher {
  const sources = new Map<string, RuntimeActivitySourceState>();
  const nowMs = options.nowMs ?? (() => Date.now());
  const leaseMs = normalizeLeaseMs(options.projectionLeaseMs);
  const renewalWindowMs = Math.max(1, Math.floor(leaseMs / 2));
  let projectionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let publishQueue: Promise<void> = Promise.resolve();

  function clearProjectionRetryTimer(): void {
    if (!projectionRetryTimer) return;
    clearTimeout(projectionRetryTimer);
    projectionRetryTimer = null;
  }

  function unrefProjectionRetryTimer(timer: ReturnType<typeof setTimeout>): void {
    if (typeof timer !== 'object' || timer === null || !('unref' in timer)) return;
    const unref = timer.unref;
    if (typeof unref === 'function') {
      unref.call(timer);
    }
  }

  function scheduleProjectionRetry(reason: string): void {
    if (projectionRetryTimer) return;
    projectionRetryTimer = setTimeout(() => {
      projectionRetryTimer = null;
      void publish(reason);
    }, DEFAULT_RUNTIME_ACTIVITY_PROJECTION_RETRY_DELAY_MS);
    unrefProjectionRetryTimer(projectionRetryTimer);
  }

  async function publishNow(reason: string): Promise<void> {
    try {
      await options.session.writeStateField({
        fieldId: 'runtime.activity',
        value: buildProjection([...sources.values()]),
        reason,
      });
      clearProjectionRetryTimer();
    } catch {
      scheduleProjectionRetry(reason);
    }
  }

  async function publish(reason: string): Promise<void> {
    const queuedPublish = publishQueue.then(() => publishNow(reason));
    publishQueue = queuedPublish.catch(() => undefined);
    await queuedPublish;
  }

  function shouldSkipRenewalWrite(current: RuntimeActivitySourceState, observedAtMs: number): boolean {
    return current.expiresAtMs - observedAtMs > renewalWindowMs;
  }

  return {
    async markSourceActive(source) {
      const sourceId = normalizeSourceId(source.sourceId);
      if (!sourceId) return;
      const observedAtMs = normalizeTimestamp(nowMs());
      const current = sources.get(sourceId);
      if (current && current.kind === source.sourceKind && shouldSkipRenewalWrite(current, observedAtMs)) {
        return;
      }
      sources.set(sourceId, {
        id: sourceId,
        kind: source.sourceKind,
        observedAtMs,
        expiresAtMs: observedAtMs + leaseMs,
      });
      await publish(current ? 'runtime_activity_source_renewed' : 'runtime_activity_source_active');
    },

    async renewSource(sourceId) {
      const normalized = normalizeSourceId(sourceId);
      if (!normalized) return;
      const current = sources.get(normalized);
      if (!current) return;
      const observedAtMs = normalizeTimestamp(nowMs());
      if (shouldSkipRenewalWrite(current, observedAtMs)) return;
      sources.set(normalized, {
        ...current,
        observedAtMs,
        expiresAtMs: observedAtMs + leaseMs,
      });
      await publish('runtime_activity_source_renewed');
    },

    async clearSource(sourceId) {
      const normalized = normalizeSourceId(sourceId);
      if (!normalized) return;
      if (!sources.delete(normalized)) return;
      await publish('runtime_activity_source_cleared');
    },

    async clearAllSources() {
      sources.clear();
      await publish('runtime_activity_sources_cleared');
    },
  };
}
