import { z } from 'zod/mini';
import { ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions/externalActionHttpError';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { DEPLOYMENT_DATA_SIZE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { EnvironmentSecretLaunchAdmissionInputV1Schema, EnvironmentSecretAdmissionRequestV1Schema, EnvironmentSecretLaunchAdmissionResultV1Schema, MachineConnectorSecretGrantInputV1Schema, MachineConnectorSecretGrantResultV1Schema } from '@happier-dev/protocol/deployments/environmentSecretLaunchAdmissionV1';
import { readEnvironmentSecretLaunchAdmissionInTx, accessMachineConnectorSecretGrantInTx } from '@/app/deployments/environmentSecretLaunchAdmission';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { readDeploymentExecutionBindingFromRequest } from '@/app/deployments/deploymentAcceptedExecution';
import type { Fastify } from '../../types';
import { PresentUserRequiredResponseSchema } from '../../utils/requirePresentUser';

/** Host-private installed delivery and Account manager preparation, excluded from ordinary bindings/list. */
export function registerEnvironmentSecretLaunchAdmissionRoute(app: Fastify): void {
    const connectorResult = MachineConnectorSecretGrantResultV1Schema;
    app.post('/v1/deployments/machines/:machineId/connector-secret-grant', {
        preHandler: app.authenticate, attachValidation: true,
        schema: { params: z.strictObject({ machineId: z.string().check(z.minLength(1)) }),
            body: MachineConnectorSecretGrantInputV1Schema,
            response: { 200: connectorResult, 400: connectorResult,
                401: z.union([connectorResult, ExternalActionHttpErrorSchema]),
                403: z.union([connectorResult, PresentUserRequiredResponseSchema]), 404: connectorResult } },
    }, async (request, reply) => {
        if (request.validationError || request.params.machineId !== request.body.subject.machineId) {
            return reply.code(400).send({ ok: false, error: 'deployment_invalid' });
        }
        const access = (tx: Parameters<typeof accessMachineConnectorSecretGrantInTx>[0]) =>
            accessMachineConnectorSecretGrantInTx(tx, request.userId, request.body,
                request.externalActionDeploymentChildAdmission);
        const value = request.body.operation === 'read' ? await inReadSnapshot(access)
            : await inTx(access, { isolationLevel: 'Serializable' });
        return reply.code(value.ok ? 200 : value.error === 'deployment_access_denied'
            ? request.externalActionDeploymentChildAdmission?.domainJob ? 401 : 403
            : value.error === 'deployment_invalid' ? 400 : 404).send(value);
    });
    const result = EnvironmentSecretLaunchAdmissionResultV1Schema;
    app.post('/v1/deployments/environments/:environmentId/secret-launch-admission', {
        preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true,
        schema: { params: z.strictObject({ environmentId: EnvironmentSecretLaunchAdmissionInputV1Schema.shape.environmentId }),
            body: EnvironmentSecretAdmissionRequestV1Schema,
            response: { 200: result, 400: result,
                403: z.union([result, PresentUserRequiredResponseSchema]), 404: result, 409: result } },
    }, async (request, reply) => {
        // Authentication already verified the exact native or generic child
        // purpose. A caller-authored header is not an admitted child result.
        const binding = readDeploymentExecutionBindingFromRequest(request);
        const native = binding?.deploymentNativeAdmission;
        const readAdmission = binding?.deploymentReadAdmission;
        const admittedDataQuery = readAdmission?.actionId === ACTION_INVOKE_ACTION_ID_V1
            || readAdmission?.actionId === DEPLOYMENT_DATA_SIZE_ACTION_ID_V1
            ? readAdmission : undefined;
        const admittedBackup = native && 'kind' in native && (native.kind === 'restore' || native.kind === 'backup') ? native : undefined;
        if (request.authTokenKind === 'api_token' && !admittedBackup && !admittedDataQuery && !request.externalActionDeploymentChildSigner
            && !(request.externalActionReviewedChildAdmission?.actionId === 'deployments.bindings.set'
                && request.externalActionReviewedChildAdmission.environmentId === request.params.environmentId)) {
            return reply.code(403).send({ ok: false, error: 'deployment_access_denied' });
        }
        if (request.validationError || request.params.environmentId !== request.body.environmentId) {
            return reply.code(400).send({ ok: false, error: 'deployment_invalid' });
        }
        if ('kind' in request.body && request.authTokenKind !== 'account') {
            return reply.code(403).send({ ok: false, error: 'deployment_access_denied' });
        }
        const value = await inReadSnapshot(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, request.userId,
            request.body, readTeamOperationAuthenticationFromRequest(request), request.externalActionDeploymentChildAdmission,
            admittedBackup, admittedDataQuery));
        const status = value.ok ? 200 : value.error === 'deployment_access_denied' ? 403
            : value.error === 'deployment_conflict' ? 409 : value.error === 'deployment_invalid' ? 400 : 404;
        return reply.code(status).send(value);
    });
}
