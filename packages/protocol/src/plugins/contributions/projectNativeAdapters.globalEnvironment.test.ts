import { describe, expect, it } from 'vitest';
import { listMachineEnvironmentAdaptersV1 } from './projectNativeAdapters.js';

describe('characterized global native environment adapters', () => {
    it('offers only native globals supported by the installed target platform contract', () => {
        expect(listMachineEnvironmentAdaptersV1('linux')).toEqual([{ id: 'mise', title: 'Mise', platform: 'linux', nativeVersion: '2026.10.4',
            globalEnvironment: { configFile: 'config.toml', installArgs: ['install'] } }]);
        expect(listMachineEnvironmentAdaptersV1('darwin')).toEqual([]);
        expect(listMachineEnvironmentAdaptersV1('win32')).toEqual([]);
    });
});
