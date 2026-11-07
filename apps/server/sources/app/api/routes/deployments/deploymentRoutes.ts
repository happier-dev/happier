import { z } from 'zod/mini';
import { ActionOperationAddressV1Schema } from '@happier-dev/protocol/actions/specs/actionOperations';
import { ActionOperationCancelV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import {
    DeploymentActionInputSchemasV1 as inputs, DeploymentActionOutputSchemasV1 as outputs,
    DeploymentDeployAdmissionInputV1Schema, DeploymentRollbackAdmissionInputV1Schema, DeploymentPromoteAdmissionInputV1Schema, DeploymentTeardownActionAdmissionInputV1Schema,
    DeploymentTransitionInputV1Schema, DeploymentCancelTransitionInputV1Schema, DeploymentReceiptResultV1Schema, DeploymentActionFailureV1Schema,
    DeploymentTargetLinksListInputV1Schema, DeploymentTargetLinksListResultV1Schema,
    DeploymentEnvironmentAccessInputV1Schema, DeploymentEnvironmentAccessResultV1Schema,
    DeploymentPendingCancelInputV1Schema, DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentCreateStorageInputV1Schema,
    DeploymentTargetLinkInputV1Schema,
} from '@happier-dev/protocol';
import { DeploymentBindingsSetStorageInputV1Schema, DeploymentEnvironmentTemplateSetInputV1Schema, DeploymentEnvironmentBackupSetInputV1Schema,
    DeploymentEnvironmentUpdateStorageInputV1Schema } from '@happier-dev/deployment-protocol';
import { MachineDeploymentReferencesInputV1Schema, MachineDeploymentReferencesPageV1Schema } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { createDeploymentEnvironmentInTx, updateDeploymentEnvironmentInTx,
    setDeploymentEnvironmentBindingsInTx, setDeploymentEnvironmentTemplateInTx, setDeploymentEnvironmentBackupInTx,
    DeploymentEnvironmentCreationError } from '@/app/deployments/deploymentEnvironmentService';
import { linkDeploymentTargetInTx } from '@/app/deployments/deploymentTargetLinkService';
import { unlinkDeploymentTargetInTx, deleteDeploymentEnvironmentInTx } from '@/app/deployments/deploymentDispositionService';
import { setDeploymentEnvironmentControllerInTx } from '@/app/deployments/deploymentControllerService';
import { listDeploymentTargetLinksInTx } from '@/app/deployments/deploymentTargetLinkReadService';
import { createDeploymentInTx, transitionDeploymentInTx } from '@/app/deployments/deploymentService';
import { cancelDeploymentPendingInTx, cancelDeploymentPendingOperationInTx } from '@/app/deployments/deploymentPendingService';
import { promoteDeploymentInTx } from '@/app/deployments/deploymentPromotionService';
import { readDeploymentExecutionBindingFromRequest } from '@/app/deployments/deploymentAcceptedExecution';
import { readDeploymentEnvironmentInTx, readDeploymentReceiptInTx, readDeploymentEnvironmentAccessInTx,
    listDeploymentEnvironmentsInTx, listDeploymentReceiptsInTx, readDeploymentMachineReferencesInTx } from '@/app/deployments/deploymentReadService';
import type { Fastify } from '../../types';
import { registerEnvironmentSecretLaunchAdmissionRoute } from './environmentSecretLaunchAdmissionRoute';
import { registerDeploymentDomainRoutes } from './deploymentDomainRoutes';
import { deploymentNewWorkFeatureGate } from './deploymentFeatureGate';
import { deploymentLinkValidationFailure } from './deploymentValidation';

const environmentParams = z.strictObject({ environmentId: z.string().check(z.minLength(1)) });
const receiptParams = z.extend(environmentParams, { deploymentId: z.string().check(z.minLength(1)) });
const targetParams = z.extend(environmentParams, { targetLinkId: z.string().check(z.minLength(1)) });
const invalid = { ok: false as const, error: 'deployment_invalid' as const };
function responses<T extends z.ZodMiniType>(schema: T) {
    return { 200: schema, 400: schema, 403: schema, 404: schema, 409: schema, 413: schema, 503: schema };
}
function status(result: { ok: boolean; error?: string }) {
    return result.ok ? 200 : result.error === 'deployment_unavailable' ? 404
        : result.error === 'deployment_access_denied' ? 403
        : result.error === 'deployment_conflict' || result.error === 'deployment_in_progress'
            || result.error === 'deployment_content_unavailable' || result.error === 'deployment_teardown_required' ? 409
        : result.error === 'machine_unavailable' ? 503 : result.error === 'quota_exceeded' ? 413 : 400;
}

/** Authenticated storage only: the daemon owns review, effects and observation. */
export function registerDeploymentRoutes(app: Fastify): void {
    registerDeploymentDomainRoutes(app);
    registerEnvironmentSecretLaunchAdmissionRoute(app);
    app.post('/v1/deployments/environments/:environmentId/delete', {
        preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: inputs['deployments.environments.delete'],
            response: responses(outputs['deployments.environments.delete']) },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId) return reply.code(400).send(invalid);
        // Disposition locks the exact Environment before admission and revision checks.
        // Terminal Account publication must see concurrent cursor updates, not an old snapshot.
        const result = await inTx(tx => deleteDeploymentEnvironmentInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)), { isolationLevel: 'ReadCommitted' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments/:environmentId/targets/:targetLinkId/unlink', {
        preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: targetParams, body: inputs['deployments.targets.unlink'],
            response: responses(outputs['deployments.targets.unlink']) },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId
            || request.params.targetLinkId !== request.body.targetLinkId) return reply.code(400).send(invalid);
        const result = await inTx(tx => unlinkDeploymentTargetInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)), { isolationLevel: 'ReadCommitted' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/pending/cancel', {
        preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { body: ActionOperationAddressV1Schema,
            response: responses(z.union([ActionOperationCancelV1ResponseSchema, DeploymentActionFailureV1Schema])) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(invalid);
        const binding = readDeploymentExecutionBindingFromRequest(request);
        const result = await inTx(tx => cancelDeploymentPendingOperationInTx(tx, request.userId, request.body, binding ?? undefined,
            readTeamOperationAuthenticationFromRequest(request)), { isolationLevel: 'Serializable' });
        return reply.code('kind' in result ? 200 : status(result)).send(result);
    });
    app.post('/v1/deployments/environments/:environmentId/pending/cancel', {
        preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: DeploymentPendingCancelInputV1Schema,
            response: responses(DeploymentEnvironmentCreateResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId) return reply.code(400).send(invalid);
        const binding = readDeploymentExecutionBindingFromRequest(request);
        const result = await inTx(tx => cancelDeploymentPendingInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request), binding ?? undefined), { isolationLevel: 'Serializable' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments/access', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { body: DeploymentEnvironmentAccessInputV1Schema, response: responses(DeploymentEnvironmentAccessResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(invalid);
        const result = await inReadSnapshot(tx => readDeploymentEnvironmentAccessInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)));
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/targets/list', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { body: DeploymentTargetLinksListInputV1Schema, response: responses(DeploymentTargetLinksListResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(deploymentLinkValidationFailure(
            'target_link.provider_links_read', request.validationError.validation, DeploymentTargetLinksListInputV1Schema.shape));
        const result = await inReadSnapshot(tx => listDeploymentTargetLinksInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)));
        return reply.code(status(result)).send(result);
    });
    app.get('/v1/deployments/machine-references', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { querystring: MachineDeploymentReferencesInputV1Schema,
            response: responses(z.union([MachineDeploymentReferencesPageV1Schema, DeploymentActionFailureV1Schema])) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(invalid);
        const result = await inReadSnapshot(tx => readDeploymentMachineReferencesInTx(tx, request.userId, request.query,
            readTeamOperationAuthenticationFromRequest(request)));
        return reply.code('ok' in result ? status(result) : 200).send(result);
    });
    app.patch('/v1/deployments/environments/:environmentId', {
        preHandler: [app.authenticate, deploymentNewWorkFeatureGate], config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: DeploymentEnvironmentUpdateStorageInputV1Schema,
            response: responses(outputs['deployments.environments.update']) },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId) return reply.code(400).send(invalid);
        const result = await inTx(tx => updateDeploymentEnvironmentInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)), { isolationLevel: 'Serializable' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments/:environmentId/controller', {
        preHandler: [app.authenticate, deploymentNewWorkFeatureGate], config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: inputs['deployments.environments.controller.set'],
            response: responses(outputs['deployments.environments.controller.set']) },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId) return reply.code(400).send(invalid);
        const result = await inTx(tx => setDeploymentEnvironmentControllerInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)), { isolationLevel: 'Serializable' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments/:environmentId/bindings', {
        preHandler: [app.authenticate, deploymentNewWorkFeatureGate], config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: DeploymentBindingsSetStorageInputV1Schema,
            response: responses(outputs['deployments.bindings.set']) },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId) return reply.code(400).send(invalid);
        const result = await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)), { isolationLevel: 'Serializable' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments/:environmentId/template', {
        preHandler: [app.authenticate, deploymentNewWorkFeatureGate], config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: DeploymentEnvironmentTemplateSetInputV1Schema,
            response: responses(outputs['deployments.environments.update']) },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId) return reply.code(400).send(invalid);
        const result = await inTx(tx => setDeploymentEnvironmentTemplateInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)), { isolationLevel: 'Serializable' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments/:environmentId/backup', {
        preHandler: [app.authenticate, deploymentNewWorkFeatureGate], config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: DeploymentEnvironmentBackupSetInputV1Schema,
            response: responses(outputs['deployments.environments.update']) },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId) return reply.code(400).send(invalid);
        const result = await inTx(tx => setDeploymentEnvironmentBackupInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)), { isolationLevel: 'Serializable' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments', { preHandler: [app.authenticate, deploymentNewWorkFeatureGate], config: { allowApiToken: true }, attachValidation: true,
        schema: { body: DeploymentEnvironmentCreateStorageInputV1Schema, response: responses(outputs['deployments.environments.create']) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(invalid);
        const result = await inTx(tx => createDeploymentEnvironmentInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)), { isolationLevel: 'Serializable' }).catch((error: unknown) => {
                if (error instanceof DeploymentEnvironmentCreationError) return error.failure;
                throw error;
            });
        return reply.code(status(result)).send(result);
    });
    app.get('/v1/deployments/environments', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { querystring: z.pipe(z.looseObject({
            limit: z.optional(z.coerce.number().check(z.int(), z.positive())),
            includeDeleted: z.optional(z.pipe(z.literal('true'), z.transform(() => true as const))),
            environmentIds: z.optional(z.pipe(z.union([z.string(), z.array(z.string())]),
                z.transform(value => typeof value === 'string' ? [value] : value))),
            previewPullRequestIds: z.optional(z.pipe(z.union([z.string(), z.array(z.string())]),
                z.transform(value => typeof value === 'string' ? [value] : value))),
        }), inputs['deployments.environments.list']), response: responses(outputs['deployments.environments.list']) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(invalid);
        const result = await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, request.userId, request.query,
            readTeamOperationAuthenticationFromRequest(request)));
        return reply.code(status(result)).send(result);
    });
    app.get('/v1/deployments/environments/:environmentId', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, querystring: z.pipe(z.looseObject({
            includeRetainedTargetLinkCleanup: z.optional(z.pipe(z.literal('true'), z.transform(() => true as const))),
        }), z.omit(inputs['deployments.environments.get'], { environmentId: true })),
            response: responses(outputs['deployments.environments.get']) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(deploymentLinkValidationFailure(
            'target_link.environment_read', request.validationError.validation, inputs['deployments.environments.get'].shape));
        const result = await inReadSnapshot(tx => readDeploymentEnvironmentInTx(tx, request.userId, { ...request.query, ...request.params },
            readTeamOperationAuthenticationFromRequest(request), request.externalActionAcceptedDeploymentRead,
            request.externalActionRegistryAppUpdateRead));
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments/:environmentId/targets', { preHandler: [app.authenticate, deploymentNewWorkFeatureGate], config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: DeploymentTargetLinkInputV1Schema, response: responses(outputs['deployments.targets.link']) },
    }, async (request, reply) => {
        if (request.validationError || request.body.environmentId !== request.params.environmentId) return reply.code(400).send(deploymentLinkValidationFailure(
            'target_link.associate', request.validationError ? request.validationError.validation
                : [{ instancePath: '/environmentId', keyword: 'path_mismatch' }], DeploymentTargetLinkInputV1Schema.shape));
        const result = await inTx(tx => linkDeploymentTargetInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)), { isolationLevel: 'Serializable' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments/:environmentId/deploy', { preHandler: [app.authenticate, deploymentNewWorkFeatureGate], config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: DeploymentDeployAdmissionInputV1Schema, response: responses(DeploymentReceiptResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError || request.body.environmentId !== request.params.environmentId) return reply.code(400).send(invalid);
        const result = await inTx(tx => createDeploymentInTx(tx, request.userId, request.body, 'deploy',
            readTeamOperationAuthenticationFromRequest(request), readDeploymentExecutionBindingFromRequest(request) ?? undefined), { isolationLevel: 'Serializable' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments/:environmentId/teardown', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: DeploymentTeardownActionAdmissionInputV1Schema, response: responses(outputs['deployments.teardown']) },
    }, async (request, reply) => {
        if (request.validationError || request.body.environmentId !== request.params.environmentId) return reply.code(400).send(invalid);
        // Receipt admission and explicit detach own the Environment row lock and revision CAS.
        // A Serializable snapshot also conflicts with unrelated Account cursor publication.
        const result = await inTx(tx => 'detachKeepRunning' in request.body
            ? unlinkDeploymentTargetInTx(tx, request.userId, request.body, readTeamOperationAuthenticationFromRequest(request))
            : createDeploymentInTx(tx, request.userId, request.body, 'teardown',
                readTeamOperationAuthenticationFromRequest(request), readDeploymentExecutionBindingFromRequest(request) ?? undefined),
            { isolationLevel: 'ReadCommitted' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments/:environmentId/rollback', { preHandler: [app.authenticate, deploymentNewWorkFeatureGate], config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: DeploymentRollbackAdmissionInputV1Schema, response: responses(DeploymentReceiptResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError || request.body.environmentId !== request.params.environmentId) return reply.code(400).send(invalid);
        const result = await inTx(tx => createDeploymentInTx(tx, request.userId, request.body, 'rollback',
            readTeamOperationAuthenticationFromRequest(request), readDeploymentExecutionBindingFromRequest(request) ?? undefined), { isolationLevel: 'Serializable' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments/:environmentId/promote', { preHandler: [app.authenticate, deploymentNewWorkFeatureGate], config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams, body: DeploymentPromoteAdmissionInputV1Schema, response: responses(DeploymentReceiptResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError || request.body.environmentId !== request.params.environmentId) return reply.code(400).send(invalid);
        const result = await inTx(tx => promoteDeploymentInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request), readDeploymentExecutionBindingFromRequest(request) ?? undefined), { isolationLevel: 'Serializable' });
        return reply.code(status(result)).send(result);
    });
    app.post('/v1/deployments/environments/:environmentId/deployments/:deploymentId/transitions', {
        preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: receiptParams, body: z.union([DeploymentTransitionInputV1Schema, DeploymentCancelTransitionInputV1Schema]),
            response: responses(DeploymentReceiptResultV1Schema) },
    }, async (request, reply) => {
        if (request.validationError || request.body.environmentId !== request.params.environmentId
            || request.body.deploymentId !== request.params.deploymentId) return reply.code(400).send(invalid);
        // The Environment row, receipt CAS and Artifact owner serialize this write;
        // an earlier Serializable snapshot would conflict with unrelated Account cursor publication.
        const result = await inTx(tx => transitionDeploymentInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)), { isolationLevel: 'ReadCommitted' });
        return reply.code(status(result)).send(result);
    });
    app.get('/v1/deployments/environments/:environmentId/deployments', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: environmentParams,
            querystring: z.extend(z.omit(inputs['deployments.receipts.list'], { environmentId: true, limit: true, inProgressOnly: true }), {
                limit: z.optional(z.coerce.number().check(z.int(), z.positive())),
                inProgressOnly: z.optional(z.pipe(z.literal('true'), z.transform(() => true as const))),
            }), response: responses(outputs['deployments.receipts.list']) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(invalid);
        const result = await inReadSnapshot(tx => listDeploymentReceiptsInTx(tx, request.userId, { ...request.query, ...request.params },
            readTeamOperationAuthenticationFromRequest(request), request.externalActionAcceptedDeploymentRead));
        return reply.code(status(result)).send(result);
    });
    app.get('/v1/deployments/environments/:environmentId/deployments/:deploymentId', {
        preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: receiptParams, querystring: z.omit(inputs['deployments.receipts.get'], { environmentId: true, deploymentId: true }),
            response: responses(outputs['deployments.receipts.get']) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(invalid);
        const result = await inReadSnapshot(tx => readDeploymentReceiptInTx(tx, request.userId, { ...request.query, ...request.params },
            readTeamOperationAuthenticationFromRequest(request), request.externalActionAcceptedDeploymentRead));
        return reply.code(status(result)).send(result);
    });
    app.get('/v1/deployments/receipts/:deploymentId', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: z.pick(receiptParams, { deploymentId: true }),
            querystring: z.extend(z.omit(inputs['deployments.receipts.get'], { environmentId: true, deploymentId: true }), {
                environmentId: z.optional(environmentParams.shape.environmentId),
            }), response: responses(outputs['deployments.receipts.get']) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(invalid);
        const result = await inReadSnapshot(tx => readDeploymentReceiptInTx(tx, request.userId, { ...request.query, ...request.params },
            readTeamOperationAuthenticationFromRequest(request), request.externalActionAcceptedDeploymentRead));
        return reply.code(status(result)).send(result);
    });
}
