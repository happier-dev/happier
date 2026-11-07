import { z } from 'zod/mini';

import { DeploymentEnvironmentContentV1Schema, DeploymentEnvironmentHeaderV1Schema } from './environment.js';
import { DeploymentTargetLinkContentV1Schema, DeploymentTargetLinkHeaderV1Schema } from './target.js';
import { DeploymentContentV1Schema, DeploymentReceiptFailureV1Schema, DeploymentReceiptHeaderV1Schema, DeploymentStepV1Schema } from './deployment.js';
import { DeploymentIdentifierV1Schema } from './ids.js';
import { DeploymentEnvironmentHealthAggregateV1Schema } from './health.js';
import { DeploymentReviewRevisionV1Schema } from './review.js';
import { DeploymentCancellationConsequenceV1Schema, type DeploymentCancellationConsequenceV1 } from '@happier-dev/protocol/deployments/deploymentStateV1';
import { DeploymentControllerAvailabilityV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentBindingSavedSecretRevisionsV1Schema } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';

const collectionCoverage = z.optional(z.enum(['complete', 'partial']));

/** Labels come from admitted Source metadata and private Artifact headers, never their bodies. */
export const DeploymentEnvironmentCollectionV1Schema = z.strictObject({
    items: z.array(z.strictObject({ environment: DeploymentEnvironmentHeaderV1Schema, title: z.string(),
        projectSourceName: z.optional(z.nullable(z.string())),
        /** Unknown unless the carried receipt is the runtime link's actual active deployment. */
        liveVersionTitle: z.optional(z.nullable(z.string())),
        runtimeTargetLink: z.optional(z.nullable(DeploymentTargetLinkHeaderV1Schema)),
        currentDeployment: z.optional(z.nullable(z.extend(DeploymentReceiptHeaderV1Schema, {
            title: z.optional(z.string()),
            steps: z.optional(z.nullable(z.array(DeploymentStepV1Schema))),
        }))) })),
    nextCursor: z.nullable(DeploymentIdentifierV1Schema),
    coverage: collectionCoverage,
});
export type DeploymentEnvironmentCollectionV1 = z.infer<typeof DeploymentEnvironmentCollectionV1Schema>;

/** Visible history facts projected from the page's opened contents; older transports may omit them. */
export const DeploymentReceiptHistoryV1Schema = z.strictObject({
    ok: z.literal(true), items: z.array(z.extend(DeploymentReceiptHeaderV1Schema, { title: z.optional(z.string()),
        source: z.optional(z.nullable(DeploymentReviewRevisionV1Schema)),
        failure: z.optional(z.nullable(DeploymentReceiptFailureV1Schema)) })),
    nextCursor: z.nullable(DeploymentIdentifierV1Schema),
    coverage: collectionCoverage,
});
export type DeploymentReceiptHistoryV1 = z.infer<typeof DeploymentReceiptHistoryV1Schema>;

/** Artifact bodies serialize ContentV1 directly. The Artifact owner opens its mode-aware envelope. */
export const DeploymentEnvironmentDetailV1Schema = z.strictObject({
    environment: DeploymentEnvironmentHeaderV1Schema,
    savedSecretRevisions: z.optional(DeploymentBindingSavedSecretRevisionsV1Schema),
    controller: z.optional(DeploymentControllerAvailabilityV1Schema),
    content: DeploymentEnvironmentContentV1Schema,
    targetLinks: z.array(z.strictObject({
        targetLink: DeploymentTargetLinkHeaderV1Schema,
        // Custody headers remain available without demanding private link bodies.
        content: z.optional(DeploymentTargetLinkContentV1Schema),
    })),
    healthAggregate: z.optional(DeploymentEnvironmentHealthAggregateV1Schema),
});
export type DeploymentEnvironmentDetailV1 = z.infer<typeof DeploymentEnvironmentDetailV1Schema>;

export const DeploymentReceiptDetailV1Schema = z.strictObject({
    deployment: DeploymentReceiptHeaderV1Schema,
    content: DeploymentContentV1Schema,
    /** Supplied by the admitted receipt read, not private Artifact content or a client-side permission check. */
    cancellable: z.optional(z.boolean()),
    cancellationConsequence: z.optional(DeploymentCancellationConsequenceV1Schema),
});
export type DeploymentReceiptDetailV1 = z.infer<typeof DeploymentReceiptDetailV1Schema>;

/** One private-content projection for UI and agent reads; it grants no cancellation authority. */
export function projectDeploymentCancellationConsequenceV1(receipt: Pick<DeploymentReceiptDetailV1, 'deployment' | 'content'>): DeploymentCancellationConsequenceV1 | undefined {
    if (receipt.deployment.operation === 'teardown' || receipt.content.platform !== undefined) return undefined;
    if (receipt.content.machineResults.some(result => result.incumbentStopped === true)) {
        return { kind: 'service-down-until-rollback' };
    }
    if (!receipt.deployment.predecessorDeploymentId || receipt.deployment.state === 'queued'
        || receipt.deployment.state === 'succeeded' || receipt.deployment.state === 'running_unverified') return undefined;
    const ownServer = 'ownServer' in receipt.content ? receipt.content.ownServer : undefined;
    if (ownServer?.approvedInputBasis.ownServer?.rollout === 'startFirst') return undefined;
    const activating = receipt.content.steps.some(step => step.id === 'activate' && step.state === 'running')
        || ownServer?.stageLogs?.some(log => log.steps?.some(step => step.ref === 'activate' && step.range.end === null));
    return activating ? { kind: 'may-leave-service-down-until-rollback' } : undefined;
}
