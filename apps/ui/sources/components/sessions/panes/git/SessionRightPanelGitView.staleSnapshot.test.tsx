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
const rpc = vi.fn(async (_method: string, _input: unknown) => ({ success: false, errorCode: 'BACKEND_UNAVAILABLE', error: 'RPC method not available' }));
// Hoist the external Socket boundary before static SCM owners bind their transport.
vi.mock('socket.io-client', async (importOriginal) => (
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal)
));
const runtime = installSessionPaneRuntimeTestHarness({ rpc });
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

describe('SessionRightPanelGitView (stale snapshot)', () => {
    it.each([true, false])('keeps the cached repository answer (%s) visible when refresh fails', async (isRepo) => {
        storage.getState().updateSessionProjectScmSnapshot('s1', createSnapshot(isRepo), runtime.serverId);
        const screen = await render();
        await act(async () => storage.getState().updateSessionProjectScmSnapshotError('s1', { message: 'RPC method not available', at: 1, errorCode: 'BACKEND_UNAVAILABLE' }, runtime.serverId));
        expect(screen.findHostByTestId('session-rightpanel-git-stale')).not.toBeNull();
        expect(screen.findHostByTestId(isRepo ? 'session-rightpanel-git-surface:commit' : 'scm-not-repository')).not.toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-unavailable')).toBeNull();
        rpc.mockClear();
        await screen.pressByTestIdAsync('session-rightpanel-git-stale-action');
        expect(rpc.mock.calls.some(([method]) => method === RPC_METHODS.SCM_STATUS_SNAPSHOT)).toBe(true);
        expect(storage.getState().getSessionProjectScmSnapshot('s1', runtime.serverId)?.repo.isRepo).toBe(isRepo);
    });

    it('stays quiet when the snapshot is current', async () => {
        storage.getState().updateSessionProjectScmSnapshot('s1', createSnapshot(), runtime.serverId);
        const screen = await render();
        await act(async () => storage.getState().updateSessionProjectScmSnapshotError('s1', null, runtime.serverId));
        expect(screen.findHostByTestId('session-rightpanel-git-stale')).toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-surface:commit')).not.toBeNull();
    });
});
