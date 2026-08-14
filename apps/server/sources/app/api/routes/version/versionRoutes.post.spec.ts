import { describe, expect, it } from 'vitest';

import { createRouteTestBuilder } from '../../testkit/routeTestBuilder';
import { versionRoutes } from './versionRoutes';

describe('versionRoutes POST /v1/version', () => {
    async function invoke(body: Record<string, unknown>) {
        const route = createRouteTestBuilder({
            method: 'POST',
            path: '/v1/version',
            registerRoutes(app) {
                versionRoutes(app as never);
            },
        });
        const { reply, response } = await route.invoke({ body });
        return {
            statusCode: reply.statusCode as number,
            response: response ?? reply.send.mock.calls.at(-1)?.[0],
        };
    }

    it('keeps the legacy version probe available without coupling it to session capabilities', async () => {
        await expect(invoke({
            platform: 'ios',
            version: '0.2.10',
            app_id: 'dev.happier.app',
        })).resolves.toEqual({
            statusCode: 200,
            response: { update_required: false, update_url: null },
        });
    });
});
