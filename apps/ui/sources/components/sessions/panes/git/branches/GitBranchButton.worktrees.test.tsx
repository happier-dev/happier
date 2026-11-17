import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScmCapabilities, type ScmWorkingSnapshot } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
    ScmWorktreeCreateRequestSchema,
    ScmWorktreeRemoveRequestSchema,
} from '@happier-dev/protocol/scm/worktrees';
import { createMachineFixture, createSessionFixture, renderScreen } from '@/dev/testkit';
import { createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionDetailsPanelCommonModuleMocks } from '../../sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '../../sessionPaneRuntimeTestHarness';

const push = vi.fn<(route: unknown) => void>();
const confirm = vi.hoisted(() => vi.fn(async () => true));
installSessionDetailsPanelCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push } }).module,
});
vi.mock('@/modal', async () => (
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true, spies: { confirm } }).module
));
vi.mock('@/components/ui/popover', async importOriginal => (
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal)
));
vi.mock('socket.io-client', async importOriginal => (
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal)
));

const calls: Array<{ method: string; input: unknown; targetId: string }> = [];
let sourceRootPath: string | undefined;
const branches = [
    { name: 'main', type: 'local' as const, isCurrent: true, upstream: null },
    { name: 'feature/auth', type: 'local' as const, isCurrent: false, upstream: null },
];
const runtime = installSessionPaneRuntimeTestHarness({
    credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    rpc: async (method, input, targetId) => {
        calls.push({ method, input, targetId });
        if (method === RPC_METHODS.SCM_BRANCH_LIST) return { success: true, branches };
        if (method === RPC_METHODS.SCM_WORKTREE_CREATE) return {
            success: true, reused: false, worktreePath: '/repo/.dev/worktree/feature-auth', branchName: 'feature-auth',
            ...(sourceRootPath ? { sourceRootPath } : {}),
        };
        if (method === RPC_METHODS.SCM_WORKTREE_PRUNE || method === RPC_METHODS.SCM_WORKTREE_REMOVE) return { success: true };
        if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: snapshot() };
        if (method === RPC_METHODS.SCM_LOG_LIST) return { success: true, entries: [] };
        return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
    },
});

function snapshot(worktrees: ScmWorkingSnapshot['repo']['worktrees'] = [
    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
]): ScmWorkingSnapshot {
    return {
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', remotes: [], worktrees },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        capabilities: createScmCapabilities({ readBranches: true, writeBranchCheckout: true, worktreeCreate: true }),
        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
        fetchedAt: Date.now(), projectKey: 'p1', hasConflicts: false, entries: [], stashCount: 0,
    };
}

function publishSession(path = '/repo', machineAvailable = true) {
    storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: runtime.serverId, active: true,
        metadata: { path, host: 'test-machine', ...(machineAvailable ? { machineId: 'machine-1' } : {}) },
    })]);
    storage.getState().applyMachines(machineAvailable ? [createMachineFixture({ storageMode: 'plain', activeAt: Date.now() })] : [],
        true, { sourceServerId: runtime.serverId });
}

beforeEach(() => {
    calls.length = 0;
    sourceRootPath = undefined;
    push.mockClear();
    confirm.mockClear();
    publishSession();
    storage.getState().applySettingsLocal({ scmUncommittedChangesStrategy: 'always_bring',
        featureToggles: { ...storage.getState().settings.featureToggles, 'scm.writeOperations': true } });
});

async function openMenu(value = snapshot()) {
    const { GitBranchButton } = await import('./GitBranchButton');
    const screen = await renderScreen(<runtime.Wrapper>
        <GitBranchButton sessionId="s1" serverId={runtime.serverId} snapshot={value} />
    </runtime.Wrapper>);
    await screen.pressByTestIdAsync('scm-branch-menu-trigger');
    expect(screen.findHostByTestId('workspace-scm-branch-popover-search')).not.toBeNull();
    return screen;
}

async function assertDraft(expected: Readonly<{ selectedPath: string; selectedMachineId: string | null; worktree?: 'new' }>) {
    await waitForHomeGovernance(() => expect(push).toHaveBeenCalledTimes(1));
    const route = push.mock.calls[0]?.[0];
    if (!route || typeof route !== 'object' || !('params' in route) || !route.params || typeof route.params !== 'object'
        || !('draftId' in route.params) || typeof route.params.draftId !== 'string') throw new Error('Expected the New Session draft route');
    const draftId = route.params.draftId;
    expect(route).toEqual({ pathname: '/new', params: { draftId,
        ...(expected.worktree ? { worktree: expected.worktree } : {}),
        ...(expected.selectedMachineId ? {} : { spawnServerId: runtime.serverId }),
    } });
    const scope = runtime.accountScope;
    if (!scope) throw new Error('Expected the active draft Account');
    const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
    expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
        selectedPath: expected.selectedPath, selectedMachineId: expected.selectedMachineId, entryIntent: 'session',
        ...(expected.selectedMachineId ? { targetServerId: runtime.serverId,
            executionTarget: { kind: 'machine', target: { serverId: runtime.serverId, machineId: expected.selectedMachineId } } } : {}),
    });
}

function requests(method: string) {
    return calls.filter(call => call.method === method);
}

describe('GitBranchButton worktrees', () => {
    it('surfaces sibling worktrees and opens a new session in the selected worktree', async () => {
        publishSession('/repo', false);
        const screen = await openMenu(snapshot([
            { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
            { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
        ]));
        await screen.pressByTestIdAsync('dropdown-option-worktree_open__repo__worktrees_feature-auth');
        await assertDraft({ selectedPath: '/repo/.worktrees/feature-auth', selectedMachineId: null });
    });

    it('creates a worktree session from the current branch through the shared repo worktree service', async () => {
        const screen = await openMenu();
        await screen.pressByTestIdAsync('dropdown-option-worktree_create-current-branch');
        await assertDraft({ selectedPath: '/repo/.dev/worktree/feature-auth', selectedMachineId: 'machine-1' });
        const [request] = requests(RPC_METHODS.SCM_WORKTREE_CREATE);
        expect(requests(RPC_METHODS.SCM_WORKTREE_CREATE)).toHaveLength(1);
        expect(request?.targetId).toBe('machine-1');
        expect(ScmWorktreeCreateRequestSchema.parse(request?.input)).toMatchObject({ cwd: '/repo', displayName: expect.any(String), branchMode: 'new' });
        expect(ScmWorktreeCreateRequestSchema.parse(request?.input).baseRef).toBeUndefined();
    });

    it('preserves the current nested session path when creating a worktree from the current branch', async () => {
        publishSession('/repo/packages/app');
        sourceRootPath = '/repo';
        const screen = await openMenu();
        await screen.pressByTestIdAsync('dropdown-option-worktree_create-current-branch');
        await assertDraft({ selectedPath: '/repo/.dev/worktree/feature-auth/packages/app', selectedMachineId: 'machine-1' });
    });

    it('prunes worktrees through the shared repo worktree service', async () => {
        const screen = await openMenu();
        await screen.pressByTestIdAsync('dropdown-option-worktree_prune');
        await waitForHomeGovernance(() => expect(requests(RPC_METHODS.SCM_WORKTREE_PRUNE)).toHaveLength(1));
        expect(requests(RPC_METHODS.SCM_WORKTREE_PRUNE)[0]).toMatchObject({ targetId: 'machine-1', input: { cwd: '/repo' } });
    });

    it('routes create-from-another-branch into the new-session worktree picker flow', async () => {
        const screen = await openMenu();
        await screen.pressByTestIdAsync('dropdown-option-worktree_create-from-another-branch');
        await assertDraft({ selectedPath: '/repo', selectedMachineId: 'machine-1', worktree: 'new' });
    });

    it('lists branches and then worktrees in one branch popover', async () => {
        const screen = await openMenu(snapshot([
            { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
            { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
        ]));
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('dropdown-option-branch_feature_auth')).not.toBeNull());
        const { SelectableMenuResults } = await import('@/components/ui/forms/dropdown/SelectableMenuResults');
        const { SegmentedTabBar } = await import('@/components/ui/navigation/SegmentedTabBar');
        expect(screen.findAllByType(SegmentedTabBar)).toHaveLength(0);
        const ids = screen.findByType(SelectableMenuResults)?.props.categories
            .flatMap((category: { items: readonly { id: string }[] }) => category.items.map(item => item.id));
        expect(ids.indexOf('branch:feature/auth')).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf('worktree:open:/repo/.worktrees/feature-auth')).toBeGreaterThan(ids.indexOf('branch:feature/auth'));
    });

    it('removes a sibling worktree through the shared repo worktree service without a second caller dialog', async () => {
        const screen = await openMenu(snapshot([
            { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
            { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
        ]));
        expect(screen.findHostByTestId('dropdown-option-worktree_remove__repo__worktrees_feature-auth')).not.toBeNull();
        await screen.pressByTestIdAsync('dropdown-option-worktree_remove__repo__worktrees_feature-auth');
        await waitForHomeGovernance(() => expect(requests(RPC_METHODS.SCM_WORKTREE_REMOVE)).toHaveLength(1));
        const request = requests(RPC_METHODS.SCM_WORKTREE_REMOVE)[0];
        expect(request?.targetId).toBe('machine-1');
        expect(ScmWorktreeRemoveRequestSchema.parse(request?.input)).toMatchObject({ cwd: '/repo',
            worktreePath: '/repo/.worktrees/feature-auth', confirmed: true, authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN });
        expect(confirm).toHaveBeenCalledTimes(1);
    });
});
