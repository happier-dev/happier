import { describe, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { homeHasMachine, isThisComputerMachineOfHome, resolveMachineAddInitialPath, resolveMachineAddPaths } from './machineAddPaths';

const policy = { allowLocalMachineSetup: true, allowRemoteSshMachineSetup: true };
const base = { policy, thisComputerJoined: false, nativeSshAvailable: false };

describe('machine add paths', () => {
    it('offers desktop tasks in order; an already joined computer stays, marked connected with its machine (lab agent-setup S1)', () => {
        expect(resolveMachineAddPaths({ ...base, device: 'desktop' })).toEqual([
            { id: 'thisComputer', runs: 'task' }, { id: 'ssh', runs: 'task' }, { id: 'anotherComputer', runs: 'command' },
        ]);
        expect(resolveMachineAddPaths({ ...base, device: 'desktop', thisComputerJoined: true, thisComputerMachineId: 'machine-1' })).toEqual([
            { id: 'thisComputer', runs: 'task', connectedMachineId: 'machine-1' }, { id: 'ssh', runs: 'task' }, { id: 'anotherComputer', runs: 'command' },
        ]);
    });
    it('offers browser commands even when a different computer is already joined', () => {
        expect(resolveMachineAddPaths({ ...base, device: 'browser', thisComputerJoined: true })).toEqual([
            { id: 'thisComputer', runs: 'command' }, { id: 'ssh', runs: 'command' }, { id: 'anotherComputer', runs: 'command' },
        ]);
    });
    it('offers phone SSH only with its native transport, and obeys build policy', () => {
        expect(resolveMachineAddPaths({ ...base, device: 'phone' })).toEqual([{ id: 'anotherComputer', runs: 'command' }]);
        expect(resolveMachineAddPaths({ ...base, device: 'phone', nativeSshAvailable: true })).toEqual([
            { id: 'ssh', runs: 'task' }, { id: 'anotherComputer', runs: 'command' },
        ]);
        expect(resolveMachineAddPaths({ ...base, device: 'desktop', policy: { allowLocalMachineSetup: false, allowRemoteSshMachineSetup: false } }).map((p) => p.id)).toEqual([]);
    });
    it('defaults by available capability, preserves an explicit path and supports SSH-only builds', () => {
        const phone = resolveMachineAddPaths({ ...base, device: 'phone', nativeSshAvailable: true });
        expect(resolveMachineAddInitialPath(phone)).toBe('anotherComputer');
        expect(resolveMachineAddInitialPath(phone, 'ssh')).toBe('ssh');
        expect(resolveMachineAddInitialPath(resolveMachineAddPaths({ ...base, device: 'browser' }))).toBe('thisComputer');
        expect(resolveMachineAddInitialPath(resolveMachineAddPaths({ ...base, device: 'desktop' }))).toBe('thisComputer');
        expect(resolveMachineAddInitialPath([{ id: 'ssh', runs: 'task' }])).toBe('ssh');
        expect(resolveMachineAddInitialPath([])).toBeNull();
    });
    it('preserves the joined desktop Add another choice while excluding the connected computer', () => {
        const desktop = resolveMachineAddPaths({ ...base, device: 'desktop', thisComputerJoined: true, thisComputerMachineId: 'local' });
        expect(resolveMachineAddInitialPath(desktop, undefined, true)).toBe('ssh');
        const phone = resolveMachineAddPaths({ ...base, device: 'phone', nativeSshAvailable: true });
        expect(resolveMachineAddInitialPath(phone, undefined, true)).toBe('anotherComputer');
    });
    it('counts offline but not revoked machines and compares this computer by id', () => {
        const machine = createMachineFixture({ id: 'local', active: false });
        expect(homeHasMachine(null)).toBeNull();
        expect(homeHasMachine([machine])).toBe(true);
        expect(homeHasMachine([{ ...machine, revokedAt: 1 }])).toBe(false);
        expect(isThisComputerMachineOfHome('local', [machine])).toBe(true);
        expect(isThisComputerMachineOfHome('other', [machine])).toBe(false);
        expect(isThisComputerMachineOfHome('local', [{ ...machine, revokedAt: 1 }])).toBe(false);
    });
    it('removes only the machine path family excluded by the build policy', () => {
        expect(resolveMachineAddPaths({ ...base, device: 'desktop', policy: {
            allowLocalMachineSetup: false, allowRemoteSshMachineSetup: true,
        } })).toEqual([{ id: 'ssh', runs: 'task' }]);
        expect(resolveMachineAddPaths({ ...base, device: 'browser', policy: {
            allowLocalMachineSetup: true, allowRemoteSshMachineSetup: false,
        } })).toEqual([{ id: 'thisComputer', runs: 'command' }, { id: 'anotherComputer', runs: 'command' }]);
    });
});
