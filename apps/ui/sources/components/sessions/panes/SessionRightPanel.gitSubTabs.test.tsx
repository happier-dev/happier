import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScmCapabilities, type ScmWorkingSnapshot } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

let snapshot: ScmWorkingSnapshot | null;
const rpc = vi.fn(async (method: string, _input: unknown) => {
    if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return snapshot ? { success: true, snapshot } : { success: false, errorCode: 'BACKEND_UNAVAILABLE' };
    if (method === RPC_METHODS.SCM_LOG_LIST) return { success: true, entries: [] };
    return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
});
function configureSocket(socket: import('socket.io-client').Socket) {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'disconnect').mockImplementation(() => {
        socket.connected = false;
        for (const listener of socket.listeners('disconnect')) listener('io client disconnect');
        return socket;
    });
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
        if (event !== 'rpc-call' || !payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
            throw new Error('Unexpected Socket RPC envelope');
        }
        return { ok: true, result: await rpc(payload.method.slice(payload.method.indexOf(':') + 1), payload.params) };
    });
}
const runtime = installSessionPaneRuntimeTestHarness({ configureSocket });
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
    const { SessionRightPanelGitView } = await import('./git/SessionRightPanelGitView');
    return renderScreen(<runtime.Wrapper><SessionRightPanelGitView sessionId="s1" serverId={runtime.serverId} scopeId="session:s1" /></runtime.Wrapper>);
}

beforeEach(() => {
    snapshot = createSnapshot();
    rpc.mockClear();
    storage.getState().updateSessionProjectScmSnapshot('s1', snapshot, runtime.serverId);
});
async function renderPanel() {
    const { SessionRightPanel } = await import('./SessionRightPanel');
    return renderScreen(<runtime.Wrapper><SessionRightPanel sessionId="s1" scopeId="session:s1" /></runtime.Wrapper>);
}
describe('SessionRightPanel git sub-tabs', () => {
    it('refreshes the exact Home snapshot on mount without preloading history', async () => {
        await renderPanel();
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(rpc.mock.calls.some(([method]) => method === RPC_METHODS.SCM_STATUS_SNAPSHOT)).toBe(true);
        expect(rpc.mock.calls.some(([method]) => method === RPC_METHODS.SCM_LOG_LIST)).toBe(false);
    });

    it('keeps a missing workspace in recovery without issuing an unscoped SCM request', async () => {
        storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: runtime.serverId, active: true, metadata: { path: '', machineId: 'm1', host: 'test-machine' } })]);
        const screen = await renderPanel();
        expect(screen.findHostByTestId('session-rightpanel-surface-git')).not.toBeNull();
        expect(rpc.mock.calls.some(([method]) => method === RPC_METHODS.SCM_STATUS_SNAPSHOT)).toBe(false);
    });

    it('offers Changes and History in Tabs layout and loads History on activation', async () => {
        const screen = await renderPanel();
        expect(screen.findHostByTestId('session-rightpanel-git-subtab:commit')).not.toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-subtab:history')).not.toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-subtab:update')).toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-surface:history')).toBeNull();
        await screen.pressByTestIdAsync('session-rightpanel-git-subtab:history');
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(runtime.pane.scopeState?.right.tabState.git).toMatchObject({ activeSubTabId: 'history' });
        expect(screen.findHostByTestId('session-rightpanel-git-surface:history')).not.toBeNull();
        expect(rpc.mock.calls.some(([method]) => method === RPC_METHODS.SCM_LOG_LIST)).toBe(true);
    });

    it('shows Unified without a sub-tab bar', async () => {
        storage.getState().applySettingsLocal({ scmGitPaneLayout: 'unified' });
        const screen = await renderPanel();
        expect(screen.findHostByTestId('session-rightpanel-git-surface:commit')).not.toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-subtab:commit')).toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-subtab:history')).toBeNull();
    });

    it('hides the composer when repository capabilities deny commits', async () => {
        snapshot = { ...createSnapshot(), capabilities: createScmCapabilities({ readStatus: true, readLog: true, writeCommit: false }) };
        storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true } });
        storage.getState().updateSessionProjectScmSnapshot('s1', snapshot, runtime.serverId);
        const screen = await renderPanel();
        expect(screen.findHostByTestId('scm-commit-message')).toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-subtab:history')).not.toBeNull();
    });

    it('renders a snapshot arriving after mount without changing hook order', async () => {
        snapshot = null;
        storage.getState().updateSessionProjectScmSnapshot('s1', null, runtime.serverId);
        const screen = await renderPanel();
        expect(screen.findHostByTestId('session-rightpanel-git-surface:commit')).toBeNull();
        snapshot = createSnapshot();
        await act(async () => storage.getState().updateSessionProjectScmSnapshot('s1', snapshot, runtime.serverId));
        expect(screen.findHostByTestId('session-rightpanel-git-surface:commit')).not.toBeNull();
    });
});
