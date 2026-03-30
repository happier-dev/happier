import { describe, expect, it } from 'vitest';

import { resolveSessionHandoffSourceMachineId } from './resolveSessionHandoffSourceMachineId';

describe('resolveSessionHandoffSourceMachineId', () => {
    it('prefers the reachable machine id when provided', () => {
        expect(resolveSessionHandoffSourceMachineId({
            reachableMachineId: ' machine_reachable ',
            sourceMachineId: ' machine_explicit ',
            sessionMetadata: { machineId: 'machine_meta' },
        })).toBe('machine_reachable');
    });

    it('falls back to the explicit sourceMachineId when no reachable machine id is available', () => {
        expect(resolveSessionHandoffSourceMachineId({
            reachableMachineId: '   ',
            sourceMachineId: ' machine_explicit ',
            sessionMetadata: { machineId: 'machine_meta' },
        })).toBe('machine_explicit');
    });

    it('falls back to session metadata machineId', () => {
        expect(resolveSessionHandoffSourceMachineId({
            sourceMachineId: null,
            sessionMetadata: { machineId: ' machine_meta ' },
        })).toBe('machine_meta');
    });

    it('falls back to directSessionV1.machineId when machineId is missing', () => {
        expect(resolveSessionHandoffSourceMachineId({
            sourceMachineId: null,
            sessionMetadata: { directSessionV1: { machineId: ' machine_direct ' } },
        })).toBe('machine_direct');
    });

    it('returns null when no non-empty id is available', () => {
        expect(resolveSessionHandoffSourceMachineId({
            sourceMachineId: '   ',
            sessionMetadata: { machineId: null, directSessionV1: { machineId: '' } },
        })).toBeNull();
    });
});
