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

let refreshSnapshot: ScmWorkingSnapshot | null = null;
const rpc = vi.fn(async (method: string, _input: unknown) => {
    if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return refreshSnapshot
        ? { success: true, snapshot: refreshSnapshot }
        : { success: false, errorCode: 'BACKEND_UNAVAILABLE', error: 'Status unavailable' };
    if (method === RPC_METHODS.SCM_LOG_LIST) return { success: true, entries: [] };
    return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
});
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

beforeEach(() => { refreshSnapshot = null; rpc.mockClear(); });
describe('SessionRightPanelGitView (snapshot SWR)', () => {
    it('registers the mounted git surface for its exact Home and retires it on unmount', async () => {
        const { readMountedSessionRealtimeScmConsumerScopes } = await import('@/sync/runtime/sessionRealtimeScmConsumers');
        storage.getState().updateSessionProjectScmSnapshot('s1', createSnapshot(), runtime.serverId);
        const screen = await render();
        expect(readMountedSessionRealtimeScmConsumerScopes()).toEqual(expect.arrayContaining([
            expect.objectContaining({ serverId: runtime.serverId, sessionId: 's1', needsMutationTranscript: true }),
        ]));
        expect(readMountedSessionRealtimeScmConsumerScopes().some((scope) => scope.serverId === 'other-home')).toBe(false);
        await act(async () => screen.tree.unmount());
        expect(readMountedSessionRealtimeScmConsumerScopes().some((scope) => scope.serverId === runtime.serverId && scope.sessionId === 's1')).toBe(false);
    });

    it('keeps retrying refresh while the first snapshot is unavailable', async () => {
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        vi.useFakeTimers();
        try {
            await renderScreen(<runtime.Wrapper><SessionRightPanelGitView sessionId="s1" serverId={runtime.serverId} scopeId="session:s1" /></runtime.Wrapper>);
            await flushHookEffects({ cycles: 2, turns: 2 });
            const count = rpc.mock.calls.filter(([method]) => method === RPC_METHODS.SCM_STATUS_SNAPSHOT).length;
            expect(count).toBeGreaterThan(0);
            await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
            expect(rpc.mock.calls.filter(([method]) => method === RPC_METHODS.SCM_STATUS_SNAPSHOT).length).toBeGreaterThan(count);
        } finally {
            vi.useRealTimers();
        }
    });

    it('renders the first loaded snapshot without changing hook order', async () => {
        const screen = await render();
        expect(screen.findHostByTestId('session-rightpanel-git-surface:commit')).toBeNull();
        await act(async () => storage.getState().updateSessionProjectScmSnapshot('s1', createSnapshot(), runtime.serverId));
        expect(screen.findHostByTestId('session-rightpanel-git-surface:commit')).not.toBeNull();
    });

    it('keeps last-known snapshot content visible while revalidating', async () => {
        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');
        const snapshot = createSnapshot();
        storage.getState().updateSessionProjectScmSnapshot('s1', snapshot, runtime.serverId);
        const screen = await render();
        const mounted = screen.findHostByTestId('session-rightpanel-git-surface:commit');
        expect(mounted).not.toBeNull();
        await act(async () => storage.getState().updateSessionProjectScmSnapshot('s1', null, runtime.serverId));
        expect(screen.findHostByTestId('session-rightpanel-git-surface:commit')).toBe(mounted);
        expect(screen.findByType(SessionRightPanelGitCommitTabContent)?.props.scmSnapshot).toBe(snapshot);
    });
});
