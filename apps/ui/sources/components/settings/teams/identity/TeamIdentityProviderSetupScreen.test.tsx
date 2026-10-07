import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const providerExecuteMock = vi.hoisted(() => vi.fn());
const identityExecuteMock = vi.hoisted(() => vi.fn());
const routerReplaceMock = vi.hoisted(() => vi.fn());
const canMutateMock = vi.hoisted(() => ({ current: true }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { replace: routerReplaceMock } }).module;
});
vi.mock('@/components/ui/forms/FieldItem', () => ({ FieldItem: 'FieldItem' }));
// Rows render their right-hand control, as the real row does; page fields are text inputs.
vi.mock('@/components/ui/lists/Item', async () => {
    const React = await import('react');
    return { Item: (props: { rightElement?: unknown }) => React.createElement('Item', props, props.rightElement as never) };
});
vi.mock('@/components/ui/forms/FieldTextInput', () => ({ FieldTextInput: 'TextInput' }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text', TextInput: 'TextInput' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
// The generated bundled-plugin inventory is an unrelated build boundary and
// is intentionally absent from synchronized source-only test targets.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [],
}));
vi.mock('@/sync/domains/plugins/availability/bundledAppExactArtifactSource', () => ({
    createBundledPluginUiAppExactArtifactSource: () => Object.freeze({
        kind: 'appExact' as const,
        fetch: async () => null,
    }),
    createBundledPluginUiAppExactArtifactSourceFromInventory: () => Object.freeze({
        kind: 'appExact' as const,
        fetch: async () => null,
    }),
}));
vi.mock('@/sync/domains/plugins/availability/reader', () => ({
    createPluginAccountAvailabilityReader: vi.fn(),
    createPluginAccountAvailabilityReaderStore: () => Object.freeze({
        replace: () => null,
        clear: () => null,
        subscribe: () => () => undefined,
        bind: vi.fn(),
    }),
    projectPluginAccountAvailabilityMaterializationIdentity: vi.fn(),
}));
vi.mock('@/components/settings/home/identity/managedIdentityProviderClient', () => ({
    createManagedIdentityProviderClient: () => ({ execute: providerExecuteMock }),
}));
vi.mock('@/components/settings/home/githubApps/managedGitHubAppsClient', () => ({
    createManagedGitHubAppsClient: () => ({ execute: vi.fn() }),
}));
vi.mock('./identityAdministrationClient', () => ({
    createIdentityAdministrationClient: () => ({ execute: identityExecuteMock }),
}));
vi.mock('../TeamSection', () => ({
    TeamSection: (props: Readonly<{ serverId: string; teamId: string; children: (context: unknown) => React.ReactNode }>) => props.children({
        team: { capabilities: { manageAuthentication: true } },
        scope: { serverId: props.serverId, accountId: 'account-1' },
        address: { serverId: props.serverId, teamId: props.teamId },
        canMutate: canMutateMock.current,
    }),
}));

import { TeamIdentityProviderSetupScreen } from './TeamIdentityProviderSetupScreen';

beforeEach(() => {
    standardCleanup();
    providerExecuteMock.mockReset();
    identityExecuteMock.mockReset();
    routerReplaceMock.mockReset();
    canMutateMock.current = true;
});

describe('TeamIdentityProviderSetupScreen', () => {
    const provider = (revision = 4) => ({
        v: 1 as const,
        owner: { kind: 'team' as const, teamId: 'team-1' },
        id: 'provider-1',
        kind: 'oidc' as const,
        displayName: 'Corporate OIDC',
        enabled: false,
        firstEnabledAt: null,
        securityRevision: 1,
        revision,
        config: {
            v: 1 as const,
            kind: 'oidc' as const,
            issuer: 'https://id.example',
            clientId: 'client-1',
            clientAuthenticationMethod: 'client_secret_post' as const,
            scopes: 'openid profile email',
            httpTimeoutSeconds: 15,
            claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: true,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
        },
        secret: { configured: true, health: 'configured' },
        lastSuccessfulTest: null,
        createdByAccountId: 'account-1',
        createdAt: 1,
        updatedAt: 1,
    });

    async function fillOidc(screen: Awaited<ReturnType<typeof renderScreen>>) {
        await act(async () => {
            screen.changeTextByTestId('team-oidc-name', 'Corporate OIDC');
            screen.changeTextByTestId('team-oidc-issuer', 'https://id.example');
            screen.changeTextByTestId('team-oidc-client-id', 'client-1');
            screen.changeTextByTestId('team-oidc-client-secret', 'secret-1');
        });
    }

    it('keeps Team-owned provider fields read-only when Team mutations are unavailable', async () => {
        canMutateMock.current = false;
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen
            serverId="home-1" teamId="team-1" providerKind="oidc"
        />);

        expect(screen.findByTestId('team-oidc-name')?.props.editable).toBe(false);
        expect(screen.findByTestId('team-oidc-allowed-users')?.props.editable).toBe(false);
        expect(screen.findByTestId('team-oidc-create')?.props.disabled).toBe(true);
    });

    it('does not carry a provider draft across an exact Team route change', async () => {
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen
            serverId="home-1" teamId="team-1" providerKind="oidc"
        />);
        await fillOidc(screen);

        await screen.update(<TeamIdentityProviderSetupScreen
            serverId="home-2" teamId="team-2" providerKind="oidc"
        />);

        expect(screen.findByTestId('team-oidc-name')?.props.value).toBe('');
        expect(screen.findByTestId('team-oidc-client-secret')?.props.value).toBe('');
    });

    it('labels Team-specific restriction fields for screen readers', async () => {
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen
            serverId="home-1" teamId="team-1" providerKind="oidc"
        />);

        expect(screen.findByTestId('team-oidc-allowed-users')?.props.accessibilityLabel)
            .toBe('teams.authentication.detail.allowedUsers');
        expect(screen.findByTestId('team-oidc-allowed-domains')?.props.accessibilityLabel)
            .toBe('teams.authentication.detail.allowedDomains');
        expect(screen.findByTestId('team-oidc-groups-any')?.props.accessibilityLabel)
            .toBe('identityAdministration.groupsAny');
        expect(screen.findByTestId('team-oidc-groups-all')?.props.accessibilityLabel)
            .toBe('identityAdministration.groupsAll');
    });

    it('creates the Team-owned OIDC provider and attaches that exact provider to the Team', async () => {
        providerExecuteMock.mockResolvedValue({ kind: 'succeeded', value: provider() });
        identityExecuteMock.mockResolvedValue({ ok: true, value: { connection: { id: 'connection-1' } } });
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen
            serverId="home-1" teamId="team-1" providerKind="oidc"
        />);

        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        await vi.waitFor(() => expect(identityExecuteMock).toHaveBeenCalledOnce());

        expect(providerExecuteMock).toHaveBeenCalledWith('identity.providers.create', expect.objectContaining({
            owner: { kind: 'team', teamId: 'team-1' },
        }), expect.any(Object));
        expect(identityExecuteMock).toHaveBeenCalledWith('teams.identity.connections.create', expect.objectContaining({
            teamId: 'team-1', providerInstanceId: 'provider-1',
        }), expect.any(Object));
        expect(routerReplaceMock).toHaveBeenCalledWith('/settings/teams/home-1/team-1/authentication/connection-1');
    });

    it('finishes Team attachment when the approved connection Action returns its result', async () => {
        providerExecuteMock.mockResolvedValue({ kind: 'succeeded', value: provider() });
        let complete: ((value: Readonly<{ connection: Readonly<{ id: string }> }>) => void | Promise<void>) | undefined;
        identityExecuteMock.mockImplementationOnce(async (
            _actionId: string,
            _input: unknown,
            options?: Readonly<{ onApprovalSucceeded?: typeof complete }>,
        ) => {
            complete = options?.onApprovalSucceeded;
            return {
                ok: false,
                approvalPending: true,
                artifactId: 'approval-attach-1',
                failure: { code: 'approval_pending', retryable: false },
            };
        });
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen
            serverId="home-1" teamId="team-1" providerKind="oidc"
        />);

        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(routerReplaceMock).not.toHaveBeenCalled();
        expect(complete).toBeTypeOf('function');
        expect(screen.tree.root.findAllByType('ItemGroup').map((group) => group.props.description))
            .not.toContain('identityAdministration.error');

        await act(async () => complete?.({ connection: { id: 'connection-approved' } }));
        expect(routerReplaceMock).toHaveBeenCalledWith(
            '/settings/teams/home-1/team-1/authentication/connection-approved',
        );
        expect(routerReplaceMock).toHaveBeenCalledTimes(1);
    });

    it('makes Team attachment retryable when the connection approval is rejected', async () => {
        providerExecuteMock.mockResolvedValue({ kind: 'succeeded', value: provider() });
        let fail: ((code: string) => void) | undefined;
        identityExecuteMock.mockImplementationOnce(async (
            _actionId: string,
            _input: unknown,
            options?: Readonly<{ onApprovalFailed?: typeof fail }>,
        ) => {
            fail = options?.onApprovalFailed;
            return {
                ok: false,
                approvalPending: true,
                artifactId: 'approval-attach-rejected',
                failure: { code: 'approval_pending', retryable: false },
            };
        });
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen
            serverId="home-1" teamId="team-1" providerKind="oidc"
        />);

        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(fail).toBeTypeOf('function');
        await act(async () => fail?.('approval_rejected'));

        expect(screen.findByTestId('team-oidc-create')?.props.disabled).toBe(false);
        expect(screen.tree.root.findAllByType('ItemGroup').map((group) => group.props.description))
            .toContain('identityAdministration.error');
        expect(routerReplaceMock).not.toHaveBeenCalled();
    });

    it('starts Team attachment once when the deferred provider Action returns its result', async () => {
        let completeProvider: ((value: ReturnType<typeof provider>) => void | Promise<void>) | undefined;
        providerExecuteMock.mockImplementationOnce(async (
            _actionId: string,
            _input: unknown,
            options?: Readonly<{ onApprovalSucceeded?: typeof completeProvider }>,
        ) => {
            completeProvider = options?.onApprovalSucceeded;
            return {
                kind: 'approval_pending',
                artifactId: 'approval-provider-1',
                approval: 'approval-provider-1',
            };
        });
        identityExecuteMock.mockResolvedValue({ ok: true, value: { connection: { id: 'connection-1' } } });
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen
            serverId="home-1" teamId="team-1" providerKind="oidc"
        />);

        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(identityExecuteMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('team-oidc-create')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(providerExecuteMock).toHaveBeenCalledOnce();

        await act(async () => {
            await completeProvider?.(provider());
        });
        await vi.waitFor(() => expect(identityExecuteMock).toHaveBeenCalledOnce());
        expect(routerReplaceMock).toHaveBeenCalledWith(
            '/settings/teams/home-1/team-1/authentication/connection-1',
        );
        expect(routerReplaceMock).toHaveBeenCalledTimes(1);
    });

    it('settles provider then connection approval phases without replaying either phase', async () => {
        let completeProvider: ((value: ReturnType<typeof provider>) => void | Promise<void>) | undefined;
        let completeConnection: ((value: Readonly<{ connection: Readonly<{ id: string }> }>) => void | Promise<void>) | undefined;
        providerExecuteMock.mockImplementationOnce(async (
            _actionId: string,
            _input: unknown,
            options?: Readonly<{ onApprovalSucceeded?: typeof completeProvider }>,
        ) => {
            completeProvider = options?.onApprovalSucceeded;
            return { kind: 'approval_pending', artifactId: 'approval-provider-1', approval: 'approval-provider-1' };
        });
        identityExecuteMock.mockImplementationOnce(async (
            _actionId: string,
            _input: unknown,
            options?: Readonly<{ onApprovalSucceeded?: typeof completeConnection }>,
        ) => {
            completeConnection = options?.onApprovalSucceeded;
            return {
                ok: false,
                approvalPending: true,
                artifactId: 'approval-connection-1',
                failure: { code: 'approval_pending', retryable: false },
            };
        });
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen
            serverId="home-1" teamId="team-1" providerKind="oidc"
        />);

        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        await act(async () => {
            await completeProvider?.(provider());
        });
        await vi.waitFor(() => expect(identityExecuteMock).toHaveBeenCalledOnce());
        expect(routerReplaceMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('team-oidc-create')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(providerExecuteMock).toHaveBeenCalledOnce();
        expect(identityExecuteMock).toHaveBeenCalledOnce();

        await act(async () => {
            await completeConnection?.({ connection: { id: 'connection-approved' } });
        });
        expect(providerExecuteMock).toHaveBeenCalledOnce();
        expect(identityExecuteMock).toHaveBeenCalledOnce();
        expect(routerReplaceMock).toHaveBeenCalledWith(
            '/settings/teams/home-1/team-1/authentication/connection-approved',
        );
        expect(routerReplaceMock).toHaveBeenCalledTimes(1);
    });

    it('reuses a created provider when attaching the connection is retried', async () => {
        providerExecuteMock.mockResolvedValue({ kind: 'succeeded', value: provider() });
        identityExecuteMock
            .mockResolvedValueOnce({ ok: false, failure: { code: 'home_unreachable' } })
            .mockResolvedValueOnce({ ok: true, value: { connection: { id: 'connection-1' } } });
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen
            serverId="home-1" teamId="team-1" providerKind="oidc"
        />);
        await fillOidc(screen);

        await screen.pressByTestIdAsync('team-oidc-create');
        await screen.pressByTestIdAsync('team-oidc-create');

        expect(providerExecuteMock).toHaveBeenCalledOnce();
        expect(identityExecuteMock).toHaveBeenCalledTimes(2);
    });

    it('keeps a created provider retryable when attaching the connection throws', async () => {
        providerExecuteMock.mockResolvedValue({ kind: 'succeeded', value: provider() });
        identityExecuteMock
            .mockRejectedValueOnce(new Error('transport closed'))
            .mockResolvedValueOnce({ ok: true, value: { connection: { id: 'connection-1' } } });
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen
            serverId="home-1" teamId="team-1" providerKind="oidc"
        />);
        await fillOidc(screen);

        await screen.pressByTestIdAsync('team-oidc-create');
        await vi.waitFor(() => expect(identityExecuteMock).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(screen.findByTestId('team-oidc-create')?.props.disabled).toBe(false));

        await screen.pressByTestIdAsync('team-oidc-create');

        expect(providerExecuteMock).toHaveBeenCalledOnce();
        expect(identityExecuteMock).toHaveBeenCalledTimes(2);
        expect(routerReplaceMock).toHaveBeenCalledWith('/settings/teams/home-1/team-1/authentication/connection-1');
    });

    it('uses the shared editor test action for a saved provider awaiting Team attachment', async () => {
        providerExecuteMock
            .mockResolvedValueOnce({ kind: 'succeeded', value: provider() })
            .mockResolvedValueOnce({ kind: 'succeeded', value: provider(5) });
        identityExecuteMock.mockResolvedValue({ ok: false, failure: { code: 'home_unreachable' } });
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen
            serverId="home-1" teamId="team-1" providerKind="oidc"
        />);
        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        await vi.waitFor(() => expect(identityExecuteMock).toHaveBeenCalledOnce());

        await screen.pressByTestIdAsync('team-oidc-test');
        await vi.waitFor(() => expect(providerExecuteMock).toHaveBeenCalledTimes(2));
        expect(providerExecuteMock).toHaveBeenLastCalledWith('identity.providers.validate', expect.objectContaining({
            owner: { kind: 'team', teamId: 'team-1' },
            id: 'provider-1',
            expectedRevision: 4,
            expectedSecurityRevision: 1,
        }), expect.any(Object));
    });

    it('applies provider edits before retrying a failed Team attachment', async () => {
        providerExecuteMock
            .mockResolvedValueOnce({
                kind: 'succeeded',
                value: {
                    ...provider(4),
                    id: 'provider-1',
                    revision: 4,
                    displayName: 'Corporate OIDC',
                    config: {
                        v: 1,
                        kind: 'oidc',
                        issuer: 'https://id.example',
                        clientId: 'client-1',
                        clientAuthenticationMethod: 'client_secret_post',
                        scopes: 'openid profile email',
                        httpTimeoutSeconds: 15,
                        claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
                        allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                        fetchUserInfo: true,
                        storeRefreshToken: false,
                        ui: { buttonColor: null, iconHint: null },
                    },
                },
            })
            .mockResolvedValueOnce({
                kind: 'succeeded',
                value: {
                    ...provider(5),
                    id: 'provider-1',
                    revision: 5,
                    displayName: 'Corporate OIDC',
                    config: {
                        v: 1,
                        kind: 'oidc',
                        issuer: 'https://new-id.example',
                        clientId: 'client-2',
                        clientAuthenticationMethod: 'client_secret_post',
                        scopes: 'openid email',
                        httpTimeoutSeconds: 15,
                        claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
                        allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                        fetchUserInfo: true,
                        storeRefreshToken: false,
                        ui: { buttonColor: null, iconHint: null },
                    },
                },
            })
            .mockResolvedValueOnce({
                kind: 'succeeded',
                value: {
                    ...provider(6),
                    config: {
                        ...provider(6).config,
                        issuer: 'https://new-id.example',
                        clientId: 'client-2',
                        scopes: 'openid email',
                    },
                },
            });
        identityExecuteMock
            .mockResolvedValueOnce({ ok: false, failure: { code: 'home_unreachable' } })
            .mockResolvedValueOnce({ ok: true, value: { connection: { id: 'connection-1' } } });
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen
            serverId="home-1" teamId="team-1" providerKind="oidc"
        />);
        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(identityExecuteMock).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(screen.findByTestId('team-oidc-create')?.props.disabled).toBe(false));

        await act(async () => {
            screen.changeTextByTestId('team-oidc-issuer', 'https://new-id.example');
            screen.changeTextByTestId('team-oidc-client-id', 'client-2');
            screen.changeTextByTestId('team-oidc-client-secret', 'secret-2');
            screen.pressByTestId('team-oidc-advanced-toggle');
        });
        await act(async () => {
            screen.changeTextByTestId('team-oidc-scopes', 'openid email');
        });
        await screen.pressByTestIdAsync('team-oidc-create');
        await vi.waitFor(() => expect(providerExecuteMock).toHaveBeenCalledTimes(3));
        await vi.waitFor(() => expect(identityExecuteMock).toHaveBeenCalledTimes(2));

        expect(providerExecuteMock).toHaveBeenNthCalledWith(2, 'identity.providers.update', expect.objectContaining({
            owner: { kind: 'team', teamId: 'team-1' },
            id: 'provider-1',
            expectedRevision: 4,
            config: expect.objectContaining({
                issuer: 'https://new-id.example',
                clientId: 'client-2',
                scopes: 'openid email',
            }),
        }), expect.any(Object));
        expect(providerExecuteMock).toHaveBeenNthCalledWith(3, 'identity.providers.secret.replace', expect.objectContaining({
            id: 'provider-1',
            expectedRevision: 5,
            clientSecret: 'secret-2',
        }), expect.any(Object));
        expect(identityExecuteMock).toHaveBeenLastCalledWith('teams.identity.connections.create', expect.objectContaining({
            providerInstanceId: 'provider-1',
        }), expect.any(Object));
    });
});
