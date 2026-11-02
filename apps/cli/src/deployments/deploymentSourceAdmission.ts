import { isDeepStrictEqual } from 'node:util';
import type { DeploymentEnvironmentDetailV1, DeploymentSourceIntentV1 } from '@happier-dev/deployment-protocol';

/** Placement and row versions may advance without changing the exact definition.
 * Retained recovery uses its receipt proof rather than today's editor content. */
export function admitDeploymentSourceIntent(environment: DeploymentEnvironmentDetailV1, intent: DeploymentSourceIntentV1): void {
    const definition = environment.content.definition;
    if (intent.kind !== definition.kind || (intent.kind === 'repository' && definition.kind === 'repository'
        ? !isDeepStrictEqual(intent.compose, definition.compose) : !isDeepStrictEqual(intent, definition))) {
        throw Object.assign(new Error('deployment_conflict'), { code: 'deployment_conflict' });
    }
}
