import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createModalModuleMock,
    createPartialStorageModuleMock,
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    SCM_OPERATION_ERROR_CODES,
    type ScmStashDropResponse,
    type ScmStashListRequest,
    type ScmStashListResponse,
    type ScmStashDropRequest,
    type ScmStashPopRequest,
    type ScmStashPopResponse,
    type ScmStashShowRequest,
    type ScmStashShowResponse,
} from '@happier-dev/protocol';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

import { SessionScmStashDetailsView } from './SessionScmStashDetailsView';
import {
    resolveManagedStashRetryDelayMs,
    resolveManagedStashRetryMaxIntervalMs,
} from './scmStashRetry';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffFilesListSpy = vi.fn();

const sessionScmStashListSpy = vi.fn<
    (sessionId: string, request: ScmStashListRequest) => Promise<ScmStashListResponse>
>(async (_sessionId, _request) => ({
    success: true,
    managedCount: 1,
    managedStashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() }],
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

const managedStashRetryMaxIntervalMs = resolveManagedStashRetryMaxIntervalMs(undefined);
const managedStashRetryDelayMs = resolveManagedStashRetryDelayMs(0, managedStashRetryMaxIntervalMs);

let scmWriteEnabled = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                                View: 'View',
                                                ActivityIndicator: 'ActivityIndicator',
                                                Pressable: 'Pressable',
                                                ScrollView: 'ScrollView',
                                                Dimensions: { get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }) },
                                            }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

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
        },
    });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    return createPartialStorageModuleMock(importOriginal, {
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
    });
});

const invalidateFromMutationAndAwaitSpy = vi.fn(async (..._args: any[]) => {});
vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: (...args: any[]) => invalidateFromMutationAndAwaitSpy(...args),
    },
}));

const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async (..._args: any[]) => true);
vi.mock('@/modal', () => {
    const modalModuleMock = createModalModuleMock({ confirmResult: true });
    modalModuleMock.spies.alert.mockImplementation((...args: any[]) => modalAlertSpy(...args));
    modalModuleMock.spies.confirm.mockImplementation((...args: any[]) => modalConfirmSpy(...args));
    return modalModuleMock.module;
});

vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: (props: any) => {
        diffFilesListSpy(props);
        return React.createElement('DiffFilesListView', props);
    },
}));

vi.mock('@/components/ui/code/diff/DiffPresentationStyleToggleButton', () => ({
    DiffPresentationStyleToggleButton: 'DiffPresentationStyleToggleButton',
}));

describe('SessionScmStashDetailsView', () => {
    beforeEach(() => {
        scmWriteEnabled = true;
        sessionScmStashListSpy.mockClear();
        sessionScmStashShowSpy.mockClear();
        sessionScmStashPopSpy.mockClear();
        sessionScmStashDropSpy.mockClear();
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
        const screen = await renderScreen(<SessionScmStashDetailsView sessionId="s1" scopeId="session:s1" />);
        await vi.waitFor(() => {
            expect(sessionScmStashListSpy).toHaveBeenCalledTimes(1);
        });
        return screen;
    }

    async function withFakeTimers(body: () => Promise<void>): Promise<void> {
        vi.useFakeTimers();
        try {
            await body();
        } finally {
            vi.useRealTimers();
        }
    }

    it('loads managed stashes and renders the diff for the first stash', async () => {
        await renderStashDetailsView();

        await vi.waitFor(() => {
            expect(sessionScmStashShowSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ stashRef: 'stash@{0}' }));
            expect(diffFilesListSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualizeFileList: true }));
        });
    });

    it('retries the selected stash diff when the backend is transiently unavailable', async () => {
        await withFakeTimers(async () => {
            sessionScmStashListSpy.mockResolvedValue({
                success: true,
                managedCount: 1,
                managedStashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() }],
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

            await flushHookEffects({ cycles: 1, advanceTimersMs: managedStashRetryDelayMs });

            await vi.waitFor(() => {
                expect(sessionScmStashShowSpy).toHaveBeenCalledTimes(2);
            });

            expect(diffFilesListSpy).toHaveBeenCalled();
        });
    });

    it('stops retrying the stash list when the backend stays unavailable and surfaces the error', async () => {
        await withFakeTimers(async () => {
            sessionScmStashListSpy.mockResolvedValue({
                success: false,
                error: 'RPC method not available',
                errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
            });

            const screen = await renderStashDetailsView();
            await flushHookEffects({ cycles: 1, advanceTimersMs: managedStashRetryMaxIntervalMs });
            await vi.waitFor(() => {
                expect(sessionScmStashListSpy).toHaveBeenCalledTimes(5);
            });

            expect(screen.getTextContent()).toContain('RPC method not available');
        });
    });

    it('stops retrying the selected stash diff when the backend stays unavailable and surfaces the error', async () => {
        await withFakeTimers(async () => {
            sessionScmStashListSpy.mockResolvedValue({
                success: true,
                managedCount: 1,
                managedStashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() }],
                totalCount: 1,
            });
            sessionScmStashShowSpy.mockResolvedValue({
                success: false,
                error: 'RPC method not available',
                errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
            });

            const screen = await renderStashDetailsView();
            await flushHookEffects({ cycles: 1, advanceTimersMs: managedStashRetryMaxIntervalMs });
            await vi.waitFor(() => {
                expect(sessionScmStashShowSpy).toHaveBeenCalledTimes(5);
            });

            expect(screen.getTextContent()).toContain('RPC method not available');
        });
    });

    it('loads the clicked stash when switching between managed stash pills', async () => {
        sessionScmStashListSpy.mockResolvedValue({
            success: true,
            managedCount: 2,
            managedStashes: [
                { stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() },
                { stashRef: 'stash@{1}', kind: 'branch', branch: 'feature', createdAt: Date.now() - 60_000 },
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
        await screen.pressByTestIdAsync(`scm-stash-pill-${toTestIdSafeValue('stash@{1}')}`);

        expect(sessionScmStashShowSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ stashRef: 'stash@{1}' }));
    });

    it('pops the selected stash when restoring', async () => {
        const screen = await renderStashDetailsView();

        await screen.pressByTestIdAsync('scm-stash-restore-button');

        expect(modalConfirmSpy).toHaveBeenCalled();
        expect(sessionScmStashPopSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ stashRef: 'stash@{0}' }));
        expect(invalidateFromMutationAndAwaitSpy).toHaveBeenCalledWith('s1');
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('drops the selected stash when discarding', async () => {
        const screen = await renderStashDetailsView();

        await screen.pressByTestIdAsync('scm-stash-discard-button');

        expect(modalConfirmSpy).toHaveBeenCalled();
        expect(sessionScmStashDropSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ stashRef: 'stash@{0}' }));
        expect(invalidateFromMutationAndAwaitSpy).toHaveBeenCalledWith('s1');
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });
});
