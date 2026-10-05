import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { EMPTY_SCM_CAPABILITIES } from '@/scm/core/snapshotMappers';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    stashList: vi.fn(),
    stashPop: vi.fn(),
    statusSnapshot: vi.fn(),
    operationLog: [] as Array<{ operation: string; status: string }>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
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
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: vi.fn(), confirm: vi.fn(async () => false), show: vi.fn() } }).module;
});
// The daemon RPC boundary.
vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({ importOriginal, overrides: {
        sessionScmStashList: state.stashList,
        sessionScmStashPop: state.stashPop,
        sessionScmRepositoryRemoveIndexLock: vi.fn(),
    } });
});
vi.mock('@/sync/ops/sessionScm', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({ importOriginal, overrides: { sessionScmStatusSnapshot: state.statusSnapshot } });
});
// Unrelated key-envelope HTTP requests must not occur in a repository recovery test.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unexpected = () => { throw new Error('Unexpected session key-envelope HTTP request in Git'); };
    return { createSessionDataKeyEnvelopeClient: unexpected, readSessionDataKeyEnvelopeCollectionPage: unexpected,
        prepareSessionDataKeyEnvelopesForScope: unexpected, prepareSessionDataKeyEnvelopesDetached: unexpected };
});

const { storage } = await import('@/sync/domains/state/storage');
const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');

const SNAPSHOT = {
    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
    branch: { head: 'v0.3', upstream: 'origin/v0.3', ahead: 0, behind: 0, detached: false },
    capabilities: { ...EMPTY_SCM_CAPABILITIES, readStash: true, writeStash: true },
    totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    fetchedAt: 1,
    projectKey: 'p1',
    hasConflicts: false,
    entries: [],
    stashCount: 2,
} satisfies ScmWorkingSnapshot;

describe('GitKeptAsideNotice (Git lab SZ)', () => {
    beforeEach(() => {
        state.stashList.mockReset();
        state.stashPop.mockReset();
        state.statusSnapshot.mockReset().mockResolvedValue({ success: true, snapshot: SNAPSHOT });
        storage.setState(storage.getInitialState(), true);
        projectManager.clear();
        storage.getState().applySessions([createSessionFixture({ id: 's1', active: true, metadata: { path: '/repo', host: 'localhost', machineId: 'm1' } })]);
    });

    it('reconciles a conflicted restore without replaying it or erasing its outcome', async () => {
        storage.getState().updateSessionProjectScmSnapshot('s1', SNAPSHOT);
        state.stashList.mockResolvedValue({ success: true,
            stashes: [{ stashRef: 'stash@{0}', stashOid: 'a'.repeat(40), kind: 'branch', branch: 'v0.3' }] });
        state.stashPop.mockImplementationOnce(async () => {
            state.statusSnapshot.mockResolvedValue({ success: true, snapshot: { ...SNAPSHOT, hasConflicts: true } });
            return { success: false, outcome: { v: 1, kind: 'conflicted', errorCode: 'CONFLICTING_WORKTREE',
                repositoryState: { hasConflicts: true, operation: null }, nextActions: [{ kind: 'resolve_conflicts' }] } };
        });
        const { GitKeptAsideNotice } = await import('./GitKeptAsideNotice');
        const screen = await renderScreen(<GitKeptAsideNotice sessionId="s1" snapshot={SNAPSHOT} />);
        await screen.pressByTestIdAsync('git-kept-aside-notice.action');
        await flushHookEffects({ cycles: 3 });
        expect(storage.getState().getSessionProjectScmSnapshot('s1')?.hasConflicts).toBe(true);
        expect(storage.getState().getSessionProjectScmOperationLog('s1')[0]?.outcome?.kind).toBe('conflicted');
        expect(state.stashPop).toHaveBeenCalledOnce();
    });

    it('offers the changes kept aside for this branch and restores them through the operation owner', async () => {
        state.stashList.mockResolvedValue({
            success: true,
            stashes: [
                { stashRef: 'stash@{0}', kind: 'transient', branch: 'v0.3', message: 'before rollback' },
                { stashRef: 'stash@{1}', stashOid: 'a'.repeat(40), kind: 'branch', branch: 'v0.3', createdAt: 1 },
            ],
        });
        state.stashPop.mockResolvedValue({ success: true });
        const { GitKeptAsideNotice } = await import('./GitKeptAsideNotice');
        const screen = await renderScreen(<GitKeptAsideNotice sessionId="s1" snapshot={SNAPSHOT} />);
        await flushHookEffects({ cycles: 2 });

        await screen.pressByTestIdAsync('git-kept-aside-notice.action');
        await flushHookEffects({ cycles: 3 });

        // The stack may have moved since the list RPC: only the captured object is safe to restore.
        expect(state.stashPop).toHaveBeenCalledWith('s1', { stashRef: 'a'.repeat(40) }, undefined);
        expect(storage.getState().getSessionProjectScmOperationLog('s1')[0]).toMatchObject({ operation: 'stash_restore', status: 'success' });
    });

    it('says nothing when this branch has nothing kept aside', async () => {
        state.stashList.mockResolvedValue({
            success: true,
            stashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'dev', createdAt: 1 }],
        });
        const { GitKeptAsideNotice } = await import('./GitKeptAsideNotice');
        const screen = await renderScreen(<GitKeptAsideNotice sessionId="s1" snapshot={SNAPSHOT} />);
        await flushHookEffects({ cycles: 2 });
        expect(screen.findAllByProps({ testID: 'git-kept-aside-notice' })).toHaveLength(0);
    });

    it('keeps a dismissed stash hidden when its index moves, but shows a different stash at that index', async () => {
        const stashOid = 'a'.repeat(40);
        state.stashList.mockResolvedValue({ success: true, stashes: [{ stashRef: 'stash@{0}', stashOid, kind: 'branch', branch: 'v0.3' }] });
        const { GitKeptAsideNotice } = await import('./GitKeptAsideNotice');
        const screen = await renderScreen(<GitKeptAsideNotice sessionId="s1" snapshot={SNAPSHOT} />);
        await screen.pressByTestIdAsync('git-kept-aside-notice.dismiss');

        state.stashList.mockResolvedValue({ success: true, stashes: [{ stashRef: 'stash@{1}', stashOid, kind: 'branch', branch: 'v0.3' }] });
        await screen.update(<GitKeptAsideNotice sessionId="s1" snapshot={{ ...SNAPSHOT, stashCount: 3 }} />);
        expect(screen.findAllHostsByTestId('git-kept-aside-notice')).toHaveLength(0);

        state.stashList.mockResolvedValue({ success: true, stashes: [{ stashRef: 'stash@{0}', stashOid: 'b'.repeat(40), kind: 'branch', branch: 'v0.3' }] });
        await screen.update(<GitKeptAsideNotice sessionId="s1" snapshot={{ ...SNAPSHOT, stashCount: 4 }} />);
        expect(screen.findAllHostsByTestId('git-kept-aside-notice')).not.toHaveLength(0);
    });

    it('keeps Look first available without offering automatic restore for a legacy entry with no object identity', async () => {
        state.stashList.mockResolvedValue({ success: true, stashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'v0.3' }] });
        const openDetails = vi.fn();
        const { GitKeptAsideNotice } = await import('./GitKeptAsideNotice');
        const screen = await renderScreen(<GitKeptAsideNotice sessionId="s1" snapshot={SNAPSHOT} onOpenStashDetails={openDetails} />);
        expect(screen.findAllHostsByTestId('git-kept-aside-notice.action')).toHaveLength(0);
        await screen.pressByTestIdAsync('git-kept-aside-notice.secondaryAction');
        expect(openDetails).toHaveBeenCalled();
        expect(state.stashPop).not.toHaveBeenCalled();
    });
});
