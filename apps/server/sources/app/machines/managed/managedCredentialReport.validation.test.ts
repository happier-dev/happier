import { describe, expect, it } from 'vitest';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerManagedMachineRoutes } from './managedRoutes';

describe('managed native credential report HTTP validation', () => {
    it.each([
        { phase: 'submitted' },
        { result: { kind: 'unknown', code: 'credential_unavailable' } },
    ])('requires controller identity before accepting a credential report: %j', async (disposition) => {
        // Only HTTP authentication is supplied by the canonical fixture; route
        // registration, wire validation and Action proof admission remain real.
        const app = createAuthenticatedTestApp();
        registerManagedMachineRoutes(app);
        const payload = {
            homeId: 'report-home', managedId: 'report-managed', expectedIntentRevision: 0, requestId: 'report-request',
            credentialDelivery: {
                request: { homeId: 'report-home', managedId: 'report-managed', sessionId: 'report-session',
                    bindingKey: 'report-binding', expectedResourceRevision: 0,
                    expectedSourceRevision: 'report-source', expectedProviderTicket: 'report-ticket' },
                ...disposition,
            },
        };
        const post = (body: unknown) => app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report',
            headers: { 'x-test-user-id': 'report-account' }, payload: body });
        try {
            const malformed = await post(payload);
            expect(malformed.statusCode, malformed.body).toBe(400);
            const valid = await post({ ...payload, controller: { machineId: 'report-controller', installationId: 'report-installation' } });
            expect(valid.statusCode, valid.body).toBe(403);
        } finally {
            await app.close();
        }
    });
});
