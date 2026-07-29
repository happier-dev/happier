import { describe, expect, it } from 'vitest';

import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';

import type {
    ConnectedServiceRegistryEntry,
} from './connectedServiceRegistry';
import {
    buildConnectedAccountSettingsRoute,
    resolveConnectedAccountOperationTarget,
    resolveConnectedAccountSettingsRoute,
} from './connectedAccountSettingsRoute';

type OperationTargetMachineFixture = Readonly<{
    id: string;
    active: boolean;
    revokedAt?: number | null;
}>;

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
        pluginId: 'happier.scm.hosting.github',
        localId: 'github-account',
    },
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

    it('round-trips the exact execution target with the selected account focus', () => {
        const route = buildConnectedAccountSettingsRoute(
            entries[0]!.service!,
            { kind: 'account', accountId: 'work' },
            { serverId: 'server-selected', machineId: 'machine-selected' },
        );

        expect(resolveConnectedAccountSettingsRoute(route.params, entries)).toMatchObject({
            service: entries[0]!.service,
            focus: { kind: 'account', accountId: 'work' },
            executionTarget: {
                serverId: 'server-selected',
                machineId: 'machine-selected',
            },
        });
    });

    it('keeps an exact server-b recovery route actionable while server-a is active', () => {
        const route = buildConnectedAccountSettingsRoute(
            entries[0]!.service!,
            { kind: 'account', accountId: 'work' },
            { serverId: 'server-b', machineId: 'machine-b' },
        );
        const resolvedRoute = resolveConnectedAccountSettingsRoute(route.params, entries);
        const machines = resolveServerScopedMachines<OperationTargetMachineFixture>({
            serverId: resolvedRoute?.executionTarget?.serverId ?? '',
            activeServerId: 'server-a',
            activeMachines: [
                { id: 'machine-a', active: true },
            ],
            machineListByServerId: {
                'server-b': [
                    { id: 'machine-b', active: true },
                ],
            },
        });

        expect(resolvedRoute?.executionTarget).toEqual({
            serverId: 'server-b',
            machineId: 'machine-b',
        });
        expect(resolveConnectedAccountOperationTarget({
            activeServerId: 'server-a',
            executionTarget: resolvedRoute?.executionTarget ?? null,
            machines: machines ?? [],
        })).toEqual({
            serverId: 'server-b',
            machineId: 'machine-b',
        });
    });

    it('uses the exact online operation target and fails closed instead of roaming', () => {
        const machines = [
            { id: 'machine-other', active: true },
            { id: 'machine-selected', active: true },
            { id: 'machine-offline', active: false },
        ];

        expect(resolveConnectedAccountOperationTarget({
            activeServerId: 'server-selected',
            executionTarget: {
                serverId: 'server-selected',
                machineId: 'machine-selected',
            },
            machines,
        })).toEqual({
            serverId: 'server-selected',
            machineId: 'machine-selected',
        });
        expect(resolveConnectedAccountOperationTarget({
            activeServerId: 'server-selected',
            executionTarget: {
                serverId: 'server-selected',
                machineId: 'machine-offline',
            },
            machines,
        })).toBeNull();
        expect(resolveConnectedAccountOperationTarget({
            activeServerId: 'server-selected',
            executionTarget: {
                serverId: 'server-selected',
                machineId: 'machine-missing',
            },
            machines,
        })).toBeNull();
    });

    it('preserves the current active-machine behavior when no execution context is supplied', () => {
        expect(resolveConnectedAccountOperationTarget({
            activeServerId: 'server-active',
            executionTarget: null,
            machines: [
                { id: 'machine-first', active: false },
                { id: 'machine-active', active: true },
            ],
        })).toEqual({
            serverId: 'server-active',
            machineId: 'machine-active',
        });
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
                pluginId: 'happier.scm.hosting.github',
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
        [{ serviceId: 'github', profileId: ['work', 'other'] }],
    ])('rejects malformed, foreign, or mixed qualified route params %#', (params) => {
        expect(resolveConnectedAccountSettingsRoute(params, entries)).toBeNull();
    });
});
