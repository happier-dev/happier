import { describe, expect, it, vi } from 'vitest';
import type { SystemTaskEvent, SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';
import { SystemTaskSpecSchema } from '@happier-dev/protocol';

type BridgeListenerSet = Readonly<{
    onEvent: (payload: unknown) => void;
    onResult: (payload: unknown) => void;
}>;

function createSpec(overrides: Partial<SystemTaskSpec> = {}): SystemTaskSpec {
    return SystemTaskSpecSchema.parse({
        protocolVersion: 1,
        kind: 'setup.thisComputer.v1',
        params: {
            demo: true,
        },
        ...overrides,
    });
}

function createManualBridge() {
    let nextTaskId = 1;
    const listeners = new Map<string, BridgeListenerSet>();
    const cancelMock = vi.fn(async (_taskId: string) => {});
    const respondMock = vi.fn(async (_taskId: string, _answer: unknown) => {});

    return {
        bridge: {
            async start(_spec: SystemTaskSpec) {
                return `task_${nextTaskId++}`;
            },
            async subscribe(taskId: string, listenersForTask: BridgeListenerSet) {
                listeners.set(taskId, listenersForTask);
                return () => {
                    listeners.delete(taskId);
                };
            },
            async cancel(taskId: string) {
                await cancelMock(taskId);
            },
            async respond(taskId: string, answer: unknown) {
                await respondMock(taskId, answer);
            },
        },
        emitEvent(taskId: string, payload: unknown) {
            listeners.get(taskId)?.onEvent(payload);
        },
        emitResult(taskId: string, payload: unknown) {
            listeners.get(taskId)?.onResult(payload);
        },
        cancelMock,
        respondMock,
    };
}

describe('createSystemTaskRunner', () => {
    it('ignores invalid events and converts an invalid result payload into a stable failure result', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec());

        const seenEvents: SystemTaskEvent[] = [];
        const seenResults: SystemTaskResult[] = [];
        runner.subscribe(taskId, (event) => {
            seenEvents.push(event);
        }, (result) => {
            seenResults.push(result);
        });

        manual.emitEvent(taskId, {
            protocolVersion: 1,
            taskId,
            tsMs: 100,
            type: 'progress',
            stepId: 'install.runtime',
            message: 'Installing runtime',
        } satisfies SystemTaskEvent);
        manual.emitEvent(taskId, {
            protocolVersion: 1,
            taskId,
            tsMs: -1,
            type: 'progress',
        });
        manual.emitResult(taskId, {
            protocolVersion: 1,
            taskId,
            ok: true,
            data: Number.NaN,
        });

        expect(seenEvents.map((event) => event.stepId)).toEqual(['install.runtime']);
        expect(seenResults).toEqual([
            {
                protocolVersion: 1,
                taskId,
                ok: false,
                error: {
                    code: 'invalid_system_task_result',
                    message: 'Received an invalid system task result payload.',
                },
            },
        ]);
        expect(runner.getSnapshot(taskId)).toEqual(expect.objectContaining({
            status: 'failed',
            events: [
                expect.objectContaining({
                    stepId: 'install.runtime',
                }),
            ],
            result: {
                protocolVersion: 1,
                taskId,
                ok: false,
                error: {
                    code: 'invalid_system_task_result',
                    message: 'Received an invalid system task result payload.',
                },
            },
        }));
    });

    it('replays stored events in order for late subscribers and stores the final result', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec());

        manual.emitEvent(taskId, {
            protocolVersion: 1,
            taskId,
            tsMs: 100,
            type: 'started',
            stepId: 'prepare',
            message: 'Preparing task',
        } satisfies SystemTaskEvent);
        manual.emitEvent(taskId, {
            protocolVersion: 1,
            taskId,
            tsMs: 200,
            type: 'progress',
            stepId: 'install.runtime',
            message: 'Installing runtime',
        } satisfies SystemTaskEvent);
        manual.emitResult(taskId, {
            protocolVersion: 1,
            taskId,
            ok: true,
            data: {
                daemonReady: true,
            },
        } satisfies SystemTaskResult);

        const replayedSteps: string[] = [];
        let replayedResult: SystemTaskResult | null = null;

        runner.subscribe(taskId, (event) => {
            replayedSteps.push(event.stepId ?? event.type);
        }, (result) => {
            replayedResult = result;
        });

        expect(replayedSteps).toEqual(['prepare', 'install.runtime']);
        expect(replayedResult).toEqual({
            protocolVersion: 1,
            taskId,
            ok: true,
            data: {
                daemonReady: true,
            },
        });
        expect(runner.getSnapshot(taskId)).toEqual(expect.objectContaining({
            status: 'succeeded',
            currentStepId: 'install.runtime',
            result: replayedResult,
        }));
    });

    it('ignores duplicate events when snapshot replay and live delivery carry the same payload', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec());

        const duplicateEvent = {
            protocolVersion: 1,
            taskId,
            tsMs: 100,
            type: 'progress',
            stepId: 'install.runtime',
            message: 'Installing runtime',
        } satisfies SystemTaskEvent;

        manual.emitEvent(taskId, duplicateEvent);
        manual.emitEvent(taskId, duplicateEvent);

        expect(runner.getSnapshot(taskId)?.events).toEqual([duplicateEvent]);
    });

    it('keeps events ordered by timestamp when an earlier event arrives after a later one', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec());

        manual.emitEvent(taskId, {
            protocolVersion: 1,
            taskId,
            tsMs: 200,
            type: 'progress',
            stepId: 'install.runtime',
            message: 'Installing runtime',
        } satisfies SystemTaskEvent);
        manual.emitEvent(taskId, {
            protocolVersion: 1,
            taskId,
            tsMs: 100,
            type: 'started',
            stepId: 'prepare',
            message: 'Preparing task',
        } satisfies SystemTaskEvent);

        expect(runner.getSnapshot(taskId)).toEqual(expect.objectContaining({
            currentStepId: 'install.runtime',
            latestMessage: 'Installing runtime',
            events: [
                expect.objectContaining({
                    tsMs: 100,
                    stepId: 'prepare',
                }),
                expect.objectContaining({
                    tsMs: 200,
                    stepId: 'install.runtime',
                }),
            ],
        }));

        const replayedSteps: string[] = [];
        runner.subscribe(taskId, (event) => {
            replayedSteps.push(event.stepId ?? event.type);
        }, () => {});

        expect(replayedSteps).toEqual(['prepare', 'install.runtime']);
    });

    it('marks the task as canceling immediately and forwards cancel to the bridge', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec());

        await runner.cancel(taskId);

        expect(manual.cancelMock).toHaveBeenCalledWith(taskId);
        expect(runner.getSnapshot(taskId)).toEqual(expect.objectContaining({
            status: 'canceling',
            cancelRequested: true,
        }));
    });

    it('marks a task as canceled when the final result error code is cancelled', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec());

        manual.emitResult(taskId, {
            protocolVersion: 1,
            taskId,
            ok: false,
            error: {
                code: 'cancelled',
                message: 'System task execution was cancelled.',
            },
        });

        expect(runner.getSnapshot(taskId)).toEqual(expect.objectContaining({
            status: 'canceled',
        }));
    });

    it('surfaces the final error message in the snapshot when a task fails', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec());

        manual.emitEvent(taskId, {
            protocolVersion: 1,
            taskId,
            tsMs: 100,
            type: 'progress',
            stepId: 'setup.thisComputer.verifyService',
            message: 'Checking local daemon status',
        } satisfies SystemTaskEvent);
        manual.emitResult(taskId, {
            protocolVersion: 1,
            taskId,
            ok: false,
            error: {
                code: 'daemon_service_not_ready',
                message: 'Daemon service did not reach a ready state for the selected Relay.',
            },
        } satisfies SystemTaskResult);

        expect(runner.getSnapshot(taskId)).toEqual(expect.objectContaining({
            status: 'failed',
            latestMessage: 'Daemon service did not reach a ready state for the selected Relay.',
            result: {
                protocolVersion: 1,
                taskId,
                ok: false,
                error: {
                    code: 'daemon_service_not_ready',
                    message: 'Daemon service did not reach a ready state for the selected Relay.',
                },
            },
        }));
    });

    it('forwards prompt responses to the bridge while the task is awaiting input', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec({
            kind: 'remote.ssh.bootstrapMachine.v1',
            params: {
                ssh: {
                    target: 'dev@example.test',
                    auth: 'agent',
                },
                relay: {
                    relayUrl: 'https://relay.example.test',
                },
                serviceMode: 'user',
            },
        }));

        manual.emitEvent(taskId, {
            protocolVersion: 1,
            taskId,
            tsMs: 100,
            type: 'prompt',
            stepId: 'ssh.hostTrust',
            message: 'Trust this SSH host?',
            data: {
                kind: 'ssh.trustHost',
                host: 'example.test',
                fingerprint: 'SHA256:test',
            },
        } satisfies SystemTaskEvent);

        await runner.respond(taskId, { trusted: true });

        expect(runner.getSnapshot(taskId)).toEqual(expect.objectContaining({
            awaitingInput: true,
            status: 'running',
        }));
        expect(manual.respondMock).toHaveBeenCalledWith(taskId, { trusted: true });
    });
});
