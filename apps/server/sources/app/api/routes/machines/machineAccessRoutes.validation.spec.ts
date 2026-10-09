import { describe, expect, it } from 'vitest';
import { withAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { machinesRoutes } from './machinesRoutes';

describe('Machine access request admission', () => {
    it('requires authenticated present-user authority before entering the access owner', async () => {
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const response = await app.inject({ method: 'GET', url: '/v1/machines/unknown/access' });
            expect(response.statusCode, response.body).toBe(401);
        });
    });

    it('rejects invalid Machine roles and caller-authored authority before database effects', async () => {
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            for (const payload of [
                { principal: { kind: 'account', accountId: 'recipient' }, level: 'edit' },
                { principal: { kind: 'account', accountId: 'recipient' }, level: 'view', actorAccountId: 'owner' },
            ]) {
                const response = await app.inject({
                    method: 'PUT', url: '/v1/machines/unknown/access',
                    headers: { 'x-test-user-id': 'owner' }, payload,
                });
                expect(response.statusCode, response.body).toBe(400);
            }
        });
    });

    it('does not let an unadmitted bearer token read Machine access or its key-holder continuation', async () => {
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            for (const suffix of ['access', 'data-key-envelopes']) {
                const response = await app.inject({
                    method: 'GET', url: `/v1/machines/unknown/${suffix}`,
                    headers: { 'x-test-user-id': 'owner', 'x-test-auth-token-kind': 'api_token' },
                });
                expect(response.statusCode, response.body).toBe(403);
            }
        });
    });
});
