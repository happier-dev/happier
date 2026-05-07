import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { PullRequestUiModel } from '@/components/sessions/sourceControl/pullRequests/pullRequestUiModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionScmPullRequestOpenOrReuseMock = vi.hoisted(() => vi.fn());
const sessionScmPullRequestRunStackedMock = vi.hoisted(() => vi.fn());
const sessionScmBranchCreateMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));
const invalidateFromMutationAndAwaitMock = vi.hoisted(() => vi.fn(async () => {}));
const modalAlertMock = vi.hoisted(() => vi.fn());
const modalPromptMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops', () => ({
    sessionScmPullRequestOpenOrReuse: sessionScmPullRequestOpenOrReuseMock,
    sessionScmPullRequestRunStacked: sessionScmPullRequestRunStackedMock,
    sessionScmBranchCreate: sessionScmBranchCreateMock,
}));

vi.mock('@/utils/url/openExternalUrl', () => ({
    openExternalUrl: openExternalUrlMock,
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: invalidateFromMutationAndAwaitMock,
    },
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: modalAlertMock,
            prompt: modalPromptMock,
        },
    }).module;
});

function readyModel(overrides: Partial<Extract<PullRequestUiModel, { kind: 'ready_to_create' }>> = {}): Extract<PullRequestUiModel, { kind: 'ready_to_create' }> {
    return {
        kind: 'ready_to_create',
        provider: {
            kind: 'github',
            name: 'GitHub',
            baseUrl: 'https://github.com',
            nameWithOwner: 'happier/dev',
            remoteName: 'origin',
        },
        providerLabel: 'GitHub',
        repositoryLabel: 'happier/dev',
        baseBranch: 'main',
        headBranch: 'feature/prs',
        canCreatePullRequest: true,
        createBlockedReason: null,
        createStrategy: { kind: 'open_or_reuse' },
        defaultBranchAction: null,
        ...overrides,
    };
}

function existingModel(): Extract<PullRequestUiModel, { kind: 'existing_pull_request' }> {
    return {
        kind: 'existing_pull_request',
        provider: {
            kind: 'github',
            name: 'GitHub',
            baseUrl: 'https://github.com',
            nameWithOwner: 'happier/dev',
            remoteName: 'origin',
        },
        pullRequest: {
            provider: {
                kind: 'github',
                name: 'GitHub',
                baseUrl: 'https://github.com',
                nameWithOwner: 'happier/dev',
                remoteName: 'origin',
            },
            number: 42,
            title: 'Add PR workflow',
            url: 'https://github.com/happier/dev/pull/42',
            baseBranch: 'main',
            headBranch: 'feature/prs',
            state: 'open',
        },
        providerLabel: 'GitHub',
        repositoryLabel: 'happier/dev',
        numberLabel: '#42',
        branchLabel: 'feature/prs -> main',
        state: 'open',
    };
}

describe('useScmPullRequestOperations', () => {
    beforeEach(() => {
        sessionScmPullRequestOpenOrReuseMock.mockReset();
        sessionScmPullRequestRunStackedMock.mockReset();
        sessionScmBranchCreateMock.mockReset();
        openExternalUrlMock.mockClear();
        invalidateFromMutationAndAwaitMock.mockClear();
        modalAlertMock.mockClear();
        modalPromptMock.mockReset();
    });

    it('opens an existing pull request URL without calling the PR create RPC', async () => {
        const { useScmPullRequestOperations } = await import('./useScmPullRequestOperations');
        const hook = await renderHook(() => useScmPullRequestOperations({ sessionId: 's1' }));

        await act(async () => {
            await hook.getCurrent().viewPullRequest(existingModel());
        });

        expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/happier/dev/pull/42');
        expect(sessionScmPullRequestOpenOrReuseMock).not.toHaveBeenCalled();
    });

    it('blocks existing PR URLs that do not match the provider origin', async () => {
        const { useScmPullRequestOperations } = await import('./useScmPullRequestOperations');
        const hook = await renderHook(() => useScmPullRequestOperations({ sessionId: 's1' }));

        await act(async () => {
            await hook.getCurrent().viewPullRequest({
                ...existingModel(),
                pullRequest: {
                    ...existingModel().pullRequest,
                    url: 'https://evil.example/happier/dev/pull/42',
                },
            });
        });

        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(modalAlertMock).toHaveBeenCalledTimes(1);
    });

    it('creates or opens a PR through the existing session SCM RPC and refreshes status', async () => {
        sessionScmPullRequestOpenOrReuseMock.mockResolvedValue({
            success: true,
            kind: 'opened',
            reused: false,
            pullRequest: existingModel().pullRequest,
        });
        const { useScmPullRequestOperations } = await import('./useScmPullRequestOperations');
        const hook = await renderHook(() => useScmPullRequestOperations({ sessionId: 's1' }));

        await act(async () => {
            await hook.getCurrent().openOrReusePullRequest(readyModel());
        });

        expect(sessionScmPullRequestOpenOrReuseMock).toHaveBeenCalledWith('s1', {
            base: 'main',
            head: 'feature/prs',
            title: 'feature/prs',
            body: '',
        });
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/happier/dev/pull/42');
        expect(invalidateFromMutationAndAwaitMock).toHaveBeenCalledWith('s1');
    });

    it('opens the compare URL when the daemon reports no authenticated PR creator', async () => {
        sessionScmPullRequestOpenOrReuseMock.mockResolvedValue({
            success: true,
            kind: 'no-auth',
            composeUrl: 'https://github.com/happier/dev/compare/main...feature/prs',
        });
        const { useScmPullRequestOperations } = await import('./useScmPullRequestOperations');
        const hook = await renderHook(() => useScmPullRequestOperations({ sessionId: 's1' }));

        await act(async () => {
            await hook.getCurrent().openOrReusePullRequest(readyModel());
        });

        expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/happier/dev/compare/main...feature/prs');
        expect(invalidateFromMutationAndAwaitMock).not.toHaveBeenCalled();
    });

    it('blocks compose URLs that do not match the provider origin', async () => {
        sessionScmPullRequestOpenOrReuseMock.mockResolvedValue({
            success: true,
            kind: 'no-auth',
            composeUrl: 'https://evil.example/happier/dev/compare/main...feature/prs',
        });
        const { useScmPullRequestOperations } = await import('./useScmPullRequestOperations');
        const hook = await renderHook(() => useScmPullRequestOperations({ sessionId: 's1' }));

        await act(async () => {
            await hook.getCurrent().openOrReusePullRequest(readyModel());
        });

        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(modalAlertMock).toHaveBeenCalledTimes(1);
        expect(invalidateFromMutationAndAwaitMock).not.toHaveBeenCalled();
    });

    it('creates a prompted feature branch from a blocked default branch', async () => {
        modalPromptMock.mockResolvedValue('feature/from-default');
        sessionScmBranchCreateMock.mockResolvedValue({ success: true });
        const { useScmPullRequestOperations } = await import('./useScmPullRequestOperations');
        const hook = await renderHook(() => useScmPullRequestOperations({ sessionId: 's1' }));

        await act(async () => {
            await hook.getCurrent().createFeatureBranch(readyModel({
                headBranch: 'main',
                createBlockedReason: 'default_branch_requires_feature',
                defaultBranchAction: {
                    kind: 'create_feature_branch',
                    suggestedBranchName: 'feature/dev-update',
                },
            }));
        });

        expect(sessionScmBranchCreateMock).toHaveBeenCalledWith('s1', {
            name: 'feature/from-default',
            checkout: true,
            startPoint: 'main',
        });
        expect(invalidateFromMutationAndAwaitMock).toHaveBeenCalledWith('s1');
    });

    it('runs the stacked PR flow for unpublished feature branches', async () => {
        sessionScmPullRequestRunStackedMock.mockResolvedValue({
            success: true,
            branch: 'feature/prs',
            pullRequest: existingModel().pullRequest,
            nextAction: {
                kind: 'openPullRequest',
                url: 'https://github.com/happier/dev/pull/42',
            },
            events: [],
        });
        const { useScmPullRequestOperations } = await import('./useScmPullRequestOperations');
        const hook = await renderHook(() => useScmPullRequestOperations({ sessionId: 's1' }));

        await act(async () => {
            await hook.getCurrent().openOrReusePullRequest(readyModel({
                createStrategy: { kind: 'run_stacked_create_pr' },
            }));
        });

        expect(sessionScmPullRequestRunStackedMock).toHaveBeenCalledWith('s1', {
            action: 'createPr',
            base: 'main',
            title: 'feature/prs',
            body: '',
        });
        expect(sessionScmPullRequestOpenOrReuseMock).not.toHaveBeenCalled();
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/happier/dev/pull/42');
    });

    it('opens stacked action nextAction compose URLs before legacy fields', async () => {
        sessionScmPullRequestRunStackedMock.mockResolvedValue({
            success: true,
            branch: 'feature/prs',
            composeUrl: 'https://github.com/happier/dev/compare/main...legacy',
            nextAction: {
                kind: 'openCompose',
                url: 'https://github.com/happier/dev/compare/main...feature%2Fprs',
            },
            events: [],
        });
        const { useScmPullRequestOperations } = await import('./useScmPullRequestOperations');
        const hook = await renderHook(() => useScmPullRequestOperations({ sessionId: 's1' }));

        await act(async () => {
            await hook.getCurrent().openOrReusePullRequest(readyModel({
                createStrategy: { kind: 'run_stacked_create_pr' },
            }));
        });

        expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/happier/dev/compare/main...feature%2Fprs');
    });
});
