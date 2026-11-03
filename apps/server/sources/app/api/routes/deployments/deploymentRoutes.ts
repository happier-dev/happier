import { z } from 'zod/mini';
import { DeploymentActionInputSchemasV1 as inputs, DeploymentActionOutputSchemasV1 as outputs,
    DeploymentActionFailureV1Schema } from '@happier-dev/protocol';
import { MachineDeploymentReferencesInputV1Schema, MachineDeploymentReferencesPageV1Schema } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { inReadSnapshot } from '@/storage/inTx';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { readDeploymentMachineReferencesInTx, listDeploymentEnvironmentsInTx } from '@/app/deployments/deploymentReadService';
import type { Fastify } from '../../types';

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

/** Authenticated deployment reference and admitted-header reads. */
export function registerDeploymentRoutes(app: Fastify): void {
    app.get('/v1/deployments/machine-references', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { querystring: MachineDeploymentReferencesInputV1Schema,
            response: responses(z.union([MachineDeploymentReferencesPageV1Schema, DeploymentActionFailureV1Schema])) },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send(invalid);
        const result = await inReadSnapshot(tx => readDeploymentMachineReferencesInTx(tx, request.userId, request.query,
            readTeamOperationAuthenticationFromRequest(request)));
        return reply.code('ok' in result ? status(result) : 200).send(result);
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
}
