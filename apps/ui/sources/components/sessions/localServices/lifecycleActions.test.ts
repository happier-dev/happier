import { describe, expect, it } from 'vitest';

import { isLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol';

import {
    buildDetectedLocalServiceTerminateRequest,
    createLocalServiceActionRequestId,
} from './lifecycleActions';

describe('local service lifecycle action helpers', () => {
    it('generates bounded request ids for action correlation', () => {
        const first = createLocalServiceActionRequestId();
        const second = createLocalServiceActionRequestId();

        expect(first).toMatch(/^local-service-action-request:/);
        expect(second).toMatch(/^local-service-action-request:/);
        expect(first).not.toBe(second);
        expect(first.length).toBeLessThanOrEqual(256);
    });



    it('builds the canonical terminate-detected LocalServiceActionRequestV1 input', () => {
        const request = buildDetectedLocalServiceTerminateRequest({
            inventoryEntryId: 'inventory-entry-1',
            machineId: 'machine-a',
            sessionId: 'session-a',
            requestId: 'request-terminate',
        });

        expect(request).toEqual({
            requestId: 'request-terminate',
            target: {
                kind: 'inventory_entry',
                inventoryEntryId: 'inventory-entry-1',
                machineId: 'machine-a',
                sessionId: 'session-a',
            },
            action: 'terminate_detected',
            force: false,
            confirmationNonce: expect.stringMatching(/^lsact1_/),
        });
        expect(isLocalServiceActionConfirmationNonceV1(request)).toBe(true);
    });
});
