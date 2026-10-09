import { expect, it } from 'vitest';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerProjectAccountRowRoutes } from './registerProjectAccountRowRoutes';

it('admits only the strict Account row request at its authenticated transport front door', async () => {
    await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
        const response = await app.inject({ method: 'POST', url: '/v1/account/project-rows/list',
            headers: { 'x-test-user-id': 'account' }, payload: { unauthorizedField: true } });
        expect(response.statusCode).toBe(400);
    });
});
