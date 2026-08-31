import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    createModalModuleMock,
    createPartialStorageModuleMock,
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
    SCM_OPERATION_ERROR_CODES,
    type ScmStashDropResponse,
    type ScmStashListRequest,
    type ScmStashListResponse,
    type ScmStashDropRequest,
    type ScmStashPopRequest,
    type ScmStashPopResponse,
    type ScmStashShowRequest,
    type ScmStashShowResponse,
    type ScmRepositoryRemoveIndexLockRequest,
    type ScmRepositoryRemoveIndexLockResponse,
} from '@happier-dev/protocol';

import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffFilesListSpy = vi.fn();

const sessionScmStashListSpy = vi.fn<
    (sessionId: string, request: ScmStashListRequest) => Promise<ScmStashListResponse>
>(async (_sessionId, _request) => ({
    success: true,
    stashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() }],
    totalCount: 1,
}));
const sessionScmStashShowSpy = vi.fn<
    (sessionId: string, request: ScmStashShowRequest) => Promise<ScmStashShowResponse>
>(async (_sessionId, _request) => ({
    success: true,
    diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 0000000..1111111 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,1 +1,1 @@',
        '-export const a = 1;',
        '+export const a = 2;',
        '',
    ].join('\n'),
    truncated: false,
}));
const sessionScmStashPopSpy = vi.fn<
    (sessionId: string, request: ScmStashPopRequest) => Promise<ScmStashPopResponse>
>(async (_sessionId, _request) => ({ success: true }));
const sessionScmStashDropSpy = vi.fn<
    (sessionId: string, request: ScmStashDropRequest) => Promise<ScmStashDropResponse>
>(async (_sessionId, _request) => ({ success: true }));
const sessionScmRepositoryRemoveIndexLockSpy = vi.fn<
    (sessionId: string, request: ScmRepositoryRemoveIndexLockRequest) => Promise<ScmRepositoryRemoveIndexLockResponse>
>(async (_sessionId, _request) => ({
    success: true,
    removed: true,
    lockPath: '/repo/.git/index.lock',
}));
const readMachineTargetForSessionSpy = vi.fn<(sessionId: string) => { machineId: string; basePath: string }>(() => ({
    machineId: 'machine-1',
    basePath: '/repo',
}));

let scmWriteEnabled = true;

const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async (..._args: any[]) => true);

installSessionFilesViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
            View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
        });
    },
    modal: async () => {
        const modalModuleMock = createModalModuleMock({ confirmResult: true });
        modalModuleMock.spies.alert.mockImplementation((...args: any[]) => modalAlertSpy(...args));
        modalModuleMock.spies.confirm.mockImplementation((...args: any[]) => modalConfirmSpy(...args));
        return modalModuleMock.module;
    },
    storage: async (importOriginal) =>
        createPartialStorageModuleMock(importOriginal, {
            useSetting: (key: string) => {
                if (key === 'wrapLinesInDiffs') return true;
                if (key === 'showLineNumbers') return true;
                if (key === 'scmReviewMaxFiles') return 25;
                if (key === 'scmReviewMaxChangedLines') return 2000;
                if (key === 'scmReviewPrefetchAheadCountWeb') return 1;
                if (key === 'scmReviewPrefetchBehindCountWeb') return 1;
                if (key === 'scmReviewPrefetchDebounceMs') return 0;
                return undefined;
            },
        }),
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => scmWriteEnabled,
}));

vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionScmStashList: (sessionId: string, request: ScmStashListRequest) => sessionScmStashListSpy(sessionId, request),
            sessionScmStashShow: (sessionId: string, request: ScmStashShowRequest) => sessionScmStashShowSpy(sessionId, request),
            sessionScmStashPop: (sessionId: string, request: ScmStashPopRequest) => sessionScmStashPopSpy(sessionId, request),
            sessionScmStashDrop: (sessionId: string, request: ScmStashDropRequest) => sessionScmStashDropSpy(sessionId, request),
            sessionScmRepositoryRemoveIndexLock: (sessionId: string, request: ScmRepositoryRemoveIndexLockRequest) =>
                sessionScmRepositoryRemoveIndexLockSpy(sessionId, request),
        },
    });
});

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionSpy(sessionId),
}));

const invalidateFromMutationAndAwaitSpy = vi.fn(async (..._args: any[]) => {});
vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: (...args: any[]) => invalidateFromMutationAndAwaitSpy(...args),
    },
}));

vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: (props: any) => {
        diffFilesListSpy(props);
        return React.createElement('DiffFilesListView', props);
    },
}));

vi.mock('@/components/ui/code/diff/DiffPresentationStyleToggleButton', () => ({
    DiffPresentationStyleToggleButton: 'DiffPresentationStyleToggleButton',
}));
vi.mock('@/components/ui/code/WrapLinesToggleButton', () => ({ WrapLinesToggleButton: 'WrapLinesToggleButton' }));

describe('SessionScmStashDetailsView', () => {
    beforeEach(() => {
        scmWriteEnabled = true;
        sessionScmStashListSpy.mockClear();
        sessionScmStashShowSpy.mockClear();
        sessionScmStashPopSpy.mockClear();
        sessionScmStashDropSpy.mockClear();
        sessionScmRepositoryRemoveIndexLockSpy.mockClear();
        sessionScmRepositoryRemoveIndexLockSpy.mockResolvedValue({
            success: true,
            removed: true,
            lockPath: '/repo/.git/index.lock',
        });
        readMachineTargetForSessionSpy.mockClear();
        readMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine-1',
            basePath: '/repo',
        });
        diffFilesListSpy.mockClear();
        invalidateFromMutationAndAwaitSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    async function renderStashDetailsView() {
        const { SessionScmStashDetailsView } = await import('./SessionScmStashDetailsView');
        const screen = await renderScreen(<SessionScmStashDetailsView sessionId="s1" scopeId="session:s1" />);
        await settleStashDetailsView();
        return screen;
    }

    async function settleStashDetailsView(options: Parameters<typeof flushHookEffects>[0] = {}): Promise<void> {
        await flushHookEffects({
            cycles: 1,
            turns: 1,
            ...options,
        });
    }

    it('loads managed stashes and renders the diff for the first stash', async () => {
        const screen = await renderStashDetailsView();
        expect(sessionScmStashShowSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ stashRef: 'stash@{0}' }));
        expect(diffFilesListSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualizeFileList: true }));
        expect(screen.findAllByType('WrapLinesToggleButton' as never)).toHaveLength(1);
    });

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
                    throw new Error('Expected a function timer handler in stash retry tests');
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
                        await settleStashDetailsView();
                    }
                },
            });
        } finally {
            setTimeoutSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            dateNowSpy.mockRestore();
        }
    }

    it('retries the selected stash diff when the backend is transiently unavailable', async () => {
        await withControlledRetryTimers(async ({ advanceTimersByCount }) => {
            sessionScmStashListSpy.mockResolvedValue({
                success: true,
                stashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() }],
                totalCount: 1,
            });
            sessionScmStashShowSpy
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

            await renderStashDetailsView();

            expect(sessionScmStashShowSpy).toHaveBeenCalledTimes(1);

            await advanceTimersByCount(1);
            expect(sessionScmStashShowSpy).toHaveBeenCalledTimes(2);

            expect(diffFilesListSpy).toHaveBeenCalled();
        });
    });

    it('stops retrying the stash list when the backend stays unavailable and surfaces the error', async () => {
        await withControlledRetryTimers(async ({ advanceTimersByCount }) => {
            sessionScmStashListSpy.mockResolvedValue({
                success: false,
                error: 'RPC method not available',
                errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
            });

            const screen = await renderStashDetailsView();
            await advanceTimersByCount(4);
            expect(sessionScmStashListSpy).toHaveBeenCalledTimes(5);

            expect(screen.getTextContent()).toContain('RPC method not available');
        });
    });

    it('stops retrying the selected stash diff when the backend stays unavailable and surfaces the error', async () => {
        await withControlledRetryTimers(async ({ advanceTimersByCount }) => {
            sessionScmStashListSpy.mockResolvedValue({
                success: true,
                stashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() }],
                totalCount: 1,
            });
            sessionScmStashShowSpy.mockResolvedValue({
                success: false,
                error: 'RPC method not available',
                errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
            });

            const screen = await renderStashDetailsView();
            await advanceTimersByCount(4);
            expect(sessionScmStashShowSpy).toHaveBeenCalledTimes(5);

            expect(screen.getTextContent()).toContain('RPC method not available');
        });
    });

    it('switches between stashes from the dropdown trigger and shows stash metadata in the subtitle', async () => {
        sessionScmStashListSpy.mockResolvedValue({
            success: true,
            stashes: [
                { stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() },
                { stashRef: 'stash@{1}', kind: 'unmanaged', message: 'WIP on feature: unmanaged', createdAt: Date.now() - 60_000 },
            ],
            totalCount: 2,
        });
        sessionScmStashShowSpy.mockImplementation(async (_sessionId, input) => ({
            success: true,
            diff: [
                `diff --git a/${input.stashRef}.ts b/${input.stashRef}.ts`,
                'index 0000000..1111111 100644',
                `--- a/${input.stashRef}.ts`,
                `+++ b/${input.stashRef}.ts`,
                '@@ -1,1 +1,1 @@',
                '-export const stash = 1;',
                '+export const stash = 2;',
                '',
            ].join('\n'),
            truncated: false,
        }));

        const screen = await renderStashDetailsView();

        const stashSelector = screen.tree.findByProps({ title: 'files.stash.detailsTitle' });
        expect(String(stashSelector.props.subtitle ?? '')).toContain('stash@{0}');

        await act(async () => {
            stashSelector.props.onPress?.();
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
            await settleStashDetailsView();
        });

        const unmanagedOption = screen.tree.findByProps({
            testID: `dropdown-option-${String('stash@{1}').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        });
        await act(async () => {
            unmanagedOption.props.onPress?.();
            await settleStashDetailsView();
        });

        expect(sessionScmStashShowSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ stashRef: 'stash@{1}' }));
        const updatedSelector = screen.tree.findByProps({ title: 'files.stash.detailsTitle' });
        expect(String(updatedSelector.props.subtitle ?? '')).toContain('stash@{1}');
    });

    it('pops the selected stash when restoring', async () => {
        const screen = await renderStashDetailsView();

        await screen.pressByTestIdAsync('scm-stash-restore-button');
        await settleStashDetailsView();

        expect(sessionScmStashPopSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ stashRef: 'stash@{0}' }));
        expect(invalidateFromMutationAndAwaitSpy).toHaveBeenCalledWith('s1');
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('drops the selected stash when discarding', async () => {
        const screen = await renderStashDetailsView();

        await screen.pressByTestIdAsync('scm-stash-discard-button');
        await settleStashDetailsView();

        expect(sessionScmStashDropSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ stashRef: 'stash@{0}' }));
        expect(invalidateFromMutationAndAwaitSpy).toHaveBeenCalledWith('s1');
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('offers stale Git index-lock recovery and retries stash pop once', async () => {
        sessionScmStashPopSpy
            .mockResolvedValueOnce({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
            })
            .mockResolvedValueOnce({ success: true });
        const screen = await renderStashDetailsView();

        await screen.pressByTestIdAsync('scm-stash-restore-button');
        await settleStashDetailsView();

        expect(modalConfirmSpy).toHaveBeenCalled();
        expect(sessionScmRepositoryRemoveIndexLockSpy).toHaveBeenCalledWith('s1', {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
        });
        expect(sessionScmStashPopSpy).toHaveBeenCalledTimes(2);
        expect(invalidateFromMutationAndAwaitSpy).toHaveBeenCalledWith('s1');
    });
});
