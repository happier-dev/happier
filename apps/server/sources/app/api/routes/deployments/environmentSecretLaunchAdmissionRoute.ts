import { z } from 'zod/mini';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { warn } from '@/utils/logging/log';
import { ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions/externalActionHttpError';
import { DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, DEPLOYMENT_DATA_SIZE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { readDeploymentDatabaseReadAccessBindingChildV1 } from '@happier-dev/protocol/deployments/deploymentReadAdmissionV1';
import { EnvironmentSecretLaunchAdmissionInputV1Schema, EnvironmentSecretAdmissionRequestV1Schema, EnvironmentSecretLaunchAdmissionResultV1Schema, MachineConnectorSecretGrantInputV1Schema, MachineConnectorSecretGrantResultV1Schema } from '@happier-dev/protocol/deployments/environmentSecretLaunchAdmissionV1';
import { readEnvironmentSecretLaunchAdmissionInTx, accessMachineConnectorSecretGrantInTx } from '@/app/deployments/environmentSecretLaunchAdmission';
import { deploymentFailure } from '@/app/deployments/deploymentAdmission';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { readDeploymentExecutionBindingFromRequest } from '@/app/deployments/deploymentAcceptedExecution';
import type { Fastify } from '../../types';
import { PresentUserRequiredResponseSchema } from '../../utils/requirePresentUser';

function warnDataRoleRefusal(value: unknown, requestId: string): void {
    const diagnostic = readActionOutputDiagnostic(value);
    if (diagnostic?.phase?.startsWith('deployment.secret_launch.data_role.')) {
        try { warn({ phase: diagnostic.phase, reason: diagnostic.causeKind, requestId }); }
        catch { /* Logging cannot replace the original refusal. */ }
    }
}

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
        const requestId = request.externalActionExecutionRequestId ?? request.id;
        const native = binding?.deploymentNativeAdmission;
        const readAdmission = binding?.deploymentReadAdmission;
        const admittedDataQuery = readAdmission && ('databaseTarget' in readAdmission
            || readAdmission.actionId === DEPLOYMENT_DATA_SIZE_ACTION_ID_V1)
            ? readAdmission : undefined;
        const admittedBackup = native && 'kind' in native && (native.kind === 'restore' || native.kind === 'backup') ? native : undefined;
        if (request.authTokenKind === 'api_token' && !admittedBackup && !admittedDataQuery && !request.externalActionDeploymentChildSigner
            && !(request.externalActionReviewedChildAdmission?.actionId === 'deployments.bindings.set'
                && request.externalActionReviewedChildAdmission.environmentId === request.params.environmentId)) {
            const dataRole = !request.validationError && !('kind' in request.body) && request.body.materialization.kind === 'dataRole';
            const refusal = deploymentFailure('deployment_access_denied', dataRole
                ? { phase: 'deployment.secret_launch.data_role.api_token_admission', causeKind: 'binding_missing' } : undefined);
            if (dataRole) warnDataRoleRefusal(refusal, requestId);
            return reply.code(403).send(refusal);
        }
        if (request.validationError || request.params.environmentId !== request.body.environmentId) {
            return reply.code(400).send({ ok: false, error: 'deployment_invalid' });
        }
        // A data-only Environment has no runtime Link for the installed request
        // shape. Home already verified the exact signed preparation for this root.
        const managedController = 'kind' in request.body && binding && request.body.dataRoleTargetLinkIds?.length
            && (request.authTokenKind === 'terminal' && binding.actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1
                || readDeploymentDatabaseReadAccessBindingChildV1(binding, request.externalActionReviewedChildAdmission))
            ? binding : undefined;
        if ('kind' in request.body && request.authTokenKind !== 'account' && !managedController) {
            return reply.code(403).send({ ok: false, error: 'deployment_access_denied' });
        }
        const value = await inReadSnapshot(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, request.userId,
            request.body, readTeamOperationAuthenticationFromRequest(request), request.externalActionDeploymentChildAdmission,
            admittedBackup, admittedDataQuery));
        if (managedController && value.ok) {
            const controller = value.bindingPreparation?.controllerInstallation;
            if (controller?.machineId !== managedController.machineId || controller.installationId !== managedController.installationId) {
                return reply.code(403).send({ ok: false, error: 'deployment_access_denied' });
            }
        }
        if (!value.ok) warnDataRoleRefusal(value, requestId);
        const status = value.ok ? 200 : value.error === 'deployment_access_denied' ? 403
            : value.error === 'deployment_conflict' ? 409 : value.error === 'deployment_invalid' ? 400 : 404;
        return reply.code(status).send(value);
    });
}
