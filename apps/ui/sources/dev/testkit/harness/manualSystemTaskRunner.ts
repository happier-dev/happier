import { vi } from 'vitest';
import type { SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import type { SystemTaskBridgeListenerSet, SystemTaskRunner } from '@/components/systemTasks/types';

/** Simulate only native process replies for a caller-owned real SystemTask runner. */
export function createManualSystemTaskBridge() {
    let nextTaskId = 1;
    let nextTsMs = 1;
    const listeners = new Map<string, SystemTaskBridgeListenerSet>();
    const bridge = {
        capabilities: {},
        start: vi.fn(async (_spec: SystemTaskSpec) => `personal-home-task-${nextTaskId++}`),
        subscribe: vi.fn(async (taskId: string, taskListeners: SystemTaskBridgeListenerSet) => {
            listeners.set(taskId, taskListeners);
            return () => { listeners.delete(taskId); };
        }),
        cancel: vi.fn(async () => undefined),
        respond: vi.fn(async () => undefined),
    };
    return {
        bridge,
        emitResult(taskId: string, result: SystemTaskResult) {
            listeners.get(taskId)?.onResult(result);
        },
        emitEvent(taskId: string, event: Record<string, unknown>) {
            listeners.get(taskId)?.onEvent({ protocolVersion: 1, taskId, tsMs: nextTsMs++, ...event });
        },
    };
}

/** Only the OS task bridge is simulated; snapshots, prompts and completion use the real runner. */
export function createManualSystemTaskRunner(mode: SystemTaskRunner['mode'] = 'tauri') {
    const manual = createManualSystemTaskBridge();
    return { runner: createSystemTaskRunner({ bridge: manual.bridge, mode }), ...manual };
}
