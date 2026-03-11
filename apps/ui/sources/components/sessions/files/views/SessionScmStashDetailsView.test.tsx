import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
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

import { SessionScmStashDetailsView } from './SessionScmStashDetailsView';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

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

let scmWriteEnabled = true;

vi.mock('react-native', () => ({
    View: 'View',
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },
    Dimensions: { get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }) },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                surface: '#fff',
                surfaceHigh: '#fff',
                surfaceHighest: '#fff',
                divider: '#ddd',
                text: '#111',
                textSecondary: '#666',
                warning: '#f00',
                success: '#0a0',
                danger: '#c00',
                textLink: '#00f',
                groupped: { background: '#fff' },
            },
        },
    }),
    StyleSheet: { create: (fn: any) => fn({ colors: { divider: '#ddd' } }) },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => scmWriteEnabled,
}));

vi.mock('@/sync/ops', () => ({
    sessionScmStashList: (sessionId: string, request: ScmStashListRequest) => sessionScmStashListSpy(sessionId, request),
    sessionScmStashShow: (sessionId: string, request: ScmStashShowRequest) => sessionScmStashShowSpy(sessionId, request),
    sessionScmStashPop: (sessionId: string, request: ScmStashPopRequest) => sessionScmStashPopSpy(sessionId, request),
    sessionScmStashDrop: (sessionId: string, request: ScmStashDropRequest) => sessionScmStashDropSpy(sessionId, request),
}));

vi.mock('@/sync/domains/state/storage', () => ({
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
}));

const invalidateFromMutationAndAwaitSpy = vi.fn(async (..._args: any[]) => {});
vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: (...args: any[]) => invalidateFromMutationAndAwaitSpy(...args),
    },
}));

const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async (..._args: any[]) => true);
vi.mock('@/modal', () => ({
    Modal: {
        alert: (...args: any[]) => modalAlertSpy(...args),
        confirm: (...args: any[]) => modalConfirmSpy(...args),
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

describe('SessionScmStashDetailsView', () => {
    it('loads managed stashes and renders the diff for the first stash', async () => {
        scmWriteEnabled = true;
        sessionScmStashListSpy.mockClear();
        sessionScmStashShowSpy.mockClear();
        diffFilesListSpy.mockClear();

        await act(async () => {
            renderer.create(<SessionScmStashDetailsView sessionId="s1" scopeId="session:s1" />);
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (diffFilesListSpy.mock.calls.length > 0) break;
        }

        expect(sessionScmStashListSpy).toHaveBeenCalledTimes(1);
        expect(sessionScmStashShowSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ stashRef: 'stash@{0}' }));
        expect(diffFilesListSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualizeFileList: true }));
    });

    it('retries the selected stash diff when the backend is transiently unavailable', async () => {
        vi.useFakeTimers();
        scmWriteEnabled = true;
        sessionScmStashListSpy.mockClear();
        sessionScmStashShowSpy.mockClear();
        diffFilesListSpy.mockClear();
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

        await act(async () => {
            renderer.create(<SessionScmStashDetailsView sessionId="s1" scopeId="session:s1" />);
        });

        expect(sessionScmStashShowSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            vi.advanceTimersByTime(1_000);
            await Promise.resolve();
        });

        expect(sessionScmStashShowSpy).toHaveBeenCalledTimes(2);

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (diffFilesListSpy.mock.calls.length > 0) break;
        }

        expect(diffFilesListSpy).toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('stops retrying the stash list when the backend stays unavailable and surfaces the error', async () => {
        vi.useFakeTimers();
        scmWriteEnabled = true;
        sessionScmStashListSpy.mockClear();
        sessionScmStashShowSpy.mockClear();
        sessionScmStashListSpy.mockResolvedValue({
            success: false,
            error: 'RPC method not available',
            errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionScmStashDetailsView sessionId="s1" scopeId="session:s1" />);
        });

        for (let i = 0; i < 11; i++) {
            await act(async () => {
                vi.advanceTimersByTime(1_000);
                await Promise.resolve();
            });
        }

        const roots = tree.root.findAllByProps({ testID: 'scm-stash-details-root' });
        expect(roots).toHaveLength(1);
        expect(sessionScmStashListSpy).toHaveBeenCalledTimes(5);
        expect(
            tree.root.findAll(
                (node) => typeof node.props?.children === 'string' && String(node.props.children).includes('RPC method not available'),
            ),
        ).not.toHaveLength(0);
        vi.useRealTimers();
    });

    it('stops retrying the selected stash diff when the backend stays unavailable and surfaces the error', async () => {
        vi.useFakeTimers();
        scmWriteEnabled = true;
        sessionScmStashListSpy.mockClear();
        sessionScmStashShowSpy.mockClear();
        diffFilesListSpy.mockClear();
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

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionScmStashDetailsView sessionId="s1" scopeId="session:s1" />);
        });

        for (let i = 0; i < 11; i++) {
            await act(async () => {
                vi.advanceTimersByTime(1_000);
                await Promise.resolve();
            });
        }

        expect(sessionScmStashShowSpy).toHaveBeenCalledTimes(5);
        expect(
            tree.root.findAll(
                (node) => typeof node.props?.children === 'string' && String(node.props.children).includes('RPC method not available'),
            ),
        ).not.toHaveLength(0);
        vi.useRealTimers();
    });

    it('loads the clicked stash when switching between managed stash pills', async () => {
        scmWriteEnabled = true;
        sessionScmStashListSpy.mockClear();
        sessionScmStashShowSpy.mockClear();
        diffFilesListSpy.mockClear();
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

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionScmStashDetailsView sessionId="s1" scopeId="session:s1" />);
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (tree.root.findAllByProps({ testID: `scm-stash-pill-${toTestIdSafeValue('stash@{1}')}` }).length > 0) break;
        }

        const secondPill = tree.root.findByProps({ testID: `scm-stash-pill-${toTestIdSafeValue('stash@{1}')}` });
        act(() => {
            secondPill.props.onPress();
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (
                sessionScmStashShowSpy.mock.calls.some(
                    (call) => call[1] && typeof call[1] === 'object' && (call[1] as { stashRef?: string }).stashRef === 'stash@{1}',
                )
            ) {
                break;
            }
        }

        expect(sessionScmStashShowSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ stashRef: 'stash@{1}' }));
    });

    it('pops the selected stash when restoring', async () => {
        scmWriteEnabled = true;
        sessionScmStashListSpy.mockClear();
        sessionScmStashShowSpy.mockClear();
        sessionScmStashPopSpy.mockClear();
        invalidateFromMutationAndAwaitSpy.mockClear();
        modalConfirmSpy.mockClear();

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionScmStashDetailsView sessionId="s1" scopeId="session:s1" />);
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (tree.root.findAllByProps({ testID: 'scm-stash-restore-button' }).length > 0) break;
        }

        const restoreButton = tree.root.findByProps({ testID: 'scm-stash-restore-button' });
        act(() => {
            restoreButton.props.onPress();
        });

        for (let i = 0; i < 10; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (sessionScmStashPopSpy.mock.calls.length > 0) break;
        }

        expect(modalConfirmSpy).toHaveBeenCalled();
        expect(sessionScmStashPopSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ stashRef: 'stash@{0}' }));
        expect(invalidateFromMutationAndAwaitSpy).toHaveBeenCalledWith('s1');
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('drops the selected stash when discarding', async () => {
        scmWriteEnabled = true;
        sessionScmStashListSpy.mockClear();
        sessionScmStashShowSpy.mockClear();
        sessionScmStashDropSpy.mockClear();
        invalidateFromMutationAndAwaitSpy.mockClear();
        modalConfirmSpy.mockClear();

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionScmStashDetailsView sessionId="s1" scopeId="session:s1" />);
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (tree.root.findAllByProps({ testID: 'scm-stash-discard-button' }).length > 0) break;
        }

        const discardButton = tree.root.findByProps({ testID: 'scm-stash-discard-button' });
        act(() => {
            discardButton.props.onPress();
        });

        for (let i = 0; i < 10; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (sessionScmStashDropSpy.mock.calls.length > 0) break;
        }

        expect(modalConfirmSpy).toHaveBeenCalled();
        expect(sessionScmStashDropSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ stashRef: 'stash@{0}' }));
        expect(invalidateFromMutationAndAwaitSpy).toHaveBeenCalledWith('s1');
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });
});
