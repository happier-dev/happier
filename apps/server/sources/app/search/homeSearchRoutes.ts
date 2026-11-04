import { MemorySearchQueryV1Schema, MemorySearchResultV1Schema, type MemorySearchQueryV1, type MemorySearchResultV1, type MemorySearchScope } from '@happier-dev/protocol/memory/memorySearch';
import { z } from 'zod/mini';
import type { Fastify } from '@/app/api/types';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { requirePresentUser } from '@/app/api/utils/requirePresentUser';
import { createServerFeatureGatedRouteApp } from '@/app/features/catalog/serverFeatureGate';
import type { HomeSearchCapability } from './homeSearchCapability';
import type { HomeSearchRequestContext } from './homeSearchService';
import { readSessionAccessAuthenticationFromRequest, type SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { isPersonalHomeRuntimePurpose } from '@/app/runtime/personalHomeRuntimePurpose';

const HomeSearchRebuildResponseSchema = z.strictObject({ ok: z.literal(true) });

/** Registers authenticated Personal Home search and local repair operations. */
export function registerHomeSearchRoutes(app: Fastify, params: Readonly<{
    service: Readonly<{
        capability(): HomeSearchCapability;
        prepare(sessionIds: readonly string[]): Promise<void>;
        search(query: MemorySearchQueryV1, context?: HomeSearchRequestContext): MemorySearchResultV1;
        invalidateAndRebuild(reason: 'explicit-repair'): Promise<void>;
    }>;
    resolveVisibleSessions: (userId: string, authentication: SessionAccessAuthentication, scope: MemorySearchScope) => Promise<NonNullable<HomeSearchRequestContext['visibleSessions']>>;
    env?: NodeJS.ProcessEnv;
}>): void {
    const env = params.env ?? process.env;
    const gated = createServerFeatureGatedRouteApp(app, 'search', env);
    gated.post('/v1/home/search', {
        schema: {
            body: MemorySearchQueryV1Schema,
            response: { 200: MemorySearchResultV1Schema },
        },
        preHandler: [app.authenticate, requirePresentUser],
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'session.messages') },
    }, async (request, reply) => {
        const visibleSessions = await params.resolveVisibleSessions(
            request.userId,
            readSessionAccessAuthenticationFromRequest(request),
            request.body.scope,
        );
        await params.service.prepare(visibleSessions.map(session => session.sessionId));
        return reply.send(params.service.search(request.body, { visibleSessions }));
    });
    // This is a local Personal Home maintenance operation. Hosted deployments
    // have no present-user authority to rebuild the shared derived index.
    if (!isPersonalHomeRuntimePurpose(env.HAPPIER_MANAGED_RELAY_PURPOSE)) return;
    gated.post('/v1/home/search/rebuild', {
        schema: { response: { 200: HomeSearchRebuildResponseSchema } },
        preHandler: [app.authenticate, requirePresentUser],
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') },
    }, async (_request, reply) => {
        await params.service.invalidateAndRebuild('explicit-repair');
        return reply.send({ ok: true as const });
    });
}
