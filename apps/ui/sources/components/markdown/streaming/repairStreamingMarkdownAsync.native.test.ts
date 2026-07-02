import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockRuntime = Readonly<{ name: string; runtimeId: number }>;
type MockWorklet = (...args: unknown[]) => unknown;

const workletsMock = vi.hoisted(() => ({
    createWorkletRuntime: vi.fn((name: string): MockRuntime => ({ name, runtimeId: 1 })),
    runOnRuntime: vi.fn((_runtime: MockRuntime, worklet: MockWorklet) => (...args: unknown[]) => worklet(...args)),
    scheduleOnRN: vi.fn((callback: MockWorklet, ...args: unknown[]) => callback(...args)),
}));

vi.mock('react-native-worklets', () => ({
    createWorkletRuntime: workletsMock.createWorkletRuntime,
    runOnRuntime: workletsMock.runOnRuntime,
    scheduleOnRN: workletsMock.scheduleOnRN,
}));

describe('repairStreamingMarkdownAsync native', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useRealTimers();
        delete process.env.EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON;
        workletsMock.createWorkletRuntime.mockReset();
        workletsMock.runOnRuntime.mockReset();
        workletsMock.scheduleOnRN.mockReset();
        workletsMock.createWorkletRuntime.mockImplementation((name: string): MockRuntime => ({ name, runtimeId: 1 }));
        workletsMock.runOnRuntime.mockImplementation((_runtime: MockRuntime, worklet: MockWorklet) => (...args: unknown[]) => worklet(...args));
        workletsMock.scheduleOnRN.mockImplementation((callback: MockWorklet, ...args: unknown[]) => callback(...args));
    });

    it('repairs markdown through the callback-based Worklets runtime API', async () => {
        const { repairStreamingMarkdownAsync } = await import('./repairStreamingMarkdownAsync.native');
        const { preprocessStreamingMarkdown } = await import('./preprocessStreamingMarkdown');
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        const markdown = ['Formula:', '', '$$', 'E = mc^2'].join('\n');
        syncPerformanceTelemetry.configure({ enabled: true });
        syncPerformanceTelemetry.reset();

        await expect(repairStreamingMarkdownAsync(markdown)).resolves.toBe(preprocessStreamingMarkdown(markdown));

        expect(workletsMock.createWorkletRuntime).toHaveBeenCalledWith('happier-markdown-repair');
        expect(workletsMock.runOnRuntime).toHaveBeenCalledTimes(1);
        expect(workletsMock.scheduleOnRN).toHaveBeenCalledTimes(1);
        expect(syncPerformanceTelemetry.snapshot().events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'ui.markdown.streaming.repair.worklet',
                count: 1,
                fields: expect.objectContaining({ chars: markdown.length }),
            }),
        ]));
    });

    it('falls back to JS preprocessing when the Worklets runtime rejects repair', async () => {
        workletsMock.runOnRuntime.mockImplementationOnce(() => {
            throw new Error('worker failed');
        });
        const { repairStreamingMarkdownAsync } = await import('./repairStreamingMarkdownAsync.native');
        const { preprocessStreamingMarkdown } = await import('./preprocessStreamingMarkdown');
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        const markdown = 'streaming **markdown';
        syncPerformanceTelemetry.configure({ enabled: true });
        syncPerformanceTelemetry.reset();

        await expect(repairStreamingMarkdownAsync(markdown)).resolves.toBe(preprocessStreamingMarkdown(markdown));
        expect(syncPerformanceTelemetry.snapshot().events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'ui.markdown.streaming.repair.fallback',
                count: 1,
                fields: expect.objectContaining({ chars: markdown.length }),
            }),
        ]));
    });

    it('skips future Worklets attempts after the runtime reports repair failure', async () => {
        workletsMock.runOnRuntime.mockImplementationOnce((_runtime: MockRuntime, _worklet: MockWorklet): MockWorklet => (
            ...args: unknown[]
        ) => {
            const onComplete = args[2];
            expect(onComplete).toBeTypeOf('function');
            (onComplete as (succeeded: number, repairedMarkdown: string, failureKind?: string) => void)(0, '', 'worklet');
        });
        const { repairStreamingMarkdownAsync } = await import('./repairStreamingMarkdownAsync.native');
        const { preprocessStreamingMarkdown } = await import('./preprocessStreamingMarkdown');
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        const first = 'streaming **markdown';
        const second = 'streaming `markdown';
        syncPerformanceTelemetry.configure({ enabled: true });
        syncPerformanceTelemetry.reset();

        await expect(repairStreamingMarkdownAsync(first)).resolves.toBe(preprocessStreamingMarkdown(first));
        await expect(repairStreamingMarkdownAsync(second)).resolves.toBe(preprocessStreamingMarkdown(second));

        expect(workletsMock.createWorkletRuntime).toHaveBeenCalledTimes(1);
        expect(workletsMock.runOnRuntime).toHaveBeenCalledTimes(1);
        expect(syncPerformanceTelemetry.snapshot().events).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'ui.markdown.streaming.repair.worklet', count: 1 }),
            expect.objectContaining({ name: 'ui.markdown.streaming.repair.fallback', count: 2 }),
            expect.objectContaining({ name: 'ui.markdown.streaming.repair.js', count: 2 }),
        ]));
    });

    it('falls back to JS preprocessing when the Worklets callback does not complete', async () => {
        vi.useFakeTimers();
        process.env.EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON = JSON.stringify({
            streamingMarkdownRepairWorkletTimeoutMs: 1,
        });
        workletsMock.runOnRuntime.mockImplementationOnce(() => () => {});
        const { repairStreamingMarkdownAsync } = await import('./repairStreamingMarkdownAsync.native');
        const { preprocessStreamingMarkdown } = await import('./preprocessStreamingMarkdown');
        const markdown = 'streaming `markdown';

        const repaired = repairStreamingMarkdownAsync(markdown);
        await vi.advanceTimersByTimeAsync(1);

        await expect(repaired).resolves.toBe(preprocessStreamingMarkdown(markdown));
    });
});
