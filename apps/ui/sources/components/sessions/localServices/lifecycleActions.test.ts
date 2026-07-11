import { describe, expect, it } from 'vitest';

import { isLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol';
import { buildManagedLocalServiceRow } from '@/dev/testkit';

import {
    buildDetectedLocalServiceTerminateRequest,
    buildManagedLocalServiceRestartRequest,
    buildManagedLocalServiceStopRequest,
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

    it('builds the canonical stop-managed LocalServiceActionRequestV1 input', () => {
        const request = buildManagedLocalServiceStopRequest({
            row: buildManagedLocalServiceRow({ id: 'managed-service-1', phase: 'running' }),
            machineId: 'machine-a',
            sessionId: 'session-a',
            requestId: 'request-a',
        });

        expect(request).toEqual({
            requestId: 'request-a',
            target: {
                kind: 'managed_service',
                managedServiceId: 'managed-service-1',
                machineId: 'machine-a',
                sessionId: 'session-a',
            },
            action: 'stop_managed',
            force: false,
            confirmationNonce: expect.stringMatching(/^lsact1_/),
        });
        expect(isLocalServiceActionConfirmationNonceV1(request)).toBe(true);
    });

    it('builds the canonical restart-managed LocalServiceActionRequestV1 input', () => {
        const request = buildManagedLocalServiceRestartRequest({
            row: buildManagedLocalServiceRow({
                id: 'managed-service-1',
                phase: 'running',
                supportedActions: ['stop_managed', 'restart_managed'],
            }),
            machineId: 'machine-a',
            sessionId: 'session-a',
            requestId: 'request-restart',
        });

        expect(request).toEqual({
            requestId: 'request-restart',
            target: {
                kind: 'managed_service',
                managedServiceId: 'managed-service-1',
                machineId: 'machine-a',
                sessionId: 'session-a',
            },
            action: 'restart_managed',
            force: false,
            confirmationNonce: expect.stringMatching(/^lsact1_/),
        });
        expect(isLocalServiceActionConfirmationNonceV1(request)).toBe(true);
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
