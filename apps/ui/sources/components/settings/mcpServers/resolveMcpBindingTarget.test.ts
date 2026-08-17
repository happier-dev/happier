import { describe, expect, it } from 'vitest';

import {
    createDefaultMcpBindingTarget,
    resolveMcpBindingTargetTypeChange,
} from './resolveMcpBindingTarget';

describe('MCP binding target selection', () => {
    const machines = [
        { id: 'machine-a' },
        { id: 'machine-b' },
    ];

    it('does not derive a machine-scoped binding from inventory order', () => {
        expect(createDefaultMcpBindingTarget(machines)).toEqual({ t: 'allMachines' });
        expect(resolveMcpBindingTargetTypeChange(
            { t: 'allMachines' },
            'machine',
            machines,
        )).toBeNull();
        expect(resolveMcpBindingTargetTypeChange(
            { t: 'allMachines' },
            'workspace',
            machines,
        )).toBeNull();
    });

    it('uses the machine explicitly chosen for a new scoped binding', () => {
        expect(resolveMcpBindingTargetTypeChange(
            { t: 'allMachines' },
            'machine',
            machines,
            'machine-b',
        )).toEqual({ t: 'machine', machineId: 'machine-b' });
        expect(resolveMcpBindingTargetTypeChange(
            { t: 'allMachines' },
            'workspace',
            machines,
            'machine-a',
        )).toEqual({ t: 'workspace', machineId: 'machine-a', workspaceRoot: '/' });
        expect(resolveMcpBindingTargetTypeChange(
            { t: 'allMachines' },
            'machine',
            machines,
            'missing-machine',
        )).toBeNull();
    });
});
