import type { FastifyReply, FastifyRequest } from 'fastify';
import { readDeploymentExecutionBindingFromRequest } from '@/app/deployments/deploymentAcceptedExecution';
import { createServerFeatureGatePreHandler } from '@/app/features/catalog/serverFeatureGate';

const gate = createServerFeatureGatePreHandler('deployments', process.env, { ok: false, error: 'deployment_unavailable' });

/** Authentication already admitted signed effects; only a new request consumes the feature decision. */
export async function deploymentNewWorkFeatureGate(request: FastifyRequest, reply: FastifyReply) {
    if (readDeploymentExecutionBindingFromRequest(request)) return;
    return gate(request, reply);
}
