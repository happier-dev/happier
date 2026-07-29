import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import { createDaemonPeerMediationObservabilityRuntime } from '@/daemon/machine/peerMediationObservabilityRuntime';
import { createDaemonPeerMediationFlowEvent } from '@/daemon/peer/mediation/observability/events';
import type { DaemonPeerMediationObservabilityRuntimeActionContext } from '@/daemon/peer/mediation/observability/runtimeActionExecutor';
import { installPeerMediationObservabilityRuntimeActionContextProvider } from '@/daemon/peer/mediation/observability/runtimeActionContextProvider';

import { createExecutionRunRpcActionDeps } from './dispatchExecutionRunRpcAction';

/**
 * PMS-WIRE read-path assembly contract. The dispatch chain must read the shared observability store
 * back from the Api provider bridge (`peerMediationObservability` context bundle) and route the
 * `peerMediation.observability.*` runtime actions to an executor over that SAME store, fail-closed on
 * the server feature gate. This is the reader half of the writer↔reader shared-store wiring.
 */

const ACCOUNT_ID = 'account_dispatch';
const MACHINE_ID = 'machine_dispatch';

// CliServerFeaturesSnapshot.features is itself a FeaturesResponse (`{ features, capabilities }`),
// so the observability read-gate sees the nested `features.machines.peerMediation.observability` bit.
function serverFeaturesSnapshot(observabilityEnabled: boolean) {
    return {
        status: 'ready' as const,
        features: {
            features: {
                machines: {
                    enabled: true,
                    peerMediation: {
                        enabled: true,
                        observability: { enabled: observabilityEnabled },
                    },
                },
            },
        },
    };
}

function enabledServerFeaturesSnapshot() {
    return serverFeaturesSnapshot(true);
}

function disabledServerFeaturesSnapshot() {
    return serverFeaturesSnapshot(false);
}

const stubManager = {} as ExecutionRunHostBridgeContract;

function tokenWithPayload(payload: Readonly<Record<string, unknown>>): string {
    return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function buildRuntimeActionExecute(input: Readonly<{
    runtime: ReturnType<typeof createDaemonPeerMediationObservabilityRuntime>;
    enabled: boolean;
}>) {
    const deps = createExecutionRunRpcActionDeps({
        manager: stubManager,
        policy: {
            allowIoModes: new Set(['headless']),
            maxConcurrentRuns: null,
            maxDepth: 8,
        } as never,
        isExecutionRunsEnabled: () => true,
        context: {
            sessionId: 'session_dispatch',
            cwd: '/tmp/pms-wire',
            peerMediationObservability: {
                store: input.runtime.store,
                accountId: ACCOUNT_ID,
                machineId: MACHINE_ID,
            },
            getServerFeaturesSnapshot: () =>
                (input.enabled ? enabledServerFeaturesSnapshot() : disabledServerFeaturesSnapshot()),
        } as never,
    });
    return deps.runtimeActionExecute as (args: Readonly<{
        actionId: string;
        input: unknown;
        context: Record<string, unknown>;
    }>) => Promise<unknown>;
}

describe('peer-mediation observability dispatch wiring', () => {
    it('routes snapshot through the dispatch chain to the shared store', async () => {
        const runtime = createDaemonPeerMediationObservabilityRuntime({ nowMs: () => 1_000 });
        runtime.emitter.emit(createDaemonPeerMediationFlowEvent({
            accountId: ACCOUNT_ID,
            machineId: MACHINE_ID,
            flowKind: 'tcp_tunnel',
            flowId: 'tunnel_dispatch',
            kind: 'flow.started',
            nowMs: 1_000,
        }));

        const runtimeActionExecute = buildRuntimeActionExecute({ runtime, enabled: true });
        const result = await runtimeActionExecute({
            actionId: 'peerMediation.observability.snapshot',
            input: {},
            context: {},
        });

        expect(result).toMatchObject({
            ok: true,
            snapshot: {
                scope: { kind: 'machine', accountId: ACCOUNT_ID, machineId: MACHINE_ID },
                flows: [expect.objectContaining({ flow: expect.objectContaining({ flowId: 'tunnel_dispatch' }) })],
            },
        });
    });

    it('fails closed at the execution boundary when the server feature gate is disabled', async () => {
        const runtime = createDaemonPeerMediationObservabilityRuntime({ nowMs: () => 1_000 });
        runtime.emitter.emit(createDaemonPeerMediationFlowEvent({
            accountId: ACCOUNT_ID,
            machineId: MACHINE_ID,
            flowKind: 'tcp_tunnel',
            flowId: 'tunnel_blocked',
            kind: 'flow.started',
            nowMs: 1_000,
        }));

        const runtimeActionExecute = buildRuntimeActionExecute({ runtime, enabled: false });
        const result = await runtimeActionExecute({
            actionId: 'peerMediation.observability.snapshot',
            input: {},
            context: {},
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'runtime_action_disabled',
        });
    });

    it('installs the startup provider from the JWT subject and dispatches through that provider context', async () => {
        const runtime = createDaemonPeerMediationObservabilityRuntime({ nowMs: () => 1_000 });
        const captured: {
            calls: number;
            provider?: () => DaemonPeerMediationObservabilityRuntimeActionContext | null;
        } = { calls: 0 };
        const api = {
            setPeerMediationObservabilityRuntimeActionContextProvider(
                next: (() => DaemonPeerMediationObservabilityRuntimeActionContext | null) | null,
            ) {
                captured.calls += 1;
                if (next) {
                    captured.provider = next;
                }
            },
        };
        installPeerMediationObservabilityRuntimeActionContextProvider({
            api,
            credentialsToken: tokenWithPayload({ sub: ACCOUNT_ID }),
            runtime,
            machineId: () => MACHINE_ID,
            logger: { warn: vi.fn() },
        });
        runtime.emitter.emit(createDaemonPeerMediationFlowEvent({
            accountId: ACCOUNT_ID,
            machineId: MACHINE_ID,
            flowKind: 'tcp_tunnel',
            flowId: 'tunnel_startup',
            kind: 'flow.started',
            nowMs: 1_000,
        }));

        const installedProvider = captured.provider;
        expect(installedProvider).toBeTypeOf('function');
        if (!installedProvider) {
            throw new Error('expected peer mediation observability startup provider to be installed');
        }
        const context = installedProvider();
        expect(context).toMatchObject({ accountId: ACCOUNT_ID, machineId: MACHINE_ID });
        const deps = createExecutionRunRpcActionDeps({
            manager: stubManager,
            policy: {
                allowIoModes: new Set(['headless']),
                maxConcurrentRuns: null,
                maxDepth: 8,
            } as never,
            isExecutionRunsEnabled: () => true,
            context: {
                sessionId: 'session_dispatch',
                cwd: '/tmp/pms-wire',
                peerMediationObservability: context,
                getServerFeaturesSnapshot: enabledServerFeaturesSnapshot,
            } as never,
        });
        const result = await (deps.runtimeActionExecute as (args: Readonly<{
            actionId: string;
            input: unknown;
            context: Record<string, unknown>;
        }>) => Promise<unknown>)({
            actionId: 'peerMediation.observability.snapshot',
            input: {},
            context: {},
        });

        expect(captured.calls).toBe(1);
        expect(result).toMatchObject({
            ok: true,
            snapshot: {
                scope: { kind: 'machine', accountId: ACCOUNT_ID, machineId: MACHINE_ID },
                flows: [expect.objectContaining({ flow: expect.objectContaining({ flowId: 'tunnel_startup' }) })],
            },
        });
    });

    it('surfaces a diagnostic when the startup JWT has no subject and leaves the provider unset', () => {
        const runtime = createDaemonPeerMediationObservabilityRuntime({ nowMs: () => 1_000 });
        const api = {
            setPeerMediationObservabilityRuntimeActionContextProvider: vi.fn(),
        };
        const logger = { warn: vi.fn() };

        installPeerMediationObservabilityRuntimeActionContextProvider({
            api,
            credentialsToken: tokenWithPayload({}),
            runtime,
            machineId: () => MACHINE_ID,
            logger,
        });

        expect(api.setPeerMediationObservabilityRuntimeActionContextProvider).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Peer mediation observability read-path disabled'),
            expect.objectContaining({ reason: 'jwt_sub_missing' }),
        );
    });
});
