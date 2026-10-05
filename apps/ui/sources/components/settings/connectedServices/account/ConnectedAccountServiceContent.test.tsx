import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { ConnectedServiceAuthGroupPolicyV1Schema, type PluginConnectedAccountAuthenticationModeV2, type QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol';
import { ConnectedAccountServiceContent } from './ConnectedAccountServiceContent';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { UseQualifiedConnectedAccountGroupsResult } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountGroups';
import type { QualifiedConnectedAccountUiGroup } from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';

const boundary = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), confirm: vi.fn(async () => true) }));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// These account journeys do not render Markdown; fail if the unavailable third-party export is used.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in account detail'); },
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: boundary.push, replace: boundary.replace, canGoBack: () => false },
}).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { confirm: boundary.confirm },
}).module);
// These injected account journeys make no HTTP requests; fail if the transport is reached.
vi.mock('@/sync/http/client', () => ({
    serverFetch: () => { throw new Error('Unexpected HTTP request in injected account detail'); },
}));
// Session/Team envelope HTTP APIs are unrelated to this injected account journey.
// Throw if reached instead of replacing any encryption or Account-domain logic.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Unexpected Session envelope API in account detail'); };
    return {
        createSessionDataKeyEnvelopeClient: unused,
        readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused,
        prepareSessionDataKeyEnvelopesDetached: unused,
    };
});
vi.mock('@/sync/api/teams/membershipSessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Unexpected Team envelope API in account detail'); };
    return {
        createMembershipSessionDataKeyEnvelopeClient: unused,
        prepareMembershipHistoryEnvelopesForScope: unused,
        prepareMembershipHistoryEnvelopesDetached: unused,
        membershipHistoryPreparationScopeKey: unused,
    };
});

afterEach(standardCleanup);

function renderContent(element: React.ReactElement) {
    return renderScreen(element, {
        wrapper: ({ children }) => <InjectedAuthProvider credentials={null}>{children}</InjectedAuthProvider>,
    });
}

const service = { pluginId: 'acme.accounts', localId: 'gateway' };
const account = {
    ref: { service, accountId: 'work' }, status: 'connected', authenticationModeId: 'token',
    revisionSemantics: 'revisioned', credentialRevision: 'revision-1',
    configurationReady: false, configurationRevision: null, scopes: [],
} satisfies QualifiedConnectedAccountProfileV4;

function makeGroup(): QualifiedConnectedAccountUiGroup {
    return {
        ref: { service, groupId: 'team' }, displayName: 'Team', activeAccountId: 'work',
        policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}), state: {},
        revision: { protocol: 'v4', incarnation: 'group-team', generation: 1, runtimeStateRevision: 1 },
        members: ['work', 'other'].map((accountId, priority) => ({
            ref: { service, accountId }, priority, enabled: true, state: {},
        })),
    };
}

function makeGroups(overrides: Partial<UseQualifiedConnectedAccountGroupsResult> = {}): UseQualifiedConnectedAccountGroupsResult {
    return {
        status: 'loaded', source: { protocol: 'v4' }, groups: [makeGroup()], error: null, mutating: false,
        refresh: async () => {}, create: async () => null, patch: async () => null, delete: async () => false,
        addMember: async () => null, patchMember: async () => null, removeMember: async () => null,
        setActiveAccount: async () => null, ...overrides,
    };
}
const modes = [{
    id: 'token', kind: 'manual', title: 'Token', outcomeReconciliation: 'none',
    fields: [{ id: 'token', title: 'Token', schema: { type: 'string', minLength: 1 }, secret: true }],
    configuration: { scope: 'account', changeBehavior: 'refresh', fields: [
        { id: 'organization', title: 'Organization', schema: { type: 'string' }, secret: false },
    ] },
}, {
    id: 'enterprise', kind: 'manual', title: 'Enterprise', outcomeReconciliation: 'none',
    fields: [{ id: 'token', title: 'Token', schema: { type: 'string', minLength: 1 }, secret: true }],
    configuration: { scope: 'service', changeBehavior: 'refresh', fields: [
        { id: 'organization', title: 'Organization', schema: { type: 'string' }, secret: false },
    ] },
}] satisfies PluginConnectedAccountAuthenticationModeV2[];

describe('ConnectedAccountServiceContent focused ownership', () => {
    beforeEach(() => {
        boundary.push.mockClear();
        boundary.replace.mockClear();
        boundary.confirm.mockReset().mockResolvedValue(true);
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            features: {
                connectedServices: { enabled: true, accountGroups: { enabled: true }, accountFallback: { enabled: true } },
                sessions: { usageLimitRecovery: { enabled: true } },
            },
        }) } });
    });
    it('prefills rename only with a saved user name, never a provider identity fallback', async () => {
        const onRenameAccount = vi.fn();
        const identified = { ...account, providerIdentity: { accountId: 'provider-account-42' } };
        const screen = await renderContent(<ConnectedAccountServiceContent
            title="Acme" service={service} focus={{ kind: 'account', accountId: 'work' }}
            modes={modes} accounts={[identified]} busy={false} onRenameAccount={onRenameAccount}
        />);
        await screen.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        expect(screen.findHostByTestId('qualified-account-detail:rename:input')?.props.value).toBe('');

        const named = await renderContent(<ConnectedAccountServiceContent
            title="Acme" service={service} focus={{ kind: 'account', accountId: 'work' }}
            modes={modes} accounts={[identified]} busy={false} onRenameAccount={onRenameAccount}
            accountLabels={{ work: 'provider-account-42' }}
        />);
        await named.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        expect(named.findHostByTestId('qualified-account-detail:rename:input')?.props.value).toBe('provider-account-42');
        expect(onRenameAccount).not.toHaveBeenCalled();
    });

    it('keeps declared account and service configuration reachable from the Collection account detail', async () => {
        const onConfigureAccount = vi.fn();
        const onConfigureService = vi.fn();
        const screen = await renderContent(<ConnectedAccountServiceContent
            title="Acme" service={service} focus={{ kind: 'account', accountId: 'work' }}
            modes={modes} accounts={[account]} busy={false}
            onConfigureAccount={onConfigureAccount} onConfigureService={onConfigureService}
            serviceConfigurationStatusByModeId={{ enterprise: 'configurationRequired' }}
        />);
        await screen.pressByTestIdAsync('qualified-account-detail:configuration');
        expect(onConfigureAccount).toHaveBeenCalledWith(account.ref);
        await screen.pressByTestIdAsync('connected-service-configuration-settings:enterprise');
        expect(onConfigureService).toHaveBeenCalledWith('enterprise');
    });

    it('omits account configuration for an unfenced account', async () => {
        const onConfigureAccount = vi.fn();
        const screen = await renderContent(<ConnectedAccountServiceContent
            title="Acme" service={service} focus={{ kind: 'account', accountId: 'work' }}
            modes={modes} accounts={[{ ...account, revisionSemantics: 'legacy_unfenced', credentialRevision: null }]}
            busy onConfigureAccount={onConfigureAccount}
        />);
        expect(screen.findHostByTestId('qualified-account-detail:configuration')).toBeNull();
        expect(onConfigureAccount).not.toHaveBeenCalled();
    });

    it('reports a missing focused account instead of recreating the old per-service list', async () => {
        const screen = await renderContent(<ConnectedAccountServiceContent
            title="Acme" service={service} focus={{ kind: 'account', accountId: 'missing' }}
            modes={modes} accounts={[account]} busy={false}
        />);
        expect(screen.findHostByTestId('qualified-account-detail:missing')).toBeTruthy();
    });

    it('keeps a focused pool activation fenced behind the explicit cooldown override confirmation', async () => {
        const group = makeGroup();
        const cooldown = Object.assign(new Error('runtime cooldown'), { code: 'connect_group_profile_runtime_cooldown', resetAtMs: Date.now() + 10_000 });
        const setActiveAccount = vi.fn<UseQualifiedConnectedAccountGroupsResult['setActiveAccount']>()
            .mockRejectedValueOnce(cooldown).mockResolvedValueOnce(group);
        const screen = await renderContent(<ConnectedAccountServiceContent
            title="Acme" service={service} focus={{ kind: 'group', groupId: 'team' }}
            modes={modes} accounts={[account, { ...account, ref: { service, accountId: 'other' } }]}
            groups={makeGroups({ groups: [group], setActiveAccount })} busy={false}
        />);
        await screen.pressByTestIdAsync('connected-services-pool-detail:member:other:active-radio');
        await vi.waitFor(() => expect(setActiveAccount).toHaveBeenLastCalledWith({
            group, account: { service, accountId: 'other' }, overrideRuntimeCooldown: true,
        }));
        expect(boundary.confirm).toHaveBeenCalledOnce();
    });

    it('creates a pool from the real draft and threads the returned group through member writes', async () => {
        const created = { ...makeGroup(), activeAccountId: null, members: [] };
        const withMember = { ...created, members: makeGroup().members.slice(0, 1) };
        const create = vi.fn<UseQualifiedConnectedAccountGroupsResult['create']>().mockResolvedValue(created);
        const addMember = vi.fn<UseQualifiedConnectedAccountGroupsResult['addMember']>().mockResolvedValue(withMember);
        const screen = await renderContent(<ConnectedAccountServiceContent
            title="Acme" service={service} focus={{ kind: 'newPool' }} modes={modes} accounts={[account]}
            groups={makeGroups({ groups: [], create, addMember })} busy={false}
        />);
        await act(async () => screen.changeTextByTestId('connected-services-pool-draft:name:field', 'Team'));
        await screen.pressByTestIdAsync('connected-services-pool-draft:member:work');
        await screen.pressByTestIdAsync('connected-services-pool-draft:create');
        await vi.waitFor(() => expect(boundary.replace).toHaveBeenCalledWith(expect.objectContaining({
            params: expect.objectContaining({ groupId: 'team' }),
        })));
        expect(create).toHaveBeenCalledWith({ groupId: expect.any(String), displayName: 'Team' });
        expect(addMember).toHaveBeenCalledWith({ group: created, account: account.ref });
    });

    it('selects the exact deep-linked pool among other groups and leaves its deletion for the Collection', async () => {
        const group = makeGroup();
        const unrelated = { ...makeGroup(), ref: { service, groupId: 'unrelated' }, displayName: 'Unrelated pool' };
        const deleteGroup = vi.fn<UseQualifiedConnectedAccountGroupsResult['delete']>().mockResolvedValue(true);
        const screen = await renderContent(<ConnectedAccountServiceContent
            title="Acme" service={service} focus={{ kind: 'group', groupId: 'team' }}
            modes={modes} accounts={[account]} groups={makeGroups({ groups: [unrelated, group], delete: deleteGroup })} busy={false}
        />);
        await screen.pressByTestIdAsync('connected-services-pool-detail:delete');
        await vi.waitFor(() => expect(boundary.replace).toHaveBeenCalledWith({ pathname: '/(app)/settings/connected-services', params: {} }));
        expect(deleteGroup).toHaveBeenCalledWith(group);
    });

    it('fails pool creation closed when the server has not enabled account groups', async () => {
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
        const screen = await renderContent(<ConnectedAccountServiceContent
            title="Acme" service={service} focus={{ kind: 'newPool' }} modes={modes} accounts={[account]}
            groups={makeGroups()} busy={false}
        />);
        expect(screen.findHostByTestId('connected-services-pool-draft:unavailable')).toBeTruthy();
        expect(screen.findHostByTestId('connected-services-pool-draft:create')).toBeNull();
    });
});
