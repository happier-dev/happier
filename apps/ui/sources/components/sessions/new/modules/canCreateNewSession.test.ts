import { describe, expect, it } from 'vitest';

import { canCreateNewSession } from '@/components/sessions/new/modules/canCreateNewSession';

describe('canCreateNewSession', () => {
    it('fails closed when machine is missing', () => {
        expect(canCreateNewSession({
            selectedMachineId: 'm1',
            selectedMachine: null,
            selectedPath: '/repo',
        })).toBe(false);
    });

    it('requires a selected machine id and a non-empty path', () => {
        const machine: any = { id: 'm1', active: true, activeAt: Date.now() };

        expect(canCreateNewSession({
            selectedMachineId: null,
            selectedMachine: machine,
            selectedPath: '/repo',
        })).toBe(false);

        expect(canCreateNewSession({
            selectedMachineId: 'm1',
            selectedMachine: machine,
            selectedPath: '   ',
        })).toBe(false);
    });

    it('returns false when selected machine is offline', () => {
        const offlineMachine: any = { id: 'm1', active: false, activeAt: 0 };
        expect(canCreateNewSession({
            selectedMachineId: 'm1',
            selectedMachine: offlineMachine,
            selectedPath: '/repo',
        })).toBe(false);
    });

    it('returns true when selected machine is online', () => {
        const onlineMachine: any = { id: 'm1', active: true, activeAt: 0 };
        expect(canCreateNewSession({
            selectedMachineId: 'm1',
            selectedMachine: onlineMachine,
            selectedPath: '/repo',
        })).toBe(true);
    });
});

