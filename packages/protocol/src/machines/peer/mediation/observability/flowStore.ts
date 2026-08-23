import { buildPeerMediationObservabilityFlowSnapshots } from './flowSnapshotFold.js';
import { peerMediationObservabilityScopeKey } from './scopeIdentity.js';
import type {
  PeerMediationObservabilityDeltaV1,
  PeerMediationObservabilityEventV1,
  PeerMediationObservabilityScopeV1,
  PeerMediationObservabilitySnapshotV1,
} from './v1.js';

/**
 * Canonical peer-mediation observability flow store (DEC-8).
 *
 * The daemon (`apps/cli`) and the server (`apps/server`) each carried a near-identical copy of this
 * engine — 275 vs 270 lines with 115 differing after normalising quotes — and the copies had already
 * drifted in ways an observer could see: different byte folding, and a daemon scope key that
 * collapsed every non-machine scope into one bucket. Protocol is the shared layer both may import,
 * so the single owner lives here; each app keeps only a named factory that binds its own retention
 * options and call signature. This is the same consolidation, for the same reason, as the redactor
 * in `metadataRedaction.ts`.
 *
 * Retention is bounded per flow, per scope and by event payload size, and an oversized event is
 * TRUNCATED WITH AN EXPLICIT MARKER (`payloadTruncated`, `originalPayloadBytes`, `payloadMaxBytes`
 * plus `redaction.truncated`) — never dropped, so a reader can always tell that a bounded event
 * existed and why it is incomplete.
 */

export const PEER_MEDIATION_OBSERVABILITY_STORE_DEFAULTS = {
  maxEventsPerFlow: 512,
  maxEventsPerScope: 2048,
  retentionWindowMs: 15 * 60 * 1000,
  eventPayloadMaxBytes: 16 * 1024,
  minEventPayloadMaxBytes: 1024,
} as const;

export type PeerMediationObservabilityFlowStoreDeltaListener = (
  delta: PeerMediationObservabilityDeltaV1,
) => void;

export type PeerMediationObservabilityFlowStore = Readonly<{
  publish(event: PeerMediationObservabilityEventV1): PeerMediationObservabilityEventV1;
  delta(scope: PeerMediationObservabilityScopeV1): PeerMediationObservabilityDeltaV1;
  snapshot(scope: PeerMediationObservabilityScopeV1): PeerMediationObservabilitySnapshotV1;
  subscribe(
    scope: PeerMediationObservabilityScopeV1,
    listener: PeerMediationObservabilityFlowStoreDeltaListener,
  ): () => void;
}>;

export type PeerMediationObservabilityFlowStoreOptions = Readonly<{
  maxEventsPerFlow?: number;
  maxEventsPerScope?: number;
  retentionWindowMs?: number;
  eventPayloadMaxBytes?: number;
  nowMs?: () => number;
}>;

function boundedPositiveInt(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function eventByteLength(event: PeerMediationObservabilityEventV1): number {
  // `Buffer` is not available in every protocol consumer (React Native / browser bundles read this
  // module too), so measure UTF-8 length with the platform-universal encoder.
  return new TextEncoder().encode(JSON.stringify(event)).length;
}

function enforceEventPayloadBudget(
  event: PeerMediationObservabilityEventV1,
  maxBytes: number,
): PeerMediationObservabilityEventV1 {
  const originalPayloadBytes = eventByteLength(event);
  if (originalPayloadBytes <= maxBytes) return event;

  return {
    ...event,
    data: {
      payloadTruncated: true,
      originalPayloadBytes,
      payloadMaxBytes: maxBytes,
    },
    redaction: {
      ...event.redaction,
      truncated: true,
    },
  };
}

function pruneRetainedEvents(
  events: readonly PeerMediationObservabilityEventV1[],
  input: Readonly<{
    nowMs: number;
    retentionWindowMs: number;
    maxEventsPerFlow: number;
    maxEventsPerScope: number;
  }>,
): PeerMediationObservabilityEventV1[] {
  const minimumEmittedAtMs = Math.max(0, input.nowMs - input.retentionWindowMs);
  const withinWindow = events.filter((event) => event.emittedAtMs >= minimumEmittedAtMs);
  const flowCounts = new Map<string, number>();
  const perFlowRetained: PeerMediationObservabilityEventV1[] = [];

  for (let index = withinWindow.length - 1; index >= 0; index -= 1) {
    const event = withinWindow[index];
    if (!event) continue;
    const count = flowCounts.get(event.flow.flowId) ?? 0;
    if (count >= input.maxEventsPerFlow) continue;
    flowCounts.set(event.flow.flowId, count + 1);
    perFlowRetained.push(event);
  }

  const retained = perFlowRetained.reverse();
  return retained.length > input.maxEventsPerScope
    ? retained.slice(-input.maxEventsPerScope)
    : retained;
}

export function createPeerMediationObservabilityFlowStore(
  options: PeerMediationObservabilityFlowStoreOptions = {},
): PeerMediationObservabilityFlowStore {
  const maxEventsPerFlow = boundedPositiveInt(
    options.maxEventsPerFlow,
    PEER_MEDIATION_OBSERVABILITY_STORE_DEFAULTS.maxEventsPerFlow,
    PEER_MEDIATION_OBSERVABILITY_STORE_DEFAULTS.maxEventsPerFlow,
  );
  const maxEventsPerScope = boundedPositiveInt(
    options.maxEventsPerScope,
    PEER_MEDIATION_OBSERVABILITY_STORE_DEFAULTS.maxEventsPerScope,
    PEER_MEDIATION_OBSERVABILITY_STORE_DEFAULTS.maxEventsPerScope,
  );
  const retentionWindowMs = boundedPositiveInt(
    options.retentionWindowMs,
    PEER_MEDIATION_OBSERVABILITY_STORE_DEFAULTS.retentionWindowMs,
    PEER_MEDIATION_OBSERVABILITY_STORE_DEFAULTS.retentionWindowMs,
  );
  const eventPayloadMaxBytes = Math.max(
    PEER_MEDIATION_OBSERVABILITY_STORE_DEFAULTS.minEventPayloadMaxBytes,
    boundedPositiveInt(
      options.eventPayloadMaxBytes,
      PEER_MEDIATION_OBSERVABILITY_STORE_DEFAULTS.eventPayloadMaxBytes,
      PEER_MEDIATION_OBSERVABILITY_STORE_DEFAULTS.eventPayloadMaxBytes,
    ),
  );
  const nowMs = options.nowMs ?? Date.now;
  const eventsByScope = new Map<string, PeerMediationObservabilityEventV1[]>();
  const sequenceByScope = new Map<string, number>();
  const listenersByScope = new Map<string, Set<PeerMediationObservabilityFlowStoreDeltaListener>>();

  function writeEvents(key: string, events: PeerMediationObservabilityEventV1[]): void {
    if (events.length === 0) {
      eventsByScope.delete(key);
      return;
    }
    eventsByScope.set(key, events);
  }

  function pruneScope(key: string, currentTimeMs: number): PeerMediationObservabilityEventV1[] {
    const retained = pruneRetainedEvents(eventsByScope.get(key) ?? [], {
      nowMs: currentTimeMs,
      retentionWindowMs,
      maxEventsPerFlow,
      maxEventsPerScope,
    });
    writeEvents(key, retained);
    return retained;
  }

  return {
    publish(event) {
      const key = peerMediationObservabilityScopeKey(event.scope);
      const currentTimeMs = nowMs();
      const sequence = (sequenceByScope.get(key) ?? 0) + 1;
      sequenceByScope.set(key, sequence);
      const sequenced = enforceEventPayloadBudget({ ...event, sequence }, eventPayloadMaxBytes);
      const events = pruneRetainedEvents([...pruneScope(key, currentTimeMs), sequenced], {
        nowMs: currentTimeMs,
        retentionWindowMs,
        maxEventsPerFlow,
        maxEventsPerScope,
      });
      writeEvents(key, events);
      const listeners = events.includes(sequenced) ? listenersByScope.get(key) : undefined;
      if (listeners && listeners.size > 0) {
        const delta: PeerMediationObservabilityDeltaV1 = {
          v: 1,
          scope: event.scope,
          sequence,
          events: [sequenced],
        };
        for (const listener of [...listeners]) listener(delta);
      }
      return sequenced;
    },
    delta(scope) {
      const key = peerMediationObservabilityScopeKey(scope);
      return {
        v: 1,
        scope,
        sequence: sequenceByScope.get(key) ?? 0,
        events: [...pruneScope(key, nowMs())],
      };
    },
    snapshot(scope) {
      const key = peerMediationObservabilityScopeKey(scope);
      const currentTimeMs = nowMs();
      const events = pruneScope(key, currentTimeMs);
      return {
        v: 1,
        scope,
        sequence: sequenceByScope.get(key) ?? 0,
        capturedAtMs: currentTimeMs,
        flows: buildPeerMediationObservabilityFlowSnapshots(events),
      };
    },
    subscribe(scope, listener) {
      const key = peerMediationObservabilityScopeKey(scope);
      const listeners = listenersByScope.get(key)
        ?? new Set<PeerMediationObservabilityFlowStoreDeltaListener>();
      listeners.add(listener);
      listenersByScope.set(key, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) listenersByScope.delete(key);
      };
    },
  };
}
