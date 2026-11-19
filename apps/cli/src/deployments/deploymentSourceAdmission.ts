import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isDeepStrictEqual } from 'node:util';
import type { DeploymentEnvironmentDetailV1, DeploymentSourceIntentV1 } from '@happier-dev/deployments/contracts/v1';

/** Placement and row versions may advance without changing the exact definition.
 * Retained recovery uses its receipt proof rather than today's editor content. */
export function admitDeploymentSourceIntent(environment: DeploymentEnvironmentDetailV1, intent: DeploymentSourceIntentV1): void {
    const definition = environment.content.definition;
    if (intent.kind !== definition.kind || (intent.kind === 'repository' && definition.kind === 'repository'
        ? !isDeepStrictEqual(intent.compose, definition.compose) : !isDeepStrictEqual(intent, definition))) {
        throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict' });
    }
}
