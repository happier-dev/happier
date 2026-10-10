import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const executeMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn());
const providerStateMock = vi.hoisted(() => ({ refreshing: false, stale: false }));
const providerSecretHealthMock = vi.hoisted(() => ({ value: 'configured' as 'configured' | 'missing' | 'unreadable' }));
const providerKindMock = vi.hoisted(() => ({ value: 'oidc' as 'oidc' | 'github_app_identity' }));
const requestApprovalMock = vi.hoisted(() => vi.fn());
const setClipboardMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: setClipboardMock }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { replace: replaceMock } }).module;
});
// Rows render their right-hand control, as the real row does; page fields are text inputs.
vi.mock('@/components/ui/lists/Item', async () => {
    const React = await import('react');
    return { Item: (props: { rightElement?: unknown }) => React.createElement('Item', props, props.rightElement as never) };
});
vi.mock('@/components/ui/forms/FieldTextInput', () => ({ FieldTextInput: 'TextInput' }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivitySpinner' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
vi.mock('@/modal', () => ({
    Modal: {
        confirm: vi.fn(async () => true),
        alertAsync: vi.fn(async () => {}),
    },
}));
vi.mock('./useManagedIdentityProviders', () => ({
    useManagedIdentityProviderClient: () => ({ execute: executeMock }),
    useManagedIdentityProviders: () => ({
        state: {
            kind: 'ready',
            refreshing: providerStateMock.refreshing,
            stale: providerStateMock.stale,
            items: [providerKindMock.value === 'oidc' ? {
                v: 1,
                owner: { kind: 'home' },
                id: 'provider-1',
                kind: 'oidc',
                displayName: 'Acme OIDC',
                enabled: true,
                firstEnabledAt: 1,
                securityRevision: 1,
                revision: 1,
                config: { issuer: 'https://issuer.example.test', clientId: 'client' },
                callbackUrl: 'https://home.example.test/v1/oauth/provider-1/callback',
                secret: {
                    configured: providerSecretHealthMock.value === 'configured',
                    health: providerSecretHealthMock.value,
                },
                lastSuccessfulTest: { at: 1, testedSecurityRevision: 1, current: true },
                createdByAccountId: null,
                createdAt: 1,
                updatedAt: 1,
                teamConsumers: [{
                    team: { id: 'team-1', name: 'Acme' },
                    binding: { kind: 'identity_connection', id: 'connection-1', enabled: true },
                }],
            } : {
                v: 1,
                owner: { kind: 'home' },
                id: 'provider-1',
                kind: 'github_app_identity',
                displayName: 'Acme GitHub',
                enabled: false,
                firstEnabledAt: null,
                securityRevision: 1,
                revision: 1,
                config: { v: 1, kind: 'github_app_identity' },
                callbackUrl: 'https://home.example.test/v1/oauth/github-app/callback',
                githubAppInstallationId: 'installation-1',
                lastSuccessfulTest: null,
                createdByAccountId: null,
                createdAt: 1,
                updatedAt: 1,
                teamConsumers: [{
                    team: { id: 'team-1', name: 'Acme' },
                    binding: { kind: 'identity_connection', id: 'connection-1', enabled: false },
                }],
            }],
        },
        refresh: refreshMock,
    }),
}));
vi.mock('../governance/HomeAdministrationSection', () => ({
    HomeAdministrationSection: (props: Readonly<{ children: (context: unknown) => React.ReactNode }>) =>
        props.children({
            scope: { serverId: 'home-1', accountId: 'account-1' },
            mutationsAvailable: true,
            projection: { capabilities: { manageAuthentication: true } },
            requestApproval: requestApprovalMock,
        }),
}));

import {
    recordIdentityProviderTestReturn,
    resetPendingIdentityProviderTestsForTests,
} from './identityProviderTestReturn';
import { ManagedIdentityProviderDetailScreen } from './ManagedIdentityProviderDetailScreen';
import { managedIdentityProviderSignInStatus } from './ManagedIdentityProvidersSection';

beforeEach(() => {
    standardCleanup();
    resetPendingIdentityProviderTestsForTests();
    executeMock.mockReset();
    refreshMock.mockReset();
    replaceMock.mockReset();
    openExternalUrlMock.mockReset();
    requestApprovalMock.mockReset();
    providerStateMock.refreshing = false;
    providerStateMock.stale = false;
    providerSecretHealthMock.value = 'configured';
    providerKindMock.value = 'oidc';
});

describe('ManagedIdentityProviderDetailScreen diagnostics', () => {
    it('surfaces the derived callback URL as a copyable read-only row', async () => {
        const screen = await renderScreen(
            <ManagedIdentityProviderDetailScreen serverId="home-1" providerId="provider-1" />,
        );
        const row = screen.findByTestId('identity-provider-callback-url');
        expect(row?.props.subtitle).toBe('https://home.example.test/v1/oauth/provider-1/callback');

        await screen.pressByTestIdAsync('identity-provider-callback-url');

        expect(setClipboardMock).toHaveBeenCalledWith('https://home.example.test/v1/oauth/provider-1/callback');
        expect(executeMock).not.toHaveBeenCalled();
    });

    it('presents an enabled installation-backed GitHub identity consumer as active without an OIDC test', () => {
        expect(managedIdentityProviderSignInStatus({
            v: 1,
            owner: { kind: 'home' },
            id: 'provider-1',
            kind: 'github_app_identity',
            displayName: 'Acme GitHub',
            enabled: true,
            firstEnabledAt: 1,
            securityRevision: 1,
            revision: 2,
            config: { v: 1, kind: 'github_app_identity' },
            githubAppInstallationId: 'installation-1',
            teamConsumers: [],
            lastSuccessfulTest: null,
            createdByAccountId: null,
            createdAt: 1,
            updatedAt: 2,
        })).toBe('active');
    });

    it('administers an installation-backed GitHub identity consumer without OIDC-only controls', async () => {
        providerKindMock.value = 'github_app_identity';
        executeMock.mockResolvedValueOnce({ kind: 'succeeded', value: {} });
        const screen = await renderScreen(
            <ManagedIdentityProviderDetailScreen serverId="home-1" providerId="provider-1" />,
        );

        expect(screen.findByTestId('identity-provider-edit')).toBeNull();
        expect(screen.findAllByProps({ title: 'identityAdministration.issuer' })).toHaveLength(0);
        expect(screen.findAllByProps({ title: 'identityAdministration.clientSecret' })).toHaveLength(0);
        expect(screen.findByTestId('identity-provider-test')).toBeNull();
        expect(screen.findByTestId('identity-provider-team-consumer:connection-1')?.props.title).toBe('Acme');
        expect(screen.findByTestId('identity-provider-team-consumer:connection-1')?.props.subtitle)
            .toBe('identityAdministration.githubFacetSignIn');

        await screen.pressByTestIdAsync('identity-provider-enable');
        expect(executeMock).toHaveBeenCalledWith('identity.providers.enable', {
            owner: { kind: 'home' },
            id: 'provider-1',
            expectedRevision: 1,
            expectedSecurityRevision: 1,
        }, expect.anything());
        expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it('shows unreadable secret material as repair-required while keeping the edit recovery available', async () => {
        providerSecretHealthMock.value = 'unreadable';
        const screen = await renderScreen(
            <ManagedIdentityProviderDetailScreen serverId="home-1" providerId="provider-1" />,
        );

        expect(screen.findByProps({ title: 'identityAdministration.clientSecret' }).props.detail)
            .toBe('identityAdministration.secretNeedsAttention');
        expect(screen.findByTestId('identity-provider-secret-repair')?.props.detail)
            .toBe('identityAdministration.secretRepair');
        expect(screen.findByTestId('identity-provider-edit')?.props.disabled).toBe(false);
    });

    it('withdraws mutation controls while the retained provider projection is stale', async () => {
        providerStateMock.stale = true;
        const screen = await renderScreen(
            <ManagedIdentityProviderDetailScreen serverId="home-1" providerId="provider-1" />,
        );

        for (const testID of [
            'identity-provider-test',
            'identity-provider-edit',
            'identity-provider-disable',
            'identity-provider-remove',
        ]) {
            expect(screen.findByTestId(testID)?.props.disabled).toBe(true);
        }
    });

    it('shows the diagnostics the OAuth return handed back for this exact provider', async () => {
        recordIdentityProviderTestReturn({
            kind: 'home', serverId: 'home-1', accountId: 'account-1',
            providerId: 'provider-1', attemptId: 'attempt-1',
            returnTo: '/settings/home/home-1/sign-in-providers/identity/provider-1',
        }, { kind: 'completed', diagnostics: {
            subjectPresent: true,
            loginAvailable: false,
            emailAvailable: true,
            emailVerified: true,
            groups: { state: 'incomplete', count: null },
            eligibility: { status: 'eligible', rules: [] },
            mappedGroups: [],
        } });

        const screen = await renderScreen(
            <ManagedIdentityProviderDetailScreen serverId="home-1" providerId="provider-1" />,
        );

        await vi.waitFor(() => expect(
            screen.findByTestId('identity-test-diagnostics:groups'),
        ).not.toBeNull());
        // A provider-scope test owns no Group mappings, so it must not present a mapping verdict.
        expect(screen.findByTestId('identity-test-diagnostics:mappedGroups')).toBeNull();
    });

    it('shows nothing when another provider owns the returned result', async () => {
        recordIdentityProviderTestReturn({
            kind: 'home', serverId: 'home-1', accountId: 'account-1',
            providerId: 'provider-2', attemptId: 'attempt-2',
            returnTo: '/settings/home/home-1/sign-in-providers/identity/provider-2',
        }, { kind: 'completed', diagnostics: {
            subjectPresent: true,
            loginAvailable: true,
            emailAvailable: true,
            emailVerified: true,
            groups: { state: 'complete', count: 1 },
            eligibility: { status: 'eligible', rules: [] },
            mappedGroups: [],
        } });

        const screen = await renderScreen(
            <ManagedIdentityProviderDetailScreen serverId="home-1" providerId="provider-1" />,
        );

        expect(screen.findByTestId('identity-test-diagnostics:groups')).toBeNull();
    });

    it('registers an OAuth-return approval with the destination Home shell', async () => {
        recordIdentityProviderTestReturn({
            kind: 'home', serverId: 'home-1', accountId: 'account-1',
            providerId: 'provider-1', attemptId: 'attempt-1',
            returnTo: '/settings/home/home-1/sign-in-providers/identity/provider-1',
        }, {
            kind: 'approval_pending',
            artifactId: 'approval-consume-1',
            actionId: 'identity.providers.test.consume',
            scope: { serverId: 'home-1', accountId: 'account-1' },
        });

        const screen = await renderScreen(
            <ManagedIdentityProviderDetailScreen serverId="home-1" providerId="provider-1" />,
        );

        await vi.waitFor(() => expect(requestApprovalMock).toHaveBeenCalledOnce());
        expect(requestApprovalMock.mock.calls[0]?.[0]).toMatchObject({
            artifactId: 'approval-consume-1',
            onExecuted: expect.any(Function),
        });
        expect(screen.findByTestId('identity-provider-notice')).toBeNull();
    });

    it('continues an approved provider test through the same OAuth-opening path', async () => {
        const approval = { artifactId: 'approval-1', onExecuted: vi.fn() };
        let completeApprovedTest: ((value: Readonly<{ attemptId: string; authorizeUrl: string }>) => void | Promise<void>) | undefined;
        executeMock.mockImplementationOnce(async (_actionId, _input, options) => {
            completeApprovedTest = options.onApprovalSucceeded;
            return { kind: 'approval_pending', artifactId: 'approval-1', approval };
        });
        const screen = await renderScreen(
            <ManagedIdentityProviderDetailScreen serverId="home-1" providerId="provider-1" />,
        );

        await screen.pressByTestIdAsync('identity-provider-test');

        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(requestApprovalMock).toHaveBeenCalledWith(approval);
        expect(screen.findByTestId('identity-provider-notice')).toBeNull();
        expect(screen.findByTestId('identity-provider-test')?.props.loading).toBe(false);

        openExternalUrlMock.mockResolvedValueOnce(true);
        await completeApprovedTest?.({ attemptId: 'attempt-1', authorizeUrl: 'https://id.example/authorize' });

        expect(openExternalUrlMock).toHaveBeenCalledOnce();
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://id.example/authorize');
        // The OAuth return lands on this provider's page under Sign-in providers.
        const { consumePendingIdentityProviderTest } = await import('./identityProviderTestReturn');
        expect(consumePendingIdentityProviderTest('provider-1')?.returnTo)
            .toBe('/settings/home/home-1/sign-in-providers/identity/provider-1');
    });

    it('refreshes only after a pending lifecycle mutation is approved', async () => {
        const approval = { artifactId: 'approval-1', onExecuted: vi.fn() };
        let completeApprovedLifecycle: (() => void | Promise<void>) | undefined;
        executeMock.mockImplementationOnce(async (_actionId, _input, options) => {
            completeApprovedLifecycle = options.onApprovalSucceeded;
            return { kind: 'approval_pending', artifactId: 'approval-1', approval };
        });
        const screen = await renderScreen(
            <ManagedIdentityProviderDetailScreen serverId="home-1" providerId="provider-1" />,
        );

        await screen.pressByTestIdAsync('identity-provider-disable');

        expect(refreshMock).not.toHaveBeenCalled();
        expect(replaceMock).not.toHaveBeenCalled();
        expect(requestApprovalMock).toHaveBeenCalledWith(approval);
        expect(screen.findByTestId('identity-provider-notice')).toBeNull();
        expect(screen.findByTestId('identity-provider-disable')?.props.disabled).toBe(false);

        await completeApprovedLifecycle?.();
        expect(refreshMock).toHaveBeenCalledOnce();
    });

    it('navigates only after a confirmed removal is approved', async () => {
        const approval = { artifactId: 'approval-1', onExecuted: vi.fn() };
        let completeApprovedRemoval: (() => void | Promise<void>) | undefined;
        executeMock
            .mockResolvedValueOnce({
                kind: 'succeeded',
                value: {
                    provider: { id: 'provider-1', revision: 1 },
                    canRemove: true,
                    blockers: { identityCount: 0, connectionCount: 0, affectedAccountIds: [] },
                },
            })
            .mockImplementationOnce(async (_actionId, _input, options) => {
                completeApprovedRemoval = options.onApprovalSucceeded;
                return { kind: 'approval_pending', artifactId: 'approval-1', approval };
            });
        const screen = await renderScreen(
            <ManagedIdentityProviderDetailScreen serverId="home-1" providerId="provider-1" />,
        );

        await screen.pressByTestIdAsync('identity-provider-remove');

        expect(replaceMock).not.toHaveBeenCalled();
        expect(requestApprovalMock).toHaveBeenCalledWith(approval);
        expect(screen.findByTestId('identity-provider-notice')).toBeNull();
        expect(screen.findByTestId('identity-provider-remove')?.props.disabled).toBe(false);

        await completeApprovedRemoval?.();
        expect(replaceMock).toHaveBeenCalledWith('/settings/home/home-1/sign-in-providers');
    });
});
