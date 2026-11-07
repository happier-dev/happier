import type { FastifyRequest } from 'fastify';
import { getActionRequiredServerFeatureId } from '@happier-dev/protocol/actions/actionRequiredServerFeature';
import type { ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { isServerFeatureEnabledForHome } from '@/app/features/catalog/serverFeatureGate';

/** These opt-outs narrow new admission; signed continuations bypass this at their existing admission owner. */
export async function isNewDeploymentOrBotWorkEnabled(request: FastifyRequest, actionId: string, envelope: ExternalActionRequestEnvelope) {
    const featureId = getActionRequiredServerFeatureId(actionId, undefined, envelope.v === 1 ? envelope.input : undefined);
    return featureId !== 'deployments' && featureId !== 'bots'
        || await isServerFeatureEnabledForHome(featureId, { request });
}
