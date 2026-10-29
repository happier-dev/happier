import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type {
    DaemonPluginInvocationLogReadResponseV1,
    PluginInvocationLogRecordV1,
} from '@happier-dev/protocol';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { PluginInvocationLogMachineReadTarget } from '@/sync/ops/pluginInvocationLogs';

afterEach(() => {
    standardCleanup();
});

const target: PluginInvocationLogMachineReadTarget = {
    serverId: 'server-profile-a',
    serverIdentityId: 'srv_plugin_logs',
    machineId: 'machine-2',
};

function logRecord(sequence: number): PluginInvocationLogRecordV1 {
    return {
        version: 1,
        kind: 'plugin_invocation_log',
        level: 'info',
        message: `redacted log ${sequence}`,
        context: {
            plugin: { id: 'example.plugin', version: '1.0.0' },
            contribution: { id: 'action.run', qualifiedId: 'example.plugin/action.run' },
            occurrenceId: 'occurrence-1',
            correlationId: 'correlation-1',
            surface: 'action',
        },
        occurredAtMs: 123,
        sequence,
    };
}

function availablePage(params?: Readonly<{
    cursor?: number;
    records?: PluginInvocationLogRecordV1[];
    hasMore?: boolean;
}>): Extract<DaemonPluginInvocationLogReadResponseV1, { kind: 'available' }> {
    return {
        version: 1 as const,
        kind: 'available' as const,
        records: params?.records ?? [{
            version: 1 as const,
            kind: 'plugin_invocation_log' as const,
            level: 'info' as const,
            message: 'redacted log message',
            fields: { safe: 'value' },
            context: {
                plugin: { id: 'example.plugin', version: '1.0.0' },
                contribution: { id: 'action.run', qualifiedId: 'example.plugin/action.run' },
                occurrenceId: 'occurrence-1',
                correlationId: 'correlation-1',
                surface: 'action',
            },
            occurredAtMs: 123,
            sequence: 4,
        }],
        cursor: params?.cursor ?? 456,
        hasMore: params?.hasMore ?? false,
        logId: 'log-1',
        cursorReset: false,
    };
}

describe('usePluginInvocationLogsController', () => {
    it('keeps a loaded empty page ready while Follow parks and after Pause', async () => {
        vi.useFakeTimers();
        try {
            const read = vi.fn(async (input: Readonly<{ waitForChanges?: true; signal: AbortSignal }>): Promise<DaemonPluginInvocationLogReadResponseV1> => {
                if (!input.waitForChanges) return availablePage({ cursor: 0, records: [] });
                return new Promise<never>((_resolve, reject) => {
                    input.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
                });
            });
            const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
            const hook = await renderHook(() => usePluginInvocationLogsController({
                pluginId: 'example.plugin', targetKey: 'origin-a', resolveTarget: () => target, read, autoLoad: false,
            }), { flushOptions: { cycles: 0 } });
            await act(async () => { await hook.getCurrent().refresh(); });
            expect(hook.getCurrent().state).toMatchObject({ phase: 'ready', records: [], cursor: 0 });
            let follow!: Promise<void>;
            await act(async () => { follow = hook.getCurrent().startFollowing(); });
            try {
                expect(hook.getCurrent().state).toMatchObject({ phase: 'ready', records: [], following: true });
                await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
                expect(read).toHaveBeenCalledTimes(2); // One finite page and one parked watch.
                act(() => { hook.getCurrent().stopFollowing(); });
                await follow;
                expect(hook.getCurrent().state).toMatchObject({ phase: 'ready', records: [], following: false });
            } finally {
                act(() => { hook.getCurrent().stopFollowing(); });
                await follow;
                await hook.unmount();
            }
        } finally {
            vi.useRealTimers();
        }
    });
    it('parks Follow for 300 idle seconds and delivers one new line once, including a log replacement at the same cursor', async () => {
        vi.useFakeTimers();
        try {
            const delivery = createDeferred<ReturnType<typeof availablePage>>();
            const read = vi.fn(async (input: Readonly<{ waitForChanges?: true; signal: AbortSignal }>): Promise<DaemonPluginInvocationLogReadResponseV1> => {
                if (!input.waitForChanges) return availablePage({ cursor: 100, records: [logRecord(1)] });
                if (read.mock.calls.length === 2) return delivery.promise;
                return new Promise<never>((_resolve, reject) => {
                    input.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
                });
            });
            const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
            const hook = await renderHook(() => usePluginInvocationLogsController({
                pluginId: 'example.plugin', targetKey: 'origin-a', resolveTarget: () => target, read, autoLoad: false,
            }), { flushOptions: { cycles: 0 } });
            let follow!: Promise<void>;
            await act(async () => { follow = hook.getCurrent().startFollowing(); });
            expect(read.mock.calls.filter(([input]) => !input.waitForChanges)).toHaveLength(1);
            await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
            expect(read).toHaveBeenCalledTimes(2); // Initial page + one parked watch; no recurring fetches.
            expect(read).toHaveBeenLastCalledWith(expect.objectContaining({
                waitForChanges: true, query: { pluginId: 'example.plugin', cursor: 100, logId: 'log-1', limit: 100 },
            }));
            await act(async () => {
                delivery.resolve({ ...availablePage({ cursor: 100, records: [logRecord(2)] }), logId: 'log-2', cursorReset: true });
            });
            expect(hook.getCurrent().state.records.map(record => record.sequence)).toEqual([2]);
            expect(read).toHaveBeenCalledTimes(3);
            act(() => { hook.getCurrent().stopFollowing(); });
            await follow;
            await hook.unmount();
        } finally {
            vi.useRealTimers();
        }
    });
    it('reconnects a requested Follow from its cursor, retires the previous watch, and stays paused after Stop', async () => {
        const recoveries = new Set<() => void>();
        const subscribeToRecovery = (_target: PluginInvocationLogMachineReadTarget, recover: () => void) => {
            recoveries.add(recover);
            return () => { recoveries.delete(recover); };
        };
        let rejectWatch!: (error: Error) => void;
        const read = vi.fn(async (input: Readonly<{ signal: AbortSignal }>): Promise<DaemonPluginInvocationLogReadResponseV1> => {
            if (read.mock.calls.length === 1) return availablePage({ cursor: 100, records: [logRecord(1)] });
            if (read.mock.calls.length === 3) return availablePage({ cursor: 200, records: [logRecord(2)] });
            return new Promise((_, reject) => {
                rejectWatch = reject;
                input.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
            });
        });
        const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
        const hook = await renderHook(() => usePluginInvocationLogsController({
            pluginId: 'example.plugin', targetKey: 'origin-a', resolveTarget: () => target, read, subscribeToRecovery, autoLoad: false,
        }));
        let follow!: Promise<void>;
        await act(async () => { follow = hook.getCurrent().startFollowing(); });
        expect(read).toHaveBeenCalledTimes(2);
        await act(async () => { rejectWatch(new Error('socket disconnected')); await follow; });
        expect(hook.getCurrent().state.records.map(record => record.sequence)).toEqual([1]);
        await act(async () => { for (const recover of recoveries) recover(); });
        expect(read).toHaveBeenNthCalledWith(3, expect.objectContaining({
            query: { pluginId: 'example.plugin', cursor: 100, logId: 'log-1', limit: 100 }, waitForChanges: true,
        }));
        expect(hook.getCurrent().state.records.map(record => record.sequence)).toEqual([1, 2]);
        const activeSignal = read.mock.calls.at(-1)?.[0].signal;
        act(() => { hook.getCurrent().stopFollowing(); });
        expect(activeSignal?.aborted).toBe(true);
        await act(async () => { for (const recover of recoveries) recover(); });
        expect(read).toHaveBeenCalledTimes(4);
        await hook.unmount();
        expect(recoveries.size).toBe(0);
    });
    it('cancels manual reads when their owner unmounts, even with automatic loading disabled', async () => {
        let requestSignal: AbortSignal | undefined;
        const read = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<DaemonPluginInvocationLogReadResponseV1>((_resolve, reject) => {
            requestSignal = signal;
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
        }));
        const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
        const hook = await renderHook(() => usePluginInvocationLogsController({
            pluginId: 'example.plugin', targetKey: 'machine-2', resolveTarget: () => target, read, autoLoad: false,
        }));
        let refresh!: Promise<void>;
        act(() => { refresh = hook.getCurrent().refresh(); });
        expect(hook.getCurrent().state.phase).toBe('loading');
        await hook.unmount();
        expect(requestSignal?.aborted).toBe(true);
        await refresh;
    });

    it('passes a trimmed correlation ID to the daemon query instead of locally filtering records', async () => {
        const read = vi.fn(async () => availablePage());
        const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
        const hook = await renderHook(() => usePluginInvocationLogsController({
            pluginId: 'example.plugin',
            targetKey: 'srv_plugin_logs:machine-2:materialization-1',
            resolveTarget: () => target,
            read,
            autoLoad: false,
        }));

        act(() => {
            hook.getCurrent().setCorrelationId('  correlation-1  ');
        });
        let refresh!: Promise<void>;
        act(() => {
            refresh = hook.getCurrent().refresh();
        });
        await act(async () => {
            await refresh;
        });

        expect(read).toHaveBeenCalledExactlyOnceWith({
            target,
            query: {
                pluginId: 'example.plugin',
                correlationId: 'correlation-1',
                limit: 100,
            },
            signal: expect.any(AbortSignal),
        });
        expect(hook.getCurrent().state).toMatchObject({
            phase: 'ready',
            records: [expect.objectContaining({ message: 'redacted log message' })],
            following: false,
        });
        await hook.unmount();
    });

    it('keeps the last successful bounded window and cursor after a later refresh failure', async () => {
        const firstPage = availablePage({
            cursor: 456,
            hasMore: true,
            records: [{
                version: 1,
                kind: 'plugin_invocation_log',
                level: 'info',
                message: 'last known redacted record',
                context: {
                    plugin: { id: 'example.plugin', version: '1.0.0' },
                    contribution: { id: 'action.run', qualifiedId: 'example.plugin/action.run' },
                    occurrenceId: 'occurrence-1',
                    correlationId: 'correlation-1',
                    surface: 'action',
                },
                occurredAtMs: 123,
                sequence: 4,
            }],
        });
        const read = vi.fn()
            .mockResolvedValueOnce(firstPage)
            .mockRejectedValueOnce(new Error('selected machine stopped responding'));
        const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
        const hook = await renderHook(() => usePluginInvocationLogsController({
            pluginId: 'example.plugin',
            targetKey: 'srv_plugin_logs:machine-2:materialization-1',
            resolveTarget: () => target,
            read,
            autoLoad: false,
        }));

        let firstRefresh!: Promise<void>;
        act(() => {
            firstRefresh = hook.getCurrent().refresh();
        });
        await act(async () => {
            await firstRefresh;
        });

        let retry!: Promise<void>;
        act(() => {
            retry = hook.getCurrent().refresh();
        });
        await act(async () => {
            await retry;
        });

        expect(hook.getCurrent().state).toMatchObject({
            phase: 'error',
            records: [expect.objectContaining({ message: 'last known redacted record' })],
            cursor: 456,
            hasMore: true,
            following: false,
        });
        await hook.unmount();
    });

    it('forwards the daemon continuation cursor and keeps only the bounded newest pagination window', async () => {
        const { PLUGIN_INVOCATION_LOG_VIEW_LIMIT, usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
        const firstPageRecords = Array.from({ length: PLUGIN_INVOCATION_LOG_VIEW_LIMIT }, (_value, index) => logRecord(index + 1));
        const secondPageRecords = Array.from({ length: PLUGIN_INVOCATION_LOG_VIEW_LIMIT }, (_value, index) => (
            logRecord(index + PLUGIN_INVOCATION_LOG_VIEW_LIMIT + 1)
        ));
        const read = vi.fn()
            .mockResolvedValueOnce(availablePage({ cursor: 100, hasMore: true, records: firstPageRecords }))
            .mockResolvedValueOnce(availablePage({ cursor: 200, hasMore: false, records: secondPageRecords }));
        const hook = await renderHook(() => usePluginInvocationLogsController({
            pluginId: 'example.plugin',
            targetKey: 'srv_plugin_logs:machine-2:materialization-1',
            resolveTarget: () => target,
            read,
            autoLoad: false,
        }));

        let refresh!: Promise<void>;
        act(() => {
            refresh = hook.getCurrent().refresh();
        });
        await act(async () => {
            await refresh;
        });

        let loadMore!: Promise<void>;
        act(() => {
            loadMore = hook.getCurrent().loadMore();
        });
        await act(async () => {
            await loadMore;
        });

        expect(read).toHaveBeenNthCalledWith(2, expect.objectContaining({
            target,
            query: {
                pluginId: 'example.plugin',
                cursor: 100,
                logId: 'log-1',
                limit: PLUGIN_INVOCATION_LOG_VIEW_LIMIT,
            },
        }));
        expect(hook.getCurrent().state).toMatchObject({
            phase: 'ready',
            cursor: 200,
            hasMore: false,
            following: false,
        });
        expect(hook.getCurrent().state.records).toHaveLength(PLUGIN_INVOCATION_LOG_VIEW_LIMIT);
        expect(hook.getCurrent().state.records[0]?.sequence).toBe(PLUGIN_INVOCATION_LOG_VIEW_LIMIT + 1);
        expect(hook.getCurrent().state.records.at(-1)?.sequence).toBe(PLUGIN_INVOCATION_LOG_VIEW_LIMIT * 2);
        await hook.unmount();
    });

    it('fails closed when the selected origin is no longer a current exact machine', async () => {
        const read = vi.fn();
        const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
        const hook = await renderHook(() => usePluginInvocationLogsController({
            pluginId: 'example.plugin',
            targetKey: 'stale-origin',
            resolveTarget: () => null,
            read,
            autoLoad: false,
        }));

        let refresh!: Promise<void>;
        act(() => {
            refresh = hook.getCurrent().refresh();
        });
        await act(async () => {
            await refresh;
        });

        expect(read).not.toHaveBeenCalled();
        expect(hook.getCurrent().state).toMatchObject({
            phase: 'unavailable',
            records: [],
        });
        await hook.unmount();
    });

    it('keeps an unsupported canonical log reader distinct from an unavailable selected machine', async () => {
        const read = vi.fn(async () => ({
            version: 1 as const,
            kind: 'unavailable' as const,
            code: 'plugin_log_reader_unavailable' as const,
        }));
        const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
        const hook = await renderHook(() => usePluginInvocationLogsController({
            pluginId: 'example.plugin',
            targetKey: 'srv_plugin_logs:machine-2:materialization-1',
            resolveTarget: () => target,
            read,
            autoLoad: false,
        }));

        let refresh!: Promise<void>;
        act(() => {
            refresh = hook.getCurrent().refresh();
        });
        await act(async () => {
            await refresh;
        });

        expect(hook.getCurrent().state).toMatchObject({
            phase: 'unavailable',
            unavailableReason: 'readerUnavailable',
        });
        await hook.unmount();
    });

    it('cancels the actual in-flight follow read when the user stops following', async () => {
        const read = vi.fn(async (input: Readonly<{ signal: AbortSignal }>) => await new Promise<never>((_resolve, reject) => {
            input.signal.addEventListener('abort', () => {
                const error = new Error('cancelled');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        }));
        const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
        const hook = await renderHook(() => usePluginInvocationLogsController({
            pluginId: 'example.plugin',
            targetKey: 'srv_plugin_logs:machine-2:materialization-1',
            resolveTarget: () => target,
            read,
            autoLoad: false,
        }));

        let follow!: Promise<void>;
        act(() => {
            follow = hook.getCurrent().startFollowing();
        });
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        const issuedSignal = read.mock.calls[0]?.[0]?.signal;

        act(() => {
            hook.getCurrent().stopFollowing();
        });
        await act(async () => {
            await expect(follow).resolves.toBeUndefined();
        });

        expect(issuedSignal?.aborted).toBe(true);
        expect(hook.getCurrent().state).toMatchObject({
            following: false,
        });
        expect(hook.getCurrent().state.phase).not.toBe('error');
        await hook.unmount();
    });

    it('continues an advancing follow cursor, then parks instead of spinning on a non-advancing page', async () => {
        const firstFollowRead = createDeferred<ReturnType<typeof availablePage>>();
        const thirdFollowRead = createDeferred<ReturnType<typeof availablePage>>();
        const parkedRead = createDeferred<ReturnType<typeof availablePage>>();
        const read = vi.fn()
            .mockResolvedValueOnce(availablePage({
                cursor: 100,
                hasMore: true,
                records: [logRecord(1)],
            }))
            .mockImplementationOnce(async () => await firstFollowRead.promise)
            .mockImplementationOnce(async () => await thirdFollowRead.promise)
            .mockImplementationOnce(async () => await parkedRead.promise);
        const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
        const hook = await renderHook(() => usePluginInvocationLogsController({
            pluginId: 'example.plugin',
            targetKey: 'srv_plugin_logs:machine-2:materialization-1',
            resolveTarget: () => target,
            read,
            autoLoad: false,
        }));

        let refresh!: Promise<void>;
        act(() => {
            refresh = hook.getCurrent().refresh();
        });
        await act(async () => {
            await refresh;
        });

        let follow!: Promise<void>;
        act(() => {
            follow = hook.getCurrent().startFollowing();
        });
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        expect(read).toHaveBeenNthCalledWith(2, expect.objectContaining({
            query: { pluginId: 'example.plugin', cursor: 100, logId: 'log-1', limit: 100 },
        }));
        await act(async () => {
            firstFollowRead.resolve(availablePage({
                cursor: 200,
                hasMore: true,
                records: [logRecord(2)],
            }));
            await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
        });
        expect(read).toHaveBeenNthCalledWith(3, expect.objectContaining({
            query: { pluginId: 'example.plugin', cursor: 200, logId: 'log-1', limit: 100 },
        }));

        thirdFollowRead.resolve(availablePage({
            cursor: 200,
            hasMore: true,
            records: [],
        }));
        await flushHookEffects();
        expect(hook.getCurrent().state).toMatchObject({
            phase: 'ready',
            cursor: 200,
            hasMore: true,
            following: true,
        });
        expect(hook.getCurrent().state.records.map((record) => record.sequence)).toEqual([1, 2]);
        expect(read).toHaveBeenCalledTimes(4);
        expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ waitForChanges: true }));

        act(() => {
            hook.getCurrent().stopFollowing();
        });
        parkedRead.resolve(availablePage({ cursor: 200, records: [] }));
        await act(async () => {
            await follow;
        });
        expect(read).toHaveBeenCalledTimes(4);
        await hook.unmount();
    });

    it('does not publish a stale response after the query changes', async () => {
        let resolveRead!: (value: ReturnType<typeof availablePage>) => void;
        const read = vi.fn(async () => await new Promise<ReturnType<typeof availablePage>>((resolve) => {
            resolveRead = resolve;
        }));
        const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
        const hook = await renderHook(() => usePluginInvocationLogsController({
            pluginId: 'example.plugin',
            targetKey: 'srv_plugin_logs:machine-2:materialization-1',
            resolveTarget: () => target,
            read,
            autoLoad: false,
        }));

        let firstRefresh!: Promise<void>;
        act(() => {
            firstRefresh = hook.getCurrent().refresh();
        });
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        act(() => {
            hook.getCurrent().setCorrelationId('correlation-2');
        });
        resolveRead(availablePage());
        await act(async () => {
            await expect(firstRefresh).resolves.toBeUndefined();
        });

        expect(hook.getCurrent().state).toMatchObject({
            correlationId: 'correlation-2',
            records: [],
        });
        await hook.unmount();
    });

    it('clears the prior exact-machine window when a manual-read target changes', async () => {
        const nextTarget: PluginInvocationLogMachineReadTarget = {
            serverId: 'server-profile-b',
            serverIdentityId: 'srv_plugin_logs_b',
            machineId: 'machine-3',
        };
        const read = vi.fn(async () => availablePage({ records: [logRecord(1)] }));
        const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
        const hook = await renderHook(
            (input: Readonly<{ targetKey: string; target: PluginInvocationLogMachineReadTarget }>) => (
                usePluginInvocationLogsController({
                    pluginId: 'example.plugin',
                    targetKey: input.targetKey,
                    resolveTarget: () => input.target,
                    read,
                    autoLoad: false,
                })
            ),
            { initialProps: { targetKey: 'origin-a', target } },
        );

        let refresh!: Promise<void>;
        act(() => {
            refresh = hook.getCurrent().refresh();
        });
        await act(async () => {
            await refresh;
        });
        expect(hook.getCurrent().state.records).toEqual([expect.objectContaining({ sequence: 1 })]);

        await hook.rerender({ targetKey: 'origin-b', target: nextTarget });

        expect(read).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().state).toMatchObject({
            phase: 'idle',
            records: [],
            cursor: null,
            hasMore: false,
        });
        await hook.unmount();
    });

    it('clears the prior machine window before automatically reading a newly selected exact origin', async () => {
        const firstRead = createDeferred<ReturnType<typeof availablePage>>();
        const secondRead = createDeferred<ReturnType<typeof availablePage>>();
        const nextTarget: PluginInvocationLogMachineReadTarget = {
            serverId: 'server-profile-b',
            serverIdentityId: 'srv_plugin_logs_b',
            machineId: 'machine-3',
        };
        const read = vi.fn()
            .mockImplementationOnce(async () => await firstRead.promise)
            .mockImplementationOnce(async () => await secondRead.promise);
        const { usePluginInvocationLogsController } = await import('./pluginInvocationLogsController');
        const renderedWindows: Array<Readonly<{
            targetKey: string;
            messages: readonly (string | undefined)[];
        }>> = [];
        const hook = await renderHook(
            (input: Readonly<{ targetKey: string; target: PluginInvocationLogMachineReadTarget }>) => {
                const controller = usePluginInvocationLogsController({
                    pluginId: 'example.plugin',
                    targetKey: input.targetKey,
                    resolveTarget: () => input.target,
                    read,
                });
                renderedWindows.push({
                    targetKey: input.targetKey,
                    messages: controller.state.records.map((record) => record.message),
                });
                return controller;
            },
            { initialProps: { targetKey: 'origin-a', target } },
        );
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        firstRead.resolve(availablePage({
            records: [{
                version: 1,
                kind: 'plugin_invocation_log',
                level: 'info',
                message: 'record from machine two',
                context: {
                    plugin: { id: 'example.plugin', version: '1.0.0' },
                    contribution: { id: 'action.run', qualifiedId: 'example.plugin/action.run' },
                    occurrenceId: 'occurrence-1',
                    correlationId: 'correlation-1',
                    surface: 'action',
                },
                occurredAtMs: 123,
                sequence: 4,
            }],
        }));
        await flushHookEffects();
        expect(hook.getCurrent().state).toMatchObject({
            phase: 'ready',
            records: [expect.objectContaining({ message: 'record from machine two' })],
        });

        renderedWindows.length = 0;
        await hook.rerender({ targetKey: 'origin-b', target: nextTarget });
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));

        const originBWindows = renderedWindows.filter(({ targetKey }) => targetKey === 'origin-b');
        expect(originBWindows).not.toHaveLength(0);
        expect(originBWindows.every(({ messages }) => messages.length === 0)).toBe(true);
        expect(hook.getCurrent().state).toMatchObject({
            phase: 'loading',
            records: [],
        });

        secondRead.resolve(availablePage({ records: [] }));
        await flushHookEffects();
        await hook.unmount();
    });
});
