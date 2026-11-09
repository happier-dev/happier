import type { Fastify } from '../../types';
import { z } from 'zod/mini';
import { PublicProfileReadResultV1Schema, PublicProfileOwnerReadV1Schema, PublicProfileMutationResultV1Schema, PublicProfilePublishBodyV1Schema,
    PublicProfileUpdateBodyV1Schema, PublicProfileRefreshBodyV1Schema, PublicProfileReportRequestV1Schema,
    PublicProfileReportResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { readRequestHomeEnv } from '@/app/home/settings/requestHomeEnv';
import { publishPublicProfile, resumePublicProfile } from '@/app/account/profile/publicProfilePublish';
import { updatePublicProfile } from '@/app/account/profile/publicProfileUpdate';
import { refreshPublicProfile } from '@/app/account/profile/publicProfileRefresh';
import { pausePublicProfile } from '@/app/account/profile/publicProfilePause';
import { unpublishPublicProfile } from '@/app/account/profile/publicProfileUnpublish';
import { readPublicProfileForAccount, readPublicProfileOwner } from '@/app/account/profile/publicProfileRead';
import { buildPublicProfileEmbed, PublicEmbedInputV1Schema, PublicEmbedResultV1Schema } from '@happier-dev/protocol/account/publicProfileEmbeds';
import type { PublicProfileServerDependencies } from '@/app/account/profile/publicProfileStorage';
import { publicProfileServerDependencies } from '@/app/account/profile/publicProfileDependencies';
import { moderatePublicProfile } from '@/app/account/profile/publicProfileModeration';
import { readPublicProfileReportUrl } from '@/app/account/profile/publicProfileContext';
import { createServerFeatureGatePreHandler } from '@/app/features/catalog/serverFeatureGate';
import { HomePublicProfileHandleReclaimInputV1Schema, HomePublicProfileHandleReclaimResultV1Schema,
    HomeAccountTargetInputV1Schema, HomePublicProfileModerationBodyV1Schema,
    HomePublicProfileModerationResultV1Schema } from '@happier-dev/protocol/home/governance';
import { homeDomainActionTransportV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { reclaimPublicProfileHandle } from '@/app/account/profile/publicProfileHandleReclaim';
import { AccountUsernameUpdateErrorV1Schema } from '@happier-dev/protocol/account/profile';

/** Authenticated intent transports share lifecycle owners; revocation is never feature-gated away. */
export function registerAccountPublicProfileRoutes(app: Fastify, deps: PublicProfileServerDependencies = publicProfileServerDependencies): void {
    const mutationResponse = { 200: PublicProfileMutationResultV1Schema };
    const publicationAdmission = [app.authenticate, createServerFeatureGatePreHandler('account.publicProfiles', process.env,
        { kind: 'unavailable', reason: 'feature_disabled' }, 200)];
    app.get('/v1/account/public-profile', { preHandler: app.authenticate, schema: { response: { 200: PublicProfileOwnerReadV1Schema } } },
        async (request, reply) => reply.send(await readPublicProfileOwner(request.userId, await readRequestHomeEnv(request), deps)));
    app.get('/v1/account/public-profile/view', { preHandler: app.authenticate,
        schema: { querystring: z.strictObject({}), response: { 200: PublicProfileReadResultV1Schema } } },
        async (request, reply) => reply.send(await readPublicProfileForAccount(request.userId, await readRequestHomeEnv(request), deps)));
    app.get('/v1/account/public-profile/embed', { preHandler: app.authenticate,
        schema: { querystring: PublicEmbedInputV1Schema, response: { 200: PublicEmbedResultV1Schema } } },
        async (request, reply) => {
            const env = await readRequestHomeEnv(request);
            const owner = await readPublicProfileOwner(request.userId, env, deps);
            if (owner.kind !== 'ready' || owner.record.state !== 'published' || owner.record.restriction) {
                return reply.send({ kind: 'unavailable', reason: 'not_published' });
            }
            const current = await readPublicProfileForAccount(request.userId, env, deps);
            return reply.send(current.kind === 'unavailable'
                ? { kind: 'unavailable', reason: 'service_unavailable' }
                : buildPublicProfileEmbed(current, request.query));
        });
    app.get('/v1/account/public-profile/report', { preHandler: app.authenticate,
        schema: { querystring: PublicProfileReportRequestV1Schema, response: { 200: PublicProfileReportResultV1Schema } } },
        async (request, reply) => {
            const url = readPublicProfileReportUrl(await readRequestHomeEnv(request), request.query.handle);
            return reply.send(url ? { kind: 'ready', url } : { kind: 'unavailable', reason: 'report_contact_unconfigured' });
        });
    app.post('/v1/account/public-profile/publish', { preHandler: publicationAdmission, schema: { body: PublicProfilePublishBodyV1Schema, response: mutationResponse } },
        async (request, reply) => reply.send(await publishPublicProfile(request.userId, request.body, await readRequestHomeEnv(request), deps)));
    app.put('/v1/account/public-profile/policy', { preHandler: publicationAdmission, schema: { body: PublicProfileUpdateBodyV1Schema, response: mutationResponse } },
        async (request, reply) => reply.send(await updatePublicProfile(request.userId, request.body)));
    app.put('/v1/account/public-profile/snapshot', { preHandler: publicationAdmission, schema: { body: PublicProfileRefreshBodyV1Schema, response: mutationResponse } },
        async (request, reply) => reply.send(await refreshPublicProfile(request.userId, request.body, await readRequestHomeEnv(request), deps)));
    app.post('/v1/account/public-profile/resume', { preHandler: publicationAdmission, schema: { body: PublicProfileRefreshBodyV1Schema, response: mutationResponse } },
        async (request, reply) => reply.send(await resumePublicProfile(request.userId, request.body, await readRequestHomeEnv(request), deps)));
    app.post('/v1/account/public-profile/pause', { preHandler: app.authenticate, schema: { body: z.strictObject({}), response: mutationResponse } },
        async (request, reply) => reply.send(await pausePublicProfile(request.userId)));
    app.delete('/v1/account/public-profile', { preHandler: app.authenticate, schema: { response: mutationResponse } },
        async (request, reply) => reply.send(await unpublishPublicProfile(request.userId)));

    app.post(homeDomainActionTransportV1('home.public_profiles.handle_reclaim').path, {
        preHandler: app.authenticate,
        schema: {
            params: z.strictObject({ accountId: HomePublicProfileHandleReclaimInputV1Schema.shape.accountId }),
            body: z.strictObject({ username: HomePublicProfileHandleReclaimInputV1Schema.shape.username,
                reason: HomePublicProfileHandleReclaimInputV1Schema.shape.reason, notice: HomePublicProfileHandleReclaimInputV1Schema.shape.notice }),
            response: { 200: HomePublicProfileHandleReclaimResultV1Schema,
                403: z.strictObject({ error: z.literal('home_governance_forbidden') }),
                404: z.strictObject({ error: z.literal('home_account_not_found') }),
                409: AccountUsernameUpdateErrorV1Schema },
        },
    }, async (request, reply) => {
        const result = await reclaimPublicProfileHandle(request.userId, { accountId: request.params.accountId, ...request.body });
        if ('kind' in result) {
            if (result.kind === 'forbidden') return reply.code(403).send({ error: 'home_governance_forbidden' });
            if (result.kind === 'not_found') return reply.code(404).send({ error: 'home_account_not_found' });
            return reply.code(409).send({ error: 'username-changed' });
        }
        return reply.send(result);
    });

    for (const operation of ['restrict', 'restore'] as const) {
        app.post(homeDomainActionTransportV1(`home.public_profiles.${operation}`).path, {
            preHandler: app.authenticate, schema: { params: HomeAccountTargetInputV1Schema, body: HomePublicProfileModerationBodyV1Schema,
                response: { 200: HomePublicProfileModerationResultV1Schema, 403: z.strictObject({ error: z.literal('home_governance_forbidden') }),
                    404: z.strictObject({ error: z.literal('home_account_not_found') }) } },
        }, async (request, reply) => {
            const result = await moderatePublicProfile(request.userId, request.params.accountId, operation, request.body.reason);
            if (result.kind === 'forbidden') return reply.code(403).send({ error: 'home_governance_forbidden' });
            if (result.kind === 'not_found') return reply.code(404).send({ error: 'home_account_not_found' });
            return reply.send(result);
        });
    }
}
