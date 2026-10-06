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

import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
let snapshot: ScmWorkingSnapshot;
const rpc = vi.fn(async (method: string, _input: unknown) => {
    if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot };
    if (method === RPC_METHODS.SCM_LOG_LIST) return { success: true, entries: [] };
    if (method === RPC_METHODS.SCM_REMOTE_PUSH || method === RPC_METHODS.SCM_REMOTE_PUBLISH) return { success: true };
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
const runtime = installSessionPaneRuntimeTestHarness({ configureSocket, features: () => createRootLayoutFeaturesResponse() });
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

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
beforeEach(() => {
    snapshot = createSnapshot();
    snapshot = { ...snapshot,
        repo: { ...snapshot.repo, remotes: [{ name: 'origin', fetchUrl: 'git@example.com:repo.git', pushUrl: 'git@example.com:repo.git' }] },
        capabilities: createScmCapabilities({ ...snapshot.capabilities, writeCommit: true, writeCommitPathSelection: true, writeRemotePush: true, writeRemotePull: true, writeRemoteFetch: true, writeRemotePublish: true }),
        branch: { head: 'v0.3', upstream: 'origin/v0.3', ahead: 2, behind: 0, detached: false },
    };
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true }, scmRemoteConfirmPolicy: 'never' });
    rpc.mockClear();
});
async function renderHeader() {
    const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
    const { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } = await import('@/components/appShell/panes/paneHeaderSlot');
    function HeaderReader() {
        const published = usePublishedPaneHeaderContent('git');
        return <>{published?.line?.leading}{published?.action}</>;
    }
    storage.getState().updateSessionProjectScmSnapshot('s1', snapshot, runtime.serverId);
    return renderScreen(<runtime.Wrapper><PaneHeaderSlotProvider><HeaderReader /><PaneHeaderSlotScope slotKey="git">
        <SessionRightPanelGitView sessionId="s1" serverId={runtime.serverId} scopeId="session:s1" />
    </PaneHeaderSlotScope></PaneHeaderSlotProvider></runtime.Wrapper>);
}
describe('SessionRightPanelGitView (remote action visibility)', () => {
    it('publishes the readable branch and Push count in the header and pushes through SCM', async () => {
        const { GitNextActionButton } = await import('./GitNextActionButton');
        const screen = await renderHeader();
        expect(screen.findHostByTestId('scm-branch-menu-trigger')).not.toBeNull();
        expect(screen.getTextContent()).toContain('v0.3');
        expect(screen.findByType(GitNextActionButton)?.props.primary).toMatchObject({ key: 'push', count: 2 });
        expect(screen.findHostByTestId('session-rightpanel-git-subtab:update')).toBeNull();
        rpc.mockClear();
        await screen.pressByTestIdAsync('session-git-header-action:push');
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(rpc.mock.calls.some(([method]) => method === RPC_METHODS.SCM_REMOTE_PUSH)).toBe(true);
    });

    it('offers Publish when the repository has a remote but no tracking branch', async () => {
        snapshot = { ...snapshot, branch: { ...snapshot.branch, upstream: null, ahead: 0 } };
        const screen = await renderHeader();
        expect(screen.findHostByTestId('session-git-header-action:publish')).not.toBeNull();
        await screen.pressByTestIdAsync('session-git-header-action:publish');
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(rpc.mock.calls.some(([method]) => method === RPC_METHODS.SCM_REMOTE_PUBLISH)).toBe(true);
    });

    it('keeps Push secondary when a selected change and persisted message make commit ready', async () => {
        const { GitNextActionButton } = await import('./GitNextActionButton');
        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');
        const { writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        writeExistingSessionDraft({ scope: { serverId: runtime.serverId, accountId: 'account-a' }, sessionId: 's1', patch: { scmCommitMessageV1: 'Keep the change' } });
        snapshot = { ...snapshot, entries: [{
            path: 'src/a.ts', previousPath: null, kind: 'modified', includeStatus: ' ', pendingStatus: 'M',
            hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
        }] };
        storage.getState().markSessionProjectScmCommitSelectionPaths('s1', ['src/a.ts'], runtime.serverId);
        const screen = await renderHeader();
        expect(screen.findByType(SessionRightPanelGitCommitTabContent)?.props.commitDraftMessage).toBe('Keep the change');
        expect(screen.findByType(GitNextActionButton)?.props.primary).toMatchObject({ key: 'push', count: 2, emphasis: 'secondary' });
    });

    it('keeps the branch readable while policy denies writes, forms and selection', async () => {
        storage.getState().applySettingsLocal({ featureToggles: { 'scm.writeOperations': false } });
        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');
        const screen = await renderHeader();
        expect(screen.findHostByTestId('scm-branch-menu-trigger')).not.toBeNull();
        expect(screen.findHostByTestId('session-git-writes-off')).not.toBeNull();
        expect(screen.root.findAll((node) => typeof node.props.testID === 'string' && node.props.testID.startsWith('session-git-header-action'))).toHaveLength(0);
        expect(screen.findByType(SessionRightPanelGitCommitTabContent)?.props).toMatchObject({ commitWriteEnabled: false, commitSelectionUiEnabled: false });
    });
});
