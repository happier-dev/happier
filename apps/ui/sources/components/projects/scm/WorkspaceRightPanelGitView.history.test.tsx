import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { machineScmLogList } from '@/sync/ops/scm/machineScm';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MachineScmLogList = typeof machineScmLogList;
const machineScmLogListSpy = vi.fn<MachineScmLogList>(async () => ({
    success: true,
    entries: [
        {
            sha: 'abc',
            shortSha: 'abc',
            authorName: 'A',
            authorEmail: 'a@example.com',
            timestamp: 1,
            subject: 'Test',
            body: '',
        },
    ],
}));

let snapshotMock: ScmWorkingSnapshot | null = null;
let scmWriteEnabledMock = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
        ActivityIndicator: 'ActivityIndicator',
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

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: () => ({
        snapshot: snapshotMock,
        loading: false,
        error: null,
        refresh: vi.fn(async () => {}),
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => scmWriteEnabledMock,
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmLogList: (...args: Parameters<typeof machineScmLogListSpy>) => machineScmLogListSpy(...args),
}));

vi.mock('./WorkspaceSourceControlView', () => ({
    WorkspaceSourceControlView: () => React.createElement('WorkspaceSourceControlViewStub'),
}));

describe('WorkspaceRightPanelGitView (history)', () => {
    it('loads commit history via machine RPC when the history sub-tab is selected', async () => {
        machineScmLogListSpy.mockClear();
        scmWriteEnabledMock = true;
        snapshotMock = {
            projectKey: 'p',
            fetchedAt: 1,
            repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
            capabilities: { readLog: true } as any,
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            hasConflicts: false,
            entries: [],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };

        const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
        const screen = await renderScreen(
            <WorkspaceRightPanelGitView
                serverId="s1"
                machineId="m1"
                rootPath="/repo"
                onOpenFile={() => {}}
            />,
        );

        const historyTab = screen.tree.findByProps({ testID: 'project-rightpanel-git-subtab:history' });
        await act(async () => {
            historyTab.props.onPress();
            await Promise.resolve();
        });

        expect(machineScmLogListSpy).toHaveBeenCalledTimes(1);
        const firstCall = machineScmLogListSpy.mock.calls[0];
        expect(firstCall).toBeTruthy();
        const machineId = firstCall?.[0];
        const request = firstCall?.[1];
        const options = firstCall?.[2];
        expect(machineId).toBe('m1');
        expect(request).toMatchObject({ cwd: '/repo', limit: 50, skip: 0 });
        expect(options).toEqual({ serverId: 's1' });
    });

    it('hides the update tab when source control writes are disabled', async () => {
        scmWriteEnabledMock = false;
        snapshotMock = {
            projectKey: 'p',
            fetchedAt: 1,
            repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
            capabilities: {
                readLog: true,
                writeRemoteFetch: true,
                writeRemotePull: true,
                writeRemotePush: true,
            } as any,
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            hasConflicts: false,
            entries: [],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };

        const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
        const screen = await renderScreen(
            <WorkspaceRightPanelGitView
                serverId="s1"
                machineId="m1"
                rootPath="/repo"
                onOpenFile={() => {}}
            />,
        );

        expect(screen.tree.findAllByProps({ testID: 'project-rightpanel-git-subtab:update' })).toHaveLength(0);
    });
});
