import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isDeepStrictEqual } from 'node:util';
import type { DeploymentDeployIntentInputV1 } from '@happier-dev/protocol';
import type { DeploymentContentV1 } from '@happier-dev/deployment-protocol';

/** The admitted root selects source and failure policy; receipt content cannot replace them. */
export function assertReviewedDeploymentSource(input: Readonly<{
    intent: DeploymentDeployIntentInputV1;
    content: Pick<DeploymentContentV1, 'sourceIntent'> & Partial<Pick<DeploymentContentV1, 'onFailure' | 'services'>>;
}>): void {
    const { intent, content } = input;
    if (!content.sourceIntent || intent.sourceIntent && !isDeepStrictEqual(intent.sourceIntent, content.sourceIntent)
        || intent.sha && (content.sourceIntent.kind !== 'repository' || content.sourceIntent.sha !== intent.sha)
        || intent.onFailure !== undefined && intent.onFailure !== content.onFailure
        || !isDeepStrictEqual(intent.services, content.services)) {
        throw createActionExecuteFailureError({ ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' });
    }
}
