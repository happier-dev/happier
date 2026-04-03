import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const original = await importOriginal<any>();
    return {
        ...original,
        useSetting: (key: string) => {
            if (key === 'wrapLinesInDiffs') return true;
            if (key === 'showLineNumbers') return true;
            if (key === 'scmReviewMaxFiles') return 25;
            return original.useSetting?.(key);
        },
    };
});

const machineScmStatusSnapshotSpy = vi.fn<(machineId: string, request: any) => Promise<any>>(async () => ({
    success: true,
    snapshot: {
        repo: { isRepo: true },
        entries: [
            {
                path: 'src/a.ts',
                kind: 'modified',
                previousPath: null,
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 1,
                    pendingRemoved: 1,
                    isBinary: false,
                },
            },
        ],
        branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
        capabilities: {},
    },
}));
const machineScmDiffFileSpy = vi.fn<(machineId: string, request: any) => Promise<any>>(async () => ({
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
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmStatusSnapshot: (machineId: string, request: any) => machineScmStatusSnapshotSpy(machineId, request),
    machineScmDiffFile: (machineId: string, request: any) => machineScmDiffFileSpy(machineId, request),
}));

const diffFilesListSpy = vi.fn();
vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: (props: any) => {
        diffFilesListSpy(props);
        return React.createElement('DiffFilesListView', props);
    },
}));

describe('WorkspaceScmReviewDetailsView', () => {
    beforeEach(() => {
        machineScmStatusSnapshotSpy.mockClear();
        machineScmDiffFileSpy.mockClear();
        diffFilesListSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    async function settle(): Promise<void> {
        await flushHookEffects({ cycles: 2, turns: 2 });
    }

    it('loads the workspace SCM snapshot and renders a review diff', async () => {
        const { WorkspaceScmReviewDetailsView } = await import('./WorkspaceScmReviewDetailsView');
        await renderScreen(
            <WorkspaceScmReviewDetailsView
                scopeId="project:wr_1"
                workspaceRefId="wr_1"
                workspaceCacheKey="wk_1"
                machineId="m1"
                rootPath="/repo"
                serverId="s1"
            />,
        );

        await settle();

        expect(machineScmStatusSnapshotSpy).toHaveBeenCalledWith('m1', expect.objectContaining({ cwd: '/repo' }));
        expect(machineScmDiffFileSpy).toHaveBeenCalledWith('m1', expect.objectContaining({ cwd: '/repo', path: 'src/a.ts' }));
        expect(diffFilesListSpy).toHaveBeenCalled();
    });
});
