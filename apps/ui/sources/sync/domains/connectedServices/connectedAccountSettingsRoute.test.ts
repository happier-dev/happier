import { describe, expect, it } from 'vitest';

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

    it('opens collection setup for the exact service and reads legacy add requests', () => {
        const service = {
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
        };

        const route = buildConnectedAccountSettingsRoute(service, null, { add: true });

        expect(route).toEqual({
            pathname: '/(app)/settings/connected-services',
            params: { connect: '1', service: 'acme.connected-accounts-conformance/vault' },
        });
        expect(readConnectedAccountAddRequest({ ...service, add: '1' })).toBe(true);
        expect(readConnectedAccountAddRequest(buildConnectedAccountSettingsRoute(service).params)).toBe(false);
    });

    it('opens a service page focused on a new-pool draft, which is not a pool', () => {
        const service = {
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
        };

        const route = buildNewConnectedAccountPoolRoute(service);

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
