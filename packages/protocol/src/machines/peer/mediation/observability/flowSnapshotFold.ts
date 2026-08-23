import type {
  PeerMediationObservabilityEventKindV1,
  PeerMediationObservabilityEventV1,
  PeerMediationObservabilityFlowSnapshotV1,
  PeerMediationObservabilityLifecycleStateV1,
} from './v1.js';

/**
 * Canonical peer-mediation observability flow fold (DEC-8, PMS-9).
 *
 * Three implementations of the event -> flow-snapshot decision existed before this module: the
 * daemon store, the server store, and the UI delta reducer. They disagreed on five event kinds and
 * on how byte counters accumulate. That disagreement is REACHABLE, not latent, because
 * `PeerMediationObservabilityDeltaV1Schema` is `.strict()` and carries no snapshots: the initial
 * subscribe renders the producer's fold, and every delta afterwards renders the consumer's fold, so
 * a flow's lifecycle state and byte totals visibly change the moment the first delta lands.
 *
 * Lifecycle resolution (`previous`-aware) also prevents a late counter event from reviving a flow
 * that already reached a terminal state, which the producers' kind-only mappers could not express.
 */

/**
 * Byte semantics on the wire, established from the emitters rather than from either fold:
 *
 * - `bytesIn` / `bytesOut` are CUMULATIVE per-flow gauges. Every producer passes a running total
 *   (`bytesByTunnelId`, `bytesByStreamId`, `state.bytesRelayed`), so the latest sample replaces the
 *   previous one. Summing them double-counts: a tunnel that emits `cap.exceeded` and then
 *   `flow.closed` at the same 1 000-byte total would otherwise report 2 000.
 * - `requestBytes` / `responseBytes` are PER-REQUEST increments. The server's HTTP events use the
 *   tunnel id as the flow id, so one flow carries many requests and their bytes must accumulate.
 */
const CUMULATIVE_BYTES_IN_KEY = 'bytesIn';
const CUMULATIVE_BYTES_OUT_KEY = 'bytesOut';
const INCREMENTAL_BYTES_IN_KEY = 'requestBytes';
const INCREMENTAL_BYTES_OUT_KEY = 'responseBytes';

export function isPeerMediationObservabilityTerminalLifecycle(
  lifecycleState: PeerMediationObservabilityLifecycleStateV1,
): boolean {
  return lifecycleState === 'closed'
    || lifecycleState === 'aborted'
    || lifecycleState === 'errored'
    || lifecycleState === 'denied';
}

/**
 * The single lifecycle mapper. The five kinds the three predecessors disagreed on:
 *
 * - `flow.started` -> `starting`. The producers returned `active`, which made the `starting` member
 *   of `PeerMediationObservabilityLifecycleStateV1Schema` unreachable from any emitter.
 * - `websocket.aborted` -> `aborted`, `websocket.errored` -> `errored`,
 *   `http.request.finished` -> `closed`. Terminal, per the producers and PMS-9's recorded intent
 *   that the stores "accept and snapshot those terminal WebSocket lifecycle states".
 * - `tunnel.substream.aborted` -> NOT terminal. The flow is the tunnel; one substream reset must not
 *   report the whole tunnel aborted and drop it out of the active-flow selectors.
 */
export function peerMediationObservabilityLifecycleForEventKind(
  kind: PeerMediationObservabilityEventKindV1,
  previous?: PeerMediationObservabilityLifecycleStateV1,
): PeerMediationObservabilityLifecycleStateV1 {
  switch (kind) {
    case 'flow.started':
      return 'starting';
    case 'flow.ready':
      return 'ready';
    case 'flow.denied':
    case 'policy.denied':
      return 'denied';
    case 'flow.closed':
    case 'websocket.closed':
    case 'http.request.finished':
      return 'closed';
    case 'flow.aborted':
    case 'websocket.aborted':
    case 'http.request.aborted':
      return 'aborted';
    case 'flow.errored':
    case 'websocket.errored':
      return 'errored';
    default:
      return previous === 'starting' || previous === 'ready' ? 'active' : previous ?? 'active';
  }
}

function readNumber(data: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readString(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function foldBytes(
  data: Readonly<Record<string, unknown>>,
  previous: number | undefined,
  cumulativeKey: string,
  incrementalKey: string,
): number {
  const cumulative = readNumber(data, cumulativeKey);
  if (cumulative !== undefined) return cumulative;
  return (previous ?? 0) + (readNumber(data, incrementalKey) ?? 0);
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Fold one event onto a flow's snapshot. Used by the protocol store engine (which reduces the whole
 * retained event list) and by the UI delta reducer (which folds one delta at a time), so both sides
 * of the snapshot/delta seam produce identical numbers.
 */
export function applyPeerMediationObservabilityEventToFlowSnapshot(
  previous: PeerMediationObservabilityFlowSnapshotV1 | undefined,
  event: PeerMediationObservabilityEventV1,
): PeerMediationObservabilityFlowSnapshotV1 {
  const data = event.data ?? {};
  const lifecycleState = peerMediationObservabilityLifecycleForEventKind(event.kind, previous?.lifecycleState);
  const closedAtMs = isPeerMediationObservabilityTerminalLifecycle(lifecycleState)
    ? event.emittedAtMs
    : previous?.closedAtMs;
  const isHttpEvent = event.kind.startsWith('http.request.');
  const isWebSocketEvent = event.kind.startsWith('websocket.');
  const reasonCode = readString(data, 'reasonCode');

  return {
    flow: event.flow,
    lifecycleState,
    startedAtMs: previous?.startedAtMs ?? event.emittedAtMs,
    lastActivityAtMs: event.emittedAtMs,
    ...optional('closedAtMs', closedAtMs),
    bytesIn: foldBytes(data, previous?.bytesIn, CUMULATIVE_BYTES_IN_KEY, INCREMENTAL_BYTES_IN_KEY),
    bytesOut: foldBytes(data, previous?.bytesOut, CUMULATIVE_BYTES_OUT_KEY, INCREMENTAL_BYTES_OUT_KEY),
    framesIn: readNumber(data, 'framesIn') ?? previous?.framesIn ?? 0,
    framesOut: readNumber(data, 'framesOut') ?? previous?.framesOut ?? 0,
    messagesIn: readNumber(data, 'messagesIn') ?? previous?.messagesIn ?? 0,
    messagesOut: readNumber(data, 'messagesOut') ?? previous?.messagesOut ?? 0,
    activeSubstreams: readNumber(data, 'activeSubstreams') ?? previous?.activeSubstreams ?? 0,
    ...optional('totalSubstreams', readNumber(data, 'totalSubstreams') ?? previous?.totalSubstreams),
    ...optional('movingThroughputBps', readNumber(data, 'movingThroughputBps') ?? previous?.movingThroughputBps),
    ...optional('capProfileId', readString(data, 'capProfileId') ?? previous?.capProfileId),
    ...optional('capUsagePercent', readNumber(data, 'capUsagePercent') ?? previous?.capUsagePercent),
    ...optional(
      'closeReasonCode',
      readString(data, 'closeReasonCode')
        ?? (lifecycleState === 'closed' ? reasonCode : undefined)
        ?? previous?.closeReasonCode,
    ),
    ...optional(
      'abortReasonCode',
      readString(data, 'abortReasonCode')
        ?? (lifecycleState === 'aborted' ? reasonCode : undefined)
        ?? previous?.abortReasonCode,
    ),
    ...optional(
      'errorReasonCode',
      readString(data, 'errorReasonCode')
        ?? (lifecycleState === 'errored' ? reasonCode : undefined)
        ?? previous?.errorReasonCode,
    ),
    ...(isHttpEvent ? { http: data } : optional('http', previous?.http)),
    ...(isWebSocketEvent ? { websocket: data } : optional('websocket', previous?.websocket)),
  };
}

/** Reduce an ordered retained-event list into one snapshot per flow id. */
export function buildPeerMediationObservabilityFlowSnapshots(
  events: readonly PeerMediationObservabilityEventV1[],
): PeerMediationObservabilityFlowSnapshotV1[] {
  const byFlow = new Map<string, PeerMediationObservabilityFlowSnapshotV1>();
  for (const event of events) {
    byFlow.set(
      event.flow.flowId,
      applyPeerMediationObservabilityEventToFlowSnapshot(byFlow.get(event.flow.flowId), event),
    );
  }
  return [...byFlow.values()];
}
