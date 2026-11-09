import { describe, expect, it } from 'vitest';
import { listMachineSetupAdaptersV1, MachineSetupToolchainSoftwareChoiceV1Schema,
    projectMachineSetupToolchainSoftwareOptionsV1 } from './projectNativeAdapters.js';

describe('characterized global native environment adapters', () => {
    it('offers language configuration through the same native qualification, without versions or recipe identities', () => {
        const supported = projectMachineSetupToolchainSoftwareOptionsV1({ platform: 'linux', arch: 'x64' });
        expect(supported.map(option => MachineSetupToolchainSoftwareChoiceV1Schema.parse(option.value))).toEqual([
            { kind: 'toolchain', adapterId: 'mise', tool: 'node' },
            { kind: 'toolchain', adapterId: 'mise', tool: 'python' },
        ]);
        expect(supported.every(option => option.disabled !== true)).toBe(true);
        for (const target of [{ platform: 'darwin', arch: 'x64' }, { platform: 'win32', arch: 'x64' },
            { platform: 'linux', arch: 'arm64' }, { platform: 'linux' }]) {
            expect(projectMachineSetupToolchainSoftwareOptionsV1(target)).toEqual(supported.map(option => ({
                ...option, disabled: true, description: expect.any(String),
            })));
        }
        expect(MachineSetupToolchainSoftwareChoiceV1Schema.safeParse({
            ...supported[0]!.value, version: '22', config: '[tools]\nnode="22"',
        }).success).toBe(false);
    });
    it('offers only native globals supported by the installed target platform contract', () => {
        expect(listMachineSetupAdaptersV1('linux')).toEqual([expect.objectContaining({ id: 'mise', title: 'Mise', platform: 'linux', nativeVersion: '2026.10.4',
            globalEnvironment: { configFile: 'config.toml', installArgs: ['install'] } })]);
        expect(listMachineSetupAdaptersV1('darwin')).toEqual([]);
        expect(listMachineSetupAdaptersV1('win32')).toEqual([]);
    });
});
