import { describe, expect, it, vi } from 'vitest';

import type {
    PeerMediationObservabilityDeltaV1,
    RuntimeActionExecuteArgs,
} from '@happier-dev/protocol';

import { createDaemonPeerMediationFlowEvent } from './events';
import { createPeerMediationObservabilityDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import { createDaemonPeerMediationObservabilityStore } from './store';

const ACCOUNT_ID = 'account_1';
const MACHINE_ID = 'machine_1';

function runtimeArgs(
    args: Omit<RuntimeActionExecuteArgs, 'context'> & Partial<Pick<RuntimeActionExecuteArgs, 'context'>>,
): RuntimeActionExecuteArgs {
    return {
        context: {},
        ...args,
    };
}

function enabledFeaturePayload() {
    return {
        features: {
            machines: {
                enabled: true,
                peerMediation: {
                    enabled: true,
                    observability: { enabled: true },
                },
            },
        },
    };
}

function disabledFeaturePayload() {
    return {
        features: {
            machines: {
                enabled: true,
                peerMediation: {
                    enabled: true,
                    observability: { enabled: false },
                },
            },
        },
    };
}

function machineScope() {
    return { kind: 'machine' as const, accountId: ACCOUNT_ID, machineId: MACHINE_ID };
}

function publishFlow(store: ReturnType<typeof createDaemonPeerMediationObservabilityStore>, flowId: string) {
    store.publish(createDaemonPeerMediationFlowEvent({
        accountId: ACCOUNT_ID,
        machineId: MACHINE_ID,
        flowKind: 'tcp_tunnel',
        flowId,
        kind: 'flow.started',
        nowMs: 1_000,
    }));
}

function createExecutorHarness(overrides?: Readonly<{
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

describe('createPeerMediationObservabilityDaemonRuntimeActionExecutor', () => {
    it('returns the store snapshot for the daemon scope', async () => {
        const { store, executor } = createExecutorHarness();
        publishFlow(store, 'tunnel_1');

        const result = await executor(runtimeArgs({ actionId: 'peerMediation.observability.snapshot', input: {} }));

        expect(result).toMatchObject({
            ok: true,
            snapshot: {
                v: 1,
                scope: machineScope(),
                flows: [expect.objectContaining({ flow: expect.objectContaining({ flowId: 'tunnel_1' }) })],
            },
        });
    });

    it('fails closed when the observability read feature is disabled', async () => {
        const { store, executor } = createExecutorHarness({ featurePayload: disabledFeaturePayload() });
        publishFlow(store, 'tunnel_1');

        const result = await executor(runtimeArgs({ actionId: 'peerMediation.observability.snapshot', input: {} }));

        expect(result).toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:peerMediation:peer_mediation_observability_read_unavailable',
        });
    });

    it('forbids a snapshot for a different machine id', async () => {
        const { executor } = createExecutorHarness();

        const result = await executor(runtimeArgs({
            actionId: 'peerMediation.observability.snapshot',
            input: { machineId: 'machine_other' },
        }));

        expect(result).toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:peerMediation:observability_scope_forbidden',
        });
    });

    it('subscribes, returns the initial snapshot, and forwards deltas to the push sink', async () => {
        const deltas: PeerMediationObservabilityDeltaV1[] = [];
        const { store, executor } = createExecutorHarness({ emitDelta: (delta) => deltas.push(delta) });
        publishFlow(store, 'tunnel_1');

        const subscribed = await executor(runtimeArgs({
            actionId: 'peerMediation.observability.subscribe',
            input: { scope: machineScope() },
        }));
        expect(subscribed).toMatchObject({ ok: true, sequence: 1 });

        publishFlow(store, 'tunnel_2');

        expect(deltas).toHaveLength(1);
        expect(deltas[0]?.events.map((event) => event.flow.flowId)).toEqual(['tunnel_2']);
    });

    it('PMS-1 poll-backed: with no push sink, subscribe returns a snapshot+sequence cursor without registering a dead listener', async () => {
        // Production config (dispatchExecutionRunRpcAction) supplies NO `emitDelta`: the daemon
        // control RPC is request/response, so subscribe is an honest snapshot-cursor, not a faked
        // live push. It must NOT register a store listener that forwards to nothing.
        const { store, executor } = createExecutorHarness();
        const subscribeSpy = vi.spyOn(store, 'subscribe');
        publishFlow(store, 'tunnel_1');

        const subscribed = await executor(runtimeArgs({
            actionId: 'peerMediation.observability.subscribe',
            input: { scope: machineScope() },
        }));

        expect(subscribed).toMatchObject({ ok: true, sequence: expect.any(Number) });
        expect(subscribeSpy).not.toHaveBeenCalled();

        // The caller advances by re-polling the snapshot; the sequence reflects new flows.
        const before = subscribed as Readonly<{ sequence: number }>;
        publishFlow(store, 'tunnel_2');
        const polled = await executor(runtimeArgs({ actionId: 'peerMediation.observability.snapshot', input: {} }));
        expect(polled).toMatchObject({ ok: true, snapshot: { sequence: expect.any(Number) } });
        const after = polled as Readonly<{ snapshot: { sequence: number } }>;
        expect(after.snapshot.sequence).toBeGreaterThan(before.sequence);

        // unsubscribe is poll-safe even when nothing was registered.
        const unsubscribed = await executor(runtimeArgs({
            actionId: 'peerMediation.observability.unsubscribe',
            input: { scope: machineScope() },
        }));
        expect(unsubscribed).toEqual({ ok: true });
    });

    it('replaces a prior subscription so deltas are not duplicated', async () => {
        const deltas: PeerMediationObservabilityDeltaV1[] = [];
        const { store, executor } = createExecutorHarness({ emitDelta: (delta) => deltas.push(delta) });

        await executor(runtimeArgs({ actionId: 'peerMediation.observability.subscribe', input: { scope: machineScope() } }));
        await executor(runtimeArgs({ actionId: 'peerMediation.observability.subscribe', input: { scope: machineScope() } }));

        publishFlow(store, 'tunnel_1');

        expect(deltas).toHaveLength(1);
    });

    it('stops forwarding deltas after unsubscribe disposes the subscription', async () => {
        const deltas: PeerMediationObservabilityDeltaV1[] = [];
        const { store, executor } = createExecutorHarness({ emitDelta: (delta) => deltas.push(delta) });

        await executor(runtimeArgs({ actionId: 'peerMediation.observability.subscribe', input: { scope: machineScope() } }));
        const unsubscribed = await executor(runtimeArgs({
            actionId: 'peerMediation.observability.unsubscribe',
            input: { scope: machineScope() },
        }));
        expect(unsubscribed).toEqual({ ok: true });

        publishFlow(store, 'tunnel_1');

        expect(deltas).toHaveLength(0);
    });

    it('forbids subscribing to another account/machine scope', async () => {
        const { executor } = createExecutorHarness();

        const result = await executor(runtimeArgs({
            actionId: 'peerMediation.observability.subscribe',
            input: { scope: { kind: 'machine', accountId: 'account_other', machineId: MACHINE_ID } },
        }));

        expect(result).toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:peerMediation:observability_scope_forbidden',
        });
    });

    it('rejects subscribe input without a scope', async () => {
        const { executor } = createExecutorHarness();

        const result = await executor(runtimeArgs({ actionId: 'peerMediation.observability.subscribe', input: {} }));

        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    });

    it('delegates non-peer-mediation actions to the fallback executor', async () => {
        const fallback = vi.fn().mockResolvedValue({ ok: true, delegated: true });
        const store = createDaemonPeerMediationObservabilityStore({ nowMs: () => 1_000 });
        const executor = createPeerMediationObservabilityDaemonRuntimeActionExecutor({
            store,
            accountId: ACCOUNT_ID,
            machineId: MACHINE_ID,
            featurePayload: enabledFeaturePayload(),
            fallback,
        });

        const result = await executor(runtimeArgs({ actionId: 'localServices.inventory.list', input: {} }));

        expect(result).toEqual({ ok: true, delegated: true });
        expect(fallback).toHaveBeenCalledOnce();
    });
});
