import type { Fastify } from '../../types';
import { z } from 'zod/mini';
import { ArtifactSignedInLinkCreateRequestV1Schema, ArtifactSignedInLinkJoinCommitInputV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { writeArtifactSignedInLink, listArtifactSignedInLinks, revokeArtifactSignedInLink,
    prepareArtifactSignedInLinkJoin, commitArtifactSignedInLinkJoin } from '@/app/share/artifactSignedInLink';
import { readRequestHomeEnv } from '@/app/home/settings/requestHomeEnv';
import { resolveEffectiveWebappBaseUrl } from '@/app/serverUrls/effectiveServerUrls';

const artifactParams = z.strictObject({ artifactId: z.string().check(z.minLength(1)) });
const lookupParams = z.strictObject({ lookupId: z.string().check(z.minLength(1)) });

/** Authenticated links share Artifact management Actions, independently of anonymous publication. */
export function registerArtifactSignedInLinkRoutes(app: Fastify): void {
    app.post('/v1/artifact-signed-in-links', { preHandler: app.authenticate,
        schema: { body: ArtifactSignedInLinkCreateRequestV1Schema } }, async (request, reply) => {
        const viewerOrigin = resolveEffectiveWebappBaseUrl(await readRequestHomeEnv(request));
        const result = await writeArtifactSignedInLink({ ...request.body, actorAccountId: request.userId });
        if (!result.ok) return reply.code(result.error === 'artifact_access_forbidden' ? 403 : 400).send({ error: result.error });
        return reply.send({ publicShare: result.value, viewerOrigin,
            ...(request.body.preserveExisting ? { created: result.created } : {}) });
    });
    app.get('/v1/artifact-signed-in-links', { preHandler: app.authenticate,
        schema: { querystring: artifactParams } }, async (request, reply) => {
        const result = await listArtifactSignedInLinks({ actorAccountId: request.userId, artifactId: request.query.artifactId });
        return result ? reply.send(result) : reply.code(403).send({ error: 'artifact_access_forbidden' });
    });
    app.delete('/v1/artifact-signed-in-links/:artifactId', { preHandler: app.authenticate,
        schema: { params: artifactParams } }, async (request, reply) => {
        const removed = await revokeArtifactSignedInLink({ actorAccountId: request.userId, artifactId: request.params.artifactId });
        return removed ? reply.send({ success: true }) : reply.code(403).send({ error: 'artifact_access_forbidden' });
    });
    app.get('/v1/artifact-signed-in-links/:lookupId/join', { preHandler: app.authenticate,
        schema: { params: lookupParams } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        const result = await prepareArtifactSignedInLinkJoin({ actorAccountId: request.userId, lookupId: request.params.lookupId });
        return result ? reply.send(result) : reply.code(404).send({ error: 'artifact_not_found' });
    });
    app.post('/v1/artifact-signed-in-links/:lookupId/join', { preHandler: app.authenticate,
        schema: { params: lookupParams, body: ArtifactSignedInLinkJoinCommitInputV1Schema } }, async (request, reply) => {
        const result = await commitArtifactSignedInLinkJoin({ ...request.body, actorAccountId: request.userId, lookupId: request.params.lookupId });
        if (result.ok) return reply.send(result.value);
        const status = result.error === 'artifact_not_found' ? 404 : result.error === 'artifact_access_forbidden' ? 403
            : result.error === 'recipient_key_unavailable' || result.error === 'recipient_key_changed' ? 409 : 400;
        return reply.code(status).send({ error: result.error, ...('reason' in result ? { reason: result.reason } : {}) });
    });
}
