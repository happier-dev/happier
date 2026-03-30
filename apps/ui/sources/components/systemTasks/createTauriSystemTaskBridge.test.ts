import { describe, expect, it, vi } from 'vitest';

const invokeTauriMock = vi.hoisted(() => vi.fn());
const listenTauriEventMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/platform/tauri', () => ({
    invokeTauri: (command: string, args?: Record<string, unknown>) => invokeTauriMock(command, args),
    listenTauriEvent: (eventName: string, handler: (payload: unknown) => void) => listenTauriEventMock(eventName, handler),
}));

describe('createTauriSystemTaskBridge', () => {
    it('replays the snapshot before queued live events when subscription races with snapshot loading', async () => {
        const listeners = new Map<string, (payload: unknown) => void>();
        listenTauriEventMock.mockReset();
        invokeTauriMock.mockReset();

        listenTauriEventMock.mockImplementation(async (eventName: string, handler: (payload: unknown) => void) => {
            listeners.set(eventName, handler);
            return () => {
                listeners.delete(eventName);
            };
        });

        let resolveSnapshot: ((value: { events: unknown[]; result: unknown | null }) => void) | null = null;
        invokeTauriMock.mockImplementation(async (command: string) => {
            if (command !== 'get_system_task_snapshot') {
                throw new Error(`Unexpected command: ${command}`);
            }
            return await new Promise((resolve) => {
                resolveSnapshot = resolve;
            });
        });

        const { createTauriSystemTaskBridge } = await import('./createTauriSystemTaskBridge');
        const bridge = createTauriSystemTaskBridge();
        const deliveredEvents: unknown[] = [];

        const subscribePromise = bridge.subscribe('task_1', {
            onEvent: (payload) => {
                deliveredEvents.push(payload);
            },
            onResult: vi.fn(),
        });

        await vi.waitFor(() => {
            expect(resolveSnapshot).not.toBeNull();
        });
        listeners.get('systemTasks://task/task_1/event')?.({
            protocolVersion: 1,
            taskId: 'task_1',
            tsMs: 300,
            type: 'progress',
            stepId: 'finish',
            message: 'Finishing setup',
        });

        const snapshotResolver = resolveSnapshot as ((value: { events: unknown[]; result: unknown | null }) => void) | null;
        if (!snapshotResolver) {
            throw new Error('Expected snapshot resolution callback');
        }

        snapshotResolver({
            events: [
                {
                    protocolVersion: 1,
                    taskId: 'task_1',
                    tsMs: 100,
                    type: 'started',
                    stepId: 'prepare',
                    message: 'Preparing setup',
                },
                {
                    protocolVersion: 1,
                    taskId: 'task_1',
                    tsMs: 200,
                    type: 'progress',
                    stepId: 'install',
                    message: 'Installing runtime',
                },
            ],
            result: null,
        });

        await subscribePromise;

        expect(deliveredEvents).toEqual([
            expect.objectContaining({ stepId: 'prepare' }),
            expect.objectContaining({ stepId: 'install' }),
            expect.objectContaining({ stepId: 'finish' }),
        ]);
    });

    it('delivers buffered live events before the final result when snapshot loading races with task completion', async () => {
        const listeners = new Map<string, (payload: unknown) => void>();
        listenTauriEventMock.mockReset();
        invokeTauriMock.mockReset();

        listenTauriEventMock.mockImplementation(async (eventName: string, handler: (payload: unknown) => void) => {
            listeners.set(eventName, handler);
            return () => {
                listeners.delete(eventName);
            };
        });

        let resolveSnapshot: ((value: { events: unknown[]; result: unknown | null }) => void) | null = null;
        invokeTauriMock.mockImplementation(async (command: string) => {
            if (command !== 'get_system_task_snapshot') {
                throw new Error(`Unexpected command: ${command}`);
            }
            return await new Promise((resolve) => {
                resolveSnapshot = resolve;
            });
        });

        const { createTauriSystemTaskBridge } = await import('./createTauriSystemTaskBridge');
        const bridge = createTauriSystemTaskBridge();
        const delivered: string[] = [];

        const subscribePromise = bridge.subscribe('task_1', {
            onEvent: (payload) => {
                const event = payload as { stepId?: string; type?: string };
                delivered.push(`event:${event.stepId ?? event.type ?? 'unknown'}`);
            },
            onResult: () => {
                delivered.push('result');
            },
        });

        await vi.waitFor(() => {
            expect(resolveSnapshot).not.toBeNull();
        });

        listeners.get('systemTasks://task/task_1/event')?.({
            protocolVersion: 1,
            taskId: 'task_1',
            tsMs: 200,
            type: 'progress',
            stepId: 'finish',
            message: 'Finishing setup',
        });
        listeners.get('systemTasks://task/task_1/result')?.({
            protocolVersion: 1,
            taskId: 'task_1',
            ok: true,
            data: {
                done: true,
            },
        });

        const snapshotResolver = resolveSnapshot as ((value: { events: unknown[]; result: unknown | null }) => void) | null;
        if (!snapshotResolver) {
            throw new Error('Expected snapshot resolution callback');
        }

        snapshotResolver({
            events: [
                {
                    protocolVersion: 1,
                    taskId: 'task_1',
                    tsMs: 100,
                    type: 'started',
                    stepId: 'prepare',
                    message: 'Preparing setup',
                },
            ],
            result: null,
        });

        await subscribePromise;

        expect(delivered).toEqual([
            'event:prepare',
            'event:finish',
            'result',
        ]);
    });

    it('forwards prompt responses to the Tauri command surface', async () => {
        listenTauriEventMock.mockReset();
        invokeTauriMock.mockReset();
        invokeTauriMock.mockResolvedValue(undefined);

        const { createTauriSystemTaskBridge } = await import('./createTauriSystemTaskBridge');
        const bridge = createTauriSystemTaskBridge();

        await bridge.respond('task_1', {
            trusted: true,
        });

        expect(invokeTauriMock).toHaveBeenCalledWith('respond_system_task_prompt', {
            taskId: 'task_1',
            answerJson: JSON.stringify({ trusted: true }),
        });
    });
});
