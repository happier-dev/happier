import { describe, expect, it } from 'vitest';

import { resolveSessionHandoffPickerSourceMachineId } from './resolveSessionHandoffPickerSourceMachineId';

describe('resolveSessionHandoffPickerSourceMachineId', () => {
    it('prefers the current session metadata machine id over a divergent source machine hint', () => {
        expect(resolveSessionHandoffPickerSourceMachineId({
            sourceMachineId: ' machine_target ',
            sessionMetadata: { machineId: ' machine_source ' },
        })).toBe('machine_source');
    });

    it('falls back to directSessionV1.machineId when machineId is missing', () => {
        expect(resolveSessionHandoffPickerSourceMachineId({
            sourceMachineId: ' machine_target ',
            sessionMetadata: { directSessionV1: { machineId: ' machine_direct ' } },
        })).toBe('machine_direct');
    });

    it('falls back to the provided source machine id when session metadata is missing', () => {
        expect(resolveSessionHandoffPickerSourceMachineId({
            sourceMachineId: ' machine_target ',
            sessionMetadata: null,
        })).toBe('machine_target');
    });

    it('returns null when no non-empty machine id is available', () => {
        expect(resolveSessionHandoffPickerSourceMachineId({
            sourceMachineId: '   ',
            sessionMetadata: { machineId: null, directSessionV1: { machineId: '' } },
        })).toBeNull();
    });
});
