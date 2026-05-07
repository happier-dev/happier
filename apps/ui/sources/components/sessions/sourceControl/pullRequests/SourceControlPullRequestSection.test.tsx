import * as React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

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

const theme = {
    colors: {
        background: 'background',
        divider: 'divider',
        primary: 'primary',
        surface: 'surface',
        surfaceHigh: 'surface-high',
        text: 'text',
        textSecondary: 'text-secondary',
    },
};

let SourceControlPullRequestSection: typeof import('./SourceControlPullRequestSection').SourceControlPullRequestSection;

function snapshot(overrides: Partial<ScmWorkingSnapshot> = {}): ScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 1,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            remotes: [],
            worktrees: [],
        },
        capabilities: {
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            readBranches: true,
            writeInclude: true,
            writeExclude: true,
            writeCommit: true,
            writeCommitPathSelection: true,
            writeCommitLineSelection: true,
            writeBackout: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            writeRemotePublish: true,
            writeBranchCreate: true,
            readHostingProvider: true,
            readPullRequests: true,
            writePullRequestCreate: true,
            writePullRequestRunStacked: true,
            defaultBranchPushPolicy: 'requires-feature-branch',
            worktreeCreate: true,
            changeSetModel: 'index',
            supportedDiffAreas: ['included', 'pending', 'both'],
        },
        branch: {
            head: 'feature/prs',
            upstream: 'origin/main',
            ahead: 1,
            behind: 0,
            detached: false,
        },
        hostingProvider: {
            kind: 'github',
            name: 'GitHub',
            baseUrl: 'https://github.com',
            nameWithOwner: 'happier/dev',
            remoteName: 'origin',
        },
        pullRequest: null,
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

describe('SourceControlPullRequestSection', () => {
    beforeAll(async () => {
        ({ SourceControlPullRequestSection } = await import('./SourceControlPullRequestSection'));
    }, 120000);

    beforeEach(() => {
        sessionScmPullRequestOpenOrReuseMock.mockReset();
        sessionScmPullRequestRunStackedMock.mockReset();
        sessionScmBranchCreateMock.mockReset();
        openExternalUrlMock.mockClear();
        invalidateFromMutationAndAwaitMock.mockClear();
        modalAlertMock.mockClear();
        modalPromptMock.mockReset();
    });

    it('surfaces the current branch pull request state', async () => {
        const screen = await renderScreen(
            <SourceControlPullRequestSection
                theme={theme}
                sessionId="s1"
                snapshot={snapshot({
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
                        state: 'closed',
                    },
                })}
                writeEnabled
            />,
        );

        expect(screen.findByTestId('scm-update-pull-request-section')).not.toBeNull();
        expect(screen.findByTestId('scm-pull-request-status-card')).not.toBeNull();
        expect(screen.findByTestId('scm-pull-request-view')).not.toBeNull();

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).toContain('#42');
        expect(serialized).toContain('Closed');
    });

    it('keeps the existing PR view action enabled when write operations are disabled', async () => {
        const screen = await renderScreen(
            <SourceControlPullRequestSection
                theme={theme}
                sessionId="s1"
                snapshot={snapshot({
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
                })}
                writeEnabled={false}
            />,
        );

        const viewButton = screen.findByTestId('scm-pull-request-view');
        expect(viewButton?.props.disabled).toBe(false);

        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(sessionScmPullRequestOpenOrReuseMock).not.toHaveBeenCalled();
    });

    it('creates or reuses a pull request through the SCM RPC and opens the resulting URL', async () => {
        sessionScmPullRequestOpenOrReuseMock.mockResolvedValue({
            success: true,
            kind: 'no-auth',
            composeUrl: 'https://github.com/happier/dev/compare/master...feature/prs',
        });
        const screen = await renderScreen(
            <SourceControlPullRequestSection
                theme={theme}
                sessionId="s1"
                snapshot={snapshot({
                    capabilities: {
                        ...snapshot().capabilities!,
                        writeRemotePublish: false,
                    },
                    branch: {
                        head: 'feature/prs',
                        upstream: 'origin/master',
                        ahead: 1,
                        behind: 0,
                        detached: false,
                    },
                })}
                writeEnabled
            />,
        );

        await screen.pressByTestIdAsync('scm-pull-request-open-or-reuse');

        expect(sessionScmPullRequestOpenOrReuseMock).toHaveBeenCalledWith('s1', {
            base: 'master',
            head: 'feature/prs',
            title: 'feature/prs',
            body: '',
        });
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/happier/dev/compare/master...feature/prs');
    });

    it('keeps PR state visible while disabling create actions when pull request creation is unsupported', async () => {
        const base = snapshot();
        const screen = await renderScreen(
            <SourceControlPullRequestSection
                theme={theme}
                sessionId="s1"
                snapshot={snapshot({
                    capabilities: {
                        ...base.capabilities!,
                        writePullRequestCreate: false,
                    },
                })}
                writeEnabled
            />,
        );

        expect(screen.findByTestId('scm-pull-request-status-card')).not.toBeNull();
        expect(screen.findByTestId('scm-pull-request-open-or-reuse')?.props.disabled).toBe(true);
    });

    it('creates a feature branch directly when a clean default branch cannot open a pull request', async () => {
        modalPromptMock.mockResolvedValue('feature/from-default');
        sessionScmBranchCreateMock.mockResolvedValue({ success: true });
        const screen = await renderScreen(
            <SourceControlPullRequestSection
                theme={theme}
                sessionId="s1"
                snapshot={snapshot({
                    branch: {
                        head: 'main',
                        upstream: 'origin/main',
                        ahead: 0,
                        behind: 0,
                        detached: false,
                    },
                })}
                writeEnabled
            />,
        );

        const createBranchButton = screen.findByTestId('scm-pull-request-create-feature-branch');
        expect(createBranchButton).not.toBeNull();
        expect(createBranchButton?.props.disabled).toBe(false);
        expect(screen.findByTestId('scm-pull-request-policy-warning')).not.toBeNull();

        await screen.pressByTestIdAsync('scm-pull-request-create-feature-branch');

        expect(sessionScmBranchCreateMock).toHaveBeenCalledWith('s1', {
            name: 'feature/from-default',
            checkout: true,
            startPoint: 'main',
        });
        expect(invalidateFromMutationAndAwaitMock).toHaveBeenCalledWith('s1');
    });

    it('creates a feature branch and opens a pull request for default-branch commits', async () => {
        modalPromptMock.mockResolvedValue('feature/from-default');
        sessionScmPullRequestRunStackedMock.mockResolvedValue({
            success: true,
            branch: 'feature/from-default',
            pullRequest: {
                provider: {
                    kind: 'github',
                    name: 'GitHub',
                    baseUrl: 'https://github.com',
                    nameWithOwner: 'happier/dev',
                    remoteName: 'origin',
                },
                number: 42,
                title: 'feature/from-default',
                url: 'https://github.com/happier/dev/pull/42',
                baseBranch: 'main',
                headBranch: 'feature/from-default',
                state: 'open',
            },
            events: [],
        });

        const screen = await renderScreen(
            <SourceControlPullRequestSection
                theme={theme}
                sessionId="s1"
                snapshot={snapshot({
                    branch: {
                        head: 'main',
                        upstream: 'origin/main',
                        ahead: 2,
                        behind: 0,
                        detached: false,
                    },
                })}
                writeEnabled
            />,
        );

        await screen.pressByTestIdAsync('scm-pull-request-create-feature-branch-and-open-pr');

        expect(sessionScmPullRequestRunStackedMock).toHaveBeenCalledWith('s1', {
            action: 'createPr',
            base: 'main',
            featureBranch: 'feature/from-default',
            title: 'feature/from-default',
            body: '',
        });
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/happier/dev/pull/42');
        expect(invalidateFromMutationAndAwaitMock).toHaveBeenCalledWith('s1');
    });

    it('renders an unavailable state when the hosting provider is unknown', async () => {
        const screen = await renderScreen(
            <SourceControlPullRequestSection
                theme={theme}
                sessionId="s1"
                snapshot={snapshot({ hostingProvider: null })}
                writeEnabled
            />,
        );

        expect(screen.findByTestId('scm-pull-request-unavailable')).not.toBeNull();
    });
});
