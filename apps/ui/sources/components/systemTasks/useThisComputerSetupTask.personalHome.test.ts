import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { buildLocalMachineSetupSystemTaskSpec } from './buildLocalMachineSetupSystemTaskSpec';
import { createSystemTaskRunner } from './createSystemTaskRunner';
import { useThisComputerSetupTask } from './useThisComputerSetupTask';
import type { SystemTaskBridgeListenerSet } from './types';

function createManualRunner() {
    let nextTaskId = 1;
    const listeners = new Map<string, SystemTaskBridgeListenerSet>();
    const bridge = {
        capabilities: {},
        start: vi.fn(async (_spec: SystemTaskSpec) => `personal-home-task-${nextTaskId++}`),
        subscribe: vi.fn(async (taskId: string, taskListeners: SystemTaskBridgeListenerSet) => {
            listeners.set(taskId, taskListeners);
            return () => {
                listeners.delete(taskId);
            };
        }),
        cancel: vi.fn(async () => undefined),
        respond: vi.fn(async () => undefined),
    };

    return {
        runner: createSystemTaskRunner({ bridge }),
        bridge,
        emitResult(taskId: string, result: SystemTaskResult) {
            listeners.get(taskId)?.onResult(result);
        },
    };
}

describe('useThisComputerSetupTask Personal Home composition', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('starts the existing local-machine recipe from the supplied Home descriptor without changing it', async () => {
        const manual = createManualRunner();
        const spec = buildLocalMachineSetupSystemTaskSpec({
            activeRelayUrl: 'http://127.0.0.1:43123',
            activeWebappUrl: 'http://127.0.0.1:43123',
            activeLocalRelayUrl: 'http://127.0.0.1:43123',
            installService: true,
            startService: true,
            verifyService: true,
        });
        const hook = await renderHook(() => useThisComputerSetupTask({ runner: manual.runner }));

        let taskId: string | undefined;
        await act(async () => {
            taskId = await hook.getCurrent().start(spec);
        });

        expect(taskId).toBe('personal-home-task-1');
        expect(manual.bridge.start).toHaveBeenCalledWith(spec);
        expect(manual.bridge.start).toHaveBeenCalledTimes(1);
    });

    it('keeps daemon pairing failure scoped to the task instead of requesting Home auth follow-up', async () => {
        const manual = createManualRunner();
        const onNeedsAuth = vi.fn();
        const onSucceeded = vi.fn();
        const hook = await renderHook(() => useThisComputerSetupTask({
            runner: manual.runner,
            onNeedsAuth,
            onSucceeded,
        }));

        let taskId: string | undefined;
        await act(async () => {
            taskId = await hook.getCurrent().start(buildLocalMachineSetupSystemTaskSpec());
        });
        expect(taskId).toBeTruthy();

        await act(async () => {
            manual.emitResult(taskId!, {
                protocolVersion: 1,
                taskId: taskId!,
                ok: false,
                error: {
                    code: 'daemon_service_not_ready',
                    message: 'Background service is not ready yet.',
                },
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(onNeedsAuth).not.toHaveBeenCalled();
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(hook.getCurrent().activeTaskSnapshot?.result).toEqual(expect.objectContaining({
            ok: false,
            error: expect.objectContaining({ code: 'daemon_service_not_ready' }),
        }));
    });
});
