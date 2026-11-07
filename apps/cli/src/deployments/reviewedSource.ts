import { isDeepStrictEqual } from 'node:util';
import type { DeploymentDeployIntentInputV1 } from '@happier-dev/protocol';
import type { DeploymentContentV1 } from '@happier-dev/deployment-protocol';

/** The admitted root selects source and failure policy; receipt content cannot replace them. */
export function assertReviewedDeploymentSource(input: Readonly<{
    intent: DeploymentDeployIntentInputV1;
    content: Pick<DeploymentContentV1, 'sourceIntent'> & Partial<Pick<DeploymentContentV1, 'onFailure'>>;
}>): void {
    const { intent, content } = input;
    if (!content.sourceIntent || intent.sourceIntent && !isDeepStrictEqual(intent.sourceIntent, content.sourceIntent)
        || intent.sha && (content.sourceIntent.kind !== 'repository' || content.sourceIntent.sha !== intent.sha)
        || intent.onFailure !== undefined && intent.onFailure !== content.onFailure) {
        throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
    }
}
