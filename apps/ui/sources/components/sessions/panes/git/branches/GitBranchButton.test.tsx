import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScmCapabilities, type ScmWorkingSnapshot } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionDetailsPanelCommonModuleMocks } from '../../sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '../../sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

import { REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN, SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import type { ScmBranchListEntry } from '@happier-dev/protocol';
import { createDeferred } from '@/dev/testkit';
let snapshot: ScmWorkingSnapshot;
let branches: ScmBranchListEntry[];
let listResponse: (() => Promise<unknown>) | null = null;
let checkoutResponses: unknown[];
const rpc = vi.fn(async (method: string, _input: unknown): Promise<unknown> => {
    if (method === RPC_METHODS.SCM_BRANCH_LIST) return listResponse ? listResponse() : { success: true, branches };
    if (method === RPC_METHODS.SCM_BRANCH_CHECKOUT) return checkoutResponses.shift() ?? { success: true };
    if (method === RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK) return { success: true, removed: true, lockPath: '/repo/.git/index.lock' };
    if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot };
    if (method === RPC_METHODS.SCM_STASH_LIST) return { success: true, stashes: [] };
    if (method === RPC_METHODS.SCM_STASH_CREATE) return { success: true, stashCreated: true, stashRef: 'stash@{0}' };
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

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
beforeEach(async () => {
    snapshot = { ...createSnapshot(),
        capabilities: createScmCapabilities({ readStatus: true, readBranches: true, writeBranchCheckout: true, writeBranchCreate: true, readStash: true, writeStashCreate: true, writeRepositoryRemoveIndexLock: true }),
    };
    branches = [
        { name: 'main', type: 'local', isCurrent: true, upstream: null },
        { name: 'feature/test', type: 'local', isCurrent: false, upstream: null },
    ];
    listResponse = null; checkoutResponses = []; rpc.mockClear();
    storage.getState().applySettingsLocal({ scmUncommittedChangesStrategy: 'always_bring' });
    const { repoScmBranchService } = await import('@/scm/repository/repoScmBranchService');
    repoScmBranchService.invalidateBranchesForSession({ sessionId: 's1', serverId: runtime.serverId });
});
async function renderBranch(disabled = false, value = snapshot) {
    const { GitBranchButton } = await import('./GitBranchButton');
    return renderScreen(<runtime.Wrapper><GitBranchButton sessionId="s1" serverId={runtime.serverId} snapshot={value} disabled={disabled} /></runtime.Wrapper>);
}
async function menu(screen: Awaited<ReturnType<typeof renderBranch>>) {
    const { WorkspaceScmBranchPopover } = await import('@/components/workspaces/scm/branches/WorkspaceScmBranchPopover');
    await screen.pressByTestIdAsync('scm-branch-menu-trigger');
    await flushHookEffects({ cycles: 3, turns: 3 });
    return screen.findByType(WorkspaceScmBranchPopover)!;
}
async function select(screen: Awaited<ReturnType<typeof renderBranch>>, id: string) {
    const { WorkspaceScmBranchPopover } = await import('@/components/workspaces/scm/branches/WorkspaceScmBranchPopover');
    const popover = screen.findByType(WorkspaceScmBranchPopover)!;
    await act(async () => popover.props.onSelectItem(id, { closeMenu: () => {}, reopenMenu: () => {} }));
}
describe('GitBranchButton', () => {
    it('keeps branch reads available while writes are disabled', async () => {
        const screen = await renderBranch(true);
        const popover = await menu(screen);
        expect(popover.props.branchItems.find((item: { id: string }) => item.id === 'branch:feature/test')?.disabled).toBe(true);
        expect(rpc.mock.calls.some(([method]) => method === RPC_METHODS.SCM_BRANCH_LIST)).toBe(true);
        await select(screen, 'branch:feature/test');
        expect(rpc.mock.calls.some(([method]) => method === RPC_METHODS.SCM_BRANCH_CHECKOUT)).toBe(false);
    });

    it('seeds the real shared branch cache before an outstanding refresh', async () => {
        const { repoScmBranchService } = await import('@/scm/repository/repoScmBranchService');
        await repoScmBranchService.fetchBranchesForSession({ sessionId: 's1', serverId: runtime.serverId });
        const pending = createDeferred<unknown>();
        listResponse = () => pending.promise;
        const screen = await renderBranch();
        const popover = await menu(screen);
        expect(popover.props.branchItems.some((item: { id: string }) => item.id === 'branch:feature/test')).toBe(true);
        await act(async () => pending.resolve({ success: true, branches }));
    });

    it('keeps cached branches visible and reports a failed refresh in the list', async () => {
        const { repoScmBranchService } = await import('@/scm/repository/repoScmBranchService');
        await repoScmBranchService.fetchBranchesForSession({ sessionId: 's1', serverId: runtime.serverId });
        listResponse = async () => ({ success: false, error: 'Refresh failed', errorCode: 'BACKEND_UNAVAILABLE' });
        const screen = await renderBranch();
        const popover = await menu(screen);
        expect(popover.props.branchItems.some((item: { id: string }) => item.id === 'branch:feature/test')).toBe(true);
        expect(popover.props.branchItems.some((item: { id: string }) => item.id === 'load-error')).toBe(true);
        const { Modal } = await import('@/modal');
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it('keeps branch menu width independent of the branch trigger', async () => {
        const { Popover } = await import('@/components/ui/popover');
        const screen = await renderBranch();
        expect(screen.findByType(Popover)?.props.maxWidthCap).toBe(420);
    });

    it('switches branches with bring_changes under the real operation owner', async () => {
        const screen = await renderBranch();
        await menu(screen);
        await select(screen, 'branch:feature/test');
        expect(rpc).toHaveBeenCalledWith(RPC_METHODS.SCM_BRANCH_CHECKOUT, expect.objectContaining({ name: 'feature/test', strategy: 'bring_changes' }));
        expect(storage.getState().getSessionProjectScmOperationLog('s1', runtime.serverId)[0]).toMatchObject({ operation: 'branch_switch', status: 'success' });
    });

    it('offers stale Git index-lock recovery and retries checkout once', async () => {
        checkoutResponses = [
            { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: "fatal: Unable to create '/repo/.git/index.lock': File exists." },
            { success: true },
        ];
        const screen = await renderBranch();
        await menu(screen);
        await select(screen, 'branch:feature/test');
        expect(rpc).toHaveBeenCalledWith(RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK, expect.objectContaining({
            cwd: '/repo', confirmed: true, confirmationToken: REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
        }));
        expect(rpc.mock.calls.filter(([method]) => method === RPC_METHODS.SCM_BRANCH_CHECKOUT)).toHaveLength(2);
        expect(storage.getState().getSessionProjectScmOperationLog('s1', runtime.serverId)[0]).toMatchObject({ operation: 'branch_switch', status: 'success' });
        const { Modal } = await import('@/modal');
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it('reports failed checkout in the operation log without a dialog', async () => {
        checkoutResponses = [{ success: false, error: 'Local changes would be overwritten', errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED }];
        const screen = await renderBranch();
        await menu(screen);
        await select(screen, 'branch:feature/test');
        expect(storage.getState().getSessionProjectScmOperationLog('s1', runtime.serverId)[0]).toMatchObject({ operation: 'branch_switch', status: 'failed' });
        const { Modal } = await import('@/modal');
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it('keeps changes aside through the operation owner only when capabilities allow it', async () => {
        snapshot = { ...snapshot, entries: [{
            path: 'a.ts', previousPath: null, kind: 'modified', includeStatus: ' ', pendingStatus: 'M',
            hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
        }] };
        const screen = await renderBranch();
        const popover = await menu(screen);
        expect(popover.props.branchItems.some((item: { id: string }) => item.id === 'git:keep-aside')).toBe(true);
        await select(screen, 'git:keep-aside');
        expect(rpc.mock.calls.some(([method]) => method === RPC_METHODS.SCM_STASH_CREATE)).toBe(true);
        expect(storage.getState().getSessionProjectScmOperationLog('s1', runtime.serverId)[0]).toMatchObject({ operation: 'stash_create', status: 'success', detail: 'stash@{0}' });
        const denied = await renderBranch(false, { ...snapshot, capabilities: { ...snapshot.capabilities, writeStashCreate: false } });
        const deniedMenu = await menu(denied);
        expect(deniedMenu.props.branchItems.some((item: { id: string }) => item.id === 'git:keep-aside')).toBe(false);
    });
});
