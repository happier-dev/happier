import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import type { SystemTaskEvent, SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';

import { useConfiguredSshHostSuggestions } from './useConfiguredSshHostSuggestions';

type RunnerHarness = Readonly<{
    runner: SystemTaskRunner;
    startSpy: ReturnType<typeof vi.fn<(spec: SystemTaskSpec) => Promise<string>>>;
    publishResult: (taskId: string, result: SystemTaskResult) => void;
}>;

function createRunnerHarness(): RunnerHarness {
    const subscribers = new Map<string, Set<() => void>>();
    const snapshots = new Map<string, SystemTaskRunState | null>();
    let nextTaskNumber = 1;

    const publish = (taskId: string, snapshot: SystemTaskRunState | null) => {
        snapshots.set(taskId, snapshot);
        subscribers.get(taskId)?.forEach((notify) => notify());
    };

    const startSpy = vi.fn(async (_spec: SystemTaskSpec) => {
        const taskId = `task-${nextTaskNumber}`;
        nextTaskNumber += 1;
        publish(taskId, {
            taskId,
            status: 'running',
            currentStepId: null,
            latestMessage: null,
            awaitingInput: false,
            cancelRequested: false,
            events: [],
            result: null,
        });
        return taskId;
    });

    function subscribe(taskId: string, listener: () => void): () => void;
    function subscribe(taskId: string, onEvent?: (event: SystemTaskEvent) => void, onResult?: (result: SystemTaskResult) => void): () => void;
    function subscribe(taskId: string, listenerOrOnEvent?: (() => void) | ((event: SystemTaskEvent) => void)): () => void {
        if (!listenerOrOnEvent) return () => {};
        const listener = listenerOrOnEvent as () => void;
        const listeners = subscribers.get(taskId) ?? new Set<() => void>();
        listeners.add(listener);
        subscribers.set(taskId, listeners);
        return () => {
            listeners.delete(listener);
        };
    }

    const runner: SystemTaskRunner = {
        mode: 'tauri',
        start: startSpy,
        cancel: vi.fn(async () => undefined),
        respond: vi.fn(async () => undefined),
        getSnapshot: (taskId) => snapshots.get(taskId) ?? null,
        subscribe,
    };

    return {
        runner,
        startSpy,
        publishResult: (taskId, result) => {
            publish(taskId, {
                taskId,
                status: result.ok ? 'succeeded' : 'failed',
                currentStepId: null,
                latestMessage: result.ok ? null : result.error.message,
                awaitingInput: false,
                cancelRequested: false,
                events: [],
                result,
            });
        },
    };
}

afterEach(() => {
    standardCleanup();
});

describe('useConfiguredSshHostSuggestions', () => {
    it('loads through the system task bridge and preserves stale suggestions while refreshing', async () => {
        const harness = createRunnerHarness();
        const rendered = await renderHook(() => useConfiguredSshHostSuggestions({
            runner: harness.runner,
        }));

        expect(harness.startSpy).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'local.ssh.discoverConfiguredHosts.v1',
            params: {},
        }));

        await act(async () => {
            harness.publishResult('task-1', {
                protocolVersion: 1,
                taskId: 'task-1',
                ok: true,
                data: [
                    {
                        id: 'ssh-config:devbox',
                        alias: 'devbox',
                        hostname: '10.0.0.5',
                        port: 2222,
                        username: 'ubuntu',
                        source: 'ssh-config',
                        sourcePath: '/Users/test/.ssh/config',
                    },
                ],
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent().suggestions.map((suggestion) => suggestion.alias)).toEqual(['devbox']);
        expect(rendered.getCurrent().loading).toBe(false);

        await act(async () => {
            await rendered.getCurrent().refresh();
        });

        expect(rendered.getCurrent().refreshing).toBe(true);
        expect(rendered.getCurrent().suggestions.map((suggestion) => suggestion.alias)).toEqual(['devbox']);

        await act(async () => {
            harness.publishResult('task-2', {
                protocolVersion: 1,
                taskId: 'task-2',
                ok: false,
                error: {
                    code: 'discovery_failed',
                    message: 'Could not read SSH config.',
                },
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent().refreshing).toBe(false);
        expect(rendered.getCurrent().suggestions.map((suggestion) => suggestion.alias)).toEqual(['devbox']);
        expect(rendered.getCurrent().error?.message).toContain('Could not read SSH config');
    });
});
