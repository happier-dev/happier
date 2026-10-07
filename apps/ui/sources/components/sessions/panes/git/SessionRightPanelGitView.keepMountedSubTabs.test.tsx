import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScmCapabilities, type ScmWorkingSnapshot } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionDetailsPanelCommonModuleMocks } from '../sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '../sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});
const runtime = installSessionPaneRuntimeTestHarness();
function createSnapshot(isRepo = true): ScmWorkingSnapshot {
    return {
        fetchedAt: 1, projectKey: 'm1:/repo',
        repo: { isRepo, rootPath: '/repo', backendId: 'git', mode: '.git', remotes: [], worktrees: [] },
        capabilities: createScmCapabilities({ readStatus: true, readLog: true, readDiffFile: true, changeSetModel: 'index' }),
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0, hasConflicts: false, entries: [],
        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    };
}
beforeEach(() => {
    storage.getState().applySessions([createSessionFixture({
        id: 's1', serverId: runtime.serverId, active: true,
        metadata: { machineId: 'm1', path: '/repo', host: 'test-machine' },
    })]);
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', storageMode: 'plain', activeAt: Date.now() })], true, { sourceServerId: runtime.serverId });
    storage.getState().applySettingsLocal({ scmGitPaneLayout: 'tabs' });
});
async function render() {
    const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
    return renderScreen(<runtime.Wrapper><SessionRightPanelGitView sessionId="s1" serverId={runtime.serverId} scopeId="session:s1" /></runtime.Wrapper>);
}

beforeEach(() => storage.getState().updateSessionProjectScmSnapshot('s1', createSnapshot(), runtime.serverId));
describe('SessionRightPanelGitView (keep mounted sub-tabs)', () => {
    it('mounts History after activation and preserves it when returning to Changes', async () => {
        const screen = await render();
        expect(screen.findHostByTestId('session-rightpanel-git-surface:commit')).not.toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-surface:history')).toBeNull();
        await screen.pressByTestIdAsync('session-rightpanel-git-subtab:history');
        const history = screen.findHostByTestId('session-rightpanel-git-surface:history');
        expect(history).not.toBeNull();
        await screen.pressByTestIdAsync('session-rightpanel-git-subtab:commit');
        expect(screen.findHostByTestId('session-rightpanel-git-surface:history')).toBe(history);
        expect(history?.props.pointerEvents).toBe('none');
    });

    it('offers Changes and History in Tabs layout and no sub-tabs in Unified', async () => {
        const screen = await render();
        expect(screen.findHostByTestId('session-rightpanel-git-subtab:commit')).not.toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-subtab:history')).not.toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-subtab:update')).toBeNull();
        await act(async () => storage.getState().applySettingsLocal({ scmGitPaneLayout: 'unified' }));
        expect(screen.findHostByTestId('session-rightpanel-git-subtab:commit')).toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-subtab:history')).toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-surface:commit')).not.toBeNull();
    });

    it('keeps commit-tab action callbacks stable when switching to History', async () => {
        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');
        const screen = await render();
        const first = screen.findByType(SessionRightPanelGitCommitTabContent)?.props;
        await screen.pressByTestIdAsync('session-rightpanel-git-subtab:history');
        const next = screen.findByType(SessionRightPanelGitCommitTabContent)?.props;
        expect(first).toBeTruthy();
        expect(next.openFileInDetails).toBe(first.openFileInDetails);
        expect(next.openFileInDetailsPinned).toBe(first.openFileInDetailsPinned);
        expect(next.onOpenReviewAllChanges).toBe(first.onOpenReviewAllChanges);
        expect(next.onOpenStashDetails).toBe(first.onOpenStashDetails);
    });
});
