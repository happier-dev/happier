import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { ScmCapabilities, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlert = vi.hoisted(() => vi.fn());
const sessionScmRemotePublish = vi.hoisted(() => vi.fn());
const invalidateFromMutationAndAwait = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: modalAlert,
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/sync/ops', () => ({
    sessionScmRemotePublish,
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait,
    },
}));

type ScmRemoteFixture = Readonly<{
    name: string;
    fetchUrl?: string;
    pushUrl?: string;
}>;

type ScmWorkingSnapshotWithRemotes = Omit<ScmWorkingSnapshot, 'repo'> & Readonly<{
    repo: ScmWorkingSnapshot['repo'] & Readonly<{
        remotes?: readonly ScmRemoteFixture[];
    }>;
}>;

type SnapshotOverrides = Partial<Omit<ScmWorkingSnapshotWithRemotes, 'repo' | 'capabilities' | 'branch' | 'totals'>> & Readonly<{
    repo?: Partial<ScmWorkingSnapshotWithRemotes['repo']>;
    capabilities?: Partial<NonNullable<ScmWorkingSnapshotWithRemotes['capabilities']>>;
    branch?: Partial<ScmWorkingSnapshotWithRemotes['branch']>;
    totals?: Partial<ScmWorkingSnapshotWithRemotes['totals']>;
}>;

function makeSnapshot(overrides?: SnapshotOverrides): ScmWorkingSnapshotWithRemotes {
    const baseCapabilities: ScmCapabilities = {
        readStatus: true,
        readDiffFile: true,
        readDiffCommit: true,
        readLog: true,
        writeInclude: true,
        writeExclude: true,
        writeCommit: true,
        writeBackout: true,
        writeRemoteFetch: true,
        writeRemotePull: true,
        writeRemotePush: true,
        writeRemotePublish: true,
        worktreeCreate: true,
    };
    const base: ScmWorkingSnapshotWithRemotes = {
        projectKey: 'm1:/repo',
        fetchedAt: 1,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            remotes: [
                {
                    name: 'origin',
                    fetchUrl: 'git@example.com:repo.git',
                    pushUrl: 'git@example.com:repo.git',
                },
            ],
        },
        capabilities: baseCapabilities,
        branch: {
            head: 'main',
            upstream: null,
            ahead: 0,
            behind: 0,
            detached: false,
        },
        stashCount: 0,
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

    return {
        ...base,
        ...overrides,
        repo: {
            ...base.repo,
            ...(overrides?.repo ?? {}),
        },
        capabilities: {
            ...baseCapabilities,
            ...(overrides?.capabilities ?? {}),
        },
        branch: {
            ...base.branch,
            ...(overrides?.branch ?? {}),
        },
        totals: {
            ...base.totals,
            ...(overrides?.totals ?? {}),
        },
    };
}

describe('usePublishBranchAction', () => {
    beforeEach(() => {
        modalAlert.mockReset();
        sessionScmRemotePublish.mockReset();
        sessionScmRemotePublish.mockResolvedValue({ success: true });
        invalidateFromMutationAndAwait.mockClear();
    });

    it('does not allow publishing an untracked branch when no remote is configured', async () => {
        const { usePublishBranchAction } = await import('./usePublishBranchAction');

        const hook = await renderHook(() => usePublishBranchAction({
            sessionId: 's1',
            snapshot: makeSnapshot({ repo: { remotes: [] } }),
            writeEnabled: true,
        }));

        expect(hook.getCurrent().canPublish).toBe(false);

        await hook.unmount();
    });

    it('publishes to origin when several remotes are configured', async () => {
        const { usePublishBranchAction } = await import('./usePublishBranchAction');

        const hook = await renderHook(() => usePublishBranchAction({
            sessionId: 's1',
            snapshot: makeSnapshot({
                repo: {
                    remotes: [
                        { name: 'upstream', fetchUrl: 'git@example.com:upstream.git', pushUrl: 'git@example.com:upstream.git' },
                        { name: 'origin', fetchUrl: 'git@example.com:origin.git', pushUrl: 'git@example.com:origin.git' },
                    ],
                },
            }),
            writeEnabled: true,
        }));

        let published = false;
        await act(async () => {
            published = await hook.getCurrent().publishBranch();
        });

        expect(published).toBe(true);
        expect(sessionScmRemotePublish).toHaveBeenCalledWith('s1', { remote: 'origin' });
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledWith('s1');

        await hook.unmount();
    });

    it('publishes to the only configured remote when origin is unavailable', async () => {
        const { usePublishBranchAction } = await import('./usePublishBranchAction');

        const hook = await renderHook(() => usePublishBranchAction({
            sessionId: 's1',
            snapshot: makeSnapshot({
                repo: {
                    remotes: [
                        { name: 'upstream', fetchUrl: 'git@example.com:upstream.git', pushUrl: 'git@example.com:upstream.git' },
                    ],
                },
            }),
            writeEnabled: true,
        }));

        let published = false;
        await act(async () => {
            published = await hook.getCurrent().publishBranch();
        });

        expect(published).toBe(true);
        expect(sessionScmRemotePublish).toHaveBeenCalledWith('s1', { remote: 'upstream' });

        await hook.unmount();
    });
});
