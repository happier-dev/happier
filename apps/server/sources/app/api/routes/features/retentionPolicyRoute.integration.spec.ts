import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRouteTestBuilder } from '../../testkit/routeTestBuilder';

describe('GET /v2/retention-policy', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('reports dev-only and predecessor retention domains through a complete extensible payload', async () => {
        vi.stubEnv('HAPPIER_SERVER_RETENTION__ENABLED', '1');
        vi.stubEnv('HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__MODE', 'delete_older_than');
        vi.stubEnv('HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__DAYS', '7');
        vi.stubEnv('HAPPIER_SERVER_RETENTION__USAGE_EVENTS__MODE', 'delete_older_than');
        vi.stubEnv('HAPPIER_SERVER_RETENTION__USAGE_EVENTS__DAYS', '180');

        const { featuresRoutes } = await import('./featuresRoutes');
        const route = createRouteTestBuilder({
            method: 'GET',
            path: '/v2/retention-policy',
            registerRoutes(app) {
                featuresRoutes(app as any);
            },
        });
        const { response } = await route.invoke();

        expect(response).toMatchObject({ version: 2, enabled: true, complete: true });
        expect((response as any).domains).toEqual(expect.arrayContaining([
            { id: 'sessionSidechainMessages', policy: { mode: 'delete_older_than', days: 7 } },
            { id: 'usageEvents', policy: { mode: 'delete_older_than', days: 180 } },
        ]));
    });
});
