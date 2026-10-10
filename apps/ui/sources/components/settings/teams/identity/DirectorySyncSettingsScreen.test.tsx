import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const executeDirectoryMock = vi.hoisted(() => vi.fn());
const executeIdentityMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());
const loadMoreSourcesMock = vi.hoisted(() => vi.fn());
const routerPushMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn());
const canMutateMock = vi.hoisted(() => ({ current: true }));
const requestApprovalMock = vi.hoisted(() => vi.fn());
const directoryStateMock = vi.hoisted(() => ({
    current: {
        kind: 'ready' as const,
        items: [] as readonly ReturnType<typeof directorySource>[],
        nextCursor: null as string | null,
        refreshing: false,
        loadingMore: false,
        stale: false,
        failure: null as Readonly<{ code: string; retryable: boolean }> | null,
    },
}));

function directorySource(id: string) {
    return {
        v: 1 as const,
        id,
        teamId: 'team-1',
        kind: 'workos_directory' as const,
        displayName: id,
        state: 'active' as const,
        allowedActions: ['teams.directory.sources.sync', 'teams.directory.sources.remove'] as const,
        sync: {
            mode: 'events_and_full' as const,
            attempt: 'succeeded' as const,
            freshness: 'fresh' as const,
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastFullReconcileAt: null,
            nextScheduledAt: null,
        },
        error: null,
    };
}

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPushMock } }).module;
});
// Rows render their right-hand control, as the real row does; page fields are text inputs.
vi.mock('@/components/ui/lists/Item', async () => {
    const React = await import('react');
    return { Item: (props: { rightElement?: unknown }) => React.createElement('Item', props, props.rightElement as never) };
});
vi.mock('@/components/ui/forms/FieldTextInput', () => ({ FieldTextInput: 'TextInput' }));
// Sections render their header action beside their rows, as the real section does.
vi.mock('@/components/ui/lists/ItemGroup', async () => {
    const React = await import('react');
    return { ItemGroup: (props: { action?: unknown; children?: unknown }) => React.createElement('ItemGroup', props, props.action as never, props.children as never) };
});
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivitySpinner' }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn(async () => true) } }));
vi.mock('./identityAdministrationClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('./identityAdministrationClient')>(),
    createIdentityAdministrationClient: () => ({
        execute: executeIdentityMock,
        executeDirectory: executeDirectoryMock,
    }),
}));
vi.mock('./useDirectoryAdministration', () => ({
    useDirectoryAdministration: () => ({
        state: directoryStateMock.current,
        refresh: refreshMock,
        loadMore: loadMoreSourcesMock,
    }),
}));
vi.mock('../TeamSection', () => ({
    TeamSection: (props: Readonly<{ children: (context: unknown) => React.ReactNode }>) => props.children({
        team: { id: 'team-1', capabilities: { manageAuthentication: true } },
        scope: { serverId: 'home-1', accountId: 'account-1' },
        address: { serverId: 'home-1', teamId: 'team-1' },
        canMutate: canMutateMock.current,
        requestApproval: requestApprovalMock,
    }),
}));

import { DirectorySyncSettingsScreen } from './DirectorySyncSettingsScreen';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol';

beforeEach(() => {
    standardCleanup();
    executeDirectoryMock.mockReset();
    executeIdentityMock.mockReset();
    refreshMock.mockReset();
    loadMoreSourcesMock.mockReset();
    routerPushMock.mockReset();
    openExternalUrlMock.mockReset();
    openExternalUrlMock.mockResolvedValue(true);
    openExternalUrlMock.mockReset();
    openExternalUrlMock.mockResolvedValue(true);
    canMutateMock.current = true;
    requestApprovalMock.mockReset();
    directoryStateMock.current.refreshing = false;
    directoryStateMock.current.loadingMore = false;
    directoryStateMock.current.stale = false;
    directoryStateMock.current.items = [];
    directoryStateMock.current.nextCursor = null;
    directoryStateMock.current.failure = null;
});

describe('DirectorySyncSettingsScreen source setup', () => {
    it('keeps setup discoverable but disabled for a read-only Team', async () => {
        canMutateMock.current = false;
        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId="home-1" teamId="team-1" />);

        expect(screen.findByTestId('team-directory-source-add')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('team-directory-source-add');
        expect(executeDirectoryMock).not.toHaveBeenCalled();
    });

    it('creates from the exact server-projected GitHub installation choice', async () => {
        executeDirectoryMock
            .mockResolvedValueOnce({
                ok: true,
                value: {
                    v: 1,
                    items: [{
                        kind: 'github_organization',
                        displayName: 'happier-dev',
                        githubAppInstallationId: 'installation-1',
                    }],
                },
            })
            .mockResolvedValueOnce({
                ok: true,
                value: { id: 'source-1' },
            });

        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId="home-1" teamId="team-1" />);
        await screen.pressByTestIdAsync('team-directory-source-add');
        await vi.waitFor(() => expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-1')).not.toBeNull());

        await screen.pressByTestIdAsync('team-directory-setup-option:github_organization:installation-1');

        expect(executeDirectoryMock).toHaveBeenNthCalledWith(1, 'teams.directory.sourceSetup.list', {
            v: 1,
            teamId: 'team-1',
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(executeDirectoryMock).toHaveBeenNthCalledWith(2, 'teams.directory.sources.create', {
            v: 1,
            teamId: 'team-1',
            kind: 'github_organization',
            displayName: 'happier-dev',
            githubAppInstallationId: 'installation-1',
        }, {
            onApprovalSucceeded: expect.any(Function),
            onApprovalFailed: expect.any(Function),
        });
        expect(refreshMock).toHaveBeenCalledOnce();
        expect(routerPushMock).toHaveBeenCalledWith(
            '/settings/teams/home-1/team-1/authentication/directory/source-1',
        );
        expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-1')).toBeNull();
    });

    it('finishes an approved source creation through the same mounted success path exactly once', async () => {
        let finishCreation: ((value: Readonly<{ id: string }>) => void | Promise<void>) | undefined;
        executeDirectoryMock
            .mockResolvedValueOnce({
                ok: true,
                value: {
                    v: 1,
                    items: [{
                        kind: 'github_organization',
                        displayName: 'happier-dev',
                        githubAppInstallationId: 'installation-1',
                    }],
                    nextCursor: null,
                    complete: true,
                },
            })
            .mockImplementationOnce(async (
                _actionId: string,
                _input: unknown,
                options?: Readonly<{ onApprovalSucceeded?: typeof finishCreation }>,
            ) => {
                finishCreation = options?.onApprovalSucceeded;
                return {
                    ok: false,
                    approvalPending: true,
                    artifactId: 'approval-source-create',
                    failure: { code: 'approval_pending', retryable: false },
                };
            });

        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId="home-1" teamId="team-1" />);
        await screen.pressByTestIdAsync('team-directory-source-add');
        await vi.waitFor(() => expect(screen.findByTestId(
            'team-directory-setup-option:github_organization:installation-1',
        )).not.toBeNull());
        await screen.pressByTestIdAsync('team-directory-setup-option:github_organization:installation-1');

        expect(finishCreation).toBeTypeOf('function');
        expect(routerPushMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-1')).not.toBeNull();

        await act(async () => {
            await finishCreation?.({ id: 'source-approved' });
        });
        expect(refreshMock).toHaveBeenCalledOnce();
        expect(routerPushMock).toHaveBeenCalledOnce();
        expect(routerPushMock).toHaveBeenCalledWith(
            '/settings/teams/home-1/team-1/authentication/directory/source-approved',
        );
        expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-1')).toBeNull();
    });

    it('exposes accumulated source pagination through an accessible mounted control', async () => {
        directoryStateMock.current.items = [directorySource('directory-51')];
        directoryStateMock.current.nextCursor = 'cursor-1';
        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId="home-1" teamId="team-1" />);

        expect(screen.findByTestId('team-directory-source-directory-51')).not.toBeNull();
        expect(screen.findByTestId('team-directory-sources-load-more')).not.toBeNull();
        await screen.pressByTestIdAsync('team-directory-sources-load-more');
        expect(loadMoreSourcesMock).toHaveBeenCalledOnce();
        await screen.pressByTestIdAsync('team-directory-source-directory-51');
        expect(routerPushMock).toHaveBeenCalledWith(
            '/settings/teams/home-1/team-1/authentication/directory/directory-51',
        );
    });

    it('does not continue from a stale source-list cursor after refresh failure', async () => {
        directoryStateMock.current.items = [directorySource('directory-1')];
        directoryStateMock.current.nextCursor = 'cursor-1';
        directoryStateMock.current.stale = true;
        directoryStateMock.current.failure = { code: 'home_unreachable', retryable: true };

        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId="home-1" teamId="team-1" />);

        expect(screen.findByTestId('team-directory-source-directory-1')).not.toBeNull();
        expect(screen.findByTestId('team-directory-sources-load-more')).toBeNull();
    });

    it('paginates setup discovery and preserves the exact continuation contract', async () => {
        executeDirectoryMock
            .mockResolvedValueOnce({
                ok: true,
                value: {
                    v: 1,
                    items: [{
                        kind: 'github_organization',
                        displayName: 'happier-dev',
                        githubAppInstallationId: 'installation-1',
                    }],
                    nextCursor: 'cursor-1',
                    complete: false,
                },
            })
            .mockResolvedValueOnce({
                ok: true,
                value: {
                    v: 1,
                    items: [{
                        kind: 'github_organization',
                        displayName: 'happier-dev-labs',
                        githubAppInstallationId: 'installation-51',
                    }],
                    nextCursor: null,
                    complete: true,
                },
            });

        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId="home-1" teamId="team-1" />);
        await screen.pressByTestIdAsync('team-directory-source-add');
        await vi.waitFor(() => expect(screen.findByTestId('team-directory-setup-load-more')).not.toBeNull());
        await screen.pressByTestIdAsync('team-directory-setup-load-more');

        await vi.waitFor(() => expect(screen.findByTestId(
            'team-directory-setup-option:github_organization:installation-51',
        )).not.toBeNull());
        expect(executeDirectoryMock).toHaveBeenCalledWith('teams.directory.sourceSetup.list', {
            v: 1,
            teamId: 'team-1',
            cursor: 'cursor-1',
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('refreshes visible setup candidates on the exact Home Team AccountChange', async () => {
        executeDirectoryMock
            .mockResolvedValueOnce({
                ok: true,
                value: { v: 1, items: [], nextCursor: null, complete: true },
            })
            .mockResolvedValueOnce({
                ok: true,
                value: {
                    v: 1,
                    items: [{
                        kind: 'github_organization',
                        displayName: 'happier-dev',
                        githubAppInstallationId: 'installation-new',
                    }],
                    nextCursor: null,
                    complete: true,
                },
            });
        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId="home-1" teamId="team-1" />);
        await screen.pressByTestIdAsync('team-directory-source-add');
        await vi.waitFor(() => expect(executeDirectoryMock).toHaveBeenCalledOnce());

        await act(async () => {
            publishHomeAccountChange('another-home', [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            publishHomeAccountChange('home-1', ['home-governance']);
        });
        expect(executeDirectoryMock).toHaveBeenCalledOnce();

        await act(async () => {
            publishHomeAccountChange('home-1', [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });
        await vi.waitFor(() => expect(executeDirectoryMock).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(screen.findByTestId(
            'team-directory-setup-option:github_organization:installation-new',
        )).not.toBeNull());
        expect(executeDirectoryMock).toHaveBeenNthCalledWith(2, 'teams.directory.sourceSetup.list', {
            v: 1,
            teamId: 'team-1',
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('retains server-projected setup choices when their refresh fails', async () => {
        executeDirectoryMock
            .mockResolvedValueOnce({
                ok: true,
                value: {
                    v: 1,
                    items: [{
                        kind: 'github_organization',
                        displayName: 'happier-dev',
                        githubAppInstallationId: 'installation-1',
                    }],
                },
            })
            .mockResolvedValueOnce({ ok: false, failure: { code: 'home_unreachable', retryable: true } });
        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId="home-1" teamId="team-1" />);

        await screen.pressByTestIdAsync('team-directory-source-add');
        await vi.waitFor(() => expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-1')).not.toBeNull());
        await screen.pressByTestIdAsync('team-directory-source-add');

        expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-1')).not.toBeNull();
        expect(screen.findByTestId('team-directory-setup-retry')).not.toBeNull();
    });

    it('presents a localized recovery message when the WorkOS portal cannot be opened', async () => {
        executeDirectoryMock.mockResolvedValueOnce({ ok: true, value: { v: 1, items: [] } });
        executeIdentityMock
            .mockResolvedValueOnce({ ok: true, value: { connection: { id: 'connection-1' } } })
            .mockResolvedValueOnce({ ok: true, value: { url: 'https://workos.example/portal' } });
        openExternalUrlMock.mockResolvedValueOnce(false);
        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId="home-1" teamId="team-1" />);

        await screen.pressByTestIdAsync('team-directory-source-add');
        await vi.waitFor(() => expect(screen.findByTestId('team-directory-setup-workos')).not.toBeNull());
        await screen.pressByTestIdAsync('team-directory-setup-workos');

        const setupGroup = screen.root.findAllByType('ItemGroup')
            .find((group) => group.props.title === 'teams.authentication.directory.setup.options');
        expect(setupGroup?.props.description).toBe('identityAdministration.errorInvalid');
        expect(setupGroup?.props.description).not.toBe('workos_portal_open_failed');
    });

    it('continues approved WorkOS connection and portal Actions through the same setup flow', async () => {
        executeDirectoryMock.mockResolvedValueOnce({
            ok: true,
            value: { v: 1, items: [], nextCursor: null, complete: true },
        });
        let finishConnection: ((value: Readonly<{ connection: Readonly<{ id: string }> }>) => void | Promise<void>) | undefined;
        let finishPortal: ((value: Readonly<{ url: string }>) => void | Promise<void>) | undefined;
        executeIdentityMock
            .mockImplementationOnce(async (
                _actionId: string,
                _input: unknown,
                options?: Readonly<{ onApprovalSucceeded?: typeof finishConnection }>,
            ) => {
                finishConnection = options?.onApprovalSucceeded;
                return {
                    ok: false,
                    approvalPending: true,
                    artifactId: 'approval-workos-create',
                    failure: { code: 'approval_pending', retryable: false },
                };
            })
            .mockImplementationOnce(async (
                _actionId: string,
                _input: unknown,
                options?: Readonly<{ onApprovalSucceeded?: typeof finishPortal }>,
            ) => {
                finishPortal = options?.onApprovalSucceeded;
                return {
                    ok: false,
                    approvalPending: true,
                    artifactId: 'approval-workos-portal',
                    failure: { code: 'approval_pending', retryable: false },
                };
            });
        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId="home-1" teamId="team-1" />);
        await screen.pressByTestIdAsync('team-directory-source-add');
        await vi.waitFor(() => expect(screen.findByTestId('team-directory-setup-workos')).not.toBeNull());

        await screen.pressByTestIdAsync('team-directory-setup-workos');
        expect(finishConnection).toBeTypeOf('function');
        await act(async () => {
            await finishConnection?.({ connection: { id: 'connection-approved' } });
        });
        expect(executeIdentityMock).toHaveBeenNthCalledWith(
            2,
            'teams.identity.workos.adminPortalLink.create',
            expect.objectContaining({ connectionId: 'connection-approved', intent: 'dsync' }),
            expect.any(Object),
        );
        expect(finishPortal).toBeTypeOf('function');
        expect(openExternalUrlMock).not.toHaveBeenCalled();

        await act(async () => {
            await finishPortal?.({ url: 'https://workos.example/approved' });
        });
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://workos.example/approved');
    });

    it('blocks source setup while the authoritative directory projection refreshes', async () => {
        directoryStateMock.current.refreshing = true;
        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId="home-1" teamId="team-1" />);

        expect(screen.findByTestId('team-directory-source-add')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('team-directory-source-add');
        expect(executeDirectoryMock).not.toHaveBeenCalled();
    });
});
