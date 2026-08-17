import { describe, expect, it } from 'vitest';

import { DEFAULT_MACHINE_ADMINISTRATION_SELECTIONS_V1 } from '@happier-dev/protocol';

import {
    applyMachineAdministrationSelectionMutationToAccountSettings,
    clearMachineAdministrationTargetPreference,
    setMachineAdministrationTargetPreference,
    setPluginMachineExecutionOriginPreference,
} from './selectionPreferences';

describe('machine administration selection preferences', () => {
    it('updates one semantic target entry without dropping another target or plugin origin', () => {
        const current = {
            v: 1 as const,
            targetsByKey: {
                agents: { serverIdentityId: 'srv_one', machineId: 'machine-a' },
            },
            pluginExecutionOriginsByPluginId: {
                'acme.plugin': {
                    serverIdentityId: 'srv_one',
                    materializationRef: {
                        machineId: 'machine-a',
                        materializationId: 'mat-a',
                        pluginId: 'acme.plugin',
                    },
                },
            },
        };

        expect(setMachineAdministrationTargetPreference(
            current,
            'plugins.home',
            { serverIdentityId: 'srv_two', machineId: 'machine-b' },
        )).toEqual({
            ...current,
            targetsByKey: {
                ...current.targetsByKey,
                'plugins.home': { serverIdentityId: 'srv_two', machineId: 'machine-b' },
            },
        });
    });

    it('updates and clears only the named entry through the Settings-owned schema', () => {
        const withTarget = setMachineAdministrationTargetPreference(
            DEFAULT_MACHINE_ADMINISTRATION_SELECTIONS_V1,
            'plugins.home',
            { serverIdentityId: 'srv_one', machineId: 'machine-a' },
        );
        const withOrigin = setPluginMachineExecutionOriginPreference(withTarget, 'acme.plugin', {
            serverIdentityId: 'srv_one',
            materializationRef: {
                machineId: 'machine-a',
                materializationId: 'mat-a',
                pluginId: 'acme.plugin',
            },
        });

        expect(clearMachineAdministrationTargetPreference(withOrigin, 'plugins.home')).toEqual({
            v: 1,
            targetsByKey: {},
            pluginExecutionOriginsByPluginId: withOrigin.pluginExecutionOriginsByPluginId,
        });
    });

    it('rejects device-local profile ids before they can enter Account settings', () => {
        expect(() => setMachineAdministrationTargetPreference(
            DEFAULT_MACHINE_ADMINISTRATION_SELECTIONS_V1,
            'plugins.home',
            { serverIdentityId: 'profile-local-1', machineId: 'machine-a' },
        )).toThrow();
    });

    it('replays a named mutation without dropping a concurrent Account Settings winner', () => {
        const next = applyMachineAdministrationSelectionMutationToAccountSettings({
            unrelatedRoot: { preserved: true },
            machineAdministrationSelectionsV1: {
                v: 1,
                targetsByKey: {
                    agents: { serverIdentityId: 'srv_one', machineId: 'machine-a' },
                },
                pluginExecutionOriginsByPluginId: {
                    'other.plugin': {
                        serverIdentityId: 'srv_one',
                        materializationRef: {
                            machineId: 'machine-a',
                            materializationId: 'mat-other',
                            pluginId: 'other.plugin',
                        },
                    },
                },
            },
        }, (current) => setMachineAdministrationTargetPreference(
            current,
            'plugins.home',
            { serverIdentityId: 'srv_two', machineId: 'machine-b' },
        ));

        expect(next).toEqual({
            unrelatedRoot: { preserved: true },
            machineAdministrationSelectionsV1: {
                v: 1,
                targetsByKey: {
                    agents: { serverIdentityId: 'srv_one', machineId: 'machine-a' },
                    'plugins.home': { serverIdentityId: 'srv_two', machineId: 'machine-b' },
                },
                pluginExecutionOriginsByPluginId: {
                    'other.plugin': {
                        serverIdentityId: 'srv_one',
                        materializationRef: {
                            machineId: 'machine-a',
                            materializationId: 'mat-other',
                            pluginId: 'other.plugin',
                        },
                    },
                },
            },
        });
    });
});
