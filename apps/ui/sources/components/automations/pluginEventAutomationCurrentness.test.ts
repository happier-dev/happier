import { describe, expect, it } from 'vitest';
import {
    arePluginMachineExecutionOriginsEqual,
    arePluginMachineMaterializationRefsEqual,
} from '@happier-dev/protocol';

import {
    areFreshPluginMachineExecutionOriginsCurrent,
    arePluginContributionIdentitiesEqual,
} from '@/sync/domains/automations/pluginEventAutomationCurrentness';

describe('plugin Event Automation currentness', () => {
    it('requires both contribution identity fields', () => {
        const event = { pluginId: 'acme.github', localId: 'events/repository' };

        expect(arePluginContributionIdentitiesEqual(event, { ...event })).toBe(true);
        expect(arePluginContributionIdentitiesEqual(event, { ...event, pluginId: 'acme.gitlab' })).toBe(false);
        expect(arePluginContributionIdentitiesEqual(event, { ...event, localId: 'events/issues' })).toBe(false);
    });

    it('requires an exact plugin materialization reference', () => {
        const materialization = {
            pluginId: 'acme.github',
            machineId: 'machine-a',
            materializationId: 'materialization-a',
        };

        expect(arePluginMachineMaterializationRefsEqual(materialization, { ...materialization })).toBe(true);
        expect(arePluginMachineMaterializationRefsEqual(
            materialization,
            { ...materialization, machineId: 'machine-b' },
        )).toBe(false);
        expect(arePluginMachineMaterializationRefsEqual(
            materialization,
            { ...materialization, materializationId: 'materialization-b' },
        )).toBe(false);
    });

    it('keeps origin currentness bound to both its materialization and resolved target', () => {
        const origin = {
            serverIdentityId: 'server-identity-a',
            materializationRef: {
                pluginId: 'acme.github',
                machineId: 'machine-a',
                materializationId: 'materialization-a',
            },
        };
        const freshOrigin = {
            origin,
            machineTarget: {
                serverId: 'server-a',
                target: {
                    serverIdentityId: 'server-identity-a',
                    machineId: 'machine-a',
                },
            },
        };

        expect(arePluginMachineExecutionOriginsEqual(origin, { ...origin })).toBe(true);
        expect(areFreshPluginMachineExecutionOriginsCurrent(freshOrigin, { ...freshOrigin })).toBe(true);
        expect(areFreshPluginMachineExecutionOriginsCurrent(freshOrigin, {
            ...freshOrigin,
            machineTarget: {
                ...freshOrigin.machineTarget,
                target: {
                    ...freshOrigin.machineTarget.target,
                    machineId: 'machine-b',
                },
            },
        })).toBe(false);
        expect(areFreshPluginMachineExecutionOriginsCurrent(freshOrigin, {
            ...freshOrigin,
            origin: {
                ...origin,
                materializationRef: {
                    ...origin.materializationRef,
                    materializationId: 'materialization-b',
                },
            },
        })).toBe(false);
    });
});
