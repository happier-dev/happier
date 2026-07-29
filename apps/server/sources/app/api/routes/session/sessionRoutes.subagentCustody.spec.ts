import { describe, expect, it } from 'vitest';

import { createFakeRouteApp } from '../../testkit/routeHarness';
import type { Fastify } from '../../types';
import { registerSessionSubagentCustodyRoutes } from './registerSessionSubagentCustodyRoutes';

describe('session durable subagent custody routes', () => {
    it('registers the complete authenticated prepare/expand surface', () => {
        const app = createFakeRouteApp();
        registerSessionSubagentCustodyRoutes(app as unknown as Fastify);

        expect([...app.routes.keys()].filter((key) => key.includes('subagents/custody'))).toEqual([
            'GET /v2/sessions/:sessionId/subagents/custody/capability',
            'GET /v2/sessions/:sessionId/subagents/custody',
            'POST /v2/sessions/:sessionId/subagents/custody/mutations',
            'POST /v2/session-subagents/custody/generation-retirements',
        ]);
    });
});
