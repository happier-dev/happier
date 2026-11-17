import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserClipboardBoundary } from '@/dev/testkit';
import { ManagedIdentityProviderV1Schema, ManagedIdentityProvidersListResultV1Schema, ManagedIdentityProviderRemovePreflightResultV1Schema, ManagedIdentityProviderTestStartResultV1Schema } from '@happier-dev/protocol/identity/providers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { homeGovernanceProjectionFixture, managedIdentityProviderFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { act } from 'react-test-renderer';
import { findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const replaceMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn());
const setClipboardMock = vi.hoisted(() => vi.fn(async (_text: string) => true));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

vi.mock('expo-clipboard', () => ({ setStringAsync: setClipboardMock }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { replace: replaceMock } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
let serverId = '';
let providerKind: 'oidc' | 'github_app_identity' = 'oidc';
let secretHealth: 'configured' | 'missing' | 'unreadable' = 'configured';
const listPath = '/v1/identity/providers/list';
function provider() {
    const common = {
        revision: 1,
        createdByAccountId: null,
        teamConsumers: [{
            team: { id: 'team-1', name: 'Acme' },
            binding: { kind: 'identity_connection' as const, id: 'connection-1', enabled: providerKind === 'oidc' },
        }],
    };
    return providerKind === 'oidc'
        ? managedIdentityProviderFixture({
            ...common,
            displayName: 'Acme OIDC',
            enabled: true,
            firstEnabledAt: 1,
            callbackUrl: 'https://home.example.test/v1/oauth/provider-1/callback',
            secret: { configured: secretHealth === 'configured', health: secretHealth },
            lastSuccessfulTest: { at: 1, testedSecurityRevision: 1, current: true },
        })
        : managedIdentityProviderFixture({
            ...common,
            kind: 'github_app_identity',
            displayName: 'Acme GitHub',
            callbackUrl: 'https://home.example.test/v1/oauth/github-app/callback',
        });
}
function answerProviders() {
    harness.answer(serverId, listPath, { body: ManagedIdentityProvidersListResultV1Schema.parse({ items: [provider()], unreadableCount: 0 }) });
}
import {
    recordIdentityProviderTestReturn,
    resetPendingIdentityProviderTestsForTests,
} from './identityProviderTestReturn';
const { ManagedIdentityProviderDetailScreen } = await import('./ManagedIdentityProviderDetailScreen');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { Modal } = await import('@/modal');
const { managedIdentityProviderSignInStatus } = await import('./ManagedIdentityProvidersSection');

beforeEach(async () => {
    standardCleanup();
    resetPendingIdentityProviderTestsForTests();
    await harness.reset();
    serverId = await harness.addHome({ name: 'Identity Home', serverUrl: 'https://home.example.test', accountId: 'account-1' });
    harness.answer(serverId, '/v1/home/governance/get', { body: homeGovernanceProjectionFixture() });
    replaceMock.mockReset();
    openExternalUrlMock.mockReset();
    secretHealth = 'configured';
    providerKind = 'oidc';
    vi.mocked(Modal.confirm).mockClear();
    installBrowserClipboardBoundary(async text => { await setClipboardMock(text); });
});

async function renderProvider() {
    answerProviders();
    const screen = await renderScreen(<ManagedIdentityProviderDetailScreen serverId={serverId} providerId="provider-1" />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('identity-provider-callback-url')).not.toBeNull());
    return screen;
}

describe('ManagedIdentityProviderDetailScreen diagnostics', () => {
    it('surfaces the derived callback URL as a copyable read-only row', async () => {
        const screen = await renderProvider();
        const row = screen.findByTestId('identity-provider-callback-url');
        expect(findTestInstanceByTypeContainingText(row!, 'Text', 'https://home.example.test/v1/oauth/provider-1/callback')).toBeDefined();

        await screen.pressByTestIdAsync('identity-provider-callback-url');

        expect(setClipboardMock).toHaveBeenCalledWith('https://home.example.test/v1/oauth/provider-1/callback');
        expect(harness.requestsFor('/v1/identity/providers/update')).toHaveLength(0);
    });

    it('presents an enabled installation-backed GitHub identity consumer as active without an OIDC test', () => {
        expect(managedIdentityProviderSignInStatus(managedIdentityProviderFixture({
            kind: 'github_app_identity',
            displayName: 'Acme GitHub',
            enabled: true,
            firstEnabledAt: 1,
            revision: 2,
            updatedAt: 2,
        }))).toBe('active');
    });

    it('administers an installation-backed GitHub identity consumer without OIDC-only controls', async () => {
        providerKind = 'github_app_identity';
        harness.answer(serverId, '/v1/identity/providers/enable', { body: ManagedIdentityProviderV1Schema.parse({ ...provider(), enabled: true, firstEnabledAt: 1 }) });
        const screen = await renderProvider();

        expect(screen.findByTestId('identity-provider-edit')).toBeNull();
        expect(screen.findAllByProps({ title: 'identityAdministration.issuer' })).toHaveLength(0);
        expect(screen.findAllByProps({ title: 'identityAdministration.clientSecret' })).toHaveLength(0);
        expect(screen.findByTestId('identity-provider-test')).toBeNull();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('identity-provider-team-consumer:connection-1')!, 'Text', 'Acme')).toBeDefined();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('identity-provider-team-consumer:connection-1')!, 'Text', 'identityAdministration.githubFacetSignIn')).toBeDefined();

        await screen.pressByTestIdAsync('identity-provider-enable');
        expect(harness.requestsFor('/v1/identity/providers/enable')[0]?.input).toEqual({
            owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 1, expectedSecurityRevision: 1,
        });
        await waitForHomeGovernance(() => expect(harness.requestsFor(listPath)).toHaveLength(2));
    });

    it('shows unreadable secret material as repair-required while keeping the edit recovery available', async () => {
        secretHealth = 'unreadable';
        const screen = await renderProvider();

        expect(screen.findByProps({ title: 'identityAdministration.clientSecret' }).props.detail)
            .toBe('identityAdministration.secretNeedsAttention');
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('identity-provider-secret-repair')!, 'Text', 'identityAdministration.secretRepair')).toBeDefined();
        expect(Boolean(screen.findByTestId('identity-provider-edit')!.props.disabled)).toBe(false);
    });

    it('withdraws mutation controls while the retained provider projection is stale', async () => {
        const screen = await renderProvider();
        harness.answer(serverId, listPath, { status: 503, body: { error: 'unavailable' } });
        await act(async () => publishHomeAccountChange(serverId));
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-provider-test')?.props.disabled).toBe(true));

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
            kind: 'home', serverId, accountId: 'account-1',
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

        const screen = await renderProvider();

        await vi.waitFor(() => expect(
            screen.findByTestId('identity-test-diagnostics:groups'),
        ).not.toBeNull());
        // A provider-scope test owns no Group mappings, so it must not present a mapping verdict.
        expect(screen.findByTestId('identity-test-diagnostics:mappedGroups')).toBeNull();
    });

    it('shows nothing when another provider owns the returned result', async () => {
        recordIdentityProviderTestReturn({
            kind: 'home', serverId, accountId: 'account-1',
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

        const screen = await renderProvider();

        expect(screen.findByTestId('identity-test-diagnostics:groups')).toBeNull();
    });

    it('opens a provider test only after the native Ask confirmation succeeds', async () => {
        await harness.requireUiApproval(serverId, 'identity.providers.test.start');
        let confirm: ((value: boolean) => void) | undefined;
        vi.mocked(Modal.confirm).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
        harness.answer(serverId, '/v1/identity/providers/test/start', { body: ManagedIdentityProviderTestStartResultV1Schema.parse({ attemptId: 'attempt-1', authorizeUrl: 'https://id.example/authorize' }) });
        const screen = await renderProvider();
        openExternalUrlMock.mockResolvedValueOnce(true);
        const pressing = screen.pressByTestIdAsync('identity-provider-test');
        await waitForHomeGovernance(() => expect(confirm).toBeTypeOf('function'));
        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(harness.requestsFor('/v1/identity/providers/test/start')).toHaveLength(0);
        await act(async () => confirm!(true));
        await pressing;
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://id.example/authorize');
        expect(harness.artifacts(serverId).list()).toEqual([]);
        const { consumePendingIdentityProviderTest } = await import('./identityProviderTestReturn');
        expect(consumePendingIdentityProviderTest('provider-1')?.returnTo)
            .toBe(`/settings/home/${serverId}/sign-in-providers/identity/provider-1`);
    });

    it('refreshes a lifecycle change only after its native review is accepted', async () => {
        await harness.requireUiApproval(serverId, 'identity.providers.disable');
        let confirm: ((value: boolean) => void) | undefined;
        vi.mocked(Modal.confirm).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
        harness.answer(serverId, '/v1/identity/providers/disable', { body: ManagedIdentityProviderV1Schema.parse({ ...provider(), enabled: false }) });
        const screen = await renderProvider();
        const pressing = screen.pressByTestIdAsync('identity-provider-disable');
        await waitForHomeGovernance(() => expect(confirm).toBeTypeOf('function'));
        expect(harness.requestsFor(listPath)).toHaveLength(1);
        await act(async () => confirm!(true));
        await pressing;
        await waitForHomeGovernance(() => expect(harness.requestsFor(listPath)).toHaveLength(2));
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });

    it('navigates only after a confirmed removal succeeds through the real client', async () => {
        harness.answer(serverId, '/v1/identity/providers/remove/preflight', { body: ManagedIdentityProviderRemovePreflightResultV1Schema.parse({
            provider: provider(), canRemove: true,
            blockers: { identityCount: 0, connectionCount: 0, affectedAccountIds: [] },
        }) });
        harness.answer(serverId, '/v1/identity/providers/remove', { body: { outcome: 'removed' } });
        const screen = await renderProvider();
        await screen.pressByTestIdAsync('identity-provider-remove');
        expect(harness.requestsFor('/v1/identity/providers/remove')).toHaveLength(1);
        expect(replaceMock).toHaveBeenCalledWith(`/settings/home/${serverId}/sign-in-providers`);
    });
});
