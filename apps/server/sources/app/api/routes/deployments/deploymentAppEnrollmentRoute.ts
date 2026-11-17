import { z } from 'zod/mini';
import { DeploymentAppEnrollmentAdmissionInputV1Schema, DeploymentAppEnrollmentAdmissionResultV1Schema } from '@happier-dev/protocol/machines/enrollmentV1';
import { DeploymentActionFailureV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { admitDeploymentAppEnrollmentInTx } from '@/app/deployments/deploymentAppEnrollment';
import { PluginInstallationPublisherProofError, verifyPluginInstallationPublisherHeader } from '@/app/plugins/installations/publisherProof';
import { lockDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { inTx } from '@/storage/inTx';
import type { Fastify } from '../../types';

/** The accepted Compose controller spends installation custody; pairing stays in auth request/wait/approve. */
export function registerDeploymentAppEnrollmentRoute(app: Fastify): void {
    const result = z.union([DeploymentAppEnrollmentAdmissionResultV1Schema, DeploymentActionFailureV1Schema]);
    app.post('/v1/deployments/environments/:environmentId/deployments/:deploymentId/app-enrollment', {
        preHandler: app.authenticate, attachValidation: true,
        schema: { params: z.strictObject({ environmentId: z.string(), deploymentId: z.string() }),
            body: DeploymentAppEnrollmentAdmissionInputV1Schema, response: { 200: result, 400: result, 403: result, 409: result } },
    }, async (request, reply) => {
        if (request.validationError || request.params.environmentId !== request.body.environmentId
            || request.params.deploymentId !== request.body.deploymentId) return reply.code(400).send({ ok: false, error: 'deployment_invalid' });
        let publisher;
        try {
            publisher = await verifyPluginInstallationPublisherHeader({ accountId: request.userId,
                request, path: request.url, required: true });
        } catch (error) {
            if (error instanceof PluginInstallationPublisherProofError) return reply.code(403).send({ ok: false, error: 'deployment_access_denied' });
            throw error;
        }
        if (!publisher) return reply.code(403).send({ ok: false, error: 'deployment_access_denied' });
        const { pairingPublicKey, existingMachineId, ...enrollment } = request.body;
        const admitted = await inTx(async tx => {
            await lockDeploymentEnvironmentInTx(tx, request.body.environmentId);
            return admitDeploymentAppEnrollmentInTx(tx, enrollment, publisher, { pairingPublicKey, existingMachineId });
        }, { isolationLevel: 'ReadCommitted' });
        return reply.code(admitted.ok ? 200 : admitted.error === 'deployment_invalid' ? 400 : admitted.error === 'deployment_conflict' ? 409 : 403).send(admitted);
    });
}
