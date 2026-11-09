import { describe, expect, it } from 'vitest';

import { isSessionMachineAccessRemoved } from './sessionMachineAccessRemoved';

describe('isSessionMachineAccessRemoved', () => {
    it('settles removal from the exact machine inventory and retracts it when the machine returns', () => {
        const input = { session: {}, machineId: 'machine-a', inventorySettled: true, machinePresent: false };
        expect(isSessionMachineAccessRemoved(input)).toBe(true);
        expect(isSessionMachineAccessRemoved({ ...input, inventorySettled: false })).toBe(false);
        expect(isSessionMachineAccessRemoved({ ...input, machinePresent: true })).toBe(false);
    });

    it('does not infer removed machine access from a recipient session or a missing target', () => {
        const input = { session: {}, machineId: 'machine-a', inventorySettled: true, machinePresent: false };
        expect(isSessionMachineAccessRemoved({ ...input, session: { accessLevel: 'view' } })).toBe(false);
        expect(isSessionMachineAccessRemoved({ ...input, session: { access: null } })).toBe(false);
        expect(isSessionMachineAccessRemoved({ ...input, machineId: null })).toBe(false);
        expect(isSessionMachineAccessRemoved({ ...input, session: null })).toBe(false);
    });
});
