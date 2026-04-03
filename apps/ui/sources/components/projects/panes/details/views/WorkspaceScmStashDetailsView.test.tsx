import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

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

const machineScmStashListSpy = vi.fn<(machineId: string, request: any) => Promise<any>>(async () => ({
    success: true,
    managedCount: 1,
    managedStashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: Date.now() }],
    totalCount: 1,
}));
const machineScmStashShowSpy = vi.fn<(machineId: string, request: any) => Promise<any>>(async () => ({
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

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmStashList: (machineId: string, request: any) => machineScmStashListSpy(machineId, request),
    machineScmStashShow: (machineId: string, request: any) => machineScmStashShowSpy(machineId, request),
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
        diffFilesListSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    async function settle(): Promise<void> {
        await flushHookEffects({ cycles: 2, turns: 2 });
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

        expect(machineScmStashListSpy).toHaveBeenCalledWith('m1', expect.objectContaining({ cwd: '/repo' }));
        expect(machineScmStashShowSpy).toHaveBeenCalledWith('m1', expect.objectContaining({ cwd: '/repo', stashRef: 'stash@{0}' }));
        expect(diffFilesListSpy).toHaveBeenCalled();
    });
});
