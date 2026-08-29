import { describe, expect, it } from 'vitest';

import type {
    ConnectedServiceRegistryEntry,
} from './connectedServiceRegistry';
import {
    buildConnectedAccountSettingsRoute,
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
    it('round-trips a novel external service through only its exact qualified identity', () => {
        const service = {
            pluginId: 'acme.connected-accounts-conformance',
            localId: 'vault',
        };

        const route = buildConnectedAccountSettingsRoute(service);

        expect(route).toEqual({
            pathname: '/(app)/settings/connected-services/account',
            params: service,
        });
        expect(resolveConnectedAccountSettingsRoute(route.params, entries)).toEqual({
            service,
            entry: entries[0],
            legacyServiceId: null,
            focus: null,
        });
    });

    it('keeps a generated released qualified route reachable before its descriptor projects', () => {
        const service = {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
        };
        const route = buildConnectedAccountSettingsRoute(service);

        expect(resolveQualifiedConnectedAccountSettingsRoute(route.params, [])).toMatchObject({
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
