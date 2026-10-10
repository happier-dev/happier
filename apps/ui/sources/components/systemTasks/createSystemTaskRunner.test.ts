import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemTaskEvent, SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';
import { SystemTaskSpecSchema } from '@happier-dev/protocol';

afterEach(() => vi.restoreAllMocks());

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
    it('admits one scoped setup before native start returns and permits a new run after settlement or launch failure', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        let finishStart!: (taskId: string) => void;
        const start = vi.fn<(spec: SystemTaskSpec) => Promise<string>>()
            .mockImplementationOnce(() => new Promise<string>((resolve) => { finishStart = resolve; }))
            .mockResolvedValue('task_other');
        const runner = createSystemTaskRunner({ bridge: { ...manual.bridge, start } });
        const spec = createSpec({ params: {
            activeRelayUrl: 'https://runner-setup.example', activeServerIdentityId: 'home-a', activeAccountId: 'account-a',
        } });
        const first = runner.start(spec);
        const adopted = runner.start({ ...spec, kind: 'setup.repairThisComputer.v1' });
        await expect(runner.start(spec, undefined, { adoptExisting: false })).rejects.toMatchObject({
            code: 'system_task_setup_in_progress',
        });
        if (!spec.params || typeof spec.params !== 'object' || Array.isArray(spec.params)) throw new Error('Expected setup parameter object');
        await expect(runner.start({ ...spec, params: { ...spec.params, activeAccountId: 'account-b' } })).rejects.toMatchObject({
            code: 'system_task_setup_in_progress',
        });
        expect(start).toHaveBeenCalledTimes(1);
        finishStart('task_setup');
        expect(await first).toBe('task_setup');
        expect(await adopted).toBe('task_setup');
        expect(await runner.start(spec)).toBe('task_setup');
        manual.emitResult('task_setup', { protocolVersion: 1, taskId: 'task_setup', ok: false,
            error: { code: 'cancelled', message: 'Stopped' } } satisfies SystemTaskResult);
        start.mockRejectedValueOnce(new Error('native launch failed')).mockResolvedValue('task_next');
        await expect(runner.start(spec)).rejects.toThrow('native launch failed');
        expect(await runner.start(spec)).toBe('task_next');
    });

    it('retires the bridge subscription when registration delivers an already-completed result', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        let activeSubscriptions = 0;
        const runner = createSystemTaskRunner({ bridge: {
            ...manual.bridge,
            // Native registration replays a snapshot before returning its SDK unlisten handle.
            async subscribe(taskId: string, listeners: BridgeListenerSet) {
                activeSubscriptions += 1;
                listeners.onResult({ protocolVersion: 1, taskId, ok: true, data: { completed: true } } satisfies SystemTaskResult);
                await Promise.resolve();
                return () => { activeSubscriptions -= 1; };
            },
        } });
        const spec = createSpec({ params: { activeRelayUrl: 'https://already-completed.example', activeAccountId: 'account-a' } });
        const taskId = await runner.start(spec);
        expect(runner.getSnapshot(taskId)?.result).toMatchObject({ ok: true, data: { completed: true } });
        expect(activeSubscriptions).toBe(0);
        expect(runner.getActiveSetupTask()).toBeNull();
        await runner.start({ ...spec, params: { activeRelayUrl: 'https://already-completed.example', activeAccountId: 'account-b' } });
        expect(activeSubscriptions).toBe(0);
    });

    it('does not replay a prompt when its subscriber synchronously changes task state', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec());
        const seen: string[] = [];
        runner.subscribe(taskId, (event) => {
            seen.push(event.type);
            if (event.type === 'prompt') void runner.cancel(taskId);
        }, () => {});
        manual.emitEvent(taskId, { protocolVersion: 1, taskId, tsMs: 1, type: 'prompt' });
        expect(seen).toEqual(['prompt']);
        expect(runner.getSnapshot(taskId)?.status).toBe('canceling');
    });

    it('retains current acquisition byte samples and milestones when older events are replayed', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec());
        const emit = (tsMs: number, phase: string, receivedBytes?: number) => manual.emitEvent(taskId, {
            protocolVersion: 1, taskId, tsMs, type: 'cli.acquisition.progress',
            stepId: 'setup.thisComputer.ensureCli', data: { phase, ...(receivedBytes === undefined ? {} : { receivedBytes }) },
        });
        emit(1, 'resolvingRelease');
        emit(2, 'downloading');
        for (let index = 3; index <= 1000; index++) emit(index, 'downloading', index);
        manual.emitEvent(taskId, { protocolVersion: 1, taskId, tsMs: 1001, type: 'prompt', stepId: 'consent' });
        emit(1002, 'verifying');
        const events: SystemTaskEvent[] = [];
        runner.subscribe(taskId, (event) => events.push(event), () => {});
        expect(events.map((event) => event.data ?? event.type)).toEqual([
            { phase: 'resolvingRelease' }, { phase: 'downloading' }, { phase: 'downloading', receivedBytes: 1000 }, 'prompt', { phase: 'verifying' },
        ]);
        emit(3, 'downloading', 3);
        expect(runner.getSnapshot(taskId)?.events).toHaveLength(5);
        expect(runner.getSnapshot(taskId)?.events[2]?.data).toEqual({ phase: 'downloading', receivedBytes: 1000 });
    });

    it('waits for the terminal result of a started task, including an already-completed task', async () => {
        const { createSystemTaskRunner, waitForSystemTaskResult } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec());

        const pending = waitForSystemTaskResult(runner, taskId);
        manual.emitResult(taskId, {
            protocolVersion: 1,
            taskId,
            ok: true,
            data: { completed: true },
        } satisfies SystemTaskResult);

        await expect(pending).resolves.toMatchObject({ ok: true, data: { completed: true } });
        await expect(waitForSystemTaskResult(runner, taskId)).resolves.toMatchObject({ ok: true, data: { completed: true } });
    });

    it('aborts one wait without canceling the task or another observer', async () => {
        const { createSystemTaskRunner, waitForSystemTaskResult } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec());
        const controller = new AbortController();
        const abandoned = waitForSystemTaskResult(runner, taskId, { signal: controller.signal });
        const rejected = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
        const retained = waitForSystemTaskResult(runner, taskId);
        controller.abort();
        manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: true, data: { completed: true } });
        await rejected;
        await expect(retained).resolves.toMatchObject({ taskId, ok: true, data: { completed: true } });
        expect(manual.cancelMock).not.toHaveBeenCalled();
    });

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

    it('reuses an existing task record when the bridge dedupes to an in-flight task id', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const bridge = {
            ...manual.bridge,
            start: vi.fn(async () => 'task_1'),
        };
        const runner = createSystemTaskRunner({ bridge });

        const firstTaskId = await runner.start(createSpec());
        manual.emitEvent(firstTaskId, {
            protocolVersion: 1,
            taskId: firstTaskId,
            tsMs: 100,
            type: 'started',
            stepId: 'prepare',
            message: 'Preparing task',
        } satisfies SystemTaskEvent);

        const secondTaskId = await runner.start(createSpec());

        expect(secondTaskId).toBe(firstTaskId);
        expect(runner.getSnapshot(firstTaskId)).toEqual(expect.objectContaining({
            events: [
                expect.objectContaining({
                    stepId: 'prepare',
                }),
            ],
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

    it('owns a registered prompt continuation for the task lifetime and answers a replay exactly once', async () => {
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const spec = createSpec({
            kind: 'remote.ssh.manageHost.v1',
            params: { action: 'personalHome.relocate' },
        });
        const taskId = await runner.start(spec);
        const continuation = vi.fn(async () => ({ descriptor: { revision: 2 } }));
        runner.registerPromptContinuation?.(taskId, continuation);
        const prompt = {
            protocolVersion: 1,
            taskId,
            tsMs: 100,
            type: 'prompt',
            stepId: 'personalHome.publishLocation',
            message: 'Publish the destination descriptor',
            data: {
                kind: 'personal_home.publish_relocation_descriptor.v1',
                operationId: 'relocation-1',
            },
        } satisfies SystemTaskEvent;

        manual.emitEvent(taskId, prompt);
        manual.emitEvent(taskId, prompt);
        await vi.waitFor(() => expect(manual.respondMock).toHaveBeenCalledTimes(1));

        expect(continuation).toHaveBeenCalledTimes(1);
        expect(manual.respondMock).toHaveBeenCalledWith(taskId, { descriptor: { revision: 2 } });
        expect(runner.listPromptContinuations?.()).toEqual([{ taskId, spec }]);
    });

    it('allows a failed prompt continuation to retry when the owner re-registers', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { createSystemTaskRunner } = await import('./createSystemTaskRunner');
        const manual = createManualBridge();
        const runner = createSystemTaskRunner({ bridge: manual.bridge });
        const taskId = await runner.start(createSpec({
            kind: 'remote.ssh.manageHost.v1',
            params: { action: 'personalHome.relocate' },
        }));
        const prompt = {
            protocolVersion: 1,
            taskId,
            tsMs: 100,
            type: 'prompt',
            stepId: 'personalHome.publishLocation',
            message: 'Publish the destination descriptor',
            data: {
                kind: 'personal_home.publish_relocation_descriptor.v1',
                operationId: 'relocation-1',
            },
        } satisfies SystemTaskEvent;
        const failedContinuation = vi.fn(async () => {
            throw new Error('temporary publication failure');
        });
        const retryContinuation = vi.fn(async () => ({ descriptor: { revision: 3 } }));

        runner.registerPromptContinuation?.(taskId, failedContinuation);
        manual.emitEvent(taskId, prompt);
        await vi.waitFor(() => expect(failedContinuation).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(expect.any(String), {
            taskId, promptKind: 'personal_home.publish_relocation_descriptor.v1',
        }));

        runner.registerPromptContinuation?.(taskId, retryContinuation);
        await vi.waitFor(() => expect(manual.respondMock).toHaveBeenCalledTimes(1));

        expect(retryContinuation).toHaveBeenCalledTimes(1);
        expect(manual.respondMock).toHaveBeenCalledWith(taskId, { descriptor: { revision: 3 } });
        warning.mockRestore();
    });
});
