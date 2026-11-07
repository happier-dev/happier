import { z } from 'zod/mini';
import { DeploymentDomainAddAdmissionInputV1Schema, DeploymentDomainRemoveAdmissionInputV1Schema,
    DeploymentDomainGetInputV1Schema, DeploymentDomainListInputV1Schema, DeploymentDomainTransitionInputV1Schema,
    DeploymentDomainMutationResultV1Schema, DeploymentDomainListResultV1Schema, DeploymentDomainPreparedContentInputV1Schema } from '@happier-dev/protocol';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { createDeploymentDomainInTx, removeDeploymentDomainInTx, readDeploymentDomainInTx,
    listDeploymentDomainsInTx, transitionDeploymentDomainInTx, prepareDeploymentDomainContentInTx } from '@/app/deployments/deploymentDomainService';
import type { Fastify } from '../../types';
import { deploymentNewWorkFeatureGate } from './deploymentFeatureGate';
import { readDeploymentExecutionBindingFromRequest, readDeploymentExecutionEffectFromRequest } from '@/app/deployments/deploymentAcceptedExecution';

const environmentParams = z.strictObject({ environmentId: z.string().check(z.minLength(1)) });
const domainParams = z.extend(environmentParams, { domainId: z.string().check(z.minLength(1)) });
const invalid = { ok: false as const, error: 'deployment_invalid' as const };
function responses<T extends z.ZodMiniType>(schema: T) {
    return { 200: schema, 400: schema, 403: schema, 404: schema, 409: schema, 413: schema, 503: schema };
}
function status(result: { ok: boolean; error?: string }) {
    return result.ok ? 200 : result.error === 'deployment_unavailable' ? 404 : result.error === 'deployment_access_denied' ? 403
        : result.error === 'deployment_conflict' || result.error === 'deployment_content_unavailable' ? 409
            : result.error === 'machine_unavailable' ? 503 : result.error === 'quota_exceeded' ? 413 : 400;
}

/** Source-admitted desired writes and exact installation-signed observations share the Domain owner. */
export function registerDeploymentDomainRoutes(app: Fastify): void {
    app.post('/v1/deployments/environments/:environmentId/domains', {
        preHandler: [app.authenticate, deploymentNewWorkFeatureGate], config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: DeploymentDomainAddAdmissionInputV1Schema,
            response: responses(DeploymentDomainMutationResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId) return reply.code(400).send(invalid);
        const execution = readDeploymentExecutionEffectFromRequest(request);
        const value = await inTx(tx => createDeploymentDomainInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request), execution?.binding, execution?.actionId), { isolationLevel: 'Serializable' });
        return reply.code(status(value)).send(value);
    });
    app.post('/v1/deployments/environments/:environmentId/domains/:domainId/remove', {
        preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: domainParams, body: DeploymentDomainRemoveAdmissionInputV1Schema,
            response: responses(DeploymentDomainMutationResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId
            || request.params.domainId !== request.body.domainId) return reply.code(400).send(invalid);
        const value = await inTx(tx => removeDeploymentDomainInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request), readDeploymentExecutionBindingFromRequest(request) ?? undefined), { isolationLevel: 'Serializable' });
        return reply.code(status(value)).send(value);
    });
    app.get('/v1/deployments/environments/:environmentId/domains/:domainId', {
        preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: domainParams, querystring: z.omit(DeploymentDomainGetInputV1Schema, { environmentId: true, domainId: true }),
            response: responses(DeploymentDomainMutationResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(invalid);
        const value = await inReadSnapshot(tx => readDeploymentDomainInTx(tx, request.userId, { ...request.query, ...request.params },
            readTeamOperationAuthenticationFromRequest(request), request.externalActionAcceptedDeploymentRead));
        return reply.code(status(value)).send(value);
    });
    app.get('/v1/deployments/environments/:environmentId/domains', {
        preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, querystring: z.extend(z.omit(DeploymentDomainListInputV1Schema, { environmentId: true }), {
            limit: z.optional(z.coerce.number().check(z.int(), z.positive())),
        }), response: responses(DeploymentDomainListResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(invalid);
        const value = await inReadSnapshot(tx => listDeploymentDomainsInTx(tx, request.userId, { ...request.query, ...request.params },
            readTeamOperationAuthenticationFromRequest(request), request.externalActionDeploymentChildAdmission,
            request.externalActionAcceptedDeploymentRead));
        return reply.code(status(value)).send(value);
    });
    app.post('/v1/deployments/environments/:environmentId/domains/:domainId/prepared-content', {
        preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: domainParams, body: DeploymentDomainPreparedContentInputV1Schema,
            response: responses(DeploymentDomainMutationResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId
            || request.params.domainId !== request.body.domainId) return reply.code(400).send(invalid);
        const value = await inTx(tx => prepareDeploymentDomainContentInTx(tx, request.userId, request.body,
            readDeploymentExecutionBindingFromRequest(request) ?? undefined), { isolationLevel: 'Serializable' });
        return reply.code(status(value)).send(value);
    });
    app.post('/v1/deployments/environments/:environmentId/domains/:domainId/transitions', {
        preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: domainParams, body: DeploymentDomainTransitionInputV1Schema,
            response: responses(DeploymentDomainMutationResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId
            || request.params.domainId !== request.body.domainId) return reply.code(400).send(invalid);
        const value = await inTx(tx => transitionDeploymentDomainInTx(tx, request.body), { isolationLevel: 'Serializable' });
        return reply.code(status(value)).send(value);
    });
}
