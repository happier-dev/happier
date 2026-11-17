import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { homeHasMachine, isThisComputerMachineOfHome, resolveMachineAddInitialPath, resolveMachineAddPaths } from './machineAddPaths';
import { readMachineAddDevice } from './useMachineAddPaths';

vi.mock('react-native', async () => (
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock()
));

afterEach(() => vi.unstubAllGlobals());

const policy = { allowLocalMachineSetup: true, allowRemoteSshMachineSetup: true };
const base = { policy, thisComputerJoined: false, nativeSshAvailable: false };

describe('machine add paths', () => {
    it.each([
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15',
        'Mozilla/5.0 (Linux; Android 15) Mobile',
    ])('offers SSH commands and pairing on a mobile browser: %s', (userAgent) => {
        vi.stubGlobal('navigator', { userAgent, maxTouchPoints: 5 });
        vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
        const device = readMachineAddDevice();
        expect(device).toBe('mobileBrowser');
        const paths = resolveMachineAddPaths({ ...base, device });
        expect(paths).toEqual([{ id: 'ssh', runs: 'command' }, { id: 'anotherComputer', runs: 'command' }]);
        expect(resolveMachineAddInitialPath(paths)).toBe('anotherComputer');
        expect(resolveMachineAddPaths({ ...base, device, policy: {
            allowLocalMachineSetup: false, allowRemoteSshMachineSetup: true,
        } })).toEqual([{ id: 'ssh', runs: 'command' }]);
    });

    it('keeps install commands on a desktop browser with a touchscreen', () => {
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 5 });
        vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
        expect(readMachineAddDevice()).toBe('browser');
        expect(resolveMachineAddPaths({ ...base, device: readMachineAddDevice() })[0]).toEqual({ id: 'thisComputer', runs: 'command' });
    });

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
