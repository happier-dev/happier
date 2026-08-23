import { describe, expect, it } from 'vitest';

import {
  applyPeerMediationObservabilityEventToFlowSnapshot,
  buildPeerMediationObservabilityFlowSnapshots,
  peerMediationObservabilityLifecycleForEventKind,
} from './flowSnapshotFold.js';
import { createPeerMediationObservabilityFlowStore } from './flowStore.js';
import { peerMediationObservabilityScopeKey } from './scopeIdentity.js';
import {
  PeerMediationObservabilityEventV1Schema,
  type PeerMediationObservabilityEventKindV1,
  type PeerMediationObservabilityEventV1,
  type PeerMediationObservabilityScopeV1,
} from './v1.js';

const MACHINE_SCOPE: PeerMediationObservabilityScopeV1 = {
  kind: 'machine',
  accountId: 'account_1',
  machineId: 'machine_1',
};

function tunnelEvent(input: Readonly<{
  kind: PeerMediationObservabilityEventKindV1;
  emittedAtMs: number;
  data?: Record<string, unknown>;
  scope?: PeerMediationObservabilityScopeV1;
  flowId?: string;
}>): PeerMediationObservabilityEventV1 {
  const flowId = input.flowId ?? 'tunnel_1';
  return PeerMediationObservabilityEventV1Schema.parse({
    v: 1,
    eventId: `event_${input.kind}_${input.emittedAtMs}`,
    sequence: 1,
    emittedAtMs: input.emittedAtMs,
    scope: input.scope ?? MACHINE_SCOPE,
    flow: { flowId, flowKind: 'tcp_tunnel', tunnelId: flowId },
    kind: input.kind,
    data: input.data ?? {},
    redaction: { level: 'metadataOnly' },
  });
}

describe('peerMediationObservabilityLifecycleForEventKind — the five previously divergent kinds', () => {
  // The daemon store, the server store and the UI delta reducer each answered these five
  // differently. Reachable, not latent: the delta schema carries no snapshots, so the initial
  // subscribe renders the producer's answer and the next delta renders the consumer's.
  it('resolves flow.started to starting, not active', () => {
    expect(peerMediationObservabilityLifecycleForEventKind('flow.started')).toBe('starting');
  });

  it('resolves websocket.aborted and websocket.errored to their terminal states, not the previous state', () => {
    expect(peerMediationObservabilityLifecycleForEventKind('websocket.aborted', 'active')).toBe('aborted');
    expect(peerMediationObservabilityLifecycleForEventKind('websocket.errored', 'active')).toBe('errored');
  });

  it('resolves http.request.finished to closed', () => {
    expect(peerMediationObservabilityLifecycleForEventKind('http.request.finished', 'active')).toBe('closed');
  });

  it('does NOT terminate the tunnel flow on tunnel.substream.aborted', () => {
    // The flow is the tunnel; one substream reset must not report the whole tunnel aborted.
    expect(peerMediationObservabilityLifecycleForEventKind('tunnel.substream.aborted', 'ready')).toBe('active');
    expect(peerMediationObservabilityLifecycleForEventKind('tunnel.substream.aborted', 'active')).toBe('active');
  });

  it('does not revive a terminal flow when a late counter event arrives', () => {
    expect(peerMediationObservabilityLifecycleForEventKind('tunnel.bytes', 'closed')).toBe('closed');
  });
});

describe('peer mediation observability byte folding', () => {
  it('treats bytesIn/bytesOut as cumulative gauges and does not double-count them', () => {
    // Every producer passes a running total (`bytesByTunnelId`, `state.bytesRelayed`). Summing two
    // samples of the same total reported 2000 bytes for a 1000-byte tunnel.
    const snapshots = buildPeerMediationObservabilityFlowSnapshots([
      tunnelEvent({ kind: 'cap.exceeded', emittedAtMs: 1_000, data: { bytesIn: 600, bytesOut: 400 } }),
      tunnelEvent({ kind: 'flow.closed', emittedAtMs: 2_000, data: { bytesIn: 600, bytesOut: 400 } }),
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.bytesIn).toBe(600);
    expect(snapshots[0]?.bytesOut).toBe(400);
  });

  it('accumulates requestBytes/responseBytes because HTTP events share one tunnel flow', () => {
    const snapshots = buildPeerMediationObservabilityFlowSnapshots([
      tunnelEvent({
        kind: 'http.request.finished',
        emittedAtMs: 1_000,
        data: { requestId: 'r1', requestBytes: 100, responseBytes: 900 },
      }),
      tunnelEvent({
        kind: 'http.request.finished',
        emittedAtMs: 2_000,
        data: { requestId: 'r2', requestBytes: 50, responseBytes: 450 },
      }),
    ]);

    expect(snapshots[0]?.bytesIn).toBe(150);
    expect(snapshots[0]?.bytesOut).toBe(1_350);
  });

  it('produces the same numbers whether folded as a snapshot or as a stream of deltas', () => {
    // This is the seam that made the drift user-visible: subscribe renders the producer's fold,
    // every delta afterwards renders the consumer's.
    const events = [
      tunnelEvent({ kind: 'flow.started', emittedAtMs: 1_000 }),
      tunnelEvent({ kind: 'flow.ready', emittedAtMs: 1_500 }),
      tunnelEvent({ kind: 'cap.exceeded', emittedAtMs: 2_000, data: { bytesIn: 600, bytesOut: 400 } }),
      tunnelEvent({ kind: 'websocket.errored', emittedAtMs: 2_500, data: { reasonCode: 'upstream_failed' } }),
    ];

    const snapshotFold = buildPeerMediationObservabilityFlowSnapshots(events)[0];
    const deltaFold = events.reduce<ReturnType<typeof applyPeerMediationObservabilityEventToFlowSnapshot> | undefined>(
      (previous, event) => applyPeerMediationObservabilityEventToFlowSnapshot(previous, event),
      undefined,
    );

    expect(deltaFold).toEqual(snapshotFold);
    expect(snapshotFold?.lifecycleState).toBe('errored');
    expect(snapshotFold?.errorReasonCode).toBe('upstream_failed');
    expect(snapshotFold?.closedAtMs).toBe(2_500);
  });

  it('records closedAtMs for every terminal lifecycle, including flow.aborted', () => {
    const snapshot = applyPeerMediationObservabilityEventToFlowSnapshot(
      undefined,
      tunnelEvent({ kind: 'flow.aborted', emittedAtMs: 4_000, data: { reasonCode: 'idle_timeout' } }),
    );
    expect(snapshot.lifecycleState).toBe('aborted');
    expect(snapshot.closedAtMs).toBe(4_000);
    expect(snapshot.abortReasonCode).toBe('idle_timeout');
  });
});

describe('createPeerMediationObservabilityFlowStore', () => {
  it('keys every scope kind distinctly instead of collapsing non-machine scopes', () => {
    const store = createPeerMediationObservabilityFlowStore({ nowMs: () => 1_000 });
    const sessionScope: PeerMediationObservabilityScopeV1 = {
      kind: 'session',
      accountId: 'account_1',
      sessionId: 'session_1',
    };
    const publicScope: PeerMediationObservabilityScopeV1 = {
      kind: 'publicPreview',
      publicExposureId: 'exposure_1',
    };

    store.publish(tunnelEvent({ kind: 'flow.ready', emittedAtMs: 1_000, scope: sessionScope, flowId: 'tunnel_a' }));
    store.publish(tunnelEvent({ kind: 'flow.ready', emittedAtMs: 1_000, scope: publicScope, flowId: 'tunnel_b' }));

    expect(peerMediationObservabilityScopeKey(sessionScope))
      .not.toBe(peerMediationObservabilityScopeKey(publicScope));
    expect(store.snapshot(sessionScope).flows.map((flow) => flow.flow.flowId)).toEqual(['tunnel_a']);
    expect(store.snapshot(publicScope).flows.map((flow) => flow.flow.flowId)).toEqual(['tunnel_b']);
    expect(store.snapshot(MACHINE_SCOPE).flows).toEqual([]);
  });

  it('emits a delta whose scope is the event scope, and sequences per scope', () => {
    const store = createPeerMediationObservabilityFlowStore({ nowMs: () => 1_000 });
    const received: number[] = [];
    const unsubscribe = store.subscribe(MACHINE_SCOPE, (delta) => {
      expect(delta.scope).toEqual(MACHINE_SCOPE);
      received.push(delta.sequence);
    });

    store.publish(tunnelEvent({ kind: 'flow.started', emittedAtMs: 1_000 }));
    store.publish(tunnelEvent({ kind: 'flow.ready', emittedAtMs: 1_000 }));
    unsubscribe();
    store.publish(tunnelEvent({ kind: 'flow.closed', emittedAtMs: 1_000 }));

    expect(received).toEqual([1, 2]);
    expect(store.snapshot(MACHINE_SCOPE).sequence).toBe(3);
  });

  it('truncates an oversized event with an explicit marker instead of dropping it', () => {
    const store = createPeerMediationObservabilityFlowStore({
      nowMs: () => 1_000,
      eventPayloadMaxBytes: 1_024,
    });
    const published = store.publish(tunnelEvent({
      kind: 'flow.ready',
      emittedAtMs: 1_000,
      data: { note: 'x'.repeat(4_000) },
    }));

    expect(published.data.payloadTruncated).toBe(true);
    expect(published.data.payloadMaxBytes).toBe(1_024);
    expect(typeof published.data.originalPayloadBytes).toBe('number');
    expect(published.redaction.truncated).toBe(true);
    expect(store.snapshot(MACHINE_SCOPE).flows).toHaveLength(1);
  });
});
