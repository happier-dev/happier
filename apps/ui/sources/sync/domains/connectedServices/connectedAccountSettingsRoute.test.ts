import { describe, expect, it } from 'vitest';
import { BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { canExecuteConnectedServiceAction, getConnectedServiceRegistryIdentityFallback } from './connectedServiceRegistry';
import { buildConnectedServicesIndexModel } from '@/components/settings/connectedServices/model/buildConnectedServicesIndexModel';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readConnectedAccountPurposeSetupRequest } from './connectedAccountPurposeSetup';

import type {
    ConnectedServiceRegistryEntry,
} from './connectedServiceRegistry';
import {
    buildConnectedAccountsSettingsRoute,
    buildConnectedAccountSettingsRoute,
    buildNewConnectedAccountPoolRoute,
    readConnectedAccountAddRequest,
    resolveConnectedAccountSettingsRoute,
    resolveQualifiedConnectedAccountSettingsRoute,
} from './connectedAccountSettingsRoute';

const entries: readonly ConnectedServiceRegistryEntry[] = [{
    serviceId: 'vault',
    service: {
        pluginId: 'acme.connected-accounts-conformance',
        localId: 'vault',
    },
    connectCommand: 'happier connect acme.connected-accounts-conformance/vault',
    supportsOauth: false,
    executable: true,
}, {
    serviceId: 'github',
    service: {
        pluginId: 'happier.scm.forge.github',
        localId: 'github-account',
    },
    legacyServiceId: 'github',
    connectCommand: 'happier connect github',
    supportsOauth: true,
    executable: true,
}];

describe('connectedAccountSettingsRoute', () => {
    it('opens reserved host account and pool rows through their canonical connected-account identity', () => {
        const service = { pluginId: 'happier', localId: 'mcp-sign-in' };
        for (const focus of [{ kind: 'account', accountId: 'signed-out-host-account' },
            { kind: 'group', groupId: 'host-pool' }] as const) {
            const route = buildConnectedAccountSettingsRoute(service, focus);
            expect(route).toMatchObject({ pathname: '/(app)/settings/connected-services/account', params: service });
            expect(resolveQualifiedConnectedAccountSettingsRoute(route!.params, [])).toMatchObject({ service, focus });
        }
    });

    it('returns a typed unavailable route for malformed service or focus input instead of throwing', () => {
        expect(buildConnectedAccountSettingsRoute({ pluginId: 'bad..plugin', localId: 'account' })).toBeNull();
        const service = { pluginId: 'happier.machine.maritime', localId: 'maritime-account' };
        expect(buildConnectedAccountSettingsRoute(service, { kind: 'account', accountId: '' })).toBeNull();
        expect(buildConnectedAccountSettingsRoute(service, { kind: 'group', groupId: '' })).toBeNull();
        expect(buildConnectedAccountSettingsRoute(service, { kind: 'unexpected' } as never)).toBeNull();
        expect(buildConnectedAccountSettingsRoute({ pluginId: 'happier', localId: 'not-a-host-service' },
            { kind: 'account', accountId: 'account' })).toBeNull();
    });

    it('resolves an exact native setup identity without granting execution from absent passive metadata', () => {
        // No bundled Account-authoring declaration: only the native answer can
        // supply this plugin's methods, unlike the separately declared Email UI.
        const service = { pluginId: 'external.mail', localId: 'imap-smtp' };
        const resolved = resolveQualifiedConnectedAccountSettingsRoute(service, [], 'nativeSetup');
        expect(resolved).toMatchObject({ service, focus: null, entry: { service, executable: false } });
        expect(canExecuteConnectedServiceAction(resolved!.entry, 'advertised-v4')).toBe(false);
        // Ordinary index/new-pool resolution still requires its own declaration.
        expect(resolveQualifiedConnectedAccountSettingsRoute(service, [])).toBeNull();
        expect(resolveQualifiedConnectedAccountSettingsRoute({ ...service, newPool: '1' }, [], 'nativeSetup')).toBeNull();
        for (const extra of [{ serviceId: 'email' }, { serverId: 'foreign' }, { machineId: 'foreign' }]) {
            expect(resolveQualifiedConnectedAccountSettingsRoute({ ...service, ...extra }, [], 'nativeSetup')).toBeNull();
        }
    });

    it('keeps every bundled Machine account and external plugin account reachable without its purpose projection', () => {
        const services = [
            ...Object.keys(BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS)
                .filter(key => key.startsWith('happier.machine.'))
                .map(key => ({ service: parseQualifiedPluginContributionKey(key)!, canAdd: true })),
            { service: { pluginId: 'external.cloud', localId: 'account' }, canAdd: false },
            { service: { pluginId: 'another.cloud', localId: 'account' }, canAdd: false },
        ];
        expect(services.length).toBeGreaterThan(2);
        for (const { service, canAdd } of services) {
            const route = buildConnectedAccountSettingsRoute(service, { kind: 'account', accountId: 'saved-account' });
            if (!route) throw new Error('Saved account must have a detail route');
            const resolved = resolveQualifiedConnectedAccountSettingsRoute(route.params, []);
            expect(resolved, `${service.pluginId}/${service.localId}`).toMatchObject({
                service, focus: { kind: 'account', accountId: 'saved-account' },
                entry: { service, executable: false },
            });
            expect(canExecuteConnectedServiceAction(resolved!.entry, 'advertised-v4'))
                .toBe(canAdd);
            expect(resolveQualifiedConnectedAccountSettingsRoute(service, [])).toBeNull();
        }
    });

    it.each([
        { service: { pluginId: 'external.cloud', localId: 'account' }, status: 'connected' },
        { service: { pluginId: 'happier', localId: 'mcp-sign-in' }, status: 'needs_reauth' },
    ] as const)('composes a saved $status account index row into its exact detail route without descriptor admission', ({ service, status }) => {
        const saved = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'saved-account' },
            status, authenticationModeId: 'token', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true, configurationRevision: null });
        const model = buildConnectedServicesIndexModel({ transport: 'advertised-v4', entries: [],
            qualifiedAccounts: [saved], qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
            resolveLabel: () => 'Cloud account',
            resolveFallbackEntry: getConnectedServiceRegistryIdentityFallback,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading', agentUses: [],
        });
        const sheet = model.sheets[0]!;
        expect(sheet).toMatchObject({ service, canOpen: true, canAdd: false, installationState: 'unknown' });
        expect(model.connectable).toEqual([]);
        const route = buildConnectedAccountSettingsRoute(sheet.service, { kind: 'account', accountId: sheet.accounts[0]!.accountId });
        if (!route) throw new Error('Saved index row must have a detail route');
        expect(resolveQualifiedConnectedAccountSettingsRoute(route.params, [])).toMatchObject({ service,
            focus: { kind: 'account', accountId: saved.ref.accountId }, entry: { executable: false } });
        expect(resolveQualifiedConnectedAccountSettingsRoute({ ...service, groupId: 'saved-pool' }, [])).toMatchObject({
            service, focus: { kind: 'group', groupId: 'saved-pool' }, entry: { executable: false },
        });
        expect(resolveQualifiedConnectedAccountSettingsRoute({ ...service, newPool: '1' }, [])).toBeNull();
    });
    it('opens source purpose setup on the invoking Home and machine', () => {
        const purpose = { consumer: { pluginId: 'acme.source', localId: 'discover' }, purpose: 'source-api' };
        expect(buildConnectedAccountsSettingsRoute({ service: entries[0]!.service!, purpose }, {
            scope: { serverId: 'home', accountId: 'viewer' }, machineId: 'machine',
        })).toEqual({ pathname: '/(app)/settings/connected-services/connect', params: {
            purposeConsumerPlugin: 'acme.source', purposeConsumerId: 'discover', purpose: 'source-api',
            purposeServerId: 'home', purposeAccountId: 'viewer', purposeMachineId: 'machine',
        } });
    });
    it('restores an Account purpose setup route without a Machine selector', () => {
        const purpose = { consumer: { pluginId: 'happier.machine.vercel', localId: 'vercel' }, purpose: 'cloud-api' };
        const scope = { serverId: 'home', accountId: 'viewer' };
        const route = buildConnectedAccountsSettingsRoute({ service: entries[0]!.service!, purpose }, { scope });
        if (!route || typeof route === 'string') throw new Error('Purpose setup must have route parameters');
        expect(readConnectedAccountPurposeSetupRequest(route.params)).toEqual({ purpose, scope });
        expect(route.params).not.toHaveProperty('purposeMachineId');
    });
    it('owns the semantic plugin navigation mapping for the overview, service, and account focus', () => {
        expect(buildConnectedAccountsSettingsRoute({})).toBe('/(app)/settings/connected-services');
        expect(buildConnectedAccountsSettingsRoute({
            service: entries[0]!.service!,
        })).toEqual(buildConnectedAccountSettingsRoute(entries[0]!.service!));
        expect(buildConnectedAccountsSettingsRoute({
            service: entries[0]!.service!,
            accountId: 'work',
        })).toEqual(buildConnectedAccountSettingsRoute(
            entries[0]!.service!,
            { kind: 'account', accountId: 'work' },
        ));
    });

    it('sends an unfocused service to the collection instead of a per-service page', () => {
        const service = {
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
        };

        const route = buildConnectedAccountSettingsRoute(service);

        expect(route).toEqual({
            pathname: '/(app)/settings/connected-services',
            params: {},
        });
    });

    it('opens the exact service account draft in detail and reads legacy add requests', () => {
        const service = {
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
        };

        const route = buildConnectedAccountSettingsRoute(service, null, { add: true });

        expect(route).toEqual({
            pathname: '/(app)/settings/connected-services/connect',
            params: { service: 'acme.connected-accounts-conformance/vault' },
        });
        expect(readConnectedAccountAddRequest({ ...service, add: '1' })).toBe(true);
        expect(readConnectedAccountAddRequest(buildConnectedAccountSettingsRoute(service)!.params)).toBe(false);
    });

    it('opens a service page focused on a new-pool draft, which is not a pool', () => {
        const service = {
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
        };

        const route = buildNewConnectedAccountPoolRoute(service);
        if (!route) throw new Error('Valid service must have a new pool route');

        expect(route.params).toEqual({ ...service, newPool: '1' });
        if (!('pluginId' in route.params)) throw new Error('New pool route must carry the qualified service');
        expect(resolveConnectedAccountSettingsRoute(route.params, entries)).toMatchObject({ service, focus: { kind: 'newPool' } });
        // A draft is never also an account or a pool.
        expect(resolveConnectedAccountSettingsRoute({ ...route.params, groupId: 'work' }, entries)).toBeNull();
        expect(resolveConnectedAccountSettingsRoute({ ...service, newPool: 'yes' }, entries)).toBeNull();
    });

    it('keeps a released qualified route and account focus reachable through a non-executable projection', () => {
        const service = {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
        };
        expect(resolveQualifiedConnectedAccountSettingsRoute(service, [])).toMatchObject({
            service,
            entry: {
                serviceId: 'openai-codex',
                service,
                legacyServiceId: 'openai-codex',
            },
            legacyServiceId: 'openai-codex',
            focus: null,
        });
        expect(resolveQualifiedConnectedAccountSettingsRoute({
            pluginId: 'foreign.accounts',
            localId: 'openai-codex',
        }, [])).toBeNull();

        const params = { ...service, accountId: 'work' };
        expect(resolveQualifiedConnectedAccountSettingsRoute(params, [])).toMatchObject({
            service,
            focus: { kind: 'account', accountId: 'work' },
        });
        const staleEntry: ConnectedServiceRegistryEntry = {
            serviceId: 'openai-codex',
            service,
            legacyServiceId: 'openai-codex',
            connectCommand: 'happier connect openai-codex',
            supportsOauth: false,
            executable: false,
            projectionStatus: 'stale',
            availability: { state: 'available', reason: 'resolved' },
            projectionConflicts: [],
        };
        expect(resolveQualifiedConnectedAccountSettingsRoute(params, [staleEntry])).toMatchObject({
            service,
            entry: staleEntry,
            focus: { kind: 'account', accountId: 'work' },
        });
    });

    it.each([
        [{ kind: 'account', accountId: 'work' } as const],
        [{ kind: 'group', groupId: 'primary' } as const],
    ])('round-trips an exact qualified %s focus', (focus) => {
        const service = {
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
        };

        const route = buildConnectedAccountSettingsRoute(service, focus);
        if (!route) throw new Error('Valid focus must have a route');
        if (!('pluginId' in route.params)) throw new Error('Focused route must carry the qualified service');
        expect(resolveConnectedAccountSettingsRoute(route.params, entries)).toMatchObject({
            service,
            focus,
        });
    });

    it('keeps device-local machine routing out of the public settings route', () => {
        const route = buildConnectedAccountSettingsRoute(
            entries[0]!.service!,
            { kind: 'account', accountId: 'work' },
        );
        if (!route) throw new Error('Valid account must have a route');

        expect(route.params).toEqual({
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
            accountId: 'work',
        });
        expect(resolveConnectedAccountSettingsRoute({
            ...route.params,
            serverId: 'server-local',
            machineId: 'machine-local',
        }, entries)).toBeNull();
    });

    it('translates only a valid built-in legacy scalar to its projected qualified owner', () => {
        const foreignClaim: ConnectedServiceRegistryEntry = {
            serviceId: 'github',
            service: {
                pluginId: 'foreign.accounts',
                localId: 'github-account',
            },
            connectCommand: 'foreign connect',
            supportsOauth: true,
            executable: true,
        };
        expect(resolveConnectedAccountSettingsRoute(
            { serviceId: 'github' },
            [foreignClaim, ...entries],
        )).toEqual({
            service: {
                pluginId: 'happier.scm.forge.github',
                localId: 'github-account',
            },
            entry: entries[1],
            legacyServiceId: 'github',
            focus: null,
        });
        expect(resolveConnectedAccountSettingsRoute({ serviceId: 'vault' }, entries)).toBeNull();
    });

    it.each([
        [{ serviceId: 'github', profileId: 'work' }, { kind: 'account', accountId: 'work' }],
        [{ serviceId: 'github', groupId: 'primary' }, { kind: 'group', groupId: 'primary' }],
    ])('preserves bounded legacy focus while translating to the qualified owner', (params, focus) => {
        expect(resolveConnectedAccountSettingsRoute(params, entries)).toMatchObject({
            service: entries[1]?.service,
            focus,
        });
    });

    it.each([
        [{ pluginId: 'acme.connected-accounts-conformance' }],
        [{ localId: 'vault' }],
        [{ pluginId: 'ACME invalid', localId: 'vault' }],
        [{ pluginId: 'acme.connected-accounts-conformance', localId: 'Vault' }],
        [{ pluginId: ['acme.connected-accounts-conformance', 'foreign.plugin'], localId: 'vault' }],
        [{ pluginId: 'foreign.plugin', localId: 'vault' }],
        [{
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
            serviceId: 'github',
        }],
        [{
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
            serviceId: '',
        }],
        [{
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
            serviceId: null,
        }],
        [{ serviceId: 'github', pluginId: '' }],
        [{ serviceId: 'github', pluginId: null }],
        [{ pluginId: 'acme.connected-accounts-conformance', localId: '' }],
        [{ serviceId: '' }],
        [{ serviceId: ['github', 'github'] }],
        [{
            pluginId: [
                'acme.connected-accounts-conformance',
                'acme.connected-accounts-conformance',
            ],
            localId: 'vault',
        }],
        [{
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
            accountId: 'work',
            groupId: 'primary',
        }],
        [{
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
            profileId: 'work',
        }],
        [{
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
            serverId: 'server-only',
        }],
        [{
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
            machineId: 'machine-only',
        }],
        [{
            serviceId: 'github',
            serverId: 'server-active',
            machineId: 'machine-selected',
        }],
        [{ serviceId: 'github', profileId: 'work', groupId: 'primary' }],
        [{ serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', accountId: 'other' }],
        [{ serviceId: 'happier.agent.codex/openai-codex', profileId: ['work', 'other'] }],
        [{ serviceId: 'happier.agent.codex/openai-codex', serverId: 'server-active' }],
        [{ serviceId: ['happier.agent.codex/openai-codex', 'happier.agent.codex/openai-codex'] }],
    ])('rejects malformed, foreign, or mixed qualified route params %#', (params) => {
        expect(resolveConnectedAccountSettingsRoute(params, entries)).toBeNull();
    });
});
