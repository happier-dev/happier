import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionFilesCommonModuleMocks } from '@/components/sessions/files/sessionFilesTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionScmRemoteAddMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const sessionScmRemoteSetUrlMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const sessionScmRemoteRemoveMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const sessionScmHostingRepositoryDescribePublishTargetsMock = vi.hoisted(() => vi.fn(async () => ({
    success: true,
    auth: { kind: 'gh-cli', authenticated: true },
    defaultRepositoryName: 'repo',
    targets: [
        {
            providerKind: 'github',
            owner: 'happier-dev',
            ownerKind: 'user',
            label: 'happier-dev',
            default: true,
            supportedVisibilities: ['private', 'public'],
        },
    ],
})));
const sessionScmHostingRepositoryPublishMock = vi.hoisted(() => vi.fn(async () => ({
    success: true,
    repository: {
        nameWithOwner: 'happier-dev/repo',
        url: 'https://github.com/happier-dev/repo',
        visibility: 'private',
    },
    remote: {
        name: 'origin',
        fetchUrl: 'https://github.com/happier-dev/repo.git',
    },
    pushed: false,
})));
const sessionScmBranchMergeMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const sessionScmBranchRebaseMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const sessionScmBranchOperationContinueMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const sessionScmBranchOperationAbortMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const invalidateFromMutationAndAwaitMock = vi.hoisted(() => vi.fn(async () => {}));
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));
const modalAlertMock = vi.hoisted(() => vi.fn());

installSessionFilesCommonModuleMocks();

vi.mock('@/components/sessions/files/SourceControlBranchSummary', () => ({
    SourceControlBranchSummary: (props: Record<string, unknown>) => React.createElement('SourceControlBranchSummary', props),
}));

vi.mock('@/components/sessions/sourceControl/remoteActions/SourceControlRemoteActionsRail', () => ({
    SourceControlRemoteActionsRail: (props: Record<string, unknown>) => React.createElement('SourceControlRemoteActionsRail', props),
}));

vi.mock('@/components/sessions/sourceControl/pullRequests/SourceControlPullRequestSection', () => ({
    SourceControlPullRequestSection: (props: Record<string, unknown>) => React.createElement('SourceControlPullRequestSection', props),
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        onViewportLayout: vi.fn(),
        onContentSizeChange: vi.fn(),
        onScroll: vi.fn(),
        visibility: {},
    }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: (props: Record<string, unknown>) => React.createElement('ScrollEdgeFades', props),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: (props: Record<string, unknown>) => React.createElement('ScrollEdgeIndicators', props),
}));

vi.mock('@/sync/ops/sessions', () => ({
    sessionScmRemoteAdd: sessionScmRemoteAddMock,
    sessionScmRemoteSetUrl: sessionScmRemoteSetUrlMock,
    sessionScmRemoteRemove: sessionScmRemoteRemoveMock,
    sessionScmHostingRepositoryDescribePublishTargets: sessionScmHostingRepositoryDescribePublishTargetsMock,
    sessionScmHostingRepositoryPublish: sessionScmHostingRepositoryPublishMock,
    sessionScmBranchMerge: sessionScmBranchMergeMock,
    sessionScmBranchRebase: sessionScmBranchRebaseMock,
    sessionScmBranchOperationContinue: sessionScmBranchOperationContinueMock,
    sessionScmBranchOperationAbort: sessionScmBranchOperationAbortMock,
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
            confirm: modalConfirmMock,
        },
    }).module;
});

const theme = {
    colors: {
        background: 'background',
        button: {
            primary: {
                background: 'button-primary-background',
                tint: 'button-primary-tint',
            },
        },
        divider: 'divider',
        input: {
            background: 'input-background',
            border: 'input-border',
        },
        primary: 'primary',
        surface: 'surface',
        surfaceHigh: 'surface-high',
        text: 'text',
        textSecondary: 'text-secondary',
        textLink: 'text-link',
    },
};

function createSnapshot(overrides: Record<string, unknown> = {}) {
    return {
        fetchedAt: 1,
        projectKey: 'm1:/repo',
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
        capabilities: {
            readBranches: true,
            writeRemoteAdd: true,
            writeRemoteSetUrl: true,
            writeRemoteRemove: true,
            readHostingRepositoryPublishTargets: true,
            writeHostingRepositoryPublish: true,
            writeBranchMerge: true,
            writeBranchRebase: true,
            writeBranchOperationControl: true,
        },
        branch: {
            head: 'main',
            upstream: 'origin/main',
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
        ...overrides,
    };
}

function findDropdownByItemIds(screen: Readonly<{
    findAll: (predicate: (node: any) => boolean) => readonly any[];
}>, itemIds: readonly string[]) {
    return screen.findAll((node) => {
        const items = node.props?.items;
        if (!Array.isArray(items)) return false;
        if (typeof node.props?.onSelect !== 'function') return false;
        return itemIds.every((id) => items.some((item: { id?: unknown }) => item.id === id));
    })[0] ?? null;
}

const scmStatusFiles = {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    includedFiles: [],
    pendingFiles: [],
    totalIncluded: 0,
    totalPending: 0,
};

describe('SessionRightPanelGitUpdateTab', () => {
    beforeEach(() => {
        sessionScmRemoteAddMock.mockClear();
        sessionScmRemoteSetUrlMock.mockClear();
        sessionScmRemoteRemoveMock.mockClear();
        sessionScmHostingRepositoryDescribePublishTargetsMock.mockClear();
        sessionScmHostingRepositoryPublishMock.mockClear();
        sessionScmBranchMergeMock.mockClear();
        sessionScmBranchRebaseMock.mockClear();
        sessionScmBranchOperationContinueMock.mockClear();
        sessionScmBranchOperationAbortMock.mockClear();
        invalidateFromMutationAndAwaitMock.mockClear();
        modalConfirmMock.mockClear();
        modalAlertMock.mockClear();
    });

    it('renders remote management and branch integration sections with stable test ids', async () => {
        const { SessionRightPanelGitUpdateTab } = await import('./SessionRightPanelGitUpdateTab');

        const screen = await renderScreen(
            <SessionRightPanelGitUpdateTab
                theme={theme}
                sessionId="session-1"
                scmSnapshot={createSnapshot({
                    operationState: {
                        kind: 'merge',
                        sourceRef: 'origin/main',
                        canContinue: true,
                        canAbort: true,
                    },
                }) as any}
                scmWriteEnabled
                actions={[]}
                scmStatusFiles={scmStatusFiles as any}
            />,
        );

        expect(screen.findByTestId('scm-update-remotes-section')).not.toBeNull();
        expect(screen.findByTestId('scm-update-add-remote')).not.toBeNull();
        expect(screen.findByTestId('scm-update-remote-edit')).not.toBeNull();
        expect(screen.findByTestId('scm-update-remote-remove')).not.toBeNull();
        expect(screen.tree.root.findByType('SourceControlPullRequestSection' as any).props.sessionId).toBe('session-1');
        expect(screen.findByTestId('scm-update-branch-integration-section')).not.toBeNull();
        expect(screen.findByTestId('scm-update-branch-source-picker')).not.toBeNull();
        expect(screen.findByTestId('scm-update-branch-merge')).not.toBeNull();
        expect(screen.findByTestId('scm-update-branch-rebase')).not.toBeNull();
        expect(screen.findByTestId('scm-update-branch-operation-continue')).not.toBeNull();
        expect(screen.findByTestId('scm-update-branch-operation-abort')).not.toBeNull();
    });

    it('runs remote management operations and refreshes the SCM snapshot', async () => {
        const { SessionRightPanelGitUpdateTab } = await import('./SessionRightPanelGitUpdateTab');

        const screen = await renderScreen(
            <SessionRightPanelGitUpdateTab
                theme={theme}
                sessionId="session-1"
                scmSnapshot={createSnapshot() as any}
                scmWriteEnabled
                actions={[]}
                scmStatusFiles={scmStatusFiles as any}
            />,
        );

        act(() => {
            screen.changeTextByTestId('scm-remote-editor-name', 'backup');
            screen.changeTextByTestId('scm-remote-editor-fetch-url', 'git@example.com:backup.git');
        });
        await screen.pressByTestIdAsync('scm-remote-editor-save');

        expect(sessionScmRemoteAddMock).toHaveBeenCalledWith('session-1', {
            name: 'backup',
            fetchUrl: 'git@example.com:backup.git',
        });

        await screen.pressByTestIdAsync('scm-update-remote-edit');
        act(() => {
            screen.changeTextByTestId('scm-remote-editor-fetch-url', 'git@example.com:next.git');
            screen.changeTextByTestId('scm-remote-editor-push-url', 'git@example.com:push.git');
        });
        await screen.pressByTestIdAsync('scm-remote-editor-save');

        expect(sessionScmRemoteSetUrlMock).toHaveBeenCalledWith('session-1', {
            name: 'origin',
            fetchUrl: 'git@example.com:next.git',
            pushUrl: 'git@example.com:push.git',
        });

        await screen.pressByTestIdAsync('scm-update-remote-remove');

        expect(modalConfirmMock).toHaveBeenCalled();
        expect(sessionScmRemoteRemoveMock).toHaveBeenCalledWith('session-1', {
            name: 'origin',
        });
        expect(invalidateFromMutationAndAwaitMock).toHaveBeenCalledWith('session-1');
    });

    it('renders GitHub publish options through shared dropdown controls', async () => {
        sessionScmHostingRepositoryDescribePublishTargetsMock.mockResolvedValueOnce({
            success: true,
            auth: { kind: 'gh-cli', authenticated: true },
            defaultRepositoryName: 'repo',
            targets: [
                {
                    providerKind: 'github',
                    owner: 'leeroybrun',
                    ownerKind: 'user',
                    label: 'leeroybrun',
                    default: false,
                    supportedVisibilities: ['private', 'public'],
                },
                {
                    providerKind: 'github',
                    owner: 'happier-dev',
                    ownerKind: 'organization',
                    label: 'happier-dev',
                    default: true,
                    supportedVisibilities: ['private', 'public', 'internal'],
                },
            ],
        });
        const { SessionRightPanelGitUpdateTab } = await import('./SessionRightPanelGitUpdateTab');

        const screen = await renderScreen(
            <SessionRightPanelGitUpdateTab
                theme={theme}
                sessionId="session-1"
                scmSnapshot={createSnapshot({
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        backendId: 'git',
                        mode: '.git',
                        remotes: [],
                    },
                }) as any}
                scmWriteEnabled
                actions={[]}
                scmStatusFiles={scmStatusFiles as any}
            />,
        );

        await act(async () => {});

        expect(screen.findByTestId('scm-publish-owner-dropdown')).not.toBeNull();
        expect(screen.findByTestId('scm-publish-visibility-dropdown')).not.toBeNull();
        expect(screen.findByTestId('scm-publish-remote-kind-dropdown')).not.toBeNull();
        expect(screen.findByTestId('scm-publish-push-toggle')).not.toBeNull();
        expect(screen.findByTestId('scm-publish-owner-leeroybrun')).toBeNull();
        expect(screen.findByTestId('scm-publish-visibility-private')).toBeNull();
        expect(screen.findByTestId('scm-publish-remote-https')).toBeNull();
        expect(findDropdownByItemIds(screen, ['owner:leeroybrun', 'owner:happier-dev'])).not.toBeNull();
        expect(findDropdownByItemIds(screen, ['visibility:private', 'visibility:public', 'visibility:internal'])).not.toBeNull();
        expect(findDropdownByItemIds(screen, ['remote-kind:https', 'remote-kind:ssh'])).not.toBeNull();
    });

    it('publishes a repository to GitHub from the remotes section when no remote is configured', async () => {
        const { SessionRightPanelGitUpdateTab } = await import('./SessionRightPanelGitUpdateTab');

        const screen = await renderScreen(
            <SessionRightPanelGitUpdateTab
                theme={theme}
                sessionId="session-1"
                scmSnapshot={createSnapshot({
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        backendId: 'git',
                        mode: '.git',
                        remotes: [],
                    },
                }) as any}
                scmWriteEnabled
                actions={[]}
                scmStatusFiles={scmStatusFiles as any}
            />,
        );

        await act(async () => {});

        expect(screen.findByTestId('scm-publish-repository-section')).not.toBeNull();
        expect(sessionScmHostingRepositoryDescribePublishTargetsMock).toHaveBeenCalledWith('session-1', {
            providerKind: 'github',
        });

        act(() => {
            screen.changeTextByTestId('scm-publish-repository-name', 'repo');
        });
        const visibilityDropdown = findDropdownByItemIds(screen, ['visibility:private', 'visibility:public']);
        const remoteKindDropdown = findDropdownByItemIds(screen, ['remote-kind:https', 'remote-kind:ssh']);
        expect(visibilityDropdown).not.toBeNull();
        expect(remoteKindDropdown).not.toBeNull();
        act(() => {
            visibilityDropdown?.props.onSelect('visibility:public');
            remoteKindDropdown?.props.onSelect('remote-kind:ssh');
        });
        await screen.pressByTestIdAsync('scm-publish-push-toggle');
        await screen.pressByTestIdAsync('scm-publish-repository-submit');

        expect(sessionScmHostingRepositoryPublishMock).toHaveBeenCalledWith('session-1', {
            providerKind: 'github',
            owner: 'happier-dev',
            ownerKind: 'user',
            repositoryName: 'repo',
            visibility: 'public',
            remoteName: 'origin',
            remoteConflictStrategy: 'fail',
            remoteUrlKind: 'ssh',
            pushCurrentBranch: true,
        });
        expect(invalidateFromMutationAndAwaitMock).toHaveBeenCalledWith('session-1');
    });

    it('publishes to GitHub with an explicit origin replacement when only non-GitHub remotes exist', async () => {
        const { SessionRightPanelGitUpdateTab } = await import('./SessionRightPanelGitUpdateTab');

        const screen = await renderScreen(
            <SessionRightPanelGitUpdateTab
                theme={theme}
                sessionId="session-1"
                scmSnapshot={createSnapshot({
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        backendId: 'git',
                        mode: '.git',
                        remotes: [
                            {
                                name: 'origin',
                                fetchUrl: 'https://gitlab.com/happier-dev/repo.git',
                            },
                        ],
                    },
                    hostingProvider: {
                        kind: 'gitlab',
                        baseUrl: 'https://gitlab.com',
                        nameWithOwner: 'happier-dev/repo',
                    },
                }) as any}
                scmWriteEnabled
                actions={[]}
                scmStatusFiles={scmStatusFiles as any}
            />,
        );

        await act(async () => {});

        expect(screen.findByTestId('scm-publish-repository-section')).not.toBeNull();

        act(() => {
            screen.changeTextByTestId('scm-publish-repository-name', 'repo');
        });
        const conflictDropdown = findDropdownByItemIds(screen, ['remote-conflict:fail', 'remote-conflict:set-url']);
        expect(conflictDropdown).not.toBeNull();
        act(() => {
            conflictDropdown?.props.onSelect('remote-conflict:set-url');
        });
        await screen.pressByTestIdAsync('scm-publish-repository-submit');

        expect(sessionScmHostingRepositoryPublishMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
            repositoryName: 'repo',
            remoteName: 'origin',
            remoteConflictStrategy: 'set-url',
        }));
    });

    it('does not offer GitHub publishing when a GitHub Enterprise remote already exists', async () => {
        const { SessionRightPanelGitUpdateTab } = await import('./SessionRightPanelGitUpdateTab');

        const screen = await renderScreen(
            <SessionRightPanelGitUpdateTab
                theme={theme}
                sessionId="session-1"
                scmSnapshot={createSnapshot({
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        backendId: 'git',
                        mode: '.git',
                        remotes: [
                            {
                                name: 'origin',
                                fetchUrl: 'https://gitlab.com/happier-dev/repo.git',
                            },
                            {
                                name: 'enterprise',
                                fetchUrl: 'git@github.company.com:happier-dev/repo.git',
                            },
                        ],
                    },
                    hostingProvider: {
                        kind: 'gitlab',
                        baseUrl: 'https://gitlab.com',
                        nameWithOwner: 'happier-dev/repo',
                    },
                }) as any}
                scmWriteEnabled
                actions={[]}
                scmStatusFiles={scmStatusFiles as any}
            />,
        );

        await act(async () => {});

        expect(screen.findByTestId('scm-publish-repository-section')).toBeNull();
        expect(sessionScmHostingRepositoryDescribePublishTargetsMock).not.toHaveBeenCalled();
    });

    it('runs branch integration operations and refreshes the SCM snapshot', async () => {
        const { SessionRightPanelGitUpdateTab } = await import('./SessionRightPanelGitUpdateTab');

        const screen = await renderScreen(
            <SessionRightPanelGitUpdateTab
                theme={theme}
                sessionId="session-1"
                scmSnapshot={createSnapshot({
                    operationState: {
                        kind: 'merge',
                        sourceRef: 'origin/main',
                        canContinue: true,
                        canAbort: true,
                    },
                }) as any}
                scmWriteEnabled
                actions={[]}
                scmStatusFiles={scmStatusFiles as any}
            />,
        );

        act(() => {
            screen.changeTextByTestId('scm-update-branch-source-picker', 'origin/main');
        });
        await screen.pressByTestIdAsync('scm-update-branch-merge');
        await screen.pressByTestIdAsync('scm-update-branch-rebase');
        await screen.pressByTestIdAsync('scm-update-branch-operation-continue');
        await screen.pressByTestIdAsync('scm-update-branch-operation-abort');

        expect(sessionScmBranchMergeMock).toHaveBeenCalledWith('session-1', {
            sourceRef: 'origin/main',
        });
        expect(sessionScmBranchRebaseMock).toHaveBeenCalledWith('session-1', {
            sourceRef: 'origin/main',
        });
        expect(sessionScmBranchOperationContinueMock).toHaveBeenCalledWith('session-1', {
            operation: 'merge',
        });
        expect(sessionScmBranchOperationAbortMock).toHaveBeenCalledWith('session-1', {
            operation: 'merge',
        });
        expect(invalidateFromMutationAndAwaitMock).toHaveBeenCalledWith('session-1');
    });
});
