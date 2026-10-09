import { describe, expect, it } from 'vitest';

import {
    isMachineAdministrationExecutionTargetCurrent,
    sameMachineAdministrationExecutionTarget,
} from './operationCurrentness';
import { isAdministrationScopedPluginSettingsTargetCurrent } from './scopedPluginSettingsTarget';
import type { FreshMachineAdministrationExecutionTargetV1 } from './useTargetSelection';

describe('machine administration operation currentness', () => {
    const expected: FreshMachineAdministrationExecutionTargetV1 = {
        kind: 'resolved',
        target: { serverIdentityId: 'srv_one', machineId: 'machine-a' },
        serverId: 'local-one',
        profile: { id: 'local-one' } as FreshMachineAdministrationExecutionTargetV1['profile'],
        machine: {
            id: 'machine-a',
            daemonStateVersion: 12,
        } as FreshMachineAdministrationExecutionTargetV1['machine'],
    };

    it('requires portable target, local route, machine and exact daemon generation', () => {
        expect(sameMachineAdministrationExecutionTarget(expected, expected)).toBe(true);
        expect(sameMachineAdministrationExecutionTarget(expected, {
            ...expected,
            machine: { ...expected.machine, daemonStateVersion: 13 },
        })).toBe(false);
        expect(sameMachineAdministrationExecutionTarget(expected, {
            ...expected,
            serverId: 'local-two',
        })).toBe(false);
    });

    it('rejects an A-to-B-to-A selection settlement even when the exact target generation matches again', () => {
        expect(sameMachineAdministrationExecutionTarget(
            { ...expected, selectionRevision: 1 },
            { ...expected, selectionRevision: 3 },
        )).toBe(false);
    });

    it('rejects a replaced installation even when the portable target and daemon generation still match', () => {
        const captured = { ...expected, machine: { ...expected.machine, installationId: 'installation-a' } };
        expect(sameMachineAdministrationExecutionTarget(captured, {
            ...captured, machine: { ...captured.machine, metadataVersion: 99 },
        })).toBe(true);
        expect(isMachineAdministrationExecutionTargetCurrent({
            expectedTarget: captured,
            resolveCurrentTarget: () => ({ ...captured, machine: { ...captured.machine, installationId: 'installation-b' } }),
        })).toBe(false);
        expect(sameMachineAdministrationExecutionTarget(expected, expected)).toBe(true);
    });

    it('also fences a screen operation to its captured selection key', () => {
        expect(isMachineAdministrationExecutionTargetCurrent({
            expectedTarget: expected,
            resolveCurrentTarget: () => expected,
            expectedSelectionKey: 'selection-a',
            currentSelectionKey: 'selection-a',
        })).toBe(true);
        expect(isMachineAdministrationExecutionTargetCurrent({
            expectedTarget: expected,
            resolveCurrentTarget: () => ({
                ...expected,
                machine: { ...expected.machine, daemonStateVersion: 13 },
            }),
            expectedSelectionKey: 'selection-a',
            currentSelectionKey: 'selection-a',
        })).toBe(false);
        expect(isMachineAdministrationExecutionTargetCurrent({
            expectedTarget: expected,
            resolveCurrentTarget: () => expected,
            expectedSelectionKey: 'selection-a',
            currentSelectionKey: 'selection-b',
        })).toBe(false);
    });

    it('applies the same daemon-generation fence to scoped Settings targets', () => {
        const target = {
            kind: 'daemon' as const,
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            serverId: 'local-one',
        };
        expect(isAdministrationScopedPluginSettingsTargetCurrent({
            target,
            expectedExecutionTarget: expected,
            resolveCurrentExecutionTarget: () => expected,
        })).toBe(true);
        expect(isAdministrationScopedPluginSettingsTargetCurrent({
            target,
            expectedExecutionTarget: expected,
            resolveCurrentExecutionTarget: () => ({
                ...expected,
                machine: { ...expected.machine, daemonStateVersion: 13 },
            }),
        })).toBe(false);
    });
});
