import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES, type ScmHostingRepositoryDescribePublishTargetsResponse, type ScmHostingRepositoryPublishResponse } from '@happier-dev/protocol';

import { createDeferred, createThemeFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { SourceControlUpdateTheme } from './SourceControlUpdateControls';
import { SourceControlPublishRepositorySection } from './SourceControlPublishRepositorySection';

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

function createSourceControlUpdateThemeFixture(): SourceControlUpdateTheme {
    return createThemeFixture() as unknown as SourceControlUpdateTheme;
}

describe('SourceControlPublishRepositorySection', () => {
    it('suppresses publish when any remote already points at a GitHub-family host', async () => {
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
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
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
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
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
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

    it('surfaces authenticated connected-account availability without remediation actions', async () => {
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
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
                        supportedVisibilities: ['private'],
                        supportedRemoteUrlKinds: ['https'],
                        auth: { state: 'authenticated', profileKind: 'connected_account' },
                    }],
                }}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
            />,
        );

        expect(screen.findByTestId('scm-publish-auth-connected-account-ready')).toBeTruthy();
        expect(screen.findByTestId('scm-publish-remediation-connect-github')).toBeNull();
        expect(screen.findByTestId('scm-publish-remediation-authenticate-gh')).toBeNull();
    });

    it('surfaces connected-service authentication remediation from backend target auth', async () => {
        const onConnectGitHub = vi.fn(async () => {});
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
                snapshot={createSnapshot()}
                writeEnabled
                disabled={false}
                publishTargets={{
                    success: true,
                    auth: { state: 'authentication_required', profileKind: 'connected_account' },
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
                        auth: {
                            state: 'authentication_required',
                            profileKind: 'connected_account',
                            remediation: { kind: 'auth_required', action: 'connect_github' },
                        },
                    }],
                }}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
                onConnectGitHub={onConnectGitHub}
            />,
        );

        expect(screen.findByTestId('scm-publish-remediation-connect-github')).toBeTruthy();
        await screen.pressByTestIdAsync('scm-publish-remediation-connect-github');

        expect(onConnectGitHub).toHaveBeenCalledTimes(1);
    });

    it('surfaces gh install remediation from backend target auth', async () => {
        const onInstallGh = vi.fn(async () => {});
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
                snapshot={createSnapshot()}
                writeEnabled
                disabled={false}
                publishTargets={{
                    success: true,
                    auth: { state: 'authentication_required', profileKind: 'provider_cli' },
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
                        auth: {
                            state: 'authentication_required',
                            profileKind: 'provider_cli',
                            remediation: { kind: 'install_required', action: 'install_gh' },
                        },
                    }],
                }}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
                onInstallGh={onInstallGh}
            />,
        );

        expect(screen.findByTestId('scm-publish-remediation-install-gh')).toBeTruthy();
        await screen.pressByTestIdAsync('scm-publish-remediation-install-gh');

        expect(onInstallGh).toHaveBeenCalledTimes(1);
    });

    it('disables gh install remediation when the owning surface provides no installable action', async () => {
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
                snapshot={createSnapshot()}
                writeEnabled
                disabled={false}
                publishTargets={{
                    success: true,
                    auth: { state: 'authentication_required', profileKind: 'provider_cli' },
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
                        auth: {
                            state: 'authentication_required',
                            profileKind: 'provider_cli',
                            remediation: { kind: 'install_required', action: 'install_gh' },
                        },
                    }],
                }}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
            />,
        );

        expect(screen.findByTestId('scm-publish-remediation-install-gh')?.props.disabled).toBe(true);
    });

    it('fails closed for publish submission while backend auth remediation is required', async () => {
        const onPublishRepository = vi.fn();
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
                snapshot={createSnapshot()}
                writeEnabled
                disabled={false}
                publishTargets={{
                    success: true,
                    auth: { state: 'authentication_required', profileKind: 'provider_cli' },
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
                        auth: {
                            state: 'authentication_required',
                            profileKind: 'provider_cli',
                            remediation: { kind: 'install_required', action: 'install_gh' },
                        },
                    }],
                }}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={onPublishRepository}
                onRefresh={vi.fn()}
            />,
        );

        expect(screen.findByTestId('scm-publish-repository-submit')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('scm-publish-repository-submit');

        expect(onPublishRepository).not.toHaveBeenCalled();
    });

    it('fails closed for publish submission when backend auth state is unknown', async () => {
        const onPublishRepository = vi.fn();
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
                snapshot={createSnapshot()}
                writeEnabled
                disabled={false}
                publishTargets={{
                    success: true,
                    auth: { state: 'unknown', profileKind: 'unknown' },
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

        expect(screen.findByTestId('scm-publish-repository-submit')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('scm-publish-repository-submit');

        expect(onPublishRepository).not.toHaveBeenCalled();
    });

    it('surfaces authenticated provider-cli availability from backend target auth', async () => {
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
                snapshot={createSnapshot()}
                writeEnabled
                disabled={false}
                publishTargets={{
                    success: true,
                    auth: { state: 'authenticated', profileKind: 'provider_cli' },
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
                        auth: { state: 'authenticated', profileKind: 'provider_cli' },
                    }],
                }}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
            />,
        );

        expect(screen.findByTestId('scm-publish-auth-provider-cli-ready')).toBeTruthy();
        expect(screen.findByTestId('scm-publish-remediation-authenticate-gh')).toBeNull();
        expect(screen.findByTestId('scm-publish-remediation-connect-github')).toBeNull();
    });

    it('routes browser remediation through validated follow-up URL shape', async () => {
        const openUrl = vi.fn(async () => {});
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
                snapshot={createSnapshot()}
                writeEnabled
                disabled={false}
                publishTargets={{
                    success: false,
                    error: 'Authentication required',
                    remediation: {
                        kind: 'auth_required',
                        action: 'open_browser',
                        followup: {
                            kind: 'openUrl',
                            purpose: 'compose',
                            url: 'https://github.com/login/oauth/authorize',
                            allowedBaseUrl: 'https://github.com',
                            urlSafety: { allowedSchemes: ['https:'] },
                        },
                    },
                }}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
                openUrl={openUrl}
            />,
        );

        expect(screen.findByTestId('scm-publish-remediation-open-browser')).toBeTruthy();
        await screen.pressByTestIdAsync('scm-publish-remediation-open-browser');

        expect(openUrl).toHaveBeenCalledWith('https://github.com/login/oauth/authorize');
    });

    it('rejects browser remediation when URL safety metadata is malformed', async () => {
        const openUrl = vi.fn(async () => {});
        const malformedTargetsResponse = {
            success: false,
            error: 'Authentication required',
            remediation: {
                kind: 'auth_required',
                action: 'open_browser',
                followup: {
                    kind: 'openUrl',
                    purpose: 'compose',
                    url: 'javascript:alert(1)',
                    allowedBaseUrl: 'javascript:alert(1)',
                    urlSafety: { allowedSchemes: 'javascript:' },
                },
            },
        } as unknown as ScmHostingRepositoryDescribePublishTargetsResponse;

        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
                snapshot={createSnapshot()}
                writeEnabled
                disabled={false}
                publishTargets={malformedTargetsResponse}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
                openUrl={openUrl}
            />,
        );

        expect(screen.findByTestId('scm-publish-remediation-open-browser')).toBeNull();
        expect(openUrl).not.toHaveBeenCalled();
    });

    it('rejects browser remediation when the follow-up URL uses a disallowed scheme', async () => {
        const openUrl = vi.fn(async () => {});
        const malformedTargetsResponse = {
            success: false,
            error: 'Authentication required',
            remediation: {
                kind: 'auth_required',
                action: 'open_browser',
                followup: {
                    kind: 'openUrl',
                    purpose: 'compose',
                    url: 'javascript:alert(1)',
                    allowedBaseUrl: 'javascript:alert(1)',
                    urlSafety: { allowedSchemes: ['https:'] },
                },
            },
        } as unknown as ScmHostingRepositoryDescribePublishTargetsResponse;

        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
                snapshot={createSnapshot()}
                writeEnabled
                disabled={false}
                publishTargets={malformedTargetsResponse}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
                openUrl={openUrl}
            />,
        );

        expect(screen.findByTestId('scm-publish-remediation-open-browser')).toBeNull();
        expect(openUrl).not.toHaveBeenCalled();
    });

    it('routes existing-origin conflict choice through the publish request', async () => {
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
                theme={createSourceControlUpdateThemeFixture()}
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

    it('surfaces commit-required remediation as a stable state', async () => {
        const commitRequiredResponse = {
            success: false,
            error: 'Commit required',
            errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
            remediation: { kind: 'commit_required' },
        } satisfies ScmHostingRepositoryPublishResponse;
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
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
                        supportedVisibilities: ['private'],
                        supportedRemoteUrlKinds: ['https'],
                    }],
                }}
                onDescribePublishTargets={vi.fn()}
                onPublishRepository={vi.fn(async () => commitRequiredResponse)}
                onRefresh={vi.fn()}
            />,
        );

        await screen.pressByTestIdAsync('scm-publish-repository-submit');

        expect(screen.findByTestId('scm-publish-remediation-commit-required')).toBeTruthy();
    });

    it('clears stale publish targets when the repository root changes', async () => {
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
        const theme = createSourceControlUpdateThemeFixture();
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={theme}
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
                theme={theme}
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

    // `F-SCM-4`. A failed discovery is the UNKNOWN state, not the "you are not signed in" state:
    // the daemon returns `success: false` when its gh probe was cut short or its provider never
    // resolved, and this surface used to answer that with an instruction to sign in — on hosts
    // where `gh auth status` succeeds. The real negative arrives as `success: true` with an
    // `authentication_required` auth summary and is asserted by the remediation tests above.
    it('offers a recoverable unknown state when publish-target discovery fails', async () => {
        const failure: ScmHostingRepositoryDescribePublishTargetsResponse = {
            success: false,
            error: 'GitHub CLI command did not complete',
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        };
        const succeeded: ScmHostingRepositoryDescribePublishTargetsResponse = {
            success: true,
            auth: { state: 'authenticated', profileKind: 'provider_cli' },
            defaultRepositoryName: 'repo',
            targets: [{
                provider: {
                    id: 'scm.github',
                    kind: 'github',
                    displayName: 'GitHub',
                    baseUrl: 'https://github.com',
                    urlSafety: { allowedSchemes: ['https:'] },
                },
                owner: 'leeroybrun',
                ownerKind: 'user',
                label: 'leeroybrun',
                isDefault: true,
                supportedVisibilities: ['private', 'public'],
                supportedRemoteUrlKinds: ['https', 'ssh'],
                auth: { state: 'authenticated', profileKind: 'provider_cli' },
            }],
        };
        const onDescribePublishTargets = vi.fn()
            .mockResolvedValueOnce(failure)
            .mockResolvedValueOnce(succeeded);
        const screen = await renderScreen(
            <SourceControlPublishRepositorySection
                theme={createSourceControlUpdateThemeFixture()}
                snapshot={createSnapshot()}
                writeEnabled
                disabled={false}
                publishTargets={null}
                onDescribePublishTargets={onDescribePublishTargets}
                onPublishRepository={vi.fn()}
                onRefresh={vi.fn()}
            />,
        );
        await flushHookEffects({ cycles: 6, turns: 3 });

        expect(screen.findByTestId('scm-publish-repository-unavailable')).toBeTruthy();
        // The publish controls stay hidden — nothing is known about where this can be published.
        expect(screen.findByTestId('scm-publish-owner-dropdown')).toBeFalsy();

        // The unknown state is not terminal: the same loader re-runs and a later success paints
        // the real targets.
        await screen.pressByTestIdAsync('scm-publish-repository-retry');
        await flushHookEffects({ cycles: 6, turns: 3 });

        expect(onDescribePublishTargets).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('scm-publish-repository-unavailable')).toBeFalsy();
        expect(screen.findByTestId('scm-publish-owner-dropdown')).toBeTruthy();
        expect(screen.getTextContent()).toContain('leeroybrun');
    });
});
