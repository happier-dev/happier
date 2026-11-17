import { describe, expect, it } from 'vitest';
import type {
    PluginProjectedAgentConnectedAccountPurposeV2} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type {
    QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { Profile } from '@/sync/domains/profiles/profile';

import { projectMachineAgentConnectedServices } from './machineAgentConnectedServices';
import { projectMachineAgent, projectMachineAgentForCredential, resolveMachineAgentSignIn } from './machineAgentModel';
import { isMachineAgentReady } from './resolveMachineAgentState';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';

it('projects the selected Team delivery readiness instead of borrowing broker limits or native sign-in', () => {
    const service = { pluginId: 'acme.agent', localId: 'account' };
    const direct = { source: 'team_resource' as const, resourceId: 'resource', deliveryMode: 'direct' as const,
        disclosedMember: { service, accountId: 'shared-account' } };
    const brokered = { source: 'team_resource' as const, resourceId: 'resource', deliveryMode: 'brokered' as const };
    const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
        id: 'resource', teamId: 'team', displayName: { content: { t: 'plain', v: 'Shared account' }, recipientEnvelope: null }, resourceRevision: 1,
        readiness: { kind: 'limit_reached', metric: 'inference_requests', resetsAtUtc: '2026-11-18T00:00:00Z' },
        recoveryAction: null, mayBroker: true, mayReceiveDirect: true, directMaterialState: 'current', sessionUsePolicy: 'personal_allowed',
        providerModels: [], connectedServiceSelections: [direct, brokered], sourcePresentation: { kind: 'connected_service', service },
    });
    const signIn = (binding: typeof direct | typeof brokered, resources = [resource]) => resolveMachineAgentSignIn({
        native: { status: 'signedOut', loginSupport: 'login_terminal' },
        connectedServices: [{ serviceId: 'acme.agent/account', title: 'Acme account', connected: false, healthy: false }],
        credentialBindings: { v: 2, bindingsByServiceId: { 'acme.agent/account': binding } }, teamCredentialResources: resources,
    });
    expect(signIn(direct)).toMatchObject({ status: 'signedIn', via: { kind: 'connected' } });
    expect(signIn(brokered)).toMatchObject({ status: 'signedOut', via: null });
    expect(signIn(direct, [{ ...resource, readiness: { kind: 'source_unavailable' } }])).toMatchObject({ status: 'signedOut' });
    expect(signIn(direct, [{ ...resource, connectedServiceSelections: [brokered] }])).toMatchObject({ status: 'signedOut' });
});

const service = { pluginId: 'acme.agent', localId: 'account' };
const profileDefaults = {
    connectedServicesV2: [], connectedAccountsV4: [],
} satisfies Pick<Profile, 'connectedServicesV2' | 'connectedAccountsV4'>;
const declaration: PluginProjectedAgentConnectedAccountPurposeV2 = {
    purpose: 'primary', service, credentialKinds: ['oauth'],
};
const entry: ConnectedServiceRegistryEntry = {
    serviceId: 'account', service, connectCommand: 'connect', supportsOauth: true, executable: true,
    projectedDescriptor: {
        id: 'account', serviceId: 'account', pluginId: 'acme.agent', title: 'Acme account',
        provenance: 'external', sourceKind: 'installed',
        authentication: {
            defaultModeId: 'oauth',
            modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'providerCheck' }],
        },
        capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    },
};
function account(overrides: Partial<QualifiedConnectedAccountProfileV4> = {}): QualifiedConnectedAccountProfileV4 {
    const fields: Omit<QualifiedConnectedAccountProfileV4, 'revisionSemantics' | 'credentialRevision'> = {
        ref: { service, accountId: 'work' }, status: 'connected', kind: 'oauth',
        authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
        displayName: 'Work account',
        scopes: [], ...overrides,
    };
    return overrides.revisionSemantics === 'legacy_unfenced'
        ? { ...fields, revisionSemantics: 'legacy_unfenced', credentialRevision: null }
        : { ...fields, revisionSemantics: 'revisioned', credentialRevision: overrides.credentialRevision ?? 'revision-1' };
}
const defaults = {
    agents: [{ agentId: 'acme', connectedAccounts: [declaration] }],
    profile: { ...profileDefaults, connectedAccountsV4: [account()] },
    accountTransport: 'advertised-v4' as const,
    entries: [entry], now: 1_000,
};

it.each([true, false])('retains evaluated Account-default authentication when only a native model is authored (healthy=%s)', (healthy) => {
    const profiles = [account({ status: healthy ? 'connected' : 'needs_reauth' }),
        account({ ref: { service, accountId: 'backup' } })];
    const connectedServices = projectMachineAgentConnectedServices({ ...defaults,
        profile: { ...profileDefaults, connectedAccountsV4: profiles } }).acme;
    const facts = createReadyMachineAgentInventoryFixture([{ agentId: 'acme', title: 'Acme' }]).capabilities.results['cli.acme']!.data;
    const held = projectMachineAgent({ agentId: 'acme', title: 'Acme',
        facts: { ...facts, signIn: { status: 'signedOut', loginSupport: 'status_only', required: false } },
        checking: false, stale: false, connectedServices, job: null,
        credentialSelection: { credentialBindings: { v: 2, bindingsByServiceId: {
            'acme.agent/account': { source: 'connected', selection: 'profile', profileId: 'work' },
        } } },
    });
    expect(held.state).toBe(healthy ? 'ready' : 'needsSignIn');
    expect(projectMachineAgentForCredential(held, {
        modelRef: { source: 'native', agentTargetKey: 'agent:acme.agent/acme', modelId: 'model-a' },
    })).toMatchObject({ state: held.state, signIn: { status: held.signIn.status } });
});

describe('projectMachineAgentConnectedServices', () => {
    it.each([false, true])('uses shared disambiguated account names under the device identity privacy policy: hidden=%s', (hidden) => {
        const projected = projectMachineAgentConnectedServices({
            ...defaults,
            presentIdentity: input => presentConnectedAccountIdentity({ hidden, label: input.label ?? null,
                email: input.email ?? null, accountId: input.accountId ?? null }),
            profile: { ...profileDefaults, connectedAccountsV4: [
                account({ displayName: 'Same name', providerIdentity: { email: 'first@example.com' } }),
                account({ ref: { service, accountId: 'backup' }, displayName: 'Same name', providerIdentity: { email: 'second@example.com' } }),
            ] },
        });
        expect(projected.acme?.[0]?.profiles?.map(profile => [profile.profileLabel, profile.providerEmail])).toEqual(hidden
            ? [['Same name', 'fi•••@e•••.com'], ['Same name', 'se•••@e•••.com']]
            : [['Same name', 'first@example.com'], ['Same name', 'second@example.com']]);
        expect(projected.acme?.[0]?.profileLabel).toBe(hidden
            ? 'Same name · fi•••@e•••.com' : 'Same name · first@example.com');
        expect(resolveMachineAgentSignIn({
            native: { status: 'signedOut', loginSupport: 'login_terminal' },
            connectedServices: projected.acme,
            credentialBindings: { v: 2, bindingsByServiceId: {
                'acme.agent/account': { source: 'connected', selection: 'profile', profileId: 'backup' },
            } },
        })).toMatchObject({ status: 'signedIn', via: { kind: 'connected', profileLabel: hidden
            ? 'Same name · se•••@e•••.com' : 'Same name · second@example.com' } });
    });

    it('retains stable shared numbering when hidden identities also collide', () => {
        const accounts = [account({ displayName: 'Same name', providerIdentity: { email: 'leeroy+work@example.com' } }),
            account({ ref: { service, accountId: 'backup' }, displayName: 'Same name', providerIdentity: { email: 'leeroy+personal@example.com' } })];
        for (const connectedAccountsV4 of [accounts, [...accounts].reverse()]) {
            const projected = projectMachineAgentConnectedServices({ ...defaults,
                presentIdentity: input => presentConnectedAccountIdentity({ hidden: true, label: input.label ?? null,
                    email: input.email ?? null, accountId: input.accountId ?? null }),
                profile: { ...profileDefaults, connectedAccountsV4 } });
            expect(Object.fromEntries(projected.acme![0]!.profiles!.map(profile => [profile.profileId, profile.profileLabel])))
                .toEqual({ work: 'Same name 2', backup: 'Same name 1' });
            expect(JSON.stringify(projected)).not.toContain('leeroy+');
        }
    });

    it('lets a declared usable healthy connected account sign in while the native probe is signed out', () => {
        const projected = projectMachineAgentConnectedServices(defaults);
        expect(projected.acme).toEqual([{
            serviceId: 'acme.agent/account', title: 'Acme account', connected: true, healthy: true,
            profileLabel: 'Work account',
            profiles: [{ profileId: 'work', healthy: true, profileLabel: 'Work account' }],
        }]);
        expect(resolveMachineAgentSignIn({
            native: { status: 'signedOut', loginSupport: 'login_terminal' }, connectedServices: projected.acme,
        })).toMatchObject({ status: 'signedIn', via: { kind: 'connected', profileLabel: 'Work account' } });
    });

    it.each([
        { status: 'needs_reauth' as const },
        { expiresAt: 1_000 },
        { authenticationModeId: null },
        { authenticationModeId: 'missing-mode' },
        { revisionSemantics: 'legacy_unfenced' as const, credentialRevision: null },
        { kind: 'token' as const },
    ])('keeps a stored account unhealthy when it cannot authorize the declared purpose: %j', (overrides) => {
        const projected = projectMachineAgentConnectedServices({
            ...defaults, profile: { ...profileDefaults, connectedAccountsV4: [account(overrides)] },
        });
        expect(projected.acme).toEqual([expect.objectContaining({ connected: true, healthy: false })]);
    });

    it('admits a retryable profile for daemon preparation without borrowing a healthy sibling', () => {
        const connectedServices = projectMachineAgentConnectedServices({
            ...defaults, profile: { ...profileDefaults, connectedAccountsV4: [
                account({ status: 'needs_reauth', ref: { service, accountId: 'revoked' } }),
                account({ status: 'refresh_failed_retryable' }),
            ] },
        }).acme;
        const selected = (profileId: string) => resolveMachineAgentSignIn({
            native: { status: 'signedOut', loginSupport: 'login_terminal' }, connectedServices,
            credentialBindings: { v: 2, bindingsByServiceId: { 'acme.agent/account': {
                source: 'connected', selection: 'profile', profileId,
            } } },
        });
        expect(selected('work').status).toBe('signedIn');
        expect(selected('revoked')).toMatchObject({ status: 'signedOut', connectedAccountFailure: {
            code: 'connected_service_credential_reconnect_required', serviceId: 'acme.agent/account', profileId: 'revoked',
        } });
    });

    it('requires account configuration only when the exact authentication mode owns it', () => {
        const configuredEntry: ConnectedServiceRegistryEntry = {
            ...entry, projectedDescriptor: {
                ...entry.projectedDescriptor!, authentication: {
                    defaultModeId: 'manual', modes: [{
                        id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [],
                        configuration: { scope: 'account', changeBehavior: 'refresh', fields: [] },
                    }],
                },
            },
        };
        const profile = { ...profileDefaults, connectedAccountsV4: [account({ authenticationModeId: 'manual', configurationReady: false })] };
        expect(projectMachineAgentConnectedServices({ ...defaults, entries: [configuredEntry], profile }).acme)
            .toEqual([expect.objectContaining({ healthy: false })]);
        expect(projectMachineAgentConnectedServices({
            ...defaults, profile: { ...profileDefaults, connectedAccountsV4: [account({ configurationReady: false })] },
        }).acme).toEqual([expect.objectContaining({ healthy: true })]);
    });

    it('finds the first usable account after unhealthy accounts and preserves declaration order', () => {
        const secondService = { pluginId: 'acme.other', localId: 'account' };
        const projected = projectMachineAgentConnectedServices({
            ...defaults,
            agents: [{ agentId: 'acme', connectedAccounts: [{ purpose: 'secondary', service: secondService }, declaration] }],
            profile: { ...profileDefaults, connectedAccountsV4: [account({ ref: { service, accountId: 'expired' }, status: 'needs_reauth', displayName: 'Expired' }), account()] },
        });
        expect(projected.acme).toEqual([
            { serviceId: 'acme.other/account', title: 'acme.other/account', connected: false, healthy: false, profileLabel: null },
            expect.objectContaining({ serviceId: 'acme.agent/account', healthy: true, profileLabel: 'Work account' }),
        ]);
    });

    it('never borrows a similarly named account or descriptor from another plugin', () => {
        const foreignService = { pluginId: 'acme.foreign', localId: 'account' };
        expect(projectMachineAgentConnectedServices({
            ...defaults, profile: { ...profileDefaults, connectedAccountsV4: [account({ ref: { service: foreignService, accountId: 'work' } })] },
        }).acme).toEqual([expect.objectContaining({ connected: false, healthy: false })]);
        expect(projectMachineAgentConnectedServices({
            ...defaults, entries: [{ ...entry, service: foreignService }],
        }).acme).toEqual([expect.objectContaining({ connected: false, healthy: false })]);
    });

    it('fails closed while negotiation or the descriptor is absent or conflicted', () => {
        for (const entries of [[], [{ ...entry, projectedDescriptor: undefined }], [{ ...entry, executable: false, projectedDescriptorCandidates: [entry.projectedDescriptor!, entry.projectedDescriptor!] }]]) {
            expect(projectMachineAgentConnectedServices({ ...defaults, entries }).acme)
                .toEqual([expect.objectContaining({ connected: false, healthy: false, profileLabel: null })]);
        }
        expect(projectMachineAgentConnectedServices({ ...defaults, accountTransport: 'indeterminate' }).acme)
            .toEqual([expect.objectContaining({ connected: false, healthy: false, profileLabel: null })]);
    });

    it('keeps selected authentication unknown until the descriptor and transport can evaluate profiles', () => {
        const credentialBindings = { v: 2 as const, bindingsByServiceId: {
            'acme.agent/account': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
        } };
        for (const projection of [
            { ...defaults, entries: [] },
            { ...defaults, entries: [{ ...entry, projectedDescriptor: undefined }] },
            { ...defaults, entries: [{ ...entry, executable: false, projectedDescriptorCandidates: [entry.projectedDescriptor!, entry.projectedDescriptor!] }] },
            { ...defaults, accountTransport: 'indeterminate' as const },
        ]) {
            const connectedServices = projectMachineAgentConnectedServices(projection).acme;
            const inventory = projectMachineAgent({ agentId: 'acme', title: 'Acme', facts: null,
                checking: false, stale: false, connectedServices, job: null });
            const installed = { ...inventory, installed: true, state: 'ready' as const };
            const selected = projectMachineAgentForCredential(installed, { credentialBindings });
            expect(selected).toMatchObject({ state: 'unknown', signIn: { status: 'unknown', via: null } });
            expect(isMachineAgentReady(selected)).toBe(false);
        }
        const evaluated = projectMachineAgentConnectedServices(defaults).acme;
        expect(resolveMachineAgentSignIn({ native: { status: 'unknown', loginSupport: 'status_only' },
            connectedServices: evaluated, credentialBindings }).status).toBe('signedIn');
        const rejected = projectMachineAgentConnectedServices({ ...defaults,
            profile: { ...profileDefaults, connectedAccountsV4: [account({ status: 'needs_reauth' })] },
        }).acme;
        expect(resolveMachineAgentSignIn({ native: { status: 'signedIn', loginSupport: 'status_only' },
            connectedServices: rejected, credentialBindings }).status).toBe('signedOut');
    });

    it('does not offer undeclared services and allows caller-localized descriptor titles', () => {
        const projected = projectMachineAgentConnectedServices({
            ...defaults, agents: [...defaults.agents, { agentId: 'native' }], titleForService: () => 'Localized account',
        });
        expect(projected.native).toEqual([]);
        expect(projected.acme).toEqual([expect.objectContaining({ title: 'Localized account' })]);
    });

    it('evaluates each purpose restriction independently when purposes share a service', () => {
        const projected = projectMachineAgentConnectedServices({
            ...defaults, agents: [{ agentId: 'acme', connectedAccounts: [
                { purpose: 'token-only', service, credentialKinds: ['token'] }, declaration,
            ] }],
        });
        expect(projected.acme.map((row) => row.healthy)).toEqual([false, true]);
    });

    it('uses the released legacy selectability owner and exact known service mapping', () => {
        const legacyService = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const legacyEntry: ConnectedServiceRegistryEntry = {
            ...entry, service: legacyService, serviceId: 'openai-codex', legacyServiceId: 'openai-codex',
        };
        const legacyDefaults = {
            ...defaults, accountTransport: 'legacy' as const, entries: [legacyEntry],
            agents: [{ agentId: 'codex', connectedAccounts: [{ purpose: 'primary', service: legacyService, credentialKinds: ['oauth'] } satisfies PluginProjectedAgentConnectedAccountPurposeV2] }],
            profile: { ...profileDefaults, connectedServicesV2: [{
                serviceId: 'openai-codex' as const, groups: [], profiles: [
                    { profileId: 'wrong-kind', status: 'connected' as const, kind: 'token' as const, providerEmail: 'token@example.com', providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null },
                    { profileId: 'work', status: 'connected' as const, kind: 'oauth' as const, providerEmail: 'work@example.com', providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null },
                ],
            }] },
        };
        expect(projectMachineAgentConnectedServices(legacyDefaults).codex).toEqual([
            expect.objectContaining({ serviceId: 'happier.agent.codex/openai-codex', connected: true, healthy: true, profileLabel: 'work@example.com' }),
        ]);
        expect(projectMachineAgentConnectedServices({
            ...legacyDefaults, profile: { ...profileDefaults, connectedServicesV2: [{
                ...legacyDefaults.profile.connectedServicesV2[0], profiles: [{ ...legacyDefaults.profile.connectedServicesV2[0].profiles[1], status: 'refresh_failed_retryable' }],
            }] },
        }).codex).toEqual([expect.objectContaining({ connected: true, healthy: true })]);
        expect(projectMachineAgentConnectedServices({ ...legacyDefaults, entries: [] }).codex)
            .toEqual([expect.objectContaining({ connected: false, healthy: false })]);
        expect(projectMachineAgentConnectedServices({ ...legacyDefaults, entries: [{ ...legacyEntry, executable: false }] }).codex)
            .toEqual([expect.objectContaining({ connected: false, healthy: false })]);
        expect(projectMachineAgentConnectedServices({
            ...legacyDefaults, agents: defaults.agents, entries: [entry],
        }).acme).toEqual([expect.objectContaining({ connected: false, healthy: false })]);
    });
});
