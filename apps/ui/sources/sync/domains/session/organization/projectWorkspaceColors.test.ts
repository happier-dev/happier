import { describe, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit';
import { buildSessionWorkspaceFallbackOrderKey } from '../listing/sessionWorkspaceOrderKeys';
import { projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { projectSessionWorkspaceColors } from './projectWorkspaceColors';

describe('projectSessionWorkspaceColors', () => {
    const machine = createMachineFixture({ id: 'machine' });
    const ref = { id: 'checkout', serverId: 'home', machineId: machine.id, rootPath: '/repo', createdAtMs: 1 };
    const key = buildSessionWorkspaceFallbackOrderKey(['home', machine.id, '/repo']);
    const projectKey = projectGroupIdentityKey({ serverId: 'home', projectKey: ref.id });
    const color = { kind: 'custom', hex: '#123456' } as const;

    it('maps an opened predecessor colour only through its exact accepted Home and unique checkout', () => {
        const input = { workspaceColors: { [key]: color }, workspaceRefs: [ref], censusServerId: 'home', machines: new Map([[machine.id, machine]]) };
        expect(projectSessionWorkspaceColors(input)[projectKey]).toBe(color);
        expect(projectSessionWorkspaceColors({ ...input, censusServerId: 'other-home' })).toBe(input.workspaceColors);
        expect(projectSessionWorkspaceColors({ ...input, workspaceRefs: [ref, { ...ref, id: 'ambiguous' }] })).toBe(input.workspaceColors);
        const explicit = { kind: 'custom', hex: '#abcdef' } as const;
        const workspaceColors = { [key]: color, [projectKey]: explicit };
        expect(projectSessionWorkspaceColors({ ...input, workspaceColors })).toBe(workspaceColors);
    });

    it('does not elect a Project colour from conflicting predecessor checkout colours', () => {
        const second = { ...ref, id: 'second', rootPath: '/other', projectKey: ref.id };
        const secondKey = buildSessionWorkspaceFallbackOrderKey(['home', machine.id, '/other']);
        const workspaceColors = { [key]: color, [secondKey]: { kind: 'custom', hex: '#abcdef' } as const };
        expect(projectSessionWorkspaceColors({ workspaceColors, workspaceRefs: [ref, second], censusServerId: 'home',
            machines: new Map([[machine.id, machine]]) })).toBe(workspaceColors);
    });
});
