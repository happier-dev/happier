import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES, type ScmHostingRepositoryDescribePublishTargetsResponse } from '@happier-dev/protocol';

import { createDeferred, createThemeFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

function createSnapshot(overrides: Partial<ScmWorkingSnapshot> = {}): ScmWorkingSnapshot {
    return {
        fetchedAt: 1,
        projectKey: 'machine:/repo',
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
            writeInclude: true,
            writeExclude: true,
            writeCommit: true,
            writeBackout: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            readHostingRepositoryPublishTargets: true,
            writeHostingRepositoryPublish: true,
            worktreeCreate: true,
            changeSetModel: 'index',
            supportedDiffAreas: ['both'],
        },
        branch: {
            head: 'feature/repo-publish',
            upstream: null,
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

describe('SourceControlPublishRepositorySection', () => {
    it('suppresses publish when any remote already points at a GitHub-family host', async () => {
        const { SourceControlPublishRepositorySection } = await import('./SourceControlPublishRepositorySection');
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createThemeFixture() as any}
                snapshot={createSnapshot({
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        backendId: 'git',
                        mode: '.git',
                        remotes: [{ name: 'upstream', fetchUrl: 'https://github.company/acme/repo.git' }],
                        worktrees: [],
                    },
                })}
                writeEnabled
                disabled={false}
                publishTargets={{
                    success: true,
                    auth: { state: 'authenticated', profileKind: 'connected_account' },
                    defaultRepositoryName: 'repo',
                    targets: [],
                }}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
            />,
        );

        expect(screen.findByTestId('scm-publish-repository-section')).toBeNull();
    });

    it('suppresses publish for scp-style GitHub SSH remotes', async () => {
        const { SourceControlPublishRepositorySection } = await import('./SourceControlPublishRepositorySection');
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createThemeFixture() as any}
                snapshot={createSnapshot({
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        backendId: 'git',
                        mode: '.git',
                        remotes: [{ name: 'origin', fetchUrl: 'git@github.com:acme/repo.git' }],
                        worktrees: [],
                    },
                })}
                writeEnabled
                disabled={false}
                publishTargets={{
                    success: true,
                    auth: { state: 'authenticated', profileKind: 'connected_account' },
                    defaultRepositoryName: 'repo',
                    targets: [],
                }}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
            />,
        );

        expect(screen.findByTestId('scm-publish-repository-section')).toBeNull();
    });

    it('renders target controls for a publishable repository with backend targets', async () => {
        const { SourceControlPublishRepositorySection } = await import('./SourceControlPublishRepositorySection');
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createThemeFixture() as any}
                snapshot={createSnapshot()}
                writeEnabled
                disabled={false}
                publishTargets={{
                    success: true,
                    auth: { state: 'authenticated', profileKind: 'connected_account' },
                    defaultRepositoryName: 'repo',
                    targets: [{
                        provider: {
                            id: 'scm.github',
                            kind: 'github',
                            displayName: 'GitHub',
                            baseUrl: 'https://github.com',
                            urlSafety: { allowedSchemes: ['https:'] },
                        },
                        owner: 'acme',
                        ownerKind: 'org',
                        label: 'acme',
                        isDefault: true,
                        supportedVisibilities: ['private', 'public'],
                        supportedRemoteUrlKinds: ['https', 'ssh'],
                    }],
                }}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={vi.fn(async () => ({ success: false as const, error: 'not used' }))}
                onRefresh={vi.fn()}
            />,
        );

        expect(screen.findByTestId('scm-publish-repository-section')).toBeTruthy();
        expect(screen.findByTestId('scm-publish-owner-dropdown')).toBeTruthy();
        expect(screen.findByTestId('scm-publish-visibility-dropdown')).toBeTruthy();
        expect(screen.findByTestId('scm-publish-protocol-dropdown')).toBeTruthy();
        expect(screen.findByTestId('scm-publish-push-current-branch-switch')).toBeTruthy();
        expect(screen.findByTestId('scm-publish-repository-submit')).toBeTruthy();
    });

    it('routes existing-origin conflict choice through the publish request', async () => {
        const { SourceControlPublishRepositorySection } = await import('./SourceControlPublishRepositorySection');
        const onPublishRepository = vi.fn()
            .mockResolvedValueOnce({
                success: false,
                error: 'Remote already exists',
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
                remediation: { kind: 'set_url_required' },
            })
            .mockResolvedValueOnce({ success: true, repository: {}, remote: {}, pushed: false });
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createThemeFixture() as any}
                snapshot={createSnapshot({
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        backendId: 'git',
                        mode: '.git',
                        remotes: [{ name: 'origin', fetchUrl: 'https://gitlab.example.com/acme/repo.git' }],
                        worktrees: [],
                    },
                })}
                writeEnabled
                disabled={false}
                publishTargets={{
                    success: true,
                    auth: { state: 'authenticated', profileKind: 'connected_account' },
                    defaultRepositoryName: 'repo',
                    targets: [{
                        provider: {
                            id: 'scm.github',
                            kind: 'github',
                            displayName: 'GitHub',
                            baseUrl: 'https://github.com',
                            urlSafety: { allowedSchemes: ['https:'] },
                        },
                        owner: 'acme',
                        ownerKind: 'org',
                        label: 'acme',
                        isDefault: true,
                        supportedVisibilities: ['private'],
                        supportedRemoteUrlKinds: ['https'],
                    }],
                }}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={onPublishRepository}
                onRefresh={vi.fn()}
            />,
        );

        expect(screen.findByTestId('scm-publish-existing-origin-dropdown')).toBeTruthy();
        await screen.pressByTestIdAsync('scm-publish-repository-submit');
        expect(onPublishRepository.mock.calls[0]?.[0]).toMatchObject({
            remoteName: 'origin',
            remoteConflictStrategy: 'fail',
        });

        const conflictDropdown = screen.findAll((node) => (
            node.props?.testID === 'scm-publish-existing-origin-dropdown'
            && typeof node.props?.onSelect === 'function'
        ))[0];
        await act(async () => {
            conflictDropdown?.props.onSelect('set-url');
        });
        await screen.pressByTestIdAsync('scm-publish-repository-submit');

        expect(onPublishRepository.mock.calls[1]?.[0]).toMatchObject({
            remoteName: 'origin',
            remoteConflictStrategy: 'set-url',
        });
    });

    it('clears stale publish targets when the repository root changes', async () => {
        const { SourceControlPublishRepositorySection } = await import('./SourceControlPublishRepositorySection');
        const firstTargets = createDeferred<ScmHostingRepositoryDescribePublishTargetsResponse>();
        const nextTargets = createDeferred<ScmHostingRepositoryDescribePublishTargetsResponse>();
        const onDescribePublishTargets = vi.fn()
            .mockReturnValueOnce(firstTargets.promise)
            .mockReturnValueOnce(nextTargets.promise);
        const initialTargets: ScmHostingRepositoryDescribePublishTargetsResponse = {
            success: true,
            auth: { state: 'authenticated', profileKind: 'connected_account' },
            defaultRepositoryName: 'repo-one',
            targets: [{
                provider: {
                    id: 'scm.github',
                    kind: 'github',
                    displayName: 'GitHub',
                    baseUrl: 'https://github.com',
                    urlSafety: { allowedSchemes: ['https:'] },
                },
                owner: 'old-owner',
                ownerKind: 'org',
                label: 'old-owner',
                isDefault: true,
                supportedVisibilities: ['private'],
                supportedRemoteUrlKinds: ['https'],
            }],
        };
        const resolveInitialTargets = () => firstTargets.resolve(initialTargets);
        const theme = createThemeFixture();
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={theme as any}
                snapshot={createSnapshot()}
                writeEnabled
                disabled={false}
                publishTargets={null}
                onDescribePublishTargets={onDescribePublishTargets}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
            />,
        );
        await act(async () => {
            resolveInitialTargets();
        });
        await flushHookEffects({ cycles: 6, turns: 3 });

        expect(screen.getTextContent()).toContain('old-owner');

        await screen.update(
            <SourceControlPublishRepositorySection
                theme={theme as any}
                snapshot={createSnapshot({
                    projectKey: 'machine:/repo-two',
                    repo: {
                        isRepo: true,
                        rootPath: '/repo-two',
                        backendId: 'git',
                        mode: '.git',
                        remotes: [],
                        worktrees: [],
                    },
                })}
                writeEnabled
                disabled={false}
                publishTargets={null}
                onDescribePublishTargets={onDescribePublishTargets}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
            />,
        );

        expect(onDescribePublishTargets).toHaveBeenCalledTimes(2);
        expect(screen.getTextContent()).not.toContain('old-owner');
    });
});
