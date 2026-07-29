import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { createModalModuleMock, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', () => createModalModuleMock({ confirmResult: true }).module);

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

type MachineScmStashCallSpy = (machineId: string, request: any, options?: any) => Promise<any>;

const machineScmStashListSpy = vi.fn<MachineScmStashCallSpy>(async () => ({
    success: true,
    stashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() }],
    totalCount: 1,
}));
const machineScmStashShowSpy = vi.fn<MachineScmStashCallSpy>(async (_machineId, request) => ({
    success: true,
    diff: [
        `diff --git a/${request.stashRef}.ts b/${request.stashRef}.ts`,
        'index 0000000..1111111 100644',
        `--- a/${request.stashRef}.ts`,
        `+++ b/${request.stashRef}.ts`,
        '@@ -1,1 +1,1 @@',
        '-export const a = 1;',
        '+export const a = 2;',
        '',
    ].join('\n'),
    truncated: false,
}));
const machineScmStashPopSpy = vi.fn<MachineScmStashCallSpy>(async () => ({ success: true }));
const machineScmStashDropSpy = vi.fn<MachineScmStashCallSpy>(async () => ({ success: true }));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmStashList: (...args: Parameters<MachineScmStashCallSpy>) => machineScmStashListSpy(...args),
    machineScmStashShow: (...args: Parameters<MachineScmStashCallSpy>) => machineScmStashShowSpy(...args),
    machineScmStashPop: (...args: Parameters<MachineScmStashCallSpy>) => machineScmStashPopSpy(...args),
    machineScmStashDrop: (...args: Parameters<MachineScmStashCallSpy>) => machineScmStashDropSpy(...args),
}));

const diffFilesListSpy = vi.fn();
vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: (props: any) => {
        diffFilesListSpy(props);
        return React.createElement('DiffFilesListView', props);
    },
}));

describe('WorkspaceScmStashDetailsView', () => {
    beforeEach(() => {
        machineScmStashListSpy.mockClear();
        machineScmStashShowSpy.mockClear();
        machineScmStashPopSpy.mockClear();
        machineScmStashDropSpy.mockClear();
        diffFilesListSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    async function settle(): Promise<void> {
        await flushHookEffects({ cycles: 2, turns: 2 });
    }

    type PendingRetryTimer = Readonly<{
        id: ReturnType<typeof setTimeout>;
        delayMs: number;
        run: () => void;
    }>;

    async function withControlledRetryTimers(body: (controls: Readonly<{
        advanceTimersByCount: (count: number) => Promise<void>;
    }>) => Promise<void>): Promise<void> {
        const pendingTimers: PendingRetryTimer[] = [];
        let nextTimerId = 1;
        let nowMs = 0;

        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler: TimerHandler, timeout?: number) => {
            const timerId = nextTimerId++;
            const delayMs = typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : 0;
            pendingTimers.push({
                id: timerId as unknown as ReturnType<typeof setTimeout>,
                delayMs,
                run: () => {
                    if (typeof handler === 'function') {
                        handler();
                        return;
                    }
                    throw new Error('Expected a function timer handler in workspace stash retry tests');
                },
            });
            return timerId as unknown as ReturnType<typeof setTimeout>;
        });
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timerId: Parameters<typeof clearTimeout>[0]) => {
            const pendingIndex = pendingTimers.findIndex((timer) => timer.id === timerId);
            if (pendingIndex >= 0) {
                pendingTimers.splice(pendingIndex, 1);
            }
        });
        const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

        try {
            await body({
                advanceTimersByCount: async (count: number) => {
                    for (let i = 0; i < count; i += 1) {
                        const nextTimer = pendingTimers.shift();
                        if (!nextTimer) {
                            throw new Error(`Expected at least ${count} pending retry timers, but only found ${i}`);
                        }
                        await act(async () => {
                            nowMs += nextTimer.delayMs;
                            nextTimer.run();
                        });
                        await settle();
                    }
                },
            });
        } finally {
            setTimeoutSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            dateNowSpy.mockRestore();
        }
    }

    it('loads stashes and renders the diff for the first stash', async () => {
        const { WorkspaceScmStashDetailsView } = await import('./WorkspaceScmStashDetailsView');
        await renderScreen(
            <WorkspaceScmStashDetailsView
                scopeId="project:wr_1"
                workspaceRefId="wr_1"
                workspaceCacheKey="wk_1"
                machineId="m1"
                rootPath="/repo"
                serverId="s1"
            />,
        );

        await settle();

        expect(machineScmStashListSpy).toHaveBeenCalledWith('m1', expect.objectContaining({ cwd: '/repo' }), { serverId: 's1' });
        expect(machineScmStashShowSpy).toHaveBeenCalledWith('m1', expect.objectContaining({ cwd: '/repo', stashRef: 'stash@{0}' }), { serverId: 's1' });
        expect(diffFilesListSpy).toHaveBeenCalled();
    });

    it('restores and discards the selected stash via machine RPC', async () => {
        const { WorkspaceScmStashDetailsView } = await import('./WorkspaceScmStashDetailsView');
        const screen = await renderScreen(
            <WorkspaceScmStashDetailsView
                scopeId="project:wr_1"
                workspaceRefId="wr_1"
                workspaceCacheKey="wk_1"
                machineId="m1"
                rootPath="/repo"
                serverId="s1"
            />,
        );

        await settle();

        const restoreButton = screen.tree.findByProps({ accessibilityLabel: 'files.stash.restore' });
        await act(async () => {
            restoreButton.props.onPress?.();
            await settle();
        });
        expect(machineScmStashPopSpy).toHaveBeenCalledWith('m1', expect.objectContaining({ cwd: '/repo', stashRef: 'stash@{0}' }), { serverId: 's1' });

        const discardButton = screen.tree.findByProps({ accessibilityLabel: 'files.stash.discard' });
        await act(async () => {
            discardButton.props.onPress?.();
            await settle();
        });
        expect(machineScmStashDropSpy).toHaveBeenCalledWith('m1', expect.objectContaining({ cwd: '/repo', stashRef: 'stash@{0}' }), { serverId: 's1' });
    });

    it('switches between stashes from the dropdown trigger and shows stash metadata in the subtitle', async () => {
        machineScmStashListSpy.mockResolvedValueOnce({
            success: true,
            stashes: [
                { stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() },
                { stashRef: 'stash@{1}', kind: 'unmanaged', message: 'WIP on feature: unmanaged', createdAt: Date.now() - 60_000 },
            ],
            totalCount: 2,
        });

        const { WorkspaceScmStashDetailsView } = await import('./WorkspaceScmStashDetailsView');
        const screen = await renderScreen(
            <WorkspaceScmStashDetailsView
                scopeId="project:wr_1"
                workspaceRefId="wr_1"
                workspaceCacheKey="wk_1"
                machineId="m1"
                rootPath="/repo"
                serverId="s1"
            />,
        );

        await settle();
        machineScmStashShowSpy.mockClear();

        const stashSelector = screen.tree.findByProps({ title: 'files.stash.detailsTitle' });
        expect(stashSelector.props.title).toBe('files.stash.detailsTitle');
        expect(String(stashSelector.props.subtitle ?? '')).toContain('stash@{0}');

        await act(async () => {
            stashSelector.props.onPress?.();
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
            await settle();
        });

        const unmanagedOption = screen.tree.findByProps({
            testID: `dropdown-option-${String('stash@{1}').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        });
        await act(async () => {
            unmanagedOption.props.onPress?.();
            await settle();
        });

        expect(machineScmStashShowSpy).toHaveBeenCalledWith('m1', expect.objectContaining({ cwd: '/repo', stashRef: 'stash@{1}' }), { serverId: 's1' });
        const updatedSelector = screen.tree.findByProps({ title: 'files.stash.detailsTitle' });
        expect(String(updatedSelector.props.subtitle ?? '')).toContain('stash@{1}');
    });

    it('retries the stash list when the backend is transiently unavailable', async () => {
        await withControlledRetryTimers(async ({ advanceTimersByCount }) => {
            machineScmStashListSpy
                .mockResolvedValueOnce({
                    success: false,
                    error: 'RPC method not available',
                    errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
                })
                .mockResolvedValueOnce({
                    success: true,
                    stashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() }],
                    totalCount: 1,
                });

            const { WorkspaceScmStashDetailsView } = await import('./WorkspaceScmStashDetailsView');
            await renderScreen(
                <WorkspaceScmStashDetailsView
                    scopeId="project:wr_1"
                    workspaceRefId="wr_1"
                    workspaceCacheKey="wk_1"
                    machineId="m1"
                    rootPath="/repo"
                    serverId="s1"
                />,
            );

            await settle();
            expect(machineScmStashListSpy).toHaveBeenCalledTimes(1);

            await advanceTimersByCount(1);
            expect(machineScmStashListSpy).toHaveBeenCalledTimes(2);
        });
    });

    it('retries the selected stash diff when the backend is transiently unavailable', async () => {
        await withControlledRetryTimers(async ({ advanceTimersByCount }) => {
            machineScmStashListSpy.mockResolvedValue({
                success: true,
                stashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() }],
                totalCount: 1,
            });
            machineScmStashShowSpy
                .mockResolvedValueOnce({
                    success: false,
                    error: 'RPC method not available',
                    errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
                })
                .mockResolvedValueOnce({
                    success: true,
                    diff: [
                        'diff --git a/src/retry.ts b/src/retry.ts',
                        'index 0000000..1111111 100644',
                        '--- a/src/retry.ts',
                        '+++ b/src/retry.ts',
                        '@@ -1,1 +1,1 @@',
                        '-export const retry = 1;',
                        '+export const retry = 2;',
                        '',
                    ].join('\n'),
                    truncated: false,
                });

            const { WorkspaceScmStashDetailsView } = await import('./WorkspaceScmStashDetailsView');
            await renderScreen(
                <WorkspaceScmStashDetailsView
                    scopeId="project:wr_1"
                    workspaceRefId="wr_1"
                    workspaceCacheKey="wk_1"
                    machineId="m1"
                    rootPath="/repo"
                    serverId="s1"
                />,
            );

            await settle();
            expect(machineScmStashShowSpy).toHaveBeenCalledTimes(1);

            await advanceTimersByCount(1);
            expect(machineScmStashShowSpy).toHaveBeenCalledTimes(2);
            expect(diffFilesListSpy).toHaveBeenCalled();
        });
    });
});
