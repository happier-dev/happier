import { describe, expect, it } from 'vitest';

import { resolveExternalSessionOperationRowCapabilities } from './externalSessionOperationRowCapabilities';

describe('resolveExternalSessionOperationRowCapabilities', () => {
    it.each([
        ['public reader', false, true, true, true, false, 'online'],
        ['friend/read-only reader', false, true, true, true, false, 'online'],
        ['offline owner', true, true, true, false, false, 'offline'],
        ['unknown-machine owner', true, true, false, false, false, 'offline'],
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
