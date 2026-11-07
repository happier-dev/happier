import type { FastifyReply } from 'fastify';
import { PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1 as paths, PluginCollectionSharingAddressV1Schema,
    PluginCollectionSharingSetGrantRequestV1Schema, PluginCollectionSharingRevokeGrantRequestV1Schema,
    PluginCollectionSharingCensusRequestV1Schema, PluginCollectionSharingCensusResponseV1Schema,
    PluginCollectionSharingGrantsResponseV1Schema, PluginCollectionSharingMutationResponseV1Schema,
    PluginCollectionSharingCommitKeysRequestV1Schema, PluginCollectionSharingCommitKeysResponseV1Schema,
    PluginCollectionSharingGetRequestV1Schema, PluginCollectionSharingResourceV1Schema,
    PluginCollectionSharingPutRequestV1Schema, PluginCollectionSharingListRequestV1Schema, PluginCollectionSharingListResponseV1Schema,
    PluginCollectionSharingErrorV1Schema } from '@happier-dev/protocol/plugins/data/collectionSharingV1';
import { listCollectionGrants, readCollectionRecipientCensus, setCollectionGrant, revokeCollectionGrant,
    commitCollectionRecipientKeys } from '@/app/plugins/data/collections/sharingAccessService';
import { CollectionSharingError, readSharedCollectionResource, putSharedCollectionResource,
    listSharedCollectionResources } from '@/app/plugins/data/collections/sharingResourceService';
import { PluginCollectionReadOperationError } from '@/app/plugins/data/collections/uiQuery';
import { PluginCollectionMutationOperationError } from '@/app/plugins/data/collections/mutation';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import type { Fastify } from '@/app/api/types';

const failures = { 400: PluginCollectionSharingErrorV1Schema, 403: PluginCollectionSharingErrorV1Schema,
    404: PluginCollectionSharingErrorV1Schema, 409: PluginCollectionSharingErrorV1Schema };
async function respond(reply: FastifyReply, operation: () => Promise<unknown>) {
    try { return reply.send(await operation()); }
    catch (error) {
        if (error instanceof CollectionSharingError || error instanceof PluginCollectionReadOperationError) {
            const status = error.code === 'collection_unavailable' ? 404 : error.code === 'collection_access_forbidden' ? 403
                : error.code === 'collection_query_invalid' || error.code === 'collection_cursor_invalid' ? 400 : 409;
            return reply.code(status).send({ error: error.code });
        }
        if (error instanceof PluginCollectionMutationOperationError) return reply.code(409).send(error.toWireError());
        throw error;
    }
}

/** Authenticated HTTP is an adapter; grant policy, content and CAS remain the existing owners. */
export function collectionSharingRoutes(app: Fastify) {
    const options = { preHandler: app.authenticate, attachValidation: true };
    app.post(paths.grants, { ...options, schema: { body: PluginCollectionSharingAddressV1Schema,
        response: { 200: PluginCollectionSharingGrantsResponseV1Schema, ...failures } } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'collection_query_invalid' });
        return respond(reply, () => listCollectionGrants(request.userId, request.body));
    });
    app.post(paths.census, { ...options, schema: { body: PluginCollectionSharingCensusRequestV1Schema,
        response: { 200: PluginCollectionSharingCensusResponseV1Schema, ...failures } } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'collection_query_invalid' });
        return respond(reply, () => readCollectionRecipientCensus(request.userId, request.body));
    });
    app.post(paths.setGrant, { ...options, schema: { body: PluginCollectionSharingSetGrantRequestV1Schema,
        response: { 200: PluginCollectionSharingMutationResponseV1Schema, ...failures } } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'collection_query_invalid' });
        return respond(reply, () => setCollectionGrant(request.userId, request.body, readSessionAccessAuthenticationFromRequest(request)));
    });
    app.post(paths.revokeGrant, { ...options, schema: { body: PluginCollectionSharingRevokeGrantRequestV1Schema,
        response: { 200: PluginCollectionSharingMutationResponseV1Schema, ...failures } } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'collection_query_invalid' });
        return respond(reply, () => revokeCollectionGrant(request.userId, request.body));
    });
    app.post(paths.commitKeys, { ...options, schema: { body: PluginCollectionSharingCommitKeysRequestV1Schema,
        response: { 200: PluginCollectionSharingCommitKeysResponseV1Schema, ...failures } } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'collection_query_invalid' });
        return respond(reply, () => commitCollectionRecipientKeys(request.userId, request.body));
    });
    app.post(paths.get, { ...options, schema: { body: PluginCollectionSharingGetRequestV1Schema,
        response: { 200: PluginCollectionSharingResourceV1Schema, ...failures } } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'collection_query_invalid' });
        return respond(reply, () => readSharedCollectionResource(request.userId, request.body));
    });
    app.post(paths.put, { ...options, schema: { body: PluginCollectionSharingPutRequestV1Schema,
        response: { 200: PluginCollectionSharingResourceV1Schema, ...failures } } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'collection_query_invalid' });
        return respond(reply, () => putSharedCollectionResource(request.userId, request.body, readSessionAccessAuthenticationFromRequest(request)));
    });
    app.post(paths.sharedWithMe, { ...options, schema: { body: PluginCollectionSharingListRequestV1Schema,
        response: { 200: PluginCollectionSharingListResponseV1Schema, ...failures } } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'collection_query_invalid' });
        return respond(reply, () => listSharedCollectionResources(request.userId, request.body));
    });
}
