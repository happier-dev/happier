import { describe, expect, it, vi } from 'vitest';

import type {
    RuntimeActionExecuteArgs,
    SimulatorPreviewActionResultV1,
    SimulatorPreviewSnapshotV1,
} from '@happier-dev/protocol';

function runtimeArgs(
    args: Omit<RuntimeActionExecuteArgs, 'context'> & Partial<Pick<RuntimeActionExecuteArgs, 'context'>>,
): RuntimeActionExecuteArgs {
    return {
        context: {},
        ...args,
    };
}

const snapshot: SimulatorPreviewSnapshotV1 = {
    v: 1,
    machineId: 'machine_1',
    generatedAt: 2_000,
    refreshState: 'idle',
    resources: [],
    diagnostics: [],
};

const acceptedControlResult: SimulatorPreviewActionResultV1 = {
    v: 1,
    eventType: 'simulator.control.send',
    status: 'accepted',
    diagnostics: [],
};

describe('UI simulator runtime action executor', () => {
    it('maps devices.simulator.list to the simulator snapshot machine route without exposing raw RPC ids', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorPreviewRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewRuntimeActionExecutor) return;

        const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot }));
        const dispatchAction = vi.fn(async () => ({ ok: true as const, result: acceptedControlResult }));
        const execute = mod.createSimulatorPreviewRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            fetchSnapshot,
            dispatchAction,
        });

        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.list',
            input: { type: 'simulator.devices.list' },
            context: { serverId: 'server_1' },
        }))).resolves.toEqual(snapshot);
        expect(fetchSnapshot).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
        });
        expect(dispatchAction).not.toHaveBeenCalled();
    });

    it('maps simulator input actions to the daemon simulator action route and preserves the event payload', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorPreviewRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewRuntimeActionExecutor) return;

        const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot }));
        const dispatchAction = vi.fn(async () => ({ ok: true as const, result: acceptedControlResult }));
        const execute = mod.createSimulatorPreviewRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            fetchSnapshot,
            dispatchAction,
        });
        const event = {
            type: 'simulator.control.send' as const,
            control: {
                v: 1 as const,
                kind: 'tap' as const,
                streamId: 'stream_1',
                sourceId: 'source_1',
                eventId: 'tap_1',
                leaseId: 'lease_1',
                x: 0.5,
                y: 0.25,
            },
        };

        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.input.tap',
            input: event,
            context: { serverId: 'server_1' },
        }))).resolves.toEqual(acceptedControlResult);
        expect(dispatchAction).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            event,
        });
        expect(fetchSnapshot).not.toHaveBeenCalled();
    });

    it('fails closed when no machine target can be resolved for the simulator action', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorPreviewRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewRuntimeActionExecutor) return;

        const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot }));
        const dispatchAction = vi.fn(async () => ({ ok: true as const, result: acceptedControlResult }));
        const execute = mod.createSimulatorPreviewRuntimeActionExecutor({
            resolveMachineId: () => null,
            fetchSnapshot,
            dispatchAction,
        });

        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.list',
            input: { type: 'simulator.devices.list' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:devices.simulator:simulator_machine_unavailable',
        });
        expect(fetchSnapshot).not.toHaveBeenCalled();
        expect(dispatchAction).not.toHaveBeenCalled();
    });

    it('keeps statically-unbacked simulator orientation actions and non-simulator families fail-closed', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorPreviewRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewRuntimeActionExecutor) return;

        const execute = mod.createSimulatorPreviewRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            fetchSnapshot: vi.fn(async () => ({ ok: true as const, snapshot })),
            dispatchAction: vi.fn(async () => ({ ok: true as const, result: acceptedControlResult })),
        });

        // Absolute orientation has no scrcpy producer path → statically-unbacked, pre-denied.
        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.input.orientation',
            input: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'orientation',
                    streamId: 'stream_1',
                    sourceId: 'source_1',
                    eventId: 'orientation_1',
                    leaseId: 'lease_1',
                    orientation: 'landscapeLeft',
                },
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:devices.simulator:simulator_runtime_action_unbacked',
        });

        await expect(execute(runtimeArgs({
            actionId: 'browser.navigate',
            input: {
                commandId: 'cmd_1',
                kind: 'navigate',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                url: 'https://example.com',
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:runtime_family_unimplemented',
        });
    });

    it('keeps absolute orientation disabled but forwards encoder-control stream actions to the daemon (resource-gated)', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorPreviewRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewRuntimeActionExecutor) return;

        const dispatchAction = vi.fn(async () => ({ ok: true as const, result: acceptedControlResult }));
        const execute = mod.createSimulatorPreviewRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            fetchSnapshot: vi.fn(async () => ({ ok: true as const, snapshot })),
            dispatchAction,
            createEventId: () => 'fps_event',
        });
        const disabledResult = {
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:devices.simulator:simulator_runtime_action_unbacked',
        };

        // The Android scrcpy server-restart producer backs every encoder-control stream action, so
        // these are now resource-gated: the UI forwards them to the daemon (sole authority) rather
        // than pre-denying them. The daemon makes the final resource-gated decision.
        const forwardedStreamActions: readonly RuntimeActionExecuteArgs[] = [
            runtimeArgs({
                actionId: 'devices.simulator.stream.keyframe',
                input: {
                    type: 'simulator.keyframe.request',
                    simulatorId: 'sim_1',
                    streamId: 'stream_1',
                    sourceId: 'source_1',
                    control: {
                        v: 1,
                        kind: 'request_keyframe',
                        streamId: 'stream_1',
                        sourceId: 'source_1',
                        eventId: 'keyframe_1',
                    },
                },
            }),
            runtimeArgs({
                actionId: 'devices.simulator.stream.snapshot',
                input: {
                    type: 'simulator.snapshot.request',
                    simulatorId: 'sim_1',
                    streamId: 'stream_1',
                    sourceId: 'source_1',
                    eventId: 'snapshot_1',
                },
            }),
            runtimeArgs({
                actionId: 'devices.simulator.stream.quality.set',
                input: {
                    type: 'simulator.quality.set',
                    simulatorId: 'sim_1',
                    streamId: 'stream_1',
                    sourceId: 'source_1',
                    control: {
                        v: 1,
                        kind: 'set_quality',
                        streamId: 'stream_1',
                        sourceId: 'source_1',
                        eventId: 'quality_1',
                        maxFramesPerSecond: 24,
                    },
                },
            }),
            runtimeArgs({
                actionId: 'devices.simulator.stream.fps.set',
                input: {
                    simulatorId: 'sim_1',
                    streamId: 'stream_1',
                    sourceId: 'source_1',
                    value: 12,
                },
            }),
            runtimeArgs({
                actionId: 'devices.simulator.stream.scale.set',
                input: {
                    simulatorId: 'sim_1',
                    streamId: 'stream_1',
                    sourceId: 'source_1',
                    value: 0.5,
                },
            }),
        ];

        for (const args of forwardedStreamActions) {
            await expect(execute(args)).resolves.toEqual(acceptedControlResult);
        }
        expect(dispatchAction).toHaveBeenCalledTimes(forwardedStreamActions.length);

        // Absolute orientation has no scrcpy producer path → still statically-unbacked + pre-denied.
        dispatchAction.mockClear();
        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.input.orientation',
            input: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'orientation',
                    streamId: 'stream_1',
                    sourceId: 'source_1',
                    eventId: 'orientation_1',
                    leaseId: 'lease_1',
                    orientation: 'landscapeLeft',
                },
            },
        }))).resolves.toEqual(disabledResult);
        expect(dispatchAction).not.toHaveBeenCalled();
    });

    it('forwards resource-gated scrcpy gestures to the daemon instead of pre-denying them (M1)', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorPreviewRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewRuntimeActionExecutor) return;

        const dispatchAction = vi.fn(async () => ({ ok: true as const, result: acceptedControlResult }));
        const execute = mod.createSimulatorPreviewRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            fetchSnapshot: vi.fn(async () => ({ ok: true as const, snapshot })),
            dispatchAction,
        });

        // The UI defers resource-gated/statically-backed decisions to the daemon (sole authority).
        const forwardedActions: readonly RuntimeActionExecuteArgs[] = [
            runtimeArgs({
                actionId: 'devices.simulator.input.pinch',
                input: {
                    type: 'simulator.control.send',
                    control: {
                        v: 1,
                        kind: 'pinch',
                        streamId: 'stream_1',
                        sourceId: 'source_1',
                        eventId: 'pinch_1',
                        leaseId: 'lease_1',
                        centerX: 0.5,
                        centerY: 0.5,
                        startDistance: 0.2,
                        endDistance: 0.5,
                    },
                },
                context: { serverId: 'server_1' },
            }),
            runtimeArgs({
                actionId: 'devices.simulator.input.rotate',
                input: {
                    type: 'simulator.control.send',
                    control: {
                        v: 1,
                        kind: 'rotate',
                        streamId: 'stream_1',
                        sourceId: 'source_1',
                        eventId: 'rotate_1',
                        leaseId: 'lease_1',
                        centerX: 0.5,
                        centerY: 0.5,
                        radius: 0.25,
                        startAngle: 0,
                        endAngle: 90,
                    },
                },
                context: { serverId: 'server_1' },
            }),
        ];

        for (const args of forwardedActions) {
            await expect(execute(args)).resolves.toEqual(acceptedControlResult);
        }
        expect(dispatchAction).toHaveBeenCalledTimes(forwardedActions.length);
    });

    it('keeps non-produced sideband runtime actions disabled without dispatching daemon actions', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorPreviewRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewRuntimeActionExecutor) return;

        const dispatchAction = vi.fn(async () => ({ ok: true as const, result: acceptedControlResult }));
        const execute = mod.createSimulatorPreviewRuntimeActionExecutor({
            resolveMachineId: () => 'machine_1',
            fetchSnapshot: vi.fn(async () => ({ ok: true as const, snapshot })),
            dispatchAction,
        });

        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.sideband.request',
            input: {
                type: 'simulator.sideband.request',
                simulatorId: 'sim_1',
                kind: 'logs',
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:devices.simulator:simulator_sideband_unbacked',
        });
        expect(dispatchAction).not.toHaveBeenCalled();
    });
});
