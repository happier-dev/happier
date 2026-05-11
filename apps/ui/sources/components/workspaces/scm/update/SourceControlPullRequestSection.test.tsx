import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ScmPullRequestOpenComposeResponse, ScmPullRequestOpenOrReuseResponse } from '@happier-dev/protocol';

import { createModalModuleMock, createThemeFixture, renderScreen } from '@/dev/testkit';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { SourceControlUpdateTheme } from './SourceControlUpdateControls';

const modalMock = createModalModuleMock({ confirmResult: true });

vi.mock('@/modal', () => modalMock.module);

function createSnapshot(overrides: Partial<ScmWorkingSnapshot> = {}): ScmWorkingSnapshot {
    return {
        fetchedAt: 1,
        projectKey: 'machine:/repo',
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            defaultBranch: 'trunk',
            remotes: [],
            worktrees: [],
        },
        capabilities: {
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
            readPullRequestStatus: true,
            writePullRequestCreate: true,
            writeBranchCreate: true,
            worktreeCreate: true,
            changeSetModel: 'index',
            supportedDiffAreas: ['both'],
        },
        branch: {
            head: 'feature/pr',
            upstream: 'origin/feature/pr',
            ahead: 1,
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

function createCapabilities(
    overrides: Partial<NonNullable<ScmWorkingSnapshot['capabilities']>> = {},
): NonNullable<ScmWorkingSnapshot['capabilities']> {
    const capabilities = createSnapshot().capabilities;
    if (!capabilities) {
        throw new Error('Expected source control capabilities fixture');
    }
    return {
        ...capabilities,
        ...overrides,
    };
}

describe('SourceControlPullRequestSection', () => {
    it('can transition from unavailable to available without changing hook order', async () => {
        const { SourceControlPullRequestSection } = await import('./SourceControlPullRequestSection');
        const theme = createThemeFixture() as unknown as SourceControlUpdateTheme;
        const screen = await renderScreen(
            <SourceControlPullRequestSection
                theme={theme}
                snapshot={null}
                disabled={false}
                onOpenOrReuse={vi.fn()}
                onRefresh={vi.fn()}
            />,
        );

        await expect(screen.update(
            <SourceControlPullRequestSection
                theme={theme}
                snapshot={createSnapshot()}
                disabled={false}
                onOpenOrReuse={vi.fn()}
                onRefresh={vi.fn()}
            />,
        )).resolves.toBeUndefined();
        expect(screen.findByTestId('scm-pull-request-section')).toBeTruthy();
    });

    it('executes backend default-branch remediation after confirmation', async () => {
        modalMock.spies.confirm.mockClear();
        const defaultBranchResponse = {
            success: false as const,
            error: 'Feature branch required',
            errorCode: 'REMOTE_REJECTED',
            defaultBranchAction: {
                kind: 'create_feature_branch_and_open_pr',
                baseBranch: 'trunk',
                currentBranch: 'trunk',
                ahead: 2,
            },
        } satisfies ScmPullRequestOpenOrReuseResponse & {
            defaultBranchAction: {
                kind: 'create_feature_branch_and_open_pr';
                baseBranch: string;
                currentBranch: string;
                ahead: number;
            };
        };
        const successResponse = {
            success: true as const,
            nextAction: { kind: 'none' as const },
        } satisfies ScmPullRequestOpenOrReuseResponse;
        const onOpenOrReuse = vi.fn()
            .mockResolvedValueOnce(defaultBranchResponse)
            .mockResolvedValueOnce(successResponse);
        const onCreateFeatureBranch = vi.fn(async () => ({ success: true as const }));
        const onRefresh = vi.fn(async () => {});
        const { SourceControlPullRequestSection } = await import('./SourceControlPullRequestSection');
        const screen = await renderScreen(
            <SourceControlPullRequestSection
                theme={createThemeFixture() as unknown as SourceControlUpdateTheme}
                snapshot={createSnapshot()}
                disabled={false}
                onOpenOrReuse={onOpenOrReuse}
                onCreateFeatureBranch={onCreateFeatureBranch}
                onRefresh={onRefresh}
            />,
        );

        await screen.pressByTestIdAsync('scm-pull-request-primary');

        expect(modalMock.spies.confirm).toHaveBeenCalledTimes(1);
        expect(onCreateFeatureBranch).toHaveBeenCalledWith({
            name: 'feature/trunk-ahead-2',
            checkout: true,
            startPoint: 'trunk',
        });
        expect(onOpenOrReuse).toHaveBeenLastCalledWith({
            base: 'trunk',
            head: 'feature/trunk-ahead-2',
        });
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('routes compose fallback through the open-compose operation and validated URL opener', async () => {
        const openComposeResponse = {
            success: true as const,
            nextAction: {
                kind: 'openUrl' as const,
                purpose: 'compose' as const,
                url: 'https://github.com/acme/repo/compare/trunk...feature/pr',
                allowedBaseUrl: 'https://github.com/acme/repo',
                urlSafety: { allowedSchemes: ['https:'] },
            },
            composeUrl: 'https://github.com/acme/repo/compare/trunk...feature/pr',
        } satisfies ScmPullRequestOpenComposeResponse;
        const onOpenCompose = vi.fn(async () => openComposeResponse);
        const onOpenOrReuse = vi.fn();
        const openUrl = vi.fn(async () => {});
        const onRefresh = vi.fn(async () => {});
        const { SourceControlPullRequestSection } = await import('./SourceControlPullRequestSection');
        const screen = await renderScreen(
            <SourceControlPullRequestSection
                theme={createThemeFixture() as unknown as SourceControlUpdateTheme}
                snapshot={createSnapshot({
                    capabilities: createCapabilities({ writePullRequestCreate: false }),
                    pullRequestStatus: {
                        provider: {
                            id: 'scm.github',
                            kind: 'github',
                            displayName: 'GitHub',
                            baseUrl: 'https://github.com/acme/repo',
                            nameWithOwner: 'acme/repo',
                            repositoryWebUrl: 'https://github.com/acme/repo',
                            urlSafety: { allowedSchemes: ['https:'] },
                        },
                        headBranch: 'feature/pr',
                        baseBranch: 'trunk',
                        openPullRequest: null,
                        composeUrl: 'https://github.com/acme/repo/compare/trunk...feature/pr',
                        authState: 'authentication_required',
                    },
                })}
                disabled={false}
                onOpenOrReuse={onOpenOrReuse}
                onOpenCompose={onOpenCompose}
                onRefresh={onRefresh}
                openUrl={openUrl}
            />,
        );

        expect(screen.findByTestId('scm-pull-request-section')).toBeTruthy();
        await screen.pressByTestIdAsync('scm-pull-request-primary');

        expect(onOpenCompose).toHaveBeenCalledWith({
            base: 'trunk',
            head: 'feature/pr',
        });
        expect(onOpenOrReuse).not.toHaveBeenCalled();
        expect(openUrl).toHaveBeenCalledWith('https://github.com/acme/repo/compare/trunk...feature/pr');
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });
});
