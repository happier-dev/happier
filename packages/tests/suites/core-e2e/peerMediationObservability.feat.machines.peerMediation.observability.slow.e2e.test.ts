import { describe, expect, it } from 'vitest';

import type {
  PeerMediationObservabilityDeltaV1,
  RuntimeActionExecuteArgs,
} from '@happier-dev/protocol';

import { createDaemonPeerMediationFlowEvent } from '../../../../apps/cli/src/daemon/peer/mediation/observability/events';
import { createPeerMediationObservabilityDaemonRuntimeActionExecutor } from '../../../../apps/cli/src/daemon/peer/mediation/observability/runtimeActionExecutor';
import { createDaemonPeerMediationObservabilityStore } from '../../../../apps/cli/src/daemon/peer/mediation/observability/store';

/**
 * §23 peer-mediation observability read-path (LANE-PMS / PMS-1 / finding #49 / DEF-14..16).
 *
 * The write-path (store + emitter wired into the relay terminators at machine-sync bootstrap) was
 * already live, but the read-path was DEAD: the runtime store was never consumed and the three
 * `peerMediation.observability.{snapshot,subscribe,unsubscribe}` ActionSpecs had no executor.
 *
 * This drives the REAL assembled daemon read-path — `createPeerMediationObservabilityDaemonRuntimeActionExecutor`
 * over a REAL `createDaemonPeerMediationObservabilityStore`, seeded with REAL flow lifecycle events
 * produced by `createDaemonPeerMediationFlowEvent` — exactly the modules `dispatchExecutionRunRpcAction`
 * wires in production. No internal mocks: the store, the executor, the event producer and the feature
 * gate are the production singletons. It proves the executor returns LIVE counters (byte totals
 * accumulated across a flow lifecycle), the subscribe snapshot-cursor + out-of-band push sink, and
 * the fail-closed scope/feature gates.
 */

const ACCOUNT_ID = 'account_pms_e2e';
const MACHINE_ID = 'machine_pms_e2e';

function machineScope() {
  return { kind: 'machine' as const, accountId: ACCOUNT_ID, machineId: MACHINE_ID };
}

function enabledFeaturePayload() {
  return {
    features: {
      machines: {
        enabled: true,
        peerMediation: { enabled: true, observability: { enabled: true } },
      },
    },
  };
}

function disabledFeaturePayload() {
  return {
    features: {
      machines: {
        enabled: true,
        peerMediation: { enabled: true, observability: { enabled: false } },
      },
    },
  };
}

function runtimeArgs(
  args: Omit<RuntimeActionExecuteArgs, 'context'> & Partial<Pick<RuntimeActionExecuteArgs, 'context'>>,
): RuntimeActionExecuteArgs {
  return { context: {}, ...args } as RuntimeActionExecuteArgs;
}

function createHarness(overrides?: Readonly<{
  featurePayload?: unknown;
  emitDelta?: (delta: PeerMediationObservabilityDeltaV1) => void;
}>) {
  const store = createDaemonPeerMediationObservabilityStore({ nowMs: () => 1_000 });
  const executor = createPeerMediationObservabilityDaemonRuntimeActionExecutor({
    store,
    accountId: ACCOUNT_ID,
    machineId: MACHINE_ID,
    featurePayload: overrides?.featurePayload ?? enabledFeaturePayload(),
    ...(overrides?.emitDelta ? { emitDelta: overrides.emitDelta } : {}),
  });
  return { store, executor };
}

/** Seed a realistic tunnel flow lifecycle: started → two byte-bearing activity events → ready. */
function seedTunnelFlowWithBytes(
  store: ReturnType<typeof createDaemonPeerMediationObservabilityStore>,
  flowId: string,
  nowMs: number,
): void {
  store.publish(createDaemonPeerMediationFlowEvent({
    accountId: ACCOUNT_ID,
    machineId: MACHINE_ID,
    flowKind: 'tcp_tunnel',
    flowId,
    kind: 'flow.started',
    nowMs,
  }));
  store.publish(createDaemonPeerMediationFlowEvent({
    accountId: ACCOUNT_ID,
    machineId: MACHINE_ID,
    flowKind: 'tcp_tunnel',
    flowId,
    kind: 'http.request.finished',
    nowMs: nowMs + 5,
    bytesIn: 1_024,
    bytesOut: 2_048,
  }));
  store.publish(createDaemonPeerMediationFlowEvent({
    accountId: ACCOUNT_ID,
    machineId: MACHINE_ID,
    flowKind: 'tcp_tunnel',
    flowId,
    kind: 'flow.ready',
    nowMs: nowMs + 10,
    bytesIn: 512,
    bytesOut: 256,
  }));
}

describe('core e2e: peer-mediation observability read-path returns live counters (LANE-PMS)', () => {
  it('returns a live snapshot with byte counters accumulated across the flow lifecycle', async () => {
    const { store, executor } = createHarness();
    seedTunnelFlowWithBytes(store, 'tunnel_live_1', 1_000);

    const result = await executor(runtimeArgs({ actionId: 'peerMediation.observability.snapshot', input: {} }));

    expect(result).toMatchObject({ ok: true });
    const snapshot = (result as Readonly<{ snapshot: { scope: unknown; sequence: number; flows: ReadonlyArray<{ flow: { flowId: string }; bytesIn: number; bytesOut: number }> } }>).snapshot;
    expect(snapshot.scope).toEqual(machineScope());
    const flow = snapshot.flows.find((f) => f.flow.flowId === 'tunnel_live_1');
    expect(flow).toBeDefined();
    // Live counters: bytes accumulate across the lifecycle events (1024+512 in, 2048+256 out).
    expect(flow?.bytesIn).toBe(1_536);
    expect(flow?.bytesOut).toBe(2_304);
    // The sequence advances as flows are published (a live cursor, not a static zero).
    expect(snapshot.sequence).toBeGreaterThan(0);
  });

  it('reflects newly published flows in a fresh snapshot (live, not cached)', async () => {
    const { store, executor } = createHarness();
    seedTunnelFlowWithBytes(store, 'tunnel_a', 1_000);
    const first = await executor(runtimeArgs({ actionId: 'peerMediation.observability.snapshot', input: {} }));
    const firstSeq = (first as Readonly<{ snapshot: { sequence: number; flows: ReadonlyArray<unknown> } }>).snapshot;
    expect(firstSeq.flows).toHaveLength(1);

    seedTunnelFlowWithBytes(store, 'tunnel_b', 2_000);
    const second = await executor(runtimeArgs({ actionId: 'peerMediation.observability.snapshot', input: {} }));
    const secondSeq = (second as Readonly<{ snapshot: { sequence: number; flows: ReadonlyArray<unknown> } }>).snapshot;
    expect(secondSeq.flows).toHaveLength(2);
    expect(secondSeq.sequence).toBeGreaterThan(firstSeq.sequence);
  });

  it('subscribe returns the initial snapshot+cursor and forwards live deltas to the out-of-band push sink', async () => {
    const deltas: PeerMediationObservabilityDeltaV1[] = [];
    const { store, executor } = createHarness({ emitDelta: (delta) => deltas.push(delta) });
    seedTunnelFlowWithBytes(store, 'tunnel_sub_1', 1_000);

    const subscribed = await executor(runtimeArgs({
      actionId: 'peerMediation.observability.subscribe',
      input: { scope: machineScope() },
    }));
    expect(subscribed).toMatchObject({ ok: true });
    const cursor = (subscribed as Readonly<{ sequence: number; snapshot: { flows: ReadonlyArray<unknown> } }>);
    expect(cursor.sequence).toBeGreaterThan(0);
    expect(cursor.snapshot.flows.length).toBeGreaterThan(0);

    // A subsequently published flow is pushed live to the sink (the relay streams deltas).
    store.publish(createDaemonPeerMediationFlowEvent({
      accountId: ACCOUNT_ID,
      machineId: MACHINE_ID,
      flowKind: 'tcp_tunnel',
      flowId: 'tunnel_sub_2',
      kind: 'flow.started',
      nowMs: 2_000,
    }));
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.events.map((event) => event.flow.flowId)).toEqual(['tunnel_sub_2']);

    const unsubscribed = await executor(runtimeArgs({
      actionId: 'peerMediation.observability.unsubscribe',
      input: { scope: machineScope() },
    }));
    expect(unsubscribed).toMatchObject({ ok: true });
  });

  it('fails closed when the observability read feature is disabled', async () => {
    const { store, executor } = createHarness({ featurePayload: disabledFeaturePayload() });
    seedTunnelFlowWithBytes(store, 'tunnel_gated', 1_000);

    const result = await executor(runtimeArgs({ actionId: 'peerMediation.observability.snapshot', input: {} }));
    expect(result).toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:peerMediation:peer_mediation_observability_read_unavailable',
    });
  });

  it('forbids reading another machine/account scope', async () => {
    const { executor } = createHarness();
    const snapshotForbidden = await executor(runtimeArgs({
      actionId: 'peerMediation.observability.snapshot',
      input: { machineId: 'machine_other' },
    }));
    expect(snapshotForbidden).toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:peerMediation:observability_scope_forbidden',
    });

    const subscribeForbidden = await executor(runtimeArgs({
      actionId: 'peerMediation.observability.subscribe',
      input: { scope: { kind: 'machine', accountId: ACCOUNT_ID, machineId: 'machine_other' } },
    }));
    expect(subscribeForbidden).toMatchObject({
      ok: false,
      errorCode: 'runtime_action_disabled',
    });
  });
});
