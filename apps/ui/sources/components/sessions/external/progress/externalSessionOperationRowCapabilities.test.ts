import { describe, expect, it } from 'vitest';

import { resolveExternalSessionOperationRowCapabilities } from './externalSessionOperationRowCapabilities';

describe('resolveExternalSessionOperationRowCapabilities', () => {
    it.each([
        ['public reader', false, true, true, true, false, 'online'],
        ['friend/read-only reader', false, true, true, true, false, 'online'],
        ['offline owner', true, true, true, false, false, 'offline'],
        // Absent machine status is an absence of knowledge, not a confirmed fact
        // about the origin: a reader without a machine subscription never observes
        // liveness, so the row must say "unknown" and still refuse owner actions.
        ['unknown-machine owner', true, true, false, false, false, 'unknown'],
        ['reader without a machine subscription', false, true, false, false, false, 'unknown'],
        ['unknown status that still reports online', true, true, false, true, false, 'unknown'],
        ['online owner', true, true, true, true, true, 'online'],
    ] as const)(
        '%s gets truthful owner-action availability',
        (
            _name,
            canSendMessages,
            hasOperationMachineTarget,
            machineStatusKnown,
            machineOnline,
            canInvokeOwnerActions,
            originAvailability,
        ) => {
            expect(resolveExternalSessionOperationRowCapabilities({
                canSendMessages,
                hasOperationMachineTarget,
                machineStatusKnown,
                machineOnline,
            })).toEqual({
                canInvokeOwnerActions,
                originAvailability,
            });
        },
    );
});
