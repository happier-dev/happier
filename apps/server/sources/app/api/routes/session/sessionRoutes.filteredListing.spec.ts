import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDbMocks, inTxPostgresControlStatementMock } from '@/app/api/testkit/dbMocks';
import { getRouteEntry } from '@/app/api/testkit/routeHarness';
import { createRouteTestBuilder } from '@/app/api/testkit/routeTestBuilder';
import { registerSessionFilteredListingRoute } from './registerSessionFilteredListingRoute';
import { homeConfigSnapshotPostgresQueryMock } from '@/app/home/settings/homeConfigSnapshot.testkit';

const boundary = vi.hoisted(() => ({ db: undefined as unknown }));
// Replace only persistence; Home configuration and feature admission stay real.
vi.mock('@/storage/db', () => ({ get db() { return boundary.db; } }));

describe('POST /v2/sessions/query activation', () => {
    beforeEach(() => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        const mocks = createDbMocks({ homeSettings: ['findUnique'], homeGovernancePolicy: ['findUnique'],
            simpleCache: ['findUnique'] });
        mocks.db.homeSettings.findUnique.mockResolvedValue(null);
        mocks.db.homeGovernancePolicy.findUnique.mockResolvedValue(null);
        mocks.db.simpleCache.findUnique.mockResolvedValue({ value: 'srv_test_home' });
        const reader = { ...mocks.db, ...inTxPostgresControlStatementMock, ...homeConfigSnapshotPostgresQueryMock };
        boundary.db = { ...reader, $transaction: async (read: (tx: typeof reader) => Promise<unknown>) => read(reader) };
    });
    afterEach(() => vi.unstubAllEnvs());

    it('declares only the reachable strict response contracts', () => {
        const route = createRouteTestBuilder({
            method: 'POST',
            path: '/v2/sessions/query',
            registerRoutes: (app) => registerSessionFilteredListingRoute(app as never),
        });
        const response = (getRouteEntry(route.app, 'POST', '/v2/sessions/query').opts.schema as {
            response: Record<number, unknown>;
        }).response;

        expect(Object.keys(response).sort()).toEqual(['200', '400', '403', '404', '409']);
    });

    it('admits only a proof-bound session.list PAT effect through the canonical auth owner', () => {
        const route = createRouteTestBuilder({
            method: 'POST',
            path: '/v2/sessions/query',
            registerRoutes: (app) => registerSessionFilteredListingRoute(app as never),
        });

        const config = getRouteEntry(route.app, 'POST', '/v2/sessions/query').opts.config;
        expect(config).toMatchObject({
        });
        expect(config?.allowApiToken).toBeUndefined();
    });

    it('registers the endpoint and refuses before authentication only under the operator opt-out', async () => {
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_FILTERED_LISTING__ENABLED', '0');
        const route = createRouteTestBuilder({
            method: 'POST',
            path: '/v2/sessions/query',
            registerRoutes: (app) => registerSessionFilteredListingRoute(app as never),
        });
        expect(route.routeExists).toBe(true);

        const { reply } = await route.invoke({
            body: {
                v: 1,
                storage: 'active',
                includeInactive: false,
                scope: 'my_work',
                attention: 'any',
                audiences: { include: [], exclude: [] },
                tagIds: { include: [], exclude: [] },
            },
        });

        expect(reply.statusCode).toBe(404);
        expect(reply.send).toHaveBeenCalledWith({ error: 'not_found' });
        expect(route.app.authenticate).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'following',
            env: { HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: '0' },
            body: {
                v: 1,
                storage: 'active',
                includeInactive: false,
                scope: 'following',
                attention: 'any',
                audiences: { include: [], exclude: [] },
                tagIds: { include: [], exclude: [] },
            },
            reason: 'following',
        },
        {
            name: 'audience',
            env: { HAPPIER_BUILD_FEATURES_DENY: 'sharing.session' },
            body: {
                v: 1,
                storage: 'active',
                includeInactive: false,
                scope: 'my_work',
                attention: 'any',
                audiences: { include: [{ kind: 'team', teamId: 'team-1' }], exclude: [] },
                tagIds: { include: [], exclude: [] },
            },
            reason: 'audience',
        },
    ] as const)('returns the Protocol unavailable response only for a missing $name producer', async ({ env, body, reason }) => {
        for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
        const route = createRouteTestBuilder({
            method: 'POST',
            path: '/v2/sessions/query',
            registerRoutes: (app) => registerSessionFilteredListingRoute(app as never),
        });

        const request = route.createAuthenticatedRequest({
            body,
            authAuthority: 'present_user',
        });
        const reply = route.createReply();
        await getRouteEntry(route.app, 'POST', '/v2/sessions/query').handler(request, reply);

        expect(reply.statusCode).toBe(404);
        expect(reply.send).toHaveBeenCalledWith({
            error: 'not_found',
            code: 'filtered_session_listing_unavailable',
            reason,
        });
        expect(route.app.authenticate).not.toHaveBeenCalled();
    });
});
